// api/_lib/onboarding-offerte-wissel.js
//
// OFFERTEWISSEL BIJ EEN LOPENDE ONBOARDING (Maxim, 10 november 2026).
//
// Waarom: Laurens Rasti tekende op 10 november een NIEUWE offerte terwijl zijn
// onboarding uit de oude offerte (7 november) nog liep. "Onboarding aanmelden"
// kon niet (er stond al een open onboarding), dus werd de oude offerte
// verwijderd, de LMS-student verwijderd, een nieuwe student aangemaakt (tweede
// uitnodiging naar de klant) en de onboarding met de hand afgerond om eruit te
// geraken. Afgerond betekent bij ons: de eerste coachingcall is gedaan. Dat was
// dus fout, en er was geen weg terug.
//
// Nu: een getekende offerte VERVANGT de lopende onboarding van dezelfde klant.
//   • traject_id en start_date komen uit de nieuwe offerte (de medewerker kiest
//     het traject zoals bij aanmelden; de startdatum komt vooringevuld);
//   • token, startcode, wizardantwoorden, mentor, uitnodiging: blijven;
//   • GEEN welkomstmail, GEEN WhatsApp, GEEN tweede LMS-uitnodiging, GEEN
//     nieuwe automation-inschrijving;
//   • de gekoppelde hlms_student krijgt product_soort, traject_maanden,
//     calls_totaal, start_datum en eind_datum van het nieuwe traject. Een
//     handmatige afwijking in het LMS (`overrides.eind_datum`,
//     `overrides.calls_totaal`) blijft staan;
//   • `onboardings.deal_id` = de offerte waar de onboarding nu bij hoort
//     (migratie docs/sql-migrations/2026-11-10-onboardings-deal-id.sql; zonder
//     die kolom gaat de wissel gewoon door en zegt de uitkomst het);
//   • audit_log (before/after) + een regel op de tijdlijn;
//   • de spiegel (hlms_crm_onboarding + hlms_intake) meteen.
//
// VOLGORDE (zoals de incassobrug): eerst alles controleren, dan het LMS, dan
// het CRM. Mislukt het LMS, dan verandert er in het CRM niets (502). Mislukt
// het CRM daarna, dan zetten we de LMS-velden terug.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { bepaalProductSoort, bepaalCallsTotaal } from './dfo-lms-student.js';
import { berekenLmsVenster } from './onboarding-window.js';
import { assertStartDateNotTooEarly } from './onboarding-start-date.js';
import { onboardingAfgesloten } from './onboarding-einde.js';
import { vulHandmatigAan } from './onboarding-handmatig.js';
import { vulIncassoAan, inIncasso } from './onboarding-incasso-stand.js';
import { spiegelNaActie } from './onboarding-spiegel.js';
import { metGewijzigdOp } from './hlms-student-gewijzigd.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Statussen waarin een onboarding nog "loopt" (de eerste coachingcall is er nog niet). */
export const LOPENDE_STATUSSEN = Object.freeze(['aangemeld', 'bezig', 'afgerond']);

/** Een getekende offerte. Zelfde woorden als de offertepagina (accepted/signed). */
export const GETEKEND = Object.freeze(['accepted', 'signed']);

/** De velden op hlms_student die de wissel bijzet. */
export const STUDENT_VELDEN = Object.freeze(['product_soort', 'traject_maanden', 'calls_totaal', 'start_datum', 'eind_datum']);

/**
 * Loopt deze onboarding nog — en kan een nieuwe offerte hem dus vervangen? PURE.
 *
 * aangemeld / bezig: ja. 'afgerond' ZONDER afsluiting (= de klant vulde de
 * wizard in, de eerste call is er nog niet): ook ja, die onboarding loopt nog.
 * Met de hand of door een sessie afgesloten, geannuleerd, gearchiveerd of in
 * incasso-opvolging: nee.
 */
export function onboardingLoopt(ob) {
  if (!ob) return false;
  const s = String(ob.status || '').trim().toLowerCase();
  if (ob.archived_at) return false;
  if (!LOPENDE_STATUSSEN.includes(s)) return false;
  if (onboardingAfgesloten(ob)) return false;
  if (inIncasso(ob)) return false;
  return true;
}

