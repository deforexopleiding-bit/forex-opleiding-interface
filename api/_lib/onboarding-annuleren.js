// api/_lib/onboarding-annuleren.js
//
// DE ANNULERING VAN EEN STUDENT — één uitvoering voor drie knoppen:
//   - "Student annuleren" in het CRM-detailscherm (api/onboarding-cancel.js);
//   - "Student annuleren" in Hoofdmentor › Onboarding in het LMS
//     (api/lms-onboarding-annuleren.js, machine-route met x-dfo-secret);
//   - NIEUW (Maxim, 21 oktober 2026): "Student annuleren" in het
//     studentdossier in het LMS (api/lms-student-annuleren.js) — voor ELKE
//     student, ook wie al gestart is en geen CRM-onboarding meer heeft.
//
// TWEE NIVEAUS, ÉÉN KERN:
//   - onboarding-niveau: `voerAnnuleringUit({ onboardingId, ... })` — zoals
//     altijd. Zonder `opties` gebeurt exact wat er vóór 21 okt gebeurde
//     (alles crediteren, alles stopzetten).
//   - student-niveau: `voerAnnuleringUit({ studentId, customerId?, opties })`
//     — de klant wordt gevonden via onboardings.dfo_lms_student_id, anders
//     onboardings.bubble_user_id, anders lower(customers.email)
//     (zoekKlantKandidaten/kiesKlant uit factuurstand-spiegel.js — dezelfde
//     regel als de factuurstand-spiegel). Twijfel = niets uitvoeren: de
//     kandidaten gaan terug naar het venster en Maxim kiest.
//
// ── DE STAPPEN ──────────────────────────────────────────────────────────
//   a) facturen crediteren in Teamleader (niet betaald, geen concept, niet
//      volledig gecrediteerd, niet al gecrediteerd door een eerdere
//      annulering) — op student-niveau alleen de AANGEVINKTE;
//   b) abonnementen deactiveren (Teamleader + lokaal 'cancelled');
//   c) offertes/deals: quotations.delete + deals.lose + lokaal gearchiveerd;
//   d) (vervallen 9 okt 2026: Bubble-einddatum/login uit — Bubble gaat dicht;
//      de toegang sluit nu alleen nog in het LMS, stap i);
//   e) onboardings.status = 'geannuleerd' (op student-niveau: de open
//      onboardings van deze student, als die er zijn);
//   f) record in onboarding_cancellations (met alle stappen en, op
//      student-niveau, de gekozen opties);
//   g) interne meldingen (app, niet naar de klant) — AWAITED, het resultaat
//      staat in het verslag;
//   h) lopende onboarding-automaties stoppen;
//   i) de toegang tot het LMS dicht — hlms_student.eind_datum op gisteren,
//      hetzelfde mechanisme als "Toegang intrekken" (alleen als de einddatum
//      later ligt of leeg is; de vorige waarde komt in de stappen). Het
//      account blijft bestaan: journal, sessies en historiek blijven;
//   j) het antwoord op "Discord verwijderd?" (alleen vanuit het LMS gevraagd);
//      bij "nee" een open kaart "Discord nog verwijderen" bij de administratie;
//   k) NIEUW: "Doorzetten naar incasso" (alleen student-niveau): de facturen
//      blijven open (crediteren kan dan niet), de klant komt in de
//      wanbetalers-pipeline op fase 'incasso' (setStage — legt Joost NIET
//      stil), en in het LMS het incasso-merkteken + de incasso_opvolging-
//      kaart (stap l, dezelfde vorm als G1 "naar incasso");
//   l) NIEUW: de annulering in het LMS (hlms_student_annuleren) — zodat het
//      dossier en het studentenoverzicht "Geannuleerd op …" tonen en de
//      student uit Klaar voor onboarding en de weeknormen verdwijnt.
// Elke stap heeft zijn eigen try/catch; één mislukte stap stopt de rest niet.
// Er gaat NIETS rechtstreeks naar de klant.
//
// IDEMPOTENT:
//   - onboarding-niveau: al geannuleerd → { already_cancelled: true };
//   - student-niveau: er staat al een annulering voor deze student →
//     { already_cancelled: true } met het verslag van toen. Het record wordt
//     EERST geschreven (als claim): twee gelijktijdige kliks → de tweede ziet
//     de eerste, ruimt zijn eigen claim op en doet niets;
//   - per factuur: wat een eerdere annulering al crediteerde, komt niet meer
//     in aanmerking (de lokale credited_amount loopt via de TL-sync achter).

import { supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from './teamleader-token.js';
import { createNotification } from './notify.js';
import { spiegelNaActie } from './onboarding-spiegel.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { ensurePipelineCustomer, setStage } from './dunning-pipeline.js';
import { crmMentorVoorLmsId } from './lms-mentor-brug.js';
import { zoekKlantKandidaten, kiesKlant } from './factuurstand-spiegel.js';
import { customerDisplayName } from './customer-name.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  await sleep(150);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length > 0) {
    return lines.reduce((sum, li) =>
      sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}


// Welke facturen crediteren we?
//   - status NIET 'concept'  (creditten kan niet, finance-invoice-credit weigert 409)
//   - status NIET 'paid'     (al volledig betaald — crediteren = onnodige boekhoud-actie)
//   - credited_amount < amount_total (niet al volledig gecrediteerd; voorkomt dubbele credits ook
//     wanneer de orchestrator twee keer ongelukkig aangeroepen wordt op een rij die net door een
//     andere admin handmatig is gecrediteerd)
function shouldCreditInvoice(inv) {
  const status = String(inv?.status || '').toLowerCase();
  if (!status) return false;
  if (status === 'concept' || status === 'paid') return false;
  const total    = Number(inv?.amount_total)    || 0;
  const credited = Number(inv?.credited_amount) || 0;
  if (total <= 0) return false;
  if (credited + 0.01 >= total) return false; // 1ct tolerantie (consistent met arrangements-propose)
  return true;
}

/**
 * Welke facturen heeft een eerdere annulering van deze klant al gecrediteerd?
 * De lokale credited_amount komt pas na de TL-sync bij; zonder deze lijst kan
 * een tweede annulering (bv. eerst de onboarding, dan het dossier) dezelfde
 * factuur nog eens crediteren. PURE.
 */
export function alGecrediteerdeFacturen(records) {
  const ids = new Set();
  for (const rec of records || []) {
    for (const r of rec?.steps?.invoices_credit?.results || []) {
      if (r?.ok === true && r.invoice_id) ids.add(String(r.invoice_id));
    }
  }
  return ids;
}

/** Facturen, abonnementen en offertes van één klant — leest alleen. */
async function leesKlantPosten(customerId) {
  if (!customerId) return { invoices: [], invoices_niet_te_crediteren: 0, subscriptions: [], deals: [], subscription_value: 0 };

  // Eerdere annuleringen van deze klant (zie alGecrediteerdeFacturen).
  const { data: eerdere, error: eErr } = await supabaseAdmin
    .from('onboarding_cancellations')
    .select('id, steps')
    .eq('customer_id', customerId)
    .limit(50);
  if (eErr) throw new Error('eerdere annuleringen lezen: ' + eErr.message);
  const alGecrediteerd = alGecrediteerdeFacturen(eerdere);

  // Facturen — alle van deze klant, te crediteren = subset.
  const { data: alleFacturen, error: fErr } = await supabaseAdmin
    .from('invoices')
    .select('id, tl_invoice_id, invoice_number, amount_total, credited_amount, status, due_date')
    .eq('customer_id', customerId)
    .limit(500);
  if (fErr) throw new Error('invoices fetch: ' + fErr.message);
  const invoices = (alleFacturen || []).filter((i) => shouldCreditInvoice(i) && !alGecrediteerd.has(String(i.id)));

  // Abonnementen — actief (status != 'cancelled'), via deal → customer.
  // Variant op sales-subscriptions-list.
  let subscriptions = [];
  const { data: alleDeals } = await supabaseAdmin
    .from('deals')
    .select('id')
    .eq('customer_id', customerId)
    .limit(200);
  const dealIds = (alleDeals || []).map((d) => d.id);
  if (dealIds.length > 0) {
    const { data: subs, error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .select('id, deal_id, description, amount, vat_percentage, term_count, status, teamleader_subscription_id, line_items')
      .in('deal_id', dealIds)
      .neq('status', 'cancelled')
      .limit(200);
    if (subErr) throw new Error('subscriptions fetch: ' + subErr.message);
    subscriptions = subs || [];
  }

  // Offertes/deals — niet al-gearchiveerde.
  const { data: deals, error: dErr } = await supabaseAdmin
    .from('deals')
    .select('id, tl_deal_id, tl_quotation_id, quote_reference, archived_at, status, source, tl_quotation_accepted_at')
    .eq('customer_id', customerId)
    .is('archived_at', null)
    .limit(200);
  if (dErr) throw new Error('deals fetch: ' + dErr.message);

  return {
    invoices,
    invoices_niet_te_crediteren: (alleFacturen || []).length - invoices.length,
    subscriptions,
    deals: deals || [],
    subscription_value: r2(subscriptions.reduce((sum, s) => sum + inclPerTerm(s), 0)),
  };
}

export async function gatherContext(onboardingId) {
  // 1) onboarding zelf
  const { data: ob, error: obErr } = await supabaseAdmin
    .from('onboardings')
    .select('id, customer_id, customer_name, mentor_user_id, bubble_user_id, dfo_lms_student_id, status')
    .eq('id', onboardingId)
    .maybeSingle();
  if (obErr) throw new Error('onboarding fetch: ' + obErr.message);
  if (!ob) return { ob: null };
  const posten = await leesKlantPosten(ob.customer_id || null);
  return { ob, ...posten };
}


/** Gisteren als kalenderdag in Brussel (YYYY-MM-DD). PURE. */
export function gisterenBrussel(nu = new Date()) {
  const vandaag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(nu);
  const d = new Date(vandaag + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Moet de LMS-einddatum naar gisteren? Alleen als ze leeg is of later ligt. PURE. */
export function moetToegangDicht(eindDatum, gisteren) {
  if (!eindDatum) return true;
  return String(eindDatum).slice(0, 10) > gisteren;
}

/** Is deze offerte al aanvaard (of een TL-import)? Dan standaard NIET annuleren. PURE. */
export function offerteIsAanvaard(deal) {
  if (!deal) return false;
  if (deal.tl_quotation_accepted_at) return true;
  if (String(deal.source || '') === 'tl_import') return true;
  return ['won', 'gewonnen', 'accepted', 'aanvaard'].includes(String(deal.status || '').toLowerCase());
}

/**
 * Wat staat standaard aangevinkt in het venster? PURE.
 *   facturen: NIET (crediteren is een bewuste keuze per factuur);
 *   abonnementen: WEL;
 *   offertes: wel, behalve een aanvaarde offerte of TL-import (daar hangt
 *     het abonnement van een gestarte student aan);
 *   automaties, LMS-toegang, open onboardings: WEL; incasso: NIET.
 */
export function standaardKeuzes(ctx) {
  return {
    facturen_crediteren:   [],
    abonnementen_stoppen:  (ctx.subscriptions || []).map((s) => s.id),
    offertes_annuleren:    (ctx.deals || []).filter((d) => !offerteIsAanvaard(d)).map((d) => d.id),
    automaties_stoppen:    true,
    lms_toegang_dicht:     true,
    onboardings_annuleren: true,
    incasso:               false,
  };
}

/**
 * De gekozen opties, gecontroleerd tegen wat er werkelijk is. PURE.
 * Zonder opties (de twee oude knoppen): alles, zoals vóór 21 oktober 2026.
 * Een id die niet bij deze klant hoort, valt weg — het venster kan nooit een
 * factuur van iemand anders laten crediteren.
 * @returns {object} de opties, of { fout } bij incasso + crediteren.
 */
export function normaliseerOpties(ctx, opties) {
  const ids = (lijst) => (lijst || []).map((x) => x.id);
  if (!opties || typeof opties !== 'object') {
    return {
      legacy: true,
      facturen_crediteren: ids(ctx.invoices), abonnementen_stoppen: ids(ctx.subscriptions),
      offertes_annuleren: ids(ctx.deals), automaties_stoppen: true, lms_toegang_dicht: true,
      onboardings_annuleren: true, incasso: false,
    };
  }
  const kies = (gevraagd, lijst) => {
    const s = new Set((Array.isArray(gevraagd) ? gevraagd : []).map(String));
    return ids(lijst).filter((id) => s.has(String(id)));
  };
  const incasso = opties.incasso === true;
  const facturen = kies(opties.facturen_crediteren, ctx.invoices);
  if (incasso && facturen.length > 0) return { fout: 'incasso_en_crediteren' };
  return {
    legacy: false,
    facturen_crediteren:   facturen,
    abonnementen_stoppen:  kies(opties.abonnementen_stoppen, ctx.subscriptions),
    offertes_annuleren:    kies(opties.offertes_annuleren, ctx.deals),
    automaties_stoppen:    opties.automaties_stoppen !== false,
    lms_toegang_dicht:     opties.lms_toegang_dicht !== false,
    onboardings_annuleren: opties.onboardings_annuleren !== false,
    incasso,
  };
}

/** De naam die in het venster getypt moet worden: voornaam + achternaam. PURE. */
export function studentNaam(st) {
  return [st?.voornaam, st?.achternaam].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
}

/**
 * Welke klant hoort bij deze student? PURE.
 * `gekozen` = wat Maxim in het venster koos (moet een kandidaat zijn).
 * Eén kandidaat over ALLE wegen → gevonden. Meer dan één (ook als een
 * zekere weg er één gaf en een lagere weg een andere) → onzeker: Maxim kiest.
 * @returns {{ status: 'gevonden'|'gekozen'|'onzeker'|'geen'|'ongeldig', customer_id: string|null, via: string|null, alle: string[] }}
 */
export function bepaalKlant(kandidaten, gekozen = null) {
  const alle = [...new Set(['onboarding', 'bubble', 'email'].flatMap((w) => (kandidaten?.[w] || []).map(String)))];
  const viaVan = (id) => ['onboarding', 'bubble', 'email'].find((w) => (kandidaten?.[w] || []).map(String).includes(id)) || null;
  if (gekozen) {
    const g = String(gekozen);
    return alle.includes(g) ? { status: 'gekozen', customer_id: g, via: viaVan(g), alle } : { status: 'ongeldig', customer_id: null, via: null, alle };
  }
  if (alle.length === 0) return { status: 'geen', customer_id: null, via: null, alle };
  const keuze = kiesKlant(kandidaten);
  if (alle.length === 1 && keuze.customer_id) return { status: 'gevonden', customer_id: keuze.customer_id, via: keuze.via, alle };
  return { status: 'onzeker', customer_id: null, via: null, alle };
}

/** De eerdere student-annuleringen (oudste eerst). */
async function studentAnnuleringen(studentId) {
  const { data, error } = await supabaseAdmin
    .from('onboarding_cancellations')
    .select('id, cancelled_at, created_at, customer_id, customer_name, steps')
    .eq('steps->>lms_student_id', studentId)
    .eq('steps->>niveau', 'student')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error('annuleringen lezen: ' + error.message);
  return data || [];
}

/**
 * De context op student-niveau. Leest alleen.
 * @returns {Promise<{fout?: {status, body}} | object>}
 */
async function gatherStudentContext({ studentId, customerId = null }) {
  const lms = getDfoLmsClient();
  if (!lms) return { fout: { status: 503, body: { error: 'LMS-koppeling niet geconfigureerd.', code: 'lms_niet_geconfigureerd' } } };
  const { data: student, error: sErr } = await lms.from('hlms_student')
    .select('id, voornaam, achternaam, email, bubble_user_id, mentor_id, eind_datum')
    .eq('id', studentId).maybeSingle();
  if (sErr) throw new Error('hlms_student lezen: ' + sErr.message);
  if (!student) return { fout: { status: 404, body: { error: 'Student niet gevonden in het LMS.', code: 'student_niet_gevonden' } } };

  const kandidaten = await zoekKlantKandidaten(student, { db: supabaseAdmin });
  const klant = bepaalKlant(kandidaten, customerId);
  if (klant.status === 'ongeldig') {
    return { fout: { status: 422, body: { error: 'Deze klant hoort niet bij deze student. Er is niets gewijzigd.', code: 'klant_ongeldig' } } };
  }

  // De kandidaten met naam en e-mail, zodat Maxim kan kiezen.
  let klanten = [];
  if (klant.alle.length > 0) {
    const { data, error } = await supabaseAdmin.from('customers')
      .select('id, first_name, last_name, company_name, is_company, email')
      .in('id', klant.alle);
    if (error) throw new Error('klanten lezen: ' + error.message);
    klanten = (data || []).map((c) => ({
      customer_id: c.id, naam: customerDisplayName(c, c.email || c.id), email: c.email || null,
      via: ['onboarding', 'bubble', 'email'].filter((w) => (kandidaten[w] || []).map(String).includes(String(c.id))),
    }));
  }

  const cid = klant.customer_id;
  // De open onboardings van DEZE student bij DEZE klant (gaan op 'geannuleerd').
  let onboardings = [];
  if (cid) {
    const filters = ['dfo_lms_student_id.eq.' + student.id];
    if (student.bubble_user_id) filters.push('bubble_user_id.eq.' + student.bubble_user_id);
    const { data, error } = await supabaseAdmin.from('onboardings')
      .select('id, customer_id, customer_name, mentor_user_id, status, archived_at, is_test')
      .or(filters.join(','));
    if (error) throw new Error('onboardings lezen: ' + error.message);
    onboardings = (data || []).filter((o) => o.is_test !== true && String(o.customer_id || '') === String(cid)
      && !o.archived_at && !['geannuleerd', 'gearchiveerd'].includes(String(o.status || '').toLowerCase()));
  }

  const posten = await leesKlantPosten(cid);
  return {
    niveau: 'student', student, klant: { ...klant, kandidaten: klanten },
    customerId: cid, customerName: studentNaam(student) || null,
    lmsStudentId: student.id, onboardings, ob: onboardings.length === 1 ? onboardings[0] : null,
    mentorUserIdOnboarding: onboardings.find((o) => o.mentor_user_id)?.mentor_user_id || null,
    ...posten,
  };
}

/** De samenvatting voor het bevestigingsvenster (onboarding-niveau) — leest alleen. */
export async function annuleringVoorbeeld(onboardingId) {
  const ctx = await gatherContext(onboardingId);
  if (!ctx.ob) return null;
  return {
    preview:             true,
    already_cancelled:   String(ctx.ob.status || '').toLowerCase() === 'geannuleerd',
    customer_name:       ctx.ob.customer_name || null,
    lms_student_id:      ctx.ob.dfo_lms_student_id || null,
    invoices: ctx.invoices.map((i) => ({
      id: i.id, invoice_number: i.invoice_number, amount_total: r2(i.amount_total),
      credited_amount: r2(i.credited_amount || 0), status: i.status, will_credit: true,
    })),
    subscriptions: ctx.subscriptions.map((s) => ({
      id: s.id, description: s.description, amount_incl: r2(inclPerTerm(s)), status: s.status,
    })),
    subscription_value: ctx.subscription_value,
    offertes: ctx.deals.map((d) => ({ id: d.id, tl_quotation_reference: d.quote_reference })),
  };
}

/**
 * De samenvatting voor het venster in het studentdossier — leest alleen.
 * Alles staat erin, niets verborgen; `standaard` zegt wat aangevinkt staat.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function studentAnnuleringVoorbeeld({ studentId, customerId = null }) {
  const eerder = await studentAnnuleringen(studentId);
  if (eerder.length > 0) {
    return { status: 200, body: { preview: true, niveau: 'student', already_cancelled: true, eerdere: eerder[0] } };
  }
  const ctx = await gatherStudentContext({ studentId, customerId });
  if (ctx.fout) return ctx.fout;
  const std = standaardKeuzes(ctx);

  let automaties = 0;
  if (ctx.onboardings.length > 0) {
    const { data } = await supabaseAdmin.from('onboarding_automation_runs')
      .select('id').in('onboarding_id', ctx.onboardings.map((o) => o.id)).eq('status', 'active');
    automaties = (data || []).length;
  }
  let pipeline = null;
  if (ctx.customerId) {
    const { data } = await supabaseAdmin.from('dunning_pipeline_customers')
      .select('stage_slug').eq('customer_id', ctx.customerId).maybeSingle();
    pipeline = data?.stage_slug || null;
  }
  const gisteren = gisterenBrussel();
  return {
    status: 200,
    body: {
      preview: true, niveau: 'student', already_cancelled: false,
      student: { id: ctx.student.id, naam: ctx.customerName, email: ctx.student.email || null, eind_datum: ctx.student.eind_datum || null },
      naam_bevestiging: ctx.customerName,
      klant: { status: ctx.klant.status, customer_id: ctx.customerId, via: ctx.klant.via, kandidaten: ctx.klant.kandidaten },
      klaar: ctx.klant.status !== 'onzeker',
      onboardings: ctx.onboardings.map((o) => ({ id: o.id, status: o.status, customer_name: o.customer_name })),
      invoices: ctx.invoices.map((i) => ({
        id: i.id, invoice_number: i.invoice_number, amount_total: r2(i.amount_total),
        credited_amount: r2(i.credited_amount || 0), status: i.status, due_date: i.due_date || null, standaard: false,
      })),
      invoices_niet_te_crediteren: ctx.invoices_niet_te_crediteren,
      subscriptions: ctx.subscriptions.map((s) => ({
        id: s.id, description: s.description, amount_incl: r2(inclPerTerm(s)), status: s.status,
        tl: !!s.teamleader_subscription_id, standaard: true,
      })),
      subscription_value: ctx.subscription_value,
      offertes: ctx.deals.map((d) => ({
        id: d.id, tl_quotation_reference: d.quote_reference, aanvaard: offerteIsAanvaard(d),
        standaard: std.offertes_annuleren.includes(d.id),
      })),
      automaties: { aantal: automaties, standaard: true },
      lms_toegang: { eind_datum: ctx.student.eind_datum || null, wordt: gisteren, al_dicht: !moetToegangDicht(ctx.student.eind_datum, gisteren), standaard: true },
      pipeline: { stage_slug: pipeline },
      standaard: std,
    },
  };
}

/** Het verslag in het record bijwerken; een fout komt in de log, niet in de stappen. */
async function werkRecordBij(cancellationId, steps) {
  if (!cancellationId) return;
  const { error } = await supabaseAdmin.from('onboarding_cancellations').update({ steps }).eq('id', cancellationId);
  if (error) console.error('[onboarding-annuleren] stappen bijwerken: ' + error.message);
}

/**
 * Voer de annulering uit — onboarding- of student-niveau.
 * @param {{ onboardingId?: string, studentId?: string, customerId?: string|null, opties?: object|null,
 *           reden: string, doorUserId: string, doorLabel?: string,
 *           discordVerwijderd?: boolean|null, via?: string }} p
 * @returns {Promise<{status: number, body: object}>}
 */
export async function voerAnnuleringUit({ onboardingId = null, studentId = null, customerId = null, opties = null, reden, doorUserId, doorLabel = null, discordVerwijderd = null, via = 'crm' }) {
  const reasonRaw = typeof reden === 'string' ? reden.trim() : '';
  const opStudent = !onboardingId && !!studentId;

  // ── De context ─────────────────────────────────────────────────────────
  let ctx;
  if (opStudent) {
    if (!reasonRaw) return { status: 400, body: { error: 'reason is verplicht bij execute.' } };
    const eerder = await studentAnnuleringen(studentId);
    if (eerder.length > 0) return { status: 200, body: { ok: true, already_cancelled: true, eerdere: eerder[0] } };
    ctx = await gatherStudentContext({ studentId, customerId });
    if (ctx.fout) return ctx.fout;
    if (ctx.klant.status === 'onzeker') {
      return { status: 409, body: { error: 'Meerdere klanten gevonden — kies eerst de juiste klant. Er is niets gewijzigd.', code: 'klant_kiezen', kandidaten: ctx.klant.kandidaten } };
    }
  } else {
    const c = await gatherContext(onboardingId);
    if (!c.ob) return { status: 404, body: { error: 'Onboarding niet gevonden.' } };
    if (String(c.ob.status || '').toLowerCase() === 'geannuleerd') {
      return { status: 200, body: { ok: true, already_cancelled: true } };
    }
    if (!reasonRaw) return { status: 400, body: { error: 'reason is verplicht bij execute.' } };
    ctx = {
      ...c, niveau: 'onboarding', onboardings: [c.ob], customerId: c.ob.customer_id || null,
      customerName: c.ob.customer_name || null, lmsStudentId: c.ob.dfo_lms_student_id || null,
      mentorUserIdOnboarding: c.ob.mentor_user_id || null,
    };
  }
  const keuze = normaliseerOpties(ctx, opStudent ? opties : null);
  if (keuze.fout === 'incasso_en_crediteren') {
    return { status: 400, body: { error: 'Bij "Doorzetten naar incasso" blijven de facturen open: crediteren kan dan niet. Er is niets gewijzigd.', code: 'incasso_en_crediteren' } };
  }
  const reason = reasonRaw.slice(0, 2000);
  const user = { id: doorUserId };
  const gekozen = (lijst, id) => lijst.includes(id);
  const teAnnulerenObs = keuze.onboardings_annuleren ? ctx.onboardings : [];
  const gekozenSubs = ctx.subscriptions.filter((s) => gekozen(keuze.abonnementen_stoppen, s.id));
  const subscriptionValue = r2(gekozenSubs.reduce((sum, s) => sum + inclPerTerm(s), 0));

    const steps = {
      automaties_gestopt:     { ok: false },
      lms_toegang:            { ok: false },
      discord:                { ok: true, skipped: true },
      invoices_credit:        { ok: false, results: [] },
      subscriptions_deactivate: { ok: false, results: [] },
      offertes_cancel:        { ok: false, results: [] },
      onboarding_status:      { ok: false },
      cancellation_record:    { ok: false },
      notify_mentor:          { ok: false },
    };
    if (opStudent) {
      Object.assign(steps, {
        niveau: 'student', lms_student_id: ctx.lmsStudentId, status: 'bezig',
        klant: { customer_id: ctx.customerId, via: ctx.klant.via, status: ctx.klant.status },
        opties: keuze,
        incasso_pipeline: { ok: true, skipped: true, reason: 'niet-gekozen' },
        lms_markering: { ok: false },
      });
    }

    // f-vooraf) Op student-niveau is het record de CLAIM: eerst schrijven,
    // dan nakijken of er niet net iemand anders was.
    let cancellationId = null;
    if (opStudent) {
      try {
        const { data: rec, error: insErr } = await supabaseAdmin
          .from('onboarding_cancellations')
          .insert({
            onboarding_id: ctx.ob?.id || null, customer_id: ctx.customerId || null,
            customer_name: ctx.customerName || null, cancelled_by: user.id, reason,
            subscription_value: subscriptionValue, steps,
          })
          .select('id')
          .single();
        if (insErr) throw new Error(insErr.message);
        cancellationId = rec?.id || null;
      } catch (e) {
        return { status: 500, body: { error: 'De annulering kon niet vastgelegd worden; er is niets gewijzigd. ' + (e?.message || e), code: 'record_mislukt' } };
      }
      const alle = await studentAnnuleringen(ctx.lmsStudentId).catch(() => []);
      if (alle.length > 0 && String(alle[0].id) !== String(cancellationId)) {
        const { error: delErr } = await supabaseAdmin.from('onboarding_cancellations').delete().eq('id', cancellationId);
        if (delErr) console.error('[onboarding-annuleren] dubbele claim opruimen: ' + delErr.message);
        return { status: 200, body: { ok: true, already_cancelled: true, eerdere: alle[0] } };
      }
      steps.cancellation_record = { ok: true, id: cancellationId };
    }

    // a) Facturen crediteren — per factuur try/catch, falende factuur stopt
    //    de loop NIET (anderen worden alsnog gecrediteerd).
    {
      const out = [];
      let allOk = true;
      for (const inv of ctx.invoices) {
        const rec = { invoice_id: inv.id, invoice_number: inv.invoice_number, tl_invoice_id: inv.tl_invoice_id || null };
        if (!gekozen(keuze.facturen_crediteren, inv.id)) {
          rec.ok = true; rec.skipped = true; rec.reason = keuze.incasso ? 'incasso' : 'niet-gekozen';
          out.push(rec);
          continue;
        }
        try {
          if (!inv.tl_invoice_id) { rec.ok = false; rec.error = 'geen TL-id'; allOk = false; out.push(rec); continue; }
          const r = await tlCall('/invoices.credit', { id: inv.tl_invoice_id, description: 'Onboarding annulering' });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            rec.ok = false;
            rec.error = `TL HTTP ${r.status}: ${(txt || '').slice(0, 200)}`;
            allOk = false;
          } else {
            let creditId = null;
            try { creditId = (await r.json())?.data?.id || null; } catch {}
            rec.ok = true;
            rec.tl_credit_note_id = creditId;
          }
        } catch (e) {
          rec.ok = false;
          rec.error = e?.message || String(e);
          allOk = false;
        }
        out.push(rec);
      }
      steps.invoices_credit = { ok: allOk, results: out };
    }

    // b) Abonnement(en) deactiveren — TL + lokaal status='cancelled'.
    {
      const out = [];
      let allOk = true;
      for (const sub of ctx.subscriptions) {
        const rec = { subscription_id: sub.id, teamleader_subscription_id: sub.teamleader_subscription_id || null };
        if (!gekozen(keuze.abonnementen_stoppen, sub.id)) {
          rec.ok = true; rec.skipped = true; rec.reason = 'niet-gekozen';
          out.push(rec);
          continue;
        }
        try {
          if (sub.teamleader_subscription_id) {
            const r = await tlCall('/subscriptions.deactivate', { id: sub.teamleader_subscription_id });
            if (!r.ok) {
              const txt = await r.text().catch(() => '');
              rec.tl_ok = false;
              rec.tl_error = `HTTP ${r.status}: ${(txt || '').slice(0, 200)}`;
              // Geen TL-deactivatie maar wel doorgaan met lokaal stopzetten
              // (consistent met sales-subscription-delete force-pad).
            } else {
              rec.tl_ok = true;
            }
          } else {
            rec.tl_skipped = true;
          }
          const { error: upErr } = await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('id', sub.id);
          if (upErr) { rec.local_ok = false; rec.local_error = upErr.message; allOk = false; }
          else       { rec.local_ok = true;  rec.ok = true; }
          if (rec.tl_ok === false) allOk = false;
        } catch (e) {
          rec.ok = false; rec.error = e?.message || String(e); allOk = false;
        }
        out.push(rec);
      }
      steps.subscriptions_deactivate = { ok: allOk, results: out };
    }

    // c) Offertes/deals annuleren — TL best-effort + lokaal archived_at.
    {
      const out = [];
      let allOk = true;
      const gekozenDeals = ctx.deals.filter((d) => gekozen(keuze.offertes_annuleren, d.id));
      const tlTok = gekozenDeals.length > 0 ? await getActiveToken().catch(() => null) : null;
      for (const deal of ctx.deals) {
        const rec = { deal_id: deal.id, tl_deal_id: deal.tl_deal_id || null, tl_quotation_id: deal.tl_quotation_id || null };
        if (!gekozen(keuze.offertes_annuleren, deal.id)) {
          rec.ok = true; rec.skipped = true; rec.reason = 'niet-gekozen';
          out.push(rec);
          continue;
        }
        try {
          if (tlTok && deal.tl_quotation_id) {
            try {
              const r = await tlCall('/quotations.delete', { id: deal.tl_quotation_id });
              rec.tl_quotation_ok = r.ok;
              if (!r.ok) rec.tl_quotation_error = `HTTP ${r.status}`;
            } catch (e) { rec.tl_quotation_ok = false; rec.tl_quotation_error = e?.message || String(e); }
          }
          if (tlTok && deal.tl_deal_id) {
            try {
              const r = await tlCall('/deals.lose', { id: deal.tl_deal_id });
              rec.tl_deal_ok = r.ok;
              if (!r.ok) rec.tl_deal_error = `HTTP ${r.status}`;
            } catch (e) { rec.tl_deal_ok = false; rec.tl_deal_error = e?.message || String(e); }
          }
          const nowIso = new Date().toISOString();
          const { error: upErr } = await supabaseAdmin
            .from('deals')
            .update({ archived_at: nowIso, tl_quotation_declined_at: nowIso })
            .eq('id', deal.id);
          if (upErr) { rec.local_ok = false; rec.local_error = upErr.message; allOk = false; }
          else       { rec.local_ok = true;  rec.ok = true; }
        } catch (e) {
          rec.ok = false; rec.error = e?.message || String(e); allOk = false;
        }
        out.push(rec);
      }
      steps.offertes_cancel = { ok: allOk, results: out };
    }

    // e) onboardings.status='geannuleerd'.
    if (teAnnulerenObs.length === 0) {
      steps.onboarding_status = { ok: true, skipped: true, reason: ctx.onboardings.length ? 'niet-gekozen' : 'geen-open-onboarding' };
    } else {
      const fouten = [];
      for (const ob of teAnnulerenObs) {
        try {
          const { error: upErr } = await supabaseAdmin
            .from('onboardings')
            .update({ status: 'geannuleerd' })
            .eq('id', ob.id);
          if (upErr) throw new Error(upErr.message);
        } catch (e) {
          fouten.push(ob.id + ': ' + (e?.message || String(e)));
        }
      }
      steps.onboarding_status = fouten.length
        ? { ok: false, error: fouten.join('; ') }
        : { ok: true, ...(opStudent ? { onboarding_ids: teAnnulerenObs.map((o) => o.id) } : {}) };
    }

    // f) Cancellation-record met snapshot (onboarding-niveau). KRITIEK voor
    //    audit + omzet-impact. Op student-niveau staat het er al (de claim).
    if (!opStudent) {
      try {
        const { data: rec, error: insErr } = await supabaseAdmin
          .from('onboarding_cancellations')
          .insert({
            onboarding_id:      ctx.ob.id,
            customer_id:        ctx.ob.customer_id || null,
            customer_name:      ctx.ob.customer_name || null,
            cancelled_by:       user.id,
            reason,
            subscription_value: subscriptionValue,
            steps,
          })
          .select('id')
          .single();
        if (insErr) throw new Error(insErr.message);
        cancellationId = rec?.id || null;
        steps.cancellation_record = { ok: true, id: cancellationId };
      } catch (e) {
        steps.cancellation_record = { ok: false, error: e?.message || String(e) };
      }
    }


    // h) Lopende onboarding-automaties stoppen (6 okt 2026, Maxim).
    if (!keuze.automaties_stoppen || ctx.onboardings.length === 0) {
      steps.automaties_gestopt = { ok: true, skipped: true, aantal: 0, reason: ctx.onboardings.length ? 'niet-gekozen' : 'geen-onboarding' };
    } else {
      try {
        const nowIso = new Date().toISOString();
        let aantal = 0;
        for (const ob of ctx.onboardings) {
          const { data: gestopt, error: autErr } = await supabaseAdmin
            .from('onboarding_automation_runs')
            .update({ status: 'cancelled', next_run_at: null, last_error: 'onboarding geannuleerd', updated_at: nowIso })
            .eq('onboarding_id', ob.id)
            .eq('status', 'active')
            .select('id');
          if (autErr) throw new Error(autErr.message);
          aantal += (gestopt || []).length;
        }
        steps.automaties_gestopt = { ok: true, aantal };
      } catch (e) {
        steps.automaties_gestopt = { ok: false, error: e?.message || String(e) };
      }
    }

    // i) De LMS-toegang dicht: eind_datum op gisteren (6 okt 2026, Maxim).
    //    Het account blijft: journal, sessies en historiek blijven staan.
    let lmsStudentId = ctx.lmsStudentId || null;
    let lmsMentorId = ctx.student?.mentor_id || null;
    try {
      const lms = getDfoLmsClient();
      if (!lms) {
        steps.lms_toegang = { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
      } else {
        // Historische koppelsleutel (uit Bubble geïmporteerde studenten zonder
        // dfo_lms_student_id op de onboarding) — alleen een DB-lookup, geen Bubble.
        if (!lmsStudentId && ctx.ob?.bubble_user_id) {
          const { data: viaBubble } = await lms.from('hlms_student').select('id').eq('bubble_user_id', ctx.ob.bubble_user_id).limit(2);
          if ((viaBubble || []).length === 1) lmsStudentId = viaBubble[0].id;
        }
        if (!lmsStudentId) {
          steps.lms_toegang = { ok: true, skipped: true, reason: 'geen-lms-student' };
        } else {
          const { data: st, error: stErr } = await lms.from('hlms_student').select('id, eind_datum, mentor_id').eq('id', lmsStudentId).maybeSingle();
          if (stErr) throw new Error(stErr.message);
          if (!st) {
            steps.lms_toegang = { ok: true, skipped: true, reason: 'lms-student-niet-gevonden' };
          } else {
            lmsMentorId = lmsMentorId || st.mentor_id || null;
            const gisteren = gisterenBrussel();
            if (!keuze.lms_toegang_dicht) {
              steps.lms_toegang = { ok: true, skipped: true, reason: 'niet-gekozen', eind_datum: st.eind_datum || null };
            } else if (!moetToegangDicht(st.eind_datum, gisteren)) {
              steps.lms_toegang = { ok: true, skipped: true, reason: 'al-verlopen', eind_datum: st.eind_datum };
            } else {
              const { error: upErr } = await lms.from('hlms_student').update({ eind_datum: gisteren }).eq('id', lmsStudentId);
              if (upErr) throw new Error(upErr.message);
              steps.lms_toegang = { ok: true, student_id: lmsStudentId, eind_datum: gisteren, vorige_eind_datum: st.eind_datum || null };
            }
          }
        }
      }
    } catch (e) {
      steps.lms_toegang = { ok: false, error: e?.message || String(e) };
    }

    // j) Discord (alleen gevraagd vanuit het LMS).
    if (discordVerwijderd === true || discordVerwijderd === false) {
      const door = doorLabel || 'onbekend';
      const notitie = 'Geannuleerd door ' + door + (via === 'lms' ? ' via het LMS' : '') + '. Uit de Discord verwijderd: '
        + (discordVerwijderd ? 'ja' : 'nee — taak "Discord nog verwijderen" bij de administratie') + '.';
      try {
        // De tijdlijn hoort bij een onboarding; zonder onboarding staat het
        // antwoord alleen in het verslag (en bij "nee" op de kaart).
        for (const ob of teAnnulerenObs.length ? teAnnulerenObs : (ctx.ob ? [ctx.ob] : [])) {
          const { error: tlErr } = await supabaseAdmin.from('onboarding_mentor_updates').insert({
            onboarding_id: ob.id, kind: 'note', status: null, created_by: doorUserId || null, note: notitie,
          });
          if (tlErr) throw new Error(tlErr.message);
        }
        steps.discord = { ok: true, verwijderd: discordVerwijderd, door, op: new Date().toISOString() };
      } catch (e) {
        steps.discord = { ok: false, verwijderd: discordVerwijderd, error: e?.message || String(e) };
      }
      if (discordVerwijderd === false) {
        try {
          const kaart = await maakDiscordKaart({ studentId: lmsStudentId, naam: ctx.customerName, door });
          steps.discord.taak = kaart;
        } catch (e) {
          steps.discord.taak = { ok: false, error: e?.message || String(e) };
        }
      }
    }

    // k) Doorzetten naar incasso: de klant in de wanbetalers-pipeline op
    //    fase 'incasso'. setStage legt Joost NIET stil (klant-module.js
    //    behandelt 'incasso' als open aanmaning; alleen hlms_crm_stilte zet
    //    de motor stil, en die raken we niet).
    if (opStudent && keuze.incasso) {
      if (!ctx.customerId) {
        steps.incasso_pipeline = { ok: false, error: 'geen CRM-klant: de wanbetalers-pipeline kan niet' };
      } else {
        try {
          const en = await ensurePipelineCustomer(ctx.customerId);
          const st = await setStage(ctx.customerId, 'incasso',
            'Geannuleerd en doorgezet naar incasso door ' + (doorLabel || 'onbekend') + (via === 'lms' ? ' via het LMS' : '') + '. Reden: ' + reason.slice(0, 500),
            user.id);
          steps.incasso_pipeline = st.ok
            ? { ok: true, nieuw_in_pipeline: !!en.created, van: st.from || null, onveranderd: !!st.unchanged }
            : { ok: false, error: st.reason || 'setStage mislukt' };
        } catch (e) {
          steps.incasso_pipeline = { ok: false, error: e?.message || String(e) };
        }
      }
    }

    // l) De annulering in het LMS: dossier en overzicht tonen "Geannuleerd
    //    op …", Klaar en weeknormen laten hem los; bij incasso ook het
    //    merkteken + de incasso_opvolging-kaart (het G1-pad).
    if (lmsStudentId) {
      steps.lms_markering = await markeerInLms({
        studentId: lmsStudentId, cancellationId, door: doorLabel, reden: reason, incasso: !!keuze.incasso,
        opties: opStudent ? keuze : { legacy: true },
      });
    } else if (opStudent) {
      steps.lms_markering = { ok: false, error: 'geen LMS-student' };
    }

    // g) Mentor- + management-melding (in de app), fail-soft maar AWAITED:
    //    het verslag zegt wat er echt gebeurde. De mentor: die van de
    //    onboarding, anders die van de student in het LMS.
    let mentorUserId = ctx.mentorUserIdOnboarding || null;
    if (!mentorUserId && lmsMentorId) {
      try { mentorUserId = (await crmMentorVoorLmsId(lmsMentorId))?.user_id || null; }
      catch (e) { console.warn('[onboarding-annuleren] mentor opzoeken: ' + (e?.message || e)); }
    }
    const custNameCancel = ctx.customerName || 'De student';
    const titel = 'Student geannuleerd' + (ctx.customerName ? (' · ' + ctx.customerName) : '');
    const entiteit = ctx.ob?.id
      ? { entityType: 'onboarding', entityId: ctx.ob.id }
      : { entityType: 'lms_student', entityId: lmsStudentId || null };
    if (mentorUserId) {
      const m = await createNotification({
        toUserId:   mentorUserId,
        type:       'onboarding.cancelled',
        title:      titel,
        body:       custNameCancel,
        linkUrl:    '/modules/mentor-onboarding.html',
        ...entiteit,
        createdBy:  doorUserId,
      });
      steps.notify_mentor = m?.ok && m.count > 0
        ? { ok: true, user_id: mentorUserId, aantal: m.count }
        : { ok: false, user_id: mentorUserId, error: m?.error || 'geen melding aangemaakt' };
    } else {
      steps.notify_mentor = { ok: true, skipped: true, reason: 'geen-mentor' };
    }
    const mgmt = await createNotification({
      toRole:     ['manager', 'super_admin'],
      type:       'onboarding.cancelled',
      title:      titel,
      body:       custNameCancel,
      linkUrl:    '/modules/onboarding-hub.html',
      ...entiteit,
      createdBy:  doorUserId,
    });
    steps.notify_management = { ok: !!mgmt?.ok, aantal: mgmt?.count || 0, ...(mgmt?.error ? { error: mgmt.error } : {}) };

    // De record krijgt het volledige verslag — NA stap g, zodat ook de
    // meldingen er juist in staan (vóór 21 okt stond notify_mentor er altijd
    // als ok:false in, omdat het record vóór de melding werd bijgewerkt).
    if (opStudent) steps.status = 'klaar';
    await werkRecordBij(cancellationId, steps);

    // Spiegel naar het LMS: bij een annulering een verwijdering.
    for (const ob of teAnnulerenObs) await spiegelNaActie(ob.id, 'onboarding-cancel');

    return { status: 200, body: { ok: true, cancellation_id: cancellationId, subscription_value: subscriptionValue, steps } };
}

/**
 * Stap l: de annulering in het LMS (functie hlms_student_annuleren, migratie
 * supabase/hlms_student_annulering.sql in dfo-lms-prototype). Faalzacht:
 * vóór die migratie staat deze stap op "overgeslagen", de rest gaat door.
 */
async function markeerInLms({ studentId, cancellationId, door, reden, incasso, opties }) {
  try {
    const lms = getDfoLmsClient();
    if (!lms) return { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
    const { data, error } = await lms.rpc('hlms_student_annuleren', {
      p_student: studentId, p_crm_cancellation_id: cancellationId || null,
      p_door: String(door || 'onbekend').slice(0, 200), p_reden: String(reden || '').slice(0, 2000),
      p_incasso: !!incasso, p_opties: opties || {},
    });
    if (error) {
      const code = String(error.code || '');
      if (code === 'PGRST202' || code === '42883') {
        return incasso
          ? { ok: false, error: 'migratie hlms_student_annulering.sql nog niet gedraaid in het LMS: geen incasso-merkteken' }
          : { ok: true, skipped: true, reason: 'lms-migratie-ontbreekt' };
      }
      throw new Error(error.message);
    }
    return { ok: true, ...(data && typeof data === 'object' ? data : {}) };
  } catch (e) {
    console.error('[onboarding-annuleren] LMS-markering ' + studentId + ': ' + (e?.message || e));
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * De kaart "Discord nog verwijderen" bij de administratie in het LMS: een
 * gewone kaart in de bak `admin`, die Dave afvinkt in zijn lijst.
 */
async function maakDiscordKaart({ studentId, naam, door }) {
  if (!studentId) return { ok: false, error: 'geen LMS-student: maak de taak met de hand aan' };
  const lms = getDfoLmsClient();
  if (!lms) return { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
  const nu = new Date().toISOString();
  const tekst = (naam || 'Deze student') + ' is geannuleerd door ' + (door || 'onbekend')
    + ', maar nog NIET uit de Discord verwijderd. Verwijder hem en vink dit af.';
  const { data, error } = await lms.from('hlms_signaal').insert({
    onderwerp: 'student', student_id: studentId, soort: 'discord_verwijderen', zwaarte: 'oranje',
    status: 'nieuw', bron: 'handmatig', bak: 'admin', eerste_op: nu, laatst_gezien_op: nu,
    bewijs: { reden: tekst, gemeld_op: nu, melding: 'discord_verwijderen' },
  }).select('id').single();
  if (error) throw new Error(error.message);
  const { error: gErr } = await lms.from('hlms_signaal_gebeurtenis').insert({ signaal_id: data.id, soort: 'geopend', tekst });
  if (gErr) console.warn('[onboarding-annuleren] tijdlijn van de kaart: ' + gErr.message);
  return { ok: true, signaal_id: data.id };
}
