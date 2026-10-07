// api/_lib/inbox-categorie.js
//
// Categorie per inbox-gesprek, AFGELEID uit de huidige CRM-status van de
// persoon (2026-10-07). Niet uit de inhoud van het bericht, niet opgeslagen:
// elke lijst-ophaling rekent opnieuw, dus een betaalde factuur of een lead die
// klant wordt, verandert het label. Leest alleen; schrijft niets.
//
// Werkt voor beide nummers: een "persoon" is { sleutel, telefoon, customer_id?,
// attendee_id? }. De klant komt uit het gesprek (customer_id), anders uit een
// UNIEKE telefoon-match op customers.phone, dan de event-aanmelding, dan de lead.
//
// Prioriteit (hoogste wint; de rest gaat mee als klein tag-je):
//   wanbetaler > onboarding > leadsonderhoud > lead_aanmelding > events > klant > onbekend
//
// Signalen (zie ook de PR-omschrijving):
//   wanbetaler      invoices.status ∈ open/partially_paid/overdue, open bedrag
//                   (amount_total − amount_paid − credited_amount) > 0, due_date
//                   verstreken (Amsterdam), geen is_test — óf een lopende aanmaning:
//                   dunning_workflow_runs.status ∈ active/paused, of
//                   dunning_pipeline_customers.stage_slug niet opgelost/afschrijven.
//   onboarding      onboardings-rij die loopt (klant-module.js isActieveOnboarding:
//                   niet gearchiveerd/geannuleerd, niet echt afgerond).
//   leadsonderhoud  kennismakingsgesprek gepland of in de laatste RECENT_DAGEN
//                   (follow_up_appointments.scheduled_at/status, leads.afspraak_op),
//                   lopende opvolgtaak (opvolging_taken.status ∈ open/wacht_inplanning)
//                   of open belcadans (follow_up_leads.lead_status niet verlengd/verloren).
//   lead_aanmelding lead zonder gepland/recent gesprek: leads-rij met bron NIET 'event…'
//                   en status niet 'gewonnen', een toegang-aanvraag, of alleen een
//                   oud/geannuleerd gesprek.
//   events          event_attendees-rij (niet geannuleerd, geen test), een lead met
//                   bron 'event…', of een nog niet verwerkte aanmelding (event_signup_inbox).
//   klant           customers-rij, niet gearchiveerd/geanonimiseerd.
//   onbekend        niets gevonden.
//
// TELEFOON-KOPPELING. De nummers staan in elke tabel in een andere notatie
// ('+31612345678', '+31 6 12345678', '0612345678', "'+316…", '+32 470 12 34 56').
// Matchen op exacte notatie mist er dus veel. Daarom normaliseren we BEIDE
// kanten naar één cijfersleutel (telSleutel) en indexeren we de (kleine)
// tabellen op die sleutel. Een klant koppelen we alleen bij precies één hit
// (CLAUDE.md les 18) — twee klanten op hetzelfde nummer = niet koppelen.
//
// De telefoon-index wordt INDEX_TTL_MS (60 s) per serverinstantie vastgehouden:
// de inboxen pollen elke ~20 s en de tabellen veranderen zelden binnen een
// minuut. De klant-gebonden signalen (facturen, aanmaningen, onboarding) worden
// bij ELKE ophaling live gelezen.
//
// Fail-soft: een loader die faalt levert "geen signaal" (console.warn); de
// lijst blijft altijd werken.

import { isActieveOnboarding, heeftOpenAanmaning } from './klant-module.js';
import { OPEN_INVOICE_STATUSES } from './dunning-pipeline.js';
import { todayIsoInTz, isOverdue } from './dunning-overdue-guard.js';

export const VOLGORDE = Object.freeze(['wanbetaler', 'onboarding', 'leadsonderhoud', 'lead_aanmelding', 'events', 'klant', 'onbekend']);
export const LABELS = Object.freeze({
  wanbetaler: 'Wanbetaler',
  onboarding: 'Onboarding',
  leadsonderhoud: 'Leadsonderhoud',
  lead_aanmelding: 'Lead-aanmelding',
  events: 'Events',
  klant: 'Klant',
  onbekend: 'Onbekend',
});
export const RECENT_DAGEN = 30;
export const INDEX_TTL_MS = 60 * 1000;
const CHUNK = 150;
const PAGINA = 1000;
const MAX_RIJEN = 20000;
const AFSPRAAK_GEPLAND = new Set(['scheduled', 'in_progress', 'verplaatst']);
const AFSPRAAK_GEWEEST = new Set(['completed', 'no_show']);
const OPVOLGING_LOPEND = ['open', 'wacht_inplanning'];
const BELCADANS_DICHT = new Set(['verlengd', 'verloren']);

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Eén cijfersleutel per telefoonnummer, ongeacht notatie. PURE.
 *   '+31 6 12345678' / '0031612345678' / '0612345678' / '612345678' → '31612345678'
 *   '+32 470 12 34 56' / '0470123456'                              → '32470123456'
 * Alleen mobiele nummers zonder landcode krijgen er een (06… → NL; 045–049… → BE);
 * al het andere blijft zijn kale cijfers. Korter dan 8 cijfers → null.
 */