/** Waarom deze onboarding niet vervangen kan worden (code + tekst), of null. PURE. */
export function redenNietVervangbaar(ob) {
  if (!ob) return { code: 'niet_gevonden', tekst: 'Onboarding niet gevonden.' };
  const s = String(ob.status || '').trim().toLowerCase();
  if (ob.archived_at || s === 'gearchiveerd') return { code: 'gearchiveerd', tekst: 'Deze onboarding is gearchiveerd.' };
  if (s === 'geannuleerd') return { code: 'geannuleerd', tekst: 'Deze onboarding is geannuleerd.' };
  if (inIncasso(ob)) return { code: 'in_incasso', tekst: 'Deze onboarding staat in incasso-opvolging. Zet hem eerst terug actief.' };
  if (onboardingAfgesloten(ob)) {
    return {
      code: 'afgesloten',
      tekst: 'Deze onboarding is al afgesloten (eerste sessie of met de hand afgerond). Heropen hem eerst als dat afronden een vergissing was.',
    };
  }
  if (!LOPENDE_STATUSSEN.includes(s)) return { code: 'niet_lopend', tekst: 'Deze onboarding loopt niet (status ' + (ob.status || 'leeg') + ').' };
  return null;
}

/**
 * Hoort deze onboarding al bij deze offerte? PURE.
 * Met `deal_id` (sinds 10 nov 2026) is dat zeker. Zonder: aangemeld NA het
 * tekenen van deze offerte = waarschijnlijk uit deze offerte (vóór de kolom
 * bestond, werd een onboarding altijd vanaf de getekende offerte aangemeld).
 */
export function hoortBijOfferte(ob, deal) {
  if (!ob || !deal) return false;
  if (ob.deal_id) return String(ob.deal_id) === String(deal.id);
  const getekend = deal.tl_quotation_accepted_at || deal.tl_quotation_signed_at || null;
  if (!getekend || !ob.created_at) return false;
  return Date.parse(ob.created_at) >= Date.parse(getekend);
}

/** Mag deze offerte de lopende onboarding vervangen (voor de knop op de offertepagina)? PURE. */
export function kanOfferteVervangen(ob, deal) {
  if (!ob || !deal) return false;
  if (!GETEKEND.includes(String(deal.tl_quotation_status || ''))) return false;
  if (String(ob.customer_id || '') !== String(deal.customer_id || '')) return false;
  if (!onboardingLoopt(ob)) return false;
  return !hoortBijOfferte(ob, deal);
}

function ymd(v) {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return DATUM_RE.test(s) ? s : null;
}

/** Heeft hlms_student een handmatige afwijking voor dit veld? PURE. */
export function heeftOverride(student, veld) {
  const o = student?.overrides;
  return !!(o && typeof o === 'object' && !Array.isArray(o) && o[veld] != null);
}

/**
 * Wat er op hlms_student verandert. PURE.
 * @returns {{patch: object|null, behouden: string[], fout: string|null}}
 *   behouden = velden die door een LMS-override blijven staan.
 */
export function studentPatchVoorWissel({ student, traject, startDate }) {
  const productSoort = bepaalProductSoort(traject);
  if (!productSoort) {
    return { patch: null, behouden: [], fout: 'Onbekend traject-type ' + JSON.stringify(traject?.type ?? null) + ': product_soort is niet te bepalen.' };
  }
  const calls = bepaalCallsTotaal(traject, productSoort);
  if (calls === null) {
    return { patch: null, behouden: [], fout: 'Traject ' + JSON.stringify(traject?.key || traject?.id || null) + ' heeft geen aantal calls ingesteld.' };
  }
  const duur = Number(traject?.duur_maanden);
  const { startIso, eindIso } = berekenLmsVenster({ startDate, duurMaanden: duur });
  const patch = {
    product_soort: productSoort,
    traject_maanden: duur > 0 ? Math.floor(duur) : null,
    start_datum: ymd(startIso),
    calls_totaal: calls,
    eind_datum: ymd(eindIso),
  };
  const behouden = [];
  for (const veld of ['eind_datum', 'calls_totaal']) {
    if (heeftOverride(student, veld)) { delete patch[veld]; behouden.push(veld); }
  }
  return { patch, behouden, fout: null };
}

/**
 * Controleer de invoer en de toestand vóór er iets geschreven wordt. PURE.
 * @returns {{ok:true}|{ok:false,status:number,code:string,error:string,extra?:object}}
 */
