// api/_lib/student-telefoon-aanvullen.js
//
// TELEFOONNUMMERS AANVULLEN VOOR ALLE LMS-STUDENTEN (Maxim, 6 oktober 2026).
//
// ── WAAROM ───────────────────────────────────────────────────────────────
// De onboardingspiegel vult hlms_student.telefoon aan voor wie een onboarding
// heeft. Na de hersync van 6 oktober stonden er nog 259 van de 304 actieve
// studenten zonder nummer: vooral Bubble-imports zonder onboarding. Hun
// nummer staat vaak wél in het CRM: op de klantkaart, in een WhatsApp-
// gesprek, bij de lead of bij de geboekte call.
//
// ── HOE EEN STUDENT AAN HET CRM HANGT (eerste treffer wint) ─────────────
//   1. onboardings.dfo_lms_student_id = student.id   (exact)
//   2. onboardings.bubble_user_id     = student.bubble_user_id
//   3. customers.email                = student.email (hoofdletterongevoelig;
//      alleen bij precies één klant — twee klanten met hetzelfde adres is
//      geen koppeling maar een vraag)
// Zonder klant zoekt de afleiding nog op het e-mailadres van de student zelf
// (lead, geboekte call). Het nummer komt uit dezelfde voorrangsregel als de
// spiegel: api/_lib/onboarding-telefoon.js.
//
// ── NOOIT OVERSCHRIJVEN ──────────────────────────────────────────────────
// Alleen studenten met een LEEG nummer worden aangeraakt, en de voorwaarde
// staat in de update zelf: een nummer dat tussen lezen en schrijven gevuld
// werd, blijft staan. Er gaat niets naar de student.
//
// DROOGLOOP: telt exact wat er zou gebeuren, schrijft niets.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { telefoonsVoorPersonen } from './onboarding-telefoon.js';

const PAGINA = 1000;
const IN_CHUNK = 200;
const MAX_FOUTEN = 10;

function leeg(t) {
  return !String(t ?? '').trim();
}

function brusselsVandaag(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(nu);
}

/** Is deze student actief (geen einddatum, of een einddatum vanaf vandaag)? PURE. */
export function isActief(student, vandaag) {
  return !student.eind_datum || String(student.eind_datum).slice(0, 10) >= vandaag;
}

/**
 * De koppeling student → klant, in de volgorde hierboven. PURE.
 * @returns {Map<string, {customer_id: string|null, answers: object|null, via: string|null}>}
 */
export function koppelStudenten(studenten, { obOpStudent, obOpBubble, klantenOpEmail }) {
  const uit = new Map();
  for (const s of studenten) {
    const a = obOpStudent.get(s.id);
    if (a) { uit.set(s.id, { customer_id: a.customer_id || null, answers: a.answers || null, via: 'onboarding' }); continue; }
    const b = s.bubble_user_id ? obOpBubble.get(String(s.bubble_user_id)) : null;
    if (b) { uit.set(s.id, { customer_id: b.customer_id || null, answers: b.answers || null, via: 'bubble' }); continue; }
    const e = String(s.email || '').trim().toLowerCase();
    const k = e ? klantenOpEmail.get(e) : null;
    if (k && k.length === 1) { uit.set(s.id, { customer_id: k[0], answers: null, via: 'email' }); continue; }
    uit.set(s.id, { customer_id: null, answers: null, via: k && k.length > 1 ? 'email-dubbel' : null });
  }
  return uit;
}