export function telSleutel(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('06')) d = '31' + d.slice(1);
  else if (d.length === 10 && /^04[5-9]/.test(d)) d = '32' + d.slice(1);
  else if (d.length === 9 && d.startsWith('6')) d = '31' + d;
  else if (d.length === 9 && /^4[5-9]/.test(d)) d = '32' + d;
  return d.length >= 8 ? d : null;
}

/** Uit een set signalen de categorie + secundaire tags. PURE. */
export function kiesCategorie(s = {}) {
  const aan = VOLGORDE.filter((k) => k !== 'onbekend' && s[k]);
  if (!aan.length) return { categorie: 'onbekend', tags: [] };
  return { categorie: aan[0], tags: aan.slice(1) };
}

/** Is deze afspraak "gepland of recent"? PURE. */
export function afspraakTelt(a, nuMs) {
  if (!a || a.is_test) return false;
  const st = String(a.status || '').toLowerCase();
  const t = a.scheduled_at ? Date.parse(a.scheduled_at) : NaN;
  if (!Number.isFinite(t)) return false;
  const grens = nuMs - RECENT_DAGEN * 86400000;
  if (AFSPRAAK_GEPLAND.has(st)) return t >= grens;   // toekomstig, of net voorbij en nog niet afgesloten
  if (AFSPRAAK_GEWEEST.has(st)) return t >= grens;   // recent gesprek (of no-show) → nog in opvolging
  return false;                                       // cancelled e.d.
}

/** Heeft deze persoon ooit een (niet-test) afspraak gehad? PURE. */
export function afspraakBekend(a) {
  return !!a && !a.is_test && !!a.scheduled_at;
}

/** Is deze factuur een achterstallige openstaande factuur? PURE. */
export function factuurAchterstallig(inv, vandaagIso) {
  if (!inv || inv.is_test) return false;
  if (!OPEN_INVOICE_STATUSES.includes(String(inv.status || ''))) return false;
  const open = Number(inv.amount_total || 0) - Number(inv.amount_paid || 0) - Number(inv.credited_amount || 0);
  if (!(open > 0.004)) return false;
  return isOverdue(inv.due_date, vandaagIso, 0);
}

/** Komt deze lead uit een event-aanmelding (spiegel-trigger)? PURE. */
export function isEventLead(lead) {
  return /^event\b/i.test(String(lead?.bron || '').trim());
}

// ── Lezen ───────────────────────────────────────────────────────────────────

function blokken(arr, n = CHUNK) {
  const uit = [];
  for (let i = 0; i < arr.length; i += n) uit.push(arr.slice(i, i + n));
  return uit;
}

/** Live lezen per id-blok (klant-signalen). Fail-soft. */
async function lees(naam, waarden, bouw) {
  const rijen = [];
  if (!waarden.length) return rijen;
  try {
    for (const deel of blokken(waarden)) {
      const { data, error } = await bouw(deel);
      if (error) { console.warn(`[inbox-categorie] ${naam} (soft):`, error.message); return rijen; }
      rijen.push(...(data || []));
    }
  } catch (e) {
    console.warn(`[inbox-categorie] ${naam} exception (soft):`, e?.message || e);
  }
  return rijen;
}

/** Hele (kleine) tabel lezen, gepagineerd (PostgREST geeft max 1000 per keer). Fail-soft. */
async function leesAlles(naam, bouw) {
  const rijen = [];
  try {
    for (let van = 0; van < MAX_RIJEN; van += PAGINA) {
      const { data, error } = await bouw().order('id', { ascending: true }).range(van, van + PAGINA - 1);
      if (error) { console.warn(`[inbox-categorie] ${naam} (soft):`, error.message); break; }
      rijen.push(...(data || []));
      if (!data || data.length < PAGINA) break;
    }
  } catch (e) {
    console.warn(`[inbox-categorie] ${naam} exception (soft):`, e?.message || e);
  }
  return rijen;
}