export function controleerWissel({ ob, deal, traject, startDate, nu = new Date() }) {
  const nee = (status, code, error, extra) => ({ ok: false, status, code, error, ...(extra ? { extra } : {}) });
  if (!ob) return nee(404, 'niet_gevonden', 'Onboarding niet gevonden.');
  const reden = redenNietVervangbaar(ob);
  if (reden) return nee(409, reden.code, reden.tekst);
  if (!deal) return nee(404, 'offerte_niet_gevonden', 'Offerte niet gevonden.');
  if (String(deal.customer_id || '') !== String(ob.customer_id || '')) {
    return nee(409, 'andere_klant', 'Deze offerte hoort bij een andere klant dan de onboarding.');
  }
  if (!GETEKEND.includes(String(deal.tl_quotation_status || ''))) {
    return nee(409, 'niet_getekend', 'Alleen een getekende offerte kan de lopende onboarding vervangen.');
  }
  if (ob.deal_id && String(ob.deal_id) === String(deal.id)) {
    return nee(409, 'al_deze_offerte', 'De onboarding hoort al bij deze offerte.');
  }
  if (!traject) return nee(404, 'traject_niet_gevonden', 'Traject niet gevonden.');
  if (traject.is_active === false) return nee(400, 'traject_niet_actief', 'Traject is niet actief.');
  if (!startDate || !DATUM_RE.test(startDate)) return nee(400, 'start_date_verplicht', 'start_date (YYYY-MM-DD) is verplicht.');
  // Dezelfde ondergrens als bij aanmelden — maar alleen als de datum verandert:
  // een start die al vastlag, mag blijven staan.
  if (startDate !== ymd(ob.start_date)) {
    const teVroeg = assertStartDateNotTooEarly(startDate, nu);
    if (teVroeg) return nee(400, teVroeg.code, teVroeg.message, { min: teVroeg.min, got: teVroeg.got });
  }
  return { ok: true };
}

/** "De kolom deal_id bestaat nog niet" (migratie niet gedraaid). PURE. */
export function isDealKolomOntbreekt(err) {
  const code = String(err?.code || '');
  if (code !== 'PGRST204' && code !== '42703') return false;
  return /deal_id/.test(String(err?.message || ''));
}

/** Kies één veld uit een rij. */
function kies(rij, velden) {
  const uit = {};
  for (const v of velden) uit[v] = rij?.[v] ?? null;
  return uit;
}

/**
 * Lees de onboarding met wat de controle nodig heeft. `deal_id` faalzacht:
 * zonder kolom (migratie nog niet gedraaid) is hij leeg.
 */
export async function leesOnboardingVoorWissel(db, onboardingId) {
  const basis = 'id, customer_id, customer_name, traject_id, start_date, status, archived_at, completed_at, started_at, created_at, auto_afgerond_op, auto_afgerond_sessie_id, dfo_lms_student_id, is_test';
  let { data, error } = await db.from('onboardings').select(basis + ', deal_id').eq('id', onboardingId).maybeSingle();
  let dealKolom = true;
  if (error && isDealKolomOntbreekt(error)) {
    dealKolom = false;
    ({ data, error } = await db.from('onboardings').select(basis).eq('id', onboardingId).maybeSingle());
  }
  if (error) throw new Error('onboarding lezen: ' + error.message);
  if (data) {
    if (!dealKolom) data.deal_id = null;
    await vulHandmatigAan(db, data);
    await vulIncassoAan(db, data);
  }
  return { ob: data || null, dealKolom };
}

/**
 * DE WISSEL. Gooit niet; geeft { status, body } terug zoals de andere
 * onboarding-acties.
 *
 * @param {{onboardingId:string, dealId:string, trajectId:string, startDate:string,
 *          doorUserId?:string|null, door?:string, db?:object, lms?:object|null, nu?:Date,
 *          spiegel?:Function}} p
 */