async function leesStudentenZonderNummer(lms) {
  const alle = [];
  for (let van = 0; ; van += PAGINA) {
    const { data, error } = await lms.from('hlms_student')
      .select('id, email, bubble_user_id, telefoon, eind_datum')
      .order('id', { ascending: true })
      .range(van, van + PAGINA - 1);
    if (error) throw new Error('hlms_student lezen: ' + error.message);
    alle.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return alle.filter((s) => leeg(s.telefoon));
}

async function leesOnboardingsOp(crm, kolom, waarden) {
  const kaart = new Map();
  for (let i = 0; i < waarden.length; i += IN_CHUNK) {
    const { data, error } = await crm.from('onboardings')
      .select('customer_id, answers, created_at, is_test, ' + kolom)
      .in(kolom, waarden.slice(i, i + IN_CHUNK))
      .order('created_at', { ascending: false });
    if (error) throw new Error('onboardings lezen (' + kolom + '): ' + error.message);
    for (const o of data || []) {
      if (o.is_test) continue;
      const sleutel = String(o[kolom]);
      if (!kaart.has(sleutel)) kaart.set(sleutel, o);   // de jongste wint
    }
  }
  return kaart;
}

async function leesKlantenOpEmail(crm, emails) {
  const kaart = new Map();
  for (let i = 0; i < emails.length; i += IN_CHUNK) {
    const deel = emails.slice(i, i + IN_CHUNK);
    const { data, error } = await crm.from('customers').select('id, email').in('email', deel);
    if (error) throw new Error('customers lezen: ' + error.message);
    for (const k of data || []) {
      const e = String(k.email || '').trim().toLowerCase();
      if (!e) continue;
      const lijst = kaart.get(e) || [];
      if (!lijst.includes(k.id)) lijst.push(k.id);
      kaart.set(e, lijst);
    }
  }
  return kaart;
}

/**
 * @param {{dry?: boolean, door?: string, lmsClient?: object, crmClient?: object}} opties
 *   lmsClient/crmClient alleen voor tests; standaard de echte koppelingen.
 * @returns {Promise<{status: number, result: object}>}
 */
export async function draaiStudentTelefoonAanvullen({ dry = false, door = 'cron', lmsClient = null, crmClient = null } = {}) {
  const result = {
    ok: true, dry, door,
    zonder_nummer: 0, zonder_nummer_actief: 0,
    gekoppeld: { onboarding: 0, bubble: 0, email: 0 },
    email_dubbel: 0, niet_gekoppeld: 0,
    gevonden: 0, gevonden_actief: 0, zonder_landcode: 0, per_bron: {},
    niet_gevonden: 0, niet_gevonden_actief: 0,
    geschreven: 0, al_gevuld: 0, mislukt: 0,
    errors: [],
  };
  const lms = lmsClient || getDfoLmsClient();
  if (!lms) {
    return { status: 503, result: { ...result, ok: false, error: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' } };
  }
  const crm = crmClient || supabaseAdmin;
  try {
    const vandaag = brusselsVandaag();
    const studenten = await leesStudentenZonderNummer(lms);
    result.zonder_nummer = studenten.length;
    result.zonder_nummer_actief = studenten.filter((s) => isActief(s, vandaag)).length;
    if (!studenten.length) return { status: 200, result };

    const ids = studenten.map((s) => s.id);
    const bubbleIds = [...new Set(studenten.map((s) => s.bubble_user_id).filter(Boolean).map(String))];
    // Zowel het adres zoals het er staat als in kleine letters: `in` is in
    // Postgres hoofdlettergevoelig, en "Jan@X.be" op de klantkaart is gewoon Jan.
    const emails = [...new Set(studenten.flatMap((s) => {
      const e = String(s.email || '').trim();
      return e ? [e, e.toLowerCase()] : [];
    }))];
    const [obOpStudent, obOpBubble, klantenOpEmail] = await Promise.all([
      leesOnboardingsOp(crm, 'dfo_lms_student_id', ids),
      bubbleIds.length ? leesOnboardingsOp(crm, 'bubble_user_id', bubbleIds) : new Map(),
      emails.length ? leesKlantenOpEmail(crm, emails) : new Map(),
    ]);

    const koppeling = koppelStudenten(studenten, { obOpStudent, obOpBubble, klantenOpEmail });
    for (const k of koppeling.values()) {
      if (k.via === 'onboarding' || k.via === 'bubble' || k.via === 'email') result.gekoppeld[k.via]++;
      else if (k.via === 'email-dubbel') result.email_dubbel++;
      else result.niet_gekoppeld++;
    }

    const nummers = await telefoonsVoorPersonen(crm, studenten.map((s) => {
      const k = koppeling.get(s.id);
      return { sleutel: s.id, customer_id: k?.customer_id || null, email: s.email || null, answers: k?.answers || null };
    }));

    for (const s of studenten) {
      const t = nummers.get(s.id);
      const actief = isActief(s, vandaag);
      if (!t?.telefoon) {
        result.niet_gevonden++;
        if (actief) result.niet_gevonden_actief++;
        continue;
      }
      result.gevonden++;
      if (actief) result.gevonden_actief++;
      if (!t.zeker) result.zonder_landcode++;
      result.per_bron[t.bron] = (result.per_bron[t.bron] || 0) + 1;
      if (dry) continue;
      // Per rij, met eigen try/catch: één fout houdt de rest niet tegen.
      try {
        const { data, error } = await lms.from('hlms_student')
          .update({ telefoon: t.telefoon })
          .eq('id', s.id)
          .or('telefoon.is.null,telefoon.eq.')
          .select('id');
        if (error) throw new Error(error.message);
        if (data && data.length) result.geschreven++;
        else result.al_gevuld++;
      } catch (e) {
        result.mislukt++;
        const msg = e?.message || String(e);
        console.error('[student-telefoon] ' + s.id + ': ' + msg);
        if (result.errors.length < MAX_FOUTEN) result.errors.push({ student_id: s.id, fout: msg });
      }
    }
    return { status: 200, result };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[student-telefoon] ' + msg);
    return { status: 502, result: { ...result, ok: false, error: msg } };
  }
}