function groepeer(rijen, sleutel) {
  const m = new Map();
  for (const r of rijen) {
    const k = sleutel(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// ── Telefoon-index (60 s per instantie) ─────────────────────────────────────

let _index = null; // { tot, data }

/** Alleen voor tests. */
export function _resetIndex() { _index = null; }

async function bouwIndex(sb) {
  const [klanten, leads, attendees, afspraken, taken, cadans, signups, toegang] = await Promise.all([
    leesAlles('customers', () => sb.from('customers')
      .select('id, phone, archived_at, anonymized_at').not('phone', 'is', null)),
    leesAlles('leads', () => sb.from('leads')
      .select('id, telefoon, telefoon_e164, bron, status, afspraak_op, customer_id').is('verwijderd_op', null)),
    leesAlles('event_attendees', () => sb.from('event_attendees')
      .select('id, phone, status, is_test, customer_id')),
    leesAlles('follow_up_appointments', () => sb.from('follow_up_appointments')
      .select('id, lead_phone, scheduled_at, status, is_test').not('lead_phone', 'is', null)),
    leesAlles('opvolging_taken', () => sb.from('opvolging_taken')
      .select('id, telefoon, status').in('status', OPVOLGING_LOPEND)),
    leesAlles('follow_up_leads', () => sb.from('follow_up_leads')
      .select('id, lead_phone, lead_status').not('lead_phone', 'is', null)),
    leesAlles('event_signup_inbox', () => sb.from('event_signup_inbox')
      .select('id, phone').not('phone', 'is', null)),
    leesAlles('toegang_aanvragen', () => sb.from('toegang_aanvragen')
      .select('id, telefoon').not('telefoon', 'is', null)),
  ]);
  return {
    klanten: groepeer(klanten.filter((c) => !c.archived_at && !c.anonymized_at), (c) => telSleutel(c.phone)),
    // leads: telefoon_e164 als die er is, anders de ruwe invoer — beide genormaliseerd.
    leads: groepeer(leads, (l) => telSleutel(l.telefoon_e164 || l.telefoon)),
    attendees: groepeer(attendees, (a) => telSleutel(a.phone)),
    attendeeOpId: new Map(attendees.map((a) => [a.id, a])),
    afspraken: groepeer(afspraken, (a) => telSleutel(a.lead_phone)),
    taken: groepeer(taken, (t) => telSleutel(t.telefoon)),
    cadans: groepeer(cadans.filter((f) => !BELCADANS_DICHT.has(String(f.lead_status || ''))), (f) => telSleutel(f.lead_phone)),
    signups: new Set(signups.map((x) => telSleutel(x.phone)).filter(Boolean)),
    toegang: new Set(toegang.map((x) => telSleutel(x.telefoon)).filter(Boolean)),
  };
}

async function telefoonIndex(sb, nuMs) {
  if (_index && _index.tot > nuMs) return _index.data;
  const data = await bouwIndex(sb);
  _index = { tot: nuMs + INDEX_TTL_MS, data };
  return data;
}

// ── Hoofdfunctie ────────────────────────────────────────────────────────────

/**
 * Categorie per persoon.
 * @param {object} sb  service-role client
 * @param {Array<{sleutel:string, telefoon?:string|null, customer_id?:string|null, attendee_id?:string|null}>} personen
 * @param {{ nu?: Date }} [opts]
 * @returns {Promise<Map<string, {categorie:string, label:string, tags:string[]}>>}
 */
export async function bepaalCategorieen(sb, personen, { nu = new Date() } = {}) {
  const uit = new Map();
  const lijst = (personen || []).filter((p) => p && p.sleutel);
  if (!lijst.length || !sb) return uit;
  const nuMs = nu.getTime();
  const vandaag = todayIsoInTz(nu);
  const ix = await telefoonIndex(sb, Date.now());
  const telVan = new Map(lijst.map((p) => [p.sleutel, telSleutel(p.telefoon)]));
  const opTel = (map, tel) => (tel ? map.get(tel) || [] : []);

  // Klant per persoon: gesprek-koppeling > unieke telefoon-match > event-aanmelding > lead.
  const klantVan = new Map();
  for (const p of lijst) {
    const tel = telVan.get(p.sleutel);
    let cid = p.customer_id || null;
    if (!cid && tel) {
      const ids = [...new Set(opTel(ix.klanten, tel).map((c) => c.id))];
      if (ids.length === 1) cid = ids[0];
    }
    if (!cid) {
      const att = p.attendee_id ? ix.attendeeOpId.get(p.attendee_id) : null;
      const ids = [...new Set([att, ...opTel(ix.attendees, tel)]
        .filter((a) => a && a.customer_id && !a.is_test).map((a) => a.customer_id))];
      if (ids.length === 1) cid = ids[0];
    }
    if (!cid) {
      const ids = [...new Set(opTel(ix.leads, tel).map((l) => l.customer_id).filter(Boolean))];
      if (ids.length === 1) cid = ids[0];
    }
    klantVan.set(p.sleutel, cid);
  }

  // Klant-gebonden signalen: LIVE, per id-blok.
  const klantIds = [...new Set([...klantVan.values()].filter(Boolean))];
  const [klanten, facturen, runs, pipeline, onboardings] = await Promise.all([
    lees('customers.id', klantIds, (d) => sb.from('customers')
      .select('id, archived_at, anonymized_at').in('id', d)),
    lees('invoices', klantIds, (d) => sb.from('invoices')
      .select('customer_id, status, due_date, amount_total, amount_paid, credited_amount, is_test')
      .in('customer_id', d).in('status', OPEN_INVOICE_STATUSES)),
    lees('dunning_workflow_runs', klantIds, (d) => sb.from('dunning_workflow_runs')
      .select('customer_id, status').in('customer_id', d).in('status', ['active', 'paused'])),
    lees('dunning_pipeline_customers', klantIds, (d) => sb.from('dunning_pipeline_customers')
      .select('customer_id, stage_slug').in('customer_id', d)),
    lees('onboardings', klantIds, (d) => sb.from('onboardings')
      .select('customer_id, status, archived_at, auto_afgerond_op, auto_afgerond_sessie_id, handmatig_afgerond_op')
      .in('customer_id', d)),
  ]);
  const actieveKlant = new Set(klanten.filter((c) => !c.archived_at && !c.anonymized_at).map((c) => c.id));
  const factPer = groepeer(facturen, (f) => f.customer_id);
  const runsPer = groepeer(runs, (r) => r.customer_id);
  const pipePer = new Map(pipeline.map((r) => [r.customer_id, r]));
  const obPer = groepeer(onboardings, (o) => o.customer_id);

  for (const p of lijst) {
    const tel = telVan.get(p.sleutel);
    const cid = klantVan.get(p.sleutel);
    const leadRijen = opTel(ix.leads, tel);
    const afspr = opTel(ix.afspraken, tel);
    const viaId = p.attendee_id ? ix.attendeeOpId.get(p.attendee_id) : null;
    const att = [...(viaId ? [viaId] : []), ...opTel(ix.attendees, tel)];
    const s = {
      wanbetaler: !!cid && (
        (factPer.get(cid) || []).some((f) => factuurAchterstallig(f, vandaag))
        || heeftOpenAanmaning({ runs: runsPer.get(cid) || [], pipeline: pipePer.get(cid) || null })),
      onboarding: !!cid && (obPer.get(cid) || []).some(isActieveOnboarding),
      leadsonderhoud: !!tel && (
        afspr.some((a) => afspraakTelt(a, nuMs))
        || leadRijen.some((l) => l.afspraak_op && Date.parse(l.afspraak_op) >= nuMs - RECENT_DAGEN * 86400000)
        || opTel(ix.taken, tel).length > 0
        || opTel(ix.cadans, tel).length > 0),
      // Lead zonder gepland/recent gesprek. Een oud of geannuleerd gesprek maakt
      // iemand een bekende lead, maar valt niet onder "gepland of recent".
      lead_aanmelding: leadRijen.some((l) => !isEventLead(l) && l.status !== 'gewonnen')
        || (!!tel && ix.toegang.has(tel))
        || afspr.some(afspraakBekend),
      // Een event-lead zonder (gevonden) aanmelding telt ook: de lead-rij komt uit een event.
      events: att.some((a) => !a.is_test && a.status !== 'geannuleerd') || leadRijen.some(isEventLead)
        || (!!tel && ix.signups.has(tel)),
      klant: !!cid && actieveKlant.has(cid),
    };
    const { categorie, tags } = kiesCategorie(s);
    uit.set(p.sleutel, { categorie, label: LABELS[categorie], tags });
  }
  return uit;
}

/**
 * Gemak voor lijst-endpoints: zet `categorie`, `categorie_label` en
 * `categorie_tags` op elk item. `persoonVan(item)` levert de persoon.
 * Fail-soft: bij een onverwachte fout blijven de items ongewijzigd.
 */
export async function voegCategorieToe(sb, items, persoonVan) {
  try {
    const personen = (items || []).map(persoonVan).filter(Boolean);
    const m = await bepaalCategorieen(sb, personen);
    for (const it of items || []) {
      const p = persoonVan(it);
      const c = p && m.get(p.sleutel);
      it.categorie = c ? c.categorie : null;
      it.categorie_label = c ? c.label : null;
      it.categorie_tags = c ? c.tags : [];
    }
  } catch (e) {
    console.warn('[inbox-categorie] voegCategorieToe (soft):', e?.message || e);
  }
  return items;
}