export async function vervangOnboardingDoorOfferte(p) {
  const db = p.db || supabaseAdmin;
  const lms = p.lms === undefined ? getDfoLmsClient() : p.lms;
  const spiegel = p.spiegel || spiegelNaActie;
  const nu = p.nu || new Date();
  const { onboardingId, dealId, trajectId } = p;
  const startDate = ymd(p.startDate);
  const door = String(p.door || 'onbekend').slice(0, 200);
  const uit = (status, body) => ({ status, body });

  if (!UUID_RE.test(String(onboardingId || ''))) return uit(400, { error: 'onboarding_id (uuid) vereist', code: 'ongeldig_verzoek' });
  if (!UUID_RE.test(String(dealId || ''))) return uit(400, { error: 'deal_id (uuid) vereist', code: 'ongeldig_verzoek' });
  if (!UUID_RE.test(String(trajectId || ''))) return uit(400, { error: 'traject_id (uuid) vereist', code: 'ongeldig_verzoek' });

  try {
    // ── 1) Lezen ─────────────────────────────────────────────────────────
    const { ob, dealKolom } = await leesOnboardingVoorWissel(db, onboardingId);
    const { data: deal, error: dErr } = await db.from('deals')
      .select('id, customer_id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, quote_reference, payment_start_date, start_date')
      .eq('id', dealId).maybeSingle();
    if (dErr) throw new Error('offerte lezen: ' + dErr.message);
    const { data: traject, error: tErr } = await db.from('onboarding_trajecten')
      .select('id, key, type, label, duur_maanden, calls, alpha_calls_total, is_active')
      .eq('id', trajectId).maybeSingle();
    if (tErr) throw new Error('traject lezen: ' + tErr.message);

    // ── 2) Controleren — vóór er iets geschreven wordt ───────────────────
    const c = controleerWissel({ ob, deal, traject, startDate, nu });
    if (!c.ok) return uit(c.status, { error: c.error, code: c.code, ...(c.extra || {}) });

    let oudTraject = null;
    if (ob.traject_id) {
      const { data: ot } = await db.from('onboarding_trajecten').select('id, key, label').eq('id', ob.traject_id).maybeSingle();
      oudTraject = ot || null;
    }

    // De stand VÓÓR de wissel, vastgelegd vóór er iets geschreven wordt.
    const voor = {
      traject_id: ob.traject_id || null, traject: oudTraject?.label || oudTraject?.key || null,
      start_date: ymd(ob.start_date), deal_id: ob.deal_id || null, lms_student: null,
    };

    // ── 3) Het LMS eerst ─────────────────────────────────────────────────
    const waarschuwingen = [];
    let lmsUit = { bijgewerkt: false };
    let studentVoor = null;
    let studentPatch = null;
    let gewijzigdVoor = null;
    if (!ob.dfo_lms_student_id) {
      lmsUit = { bijgewerkt: false, reden: 'geen_lms_student' };
      waarschuwingen.push('Er hangt geen LMS-student aan deze onboarding: in het LMS is niets bijgezet. Maak hem aan met "Student aanmaken in LMS" als dat nodig is.');
    } else if (!lms) {
      return uit(503, { error: 'Het LMS is niet geconfigureerd (DFO_LMS_SUPABASE_URL/KEY). Er is niets gewijzigd.', code: 'lms_niet_geconfigureerd' });
    } else {
      const { data: st, error: sErr } = await lms.from('hlms_student')
        .select('id, product_soort, traject_maanden, calls_totaal, start_datum, eind_datum, overrides, gewijzigd_op')
        .eq('id', ob.dfo_lms_student_id).maybeSingle();
      if (sErr) return uit(502, { error: 'LMS-student lezen mislukt: ' + sErr.message + '. Er is niets gewijzigd.', code: 'lms_fout' });
      if (!st) {
        lmsUit = { bijgewerkt: false, reden: 'lms_student_niet_gevonden' };
        waarschuwingen.push('De gekoppelde LMS-student bestaat niet (meer): in het LMS is niets bijgezet.');
      } else {
        const sp = studentPatchVoorWissel({ student: st, traject, startDate });
        if (sp.fout) return uit(422, { error: sp.fout + ' Er is niets gewijzigd.', code: 'traject_onvolledig' });
        studentVoor = kies(st, STUDENT_VELDEN);
        studentPatch = sp.patch;
        gewijzigdVoor = st.gewijzigd_op ?? null;
        const { error: uErr } = await lms.from('hlms_student').update(metGewijzigdOp(studentPatch, nu)).eq('id', st.id);
        if (uErr) return uit(502, { error: 'LMS-student bijwerken mislukt: ' + uErr.message + '. Er is niets gewijzigd.', code: 'lms_fout' });
        lmsUit = { bijgewerkt: true, student_id: st.id, behouden: sp.behouden };
        for (const v of sp.behouden) {
          waarschuwingen.push('In het LMS staat een handmatige afwijking voor ' + v + ' (' + JSON.stringify(st.overrides?.[v]?.waarde ?? st.overrides?.[v]) + '): die is blijven staan. Kijk na of ze bij de nieuwe offerte past.');
        }
      }
    }

    // ── 4) Het CRM ───────────────────────────────────────────────────────
    const patch = { traject_id: traject.id, start_date: startDate, updated_at: nu.toISOString() };
    let dealIdGezet = false;
    let upErr = null;
    if (dealKolom) {
      ({ error: upErr } = await db.from('onboardings').update({ ...patch, deal_id: deal.id }).eq('id', ob.id));
      if (!upErr) dealIdGezet = true;
      if (upErr && isDealKolomOntbreekt(upErr)) upErr = null;
    }
    if (!dealIdGezet && !upErr) {
      ({ error: upErr } = await db.from('onboardings').update(patch).eq('id', ob.id));
    }
    if (upErr) {
      // Terugdraaien in het LMS: anders spreken beide kanten elkaar tegen.
      if (studentVoor && lms && lmsUit.student_id) {
        const terug = {};
        for (const k of Object.keys(studentPatch || {})) terug[k] = studentVoor[k];
        // Netto is er niets gewijzigd: ook gewijzigd_op terug naar wat er stond.
        const { error: rbErr } = await lms.from('hlms_student').update({ ...terug, gewijzigd_op: gewijzigdVoor }).eq('id', lmsUit.student_id);
        if (rbErr) console.error('[offerte-wissel] LMS terugzetten mislukt voor ' + lmsUit.student_id + ': ' + rbErr.message);
      }
      return uit(500, { error: 'Onboarding bijwerken mislukt: ' + upErr.message, code: 'crm_fout' });
    }
    if (!dealIdGezet) {
      waarschuwingen.push('De kolom onboardings.deal_id bestaat nog niet (migratie 2026-11-10-onboardings-deal-id.sql): de koppeling met de offerte is niet bewaard.');
    }

    voor.lms_student = studentVoor;
    const na = {
      traject_id: traject.id, traject: traject.label || traject.key || null,
      start_date: startDate, deal_id: dealIdGezet ? deal.id : voor.deal_id,
      lms_student: studentPatch ? { ...studentVoor, ...studentPatch } : null,
    };

    // ── 5) Spoor: audit_log + tijdlijn (faalzacht: de wissel staat vast) ─
    const ref = deal.quote_reference || deal.id;
    const reden = 'Offerte ' + ref + ' vervangt de lopende onboarding (door ' + door + ').';
    try {
      const { error: aErr } = await db.from('audit_log').insert({
        user_id: p.doorUserId || null,
        action: 'onboarding.offerte_wissel',
        entity_type: 'onboarding',
        entity_id: ob.id,
        before_json: voor,
        after_json: na,
        reason_text: reden.slice(0, 500),
      });
      if (aErr) console.error('[offerte-wissel] audit_log ' + ob.id + ': ' + aErr.message);
    } catch (e) { console.error('[offerte-wissel] audit_log ' + ob.id + ': ' + (e?.message || e)); }
    try {
      const { error: tlErr } = await db.from('onboarding_mentor_updates').insert({
        onboarding_id: ob.id,
        kind: 'note',
        status: null,
        note: ('Offerte gewisseld door ' + door + ': nieuwe offerte ' + ref + '. Traject '
          + (voor.traject || '—') + ' → ' + (na.traject || '—') + ', start '
          + (voor.start_date || '—') + ' → ' + startDate + '. Geen nieuwe mail, WhatsApp of LMS-uitnodiging.').slice(0, 2000),
        created_by: p.doorUserId || null,
      });
      if (tlErr) console.error('[offerte-wissel] tijdlijn ' + ob.id + ': ' + tlErr.message);
    } catch (e) { console.error('[offerte-wissel] tijdlijn ' + ob.id + ': ' + (e?.message || e)); }

    // ── 6) Spiegel meteen (hlms_crm_onboarding + hlms_intake) ────────────
    const sp = await spiegel(ob.id, 'onboarding-offerte-wissel');

    return uit(200, {
      ok: true,
      onboarding_id: ob.id,
      voor, na,
      lms: lmsUit,
      spiegel: sp?.resultaat || null,
      waarschuwingen,
      // Bewust NIETS verstuurd: geen welkomstmail, geen WhatsApp, geen LMS-uitnodiging.
      verstuurd: [],
    });
  } catch (e) {
    console.error('[offerte-wissel] ' + onboardingId + ': ' + (e?.message || e));
    return uit(500, { error: e?.message || 'Interne fout', code: 'fout' });
  }
}

// ── WAARSCHUWING BIJ "DEFINITIEF VERWIJDEREN (TL + CRM)" (12 nov 2026) ───────
// Aanleiding: op 10 nov werd de oude offerte van Laurens Rasti definitief
// verwijderd om van offerte te wisselen. De onboarding bleef open staan, er
// kwam een tweede LMS-account en een tweede uitnodiging. Verwijderen is geen
// offertewissel: het venster moet dat zeggen, en de server vraagt een extra
// bevestiging. Geen blocker: verwijderen blijft mogelijk.

/** De uitleg in het venster (één bron voor beide schermen). */
export const VERWIJDER_ONBOARDING_UITLEG =
  'Wissel je van offerte? Verwijder deze offerte dan niet, maar open de nieuwe getekende offerte en kies '
  + '"Deze offerte vervangt de lopende onboarding". Account, uitnodiging en antwoorden blijven dan behouden en de '
  + 'klant krijgt niets. Verwijderen laat de onboarding gewoon open staan.';

/**
 * Welke onboardings verdienen een waarschuwing bij het verwijderen van deze
 * offerte? PURE.
 *   • een LOPENDE onboarding van dezelfde klant (zelfde regel als de
 *     vervang-knop: aangemeld/bezig, of wizard voltooid zonder afsluiting);
 *   • elke onboarding die via `deal_id` aan precies deze offerte hangt
 *     (behalve gearchiveerd/geannuleerd: daar valt niets meer open te laten).
 * @returns {{id, naam, status, start_date, reden: 'lopend'|'deze_offerte'|'beide'}[]}
 */
export function onboardingsBijVerwijderen(onboardings, deal) {
  const uit = [];
  for (const ob of Array.isArray(onboardings) ? onboardings : []) {
    if (!ob?.id) continue;
    const s = String(ob.status || '').trim().toLowerCase();
    const opDeze = !!(deal?.id && ob.deal_id && String(ob.deal_id) === String(deal.id))
      && !ob.archived_at && s !== 'gearchiveerd' && s !== 'geannuleerd';
    const loopt = onboardingLoopt(ob)
      && (!deal?.customer_id || String(ob.customer_id || '') === String(deal.customer_id));
    if (!opDeze && !loopt) continue;
    uit.push({
      id: ob.id,
      naam: ob.customer_name || null,
      status: ob.status || null,
      start_date: ymd(ob.start_date),
      reden: opDeze && loopt ? 'beide' : (opDeze ? 'deze_offerte' : 'lopend'),
    });
  }
  return uit;
}

/**
 * Lees de onboardings van de klant en die op deze offerte, faalzacht: een
 * leesfout geeft `{ onboardings: [], fout }` (dan geen waarschuwing — het is
 * geen blocker — maar wel een logregel en de fout in het antwoord).
 */
export async function leesOnboardingsBijVerwijderen(db, deal) {
  const basis = 'id, customer_id, customer_name, status, start_date, archived_at, auto_afgerond_op, auto_afgerond_sessie_id';
  try {
    const rijen = new Map();
    const lees = async (kolom, waarde, metDeal) => {
      const sel = metDeal ? basis + ', deal_id' : basis;
      const { data, error } = await db.from('onboardings').select(sel).eq(kolom, waarde);
      if (error) return { error };
      for (const r of data || []) rijen.set(r.id, { deal_id: null, ...rijen.get(r.id), ...r });
      return { error: null };
    };
    let dealKolom = true;
    if (deal?.customer_id) {
      let r = await lees('customer_id', deal.customer_id, true);
      if (r.error && isDealKolomOntbreekt(r.error)) { dealKolom = false; r = await lees('customer_id', deal.customer_id, false); }
      if (r.error) throw new Error(r.error.message);
    }
    if (dealKolom && deal?.id) {
      const r = await lees('deal_id', deal.id, true);
      if (r.error && !isDealKolomOntbreekt(r.error)) throw new Error(r.error.message);
    }
    const lijst = [...rijen.values()];
    await vulHandmatigAan(db, lijst);
    await vulIncassoAan(db, lijst);
    return { onboardings: onboardingsBijVerwijderen(lijst, deal), fout: null };
  } catch (e) {
    console.error('[offerte-verwijderen] onboardings lezen: ' + (e?.message || e));
    return { onboardings: [], fout: e?.message || String(e) };
  }
}
