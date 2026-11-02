// api/_lib/webinar-boekingen.js
//
// Module Webinar › tabel Weken: per webinar-dag de afspraken die via de QR
// (/agenda/webinar, booking_source 'webinar') zijn INGEPLAND (2026-11-02).
//
// KOPPELING (beslissing Maxim):
//   - per dag op het moment van BOEKEN (created_at van de oorspronkelijke
//     afspraak), in Europe/Brussels. NIET de datum van de call, NIET of iemand
//     zich aanmeldde of aanwezig was. Ook testboekingen tellen mee (met label).
//   - boeking op een dag zonder webinar → onder het LAATSTE webinar vóór die
//     dag (elke sessie van de reeks telt, ook een overgeslagen week: wie op die
//     maandag boekt, staat onder die maandag).
//   - boeking vóór het eerste webinar → apart (voor_eerste), nooit weg.
//   => som over alle sessies + voor_eerste = alle webinar-boekingen.
//
// EEN BOEKING = een keten: de oorspronkelijke afspraak (parent_appointment_id
// leeg) plus de afspraken die er bij het verzetten uit ontstonden (kind met
// parent_appointment_id). Geboekt op = de oorspronkelijke; de call en de status
// komen van de LAATSTE afspraak in de keten. Zo telt een verzette call één keer.
//
// Sale/offerte: een deal (niet gearchiveerd) die NA de boeking is aangemaakt en
// hoort bij de lead van de boeking (opstartsessie_submissions.appointment_id →
// lead_id = deals.source_lead_id) of bij een klant met hetzelfde e-mailadres.
// Anders, als de call als uitkomst 'sale' kreeg: "Sale (uitkomst call)".
//
// Alleen lezen; geen migratie nodig.

import { normEmail } from './webinar-opvolging.js';

export const ZONE = 'Europe/Brussels';
export const VOOR_EERSTE = 'voor';

const dagFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Kalenderdag (YYYY-MM-DD) van een moment in Brussel. PURE. */
export function brusselsDag(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dagFmt.format(d);
}

/** Dag van een sessie: de kolom datum (NL-wandklok), anders de startdag in Brussel. PURE. */
export function sessieDag(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s?.datum || '')) ? String(s.datum) : brusselsDag(s?.starts_at);
}

/** De sessie waar een boekingsdag onder valt: laatste sessie op of vóór die dag. PURE. */
export function sessieVoorDag(dag, sessies) {
  let beste = null;
  for (const s of sessies) {
    const sd = sessieDag(s);
    if (!sd || sd > dag) continue;
    if (!beste || sd > sessieDag(beste) || (sd === sessieDag(beste) && String(s.starts_at) > String(beste.starts_at))) beste = s;
  }
  return beste;
}

/** Afspraken → ketens { root, laatste, ids }. PURE. */
export function bouwKetens(afspraken = []) {
  const perId = new Map(afspraken.map((a) => [a.id, a]));
  const kinderen = new Map();
  for (const a of afspraken) {
    if (a.parent_appointment_id && perId.has(a.parent_appointment_id)) {
      if (!kinderen.has(a.parent_appointment_id)) kinderen.set(a.parent_appointment_id, []);
      kinderen.get(a.parent_appointment_id).push(a);
    }
  }
  const ketens = [];
  for (const a of afspraken) {
    // Root = geen ouder, of een ouder die niet bij de webinar-boekingen hoort.
    if (a.parent_appointment_id && perId.has(a.parent_appointment_id)) continue;
    const ids = [a.id];
    let laatste = a;
    const gezien = new Set([a.id]);
    for (;;) {
      const k = (kinderen.get(laatste.id) || []).filter((x) => !gezien.has(x.id))
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
      if (!k) break;
      gezien.add(k.id); ids.push(k.id); laatste = k;
    }
    ketens.push({ root: a, laatste, ids });
  }
  return ketens;
}

/** Status van een boeking (keten): gepland / verplaatst / geannuleerd / no-show / gehad / … PURE. */
export function boekingStatus(keten) {
  const s = String(keten.laatste?.status || '');
  const verzet = keten.ids.length > 1;
  if (s === 'scheduled') return verzet ? 'verplaatst' : 'gepland';
  if (s === 'wacht_op_reschedule' || s === 'verplaatst') return 'verplaatst';
  if (s === 'cancelled') return 'geannuleerd';
  if (s === 'no_show') return 'no-show';
  if (s === 'completed') return 'gehad';
  if (s === 'verwijderd') return 'verwijderd';
  return s || 'onbekend';
}

/** Label van een deal. PURE. */
export function dealLabel(d) {
  const st = String(d?.tl_quotation_status || '');
  if (st === 'accepted') return 'Sale';
  if (st === 'declined') return 'Offerte afgewezen';
  return 'Offerte';
}

/** Beste deal bij een boeking: na de boeking, niet gearchiveerd; Sale eerst, dan de nieuwste. PURE. */
export function dealVoorBoeking(keten, { deals = [], klanten = [], submissions = [] } = {}) {
  const sinds = String(keten.root.created_at || '');
  const leadIds = new Set(submissions.filter((s) => keten.ids.includes(s.appointment_id) && s.lead_id).map((s) => s.lead_id));
  const e = normEmail(keten.root.lead_email || keten.laatste.lead_email);
  const klantIds = new Set(klanten.filter((k) => e && normEmail(k.email) === e).map((k) => k.id));
  const kandidaten = deals.filter((d) => !d.archived_at
    && String(d.created_at || '') >= sinds
    && ((d.source_lead_id && leadIds.has(d.source_lead_id)) || (d.customer_id && klantIds.has(d.customer_id))));
  kandidaten.sort((x, y) => (dealLabel(y) === 'Sale') - (dealLabel(x) === 'Sale') || String(y.created_at).localeCompare(String(x.created_at)));
  return kandidaten[0] || null;
}

/**
 * Alle webinar-boekingen verdeeld over de sessies. PURE.
 * @returns {{ perSessie: Record<string, object[]>, voorEerste: object[], totaal: number }}
 */
export function verdeelBoekingen({ afspraken = [], sessies = [], deals = [], klanten = [], submissions = [] } = {}) {
  const perSessie = Object.fromEntries(sessies.map((s) => [s.id, []]));
  const voorEerste = [];
  const ketens = bouwKetens(afspraken.filter((a) => String(a.booking_source || '') === 'webinar'));
  for (const k of ketens) {
    const geboektDag = brusselsDag(k.root.created_at);
    const deal = dealVoorBoeking(k, { deals, klanten, submissions });
    const rij = {
      id: k.root.id,
      afspraak_id: k.laatste.id,
      naam: k.laatste.lead_name || k.root.lead_name || null,
      email: k.laatste.lead_email || k.root.lead_email || null,
      telefoon: k.laatste.lead_phone || k.root.lead_phone || null,
      geboekt_op: k.root.created_at,
      geboekt_dag: geboektDag,
      call_op: k.laatste.scheduled_at,
      eerst_gepland_op: k.root.scheduled_at || null,
      status: boekingStatus(k),
      verzet: k.ids.length > 1,
      is_test: !!(k.root.is_test || k.laatste.is_test),
      uitkomst: k.laatste.uitkomst || null,
      deal: deal ? { id: deal.id, label: dealLabel(deal), referentie: deal.quote_reference || null } : null,
      sale_uitkomst: !deal && String(k.laatste.uitkomst || '') === 'sale',
    };
    const s = geboektDag ? sessieVoorDag(geboektDag, sessies) : null;
    if (s) perSessie[s.id].push(rij); else voorEerste.push(rij);
  }
  const nieuwsteEerst = (a, b) => String(b.geboekt_op).localeCompare(String(a.geboekt_op));
  for (const id of Object.keys(perSessie)) perSessie[id].sort(nieuwsteEerst);
  voorEerste.sort(nieuwsteEerst);
  return { perSessie, voorEerste, totaal: ketens.length };
}

/** Samenvatting voor de tabel: totaal = in de getoonde weken + eerdere weken + vóór het eerste webinar. PURE. */
export function samenvatting(verdeling, getoondeIds = []) {
  const getoond = new Set(getoondeIds);
  let inTabel = 0; let eerder = 0;
  for (const [id, rijen] of Object.entries(verdeling.perSessie)) {
    if (getoond.has(id)) inTabel += rijen.length; else eerder += rijen.length;
  }
  return { totaal: verdeling.totaal, in_tabel: inTabel, andere_weken: eerder, voor_eerste: verdeling.voorEerste.length };
}

/** Alles laden (lezend) en verdelen. */
export async function laadBoekingen(sb, reeksId) {
  const lees = async (q, wat) => { const { data, error } = await q; if (error) throw new Error(wat + ': ' + error.message); return data || []; };
  const [sessies, afspraken] = await Promise.all([
    lees(sb.from('webinar_sessies').select('id, datum, starts_at, status').eq('reeks_id', reeksId).order('starts_at', { ascending: true }).limit(2000), 'sessies'),
    lees(sb.from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, status, booking_source, created_at, scheduled_at, parent_appointment_id, is_test, uitkomst')
      .eq('booking_source', 'webinar').order('created_at', { ascending: true }).limit(20000), 'webinar-boekingen'),
  ]);
  const ids = afspraken.map((a) => a.id);
  // Ruwe én kleine letters: customers.email is niet overal genormaliseerd.
  const emails = [...new Set(afspraken.flatMap((a) => [String(a.lead_email || '').trim(), normEmail(a.lead_email)]).filter(Boolean))];
  // Lead-koppeling en klanten: fail-soft (de telling hangt er niet van af).
  const zacht = async (q, wat) => { const { data, error } = await q; if (error) { console.warn('[webinar-boekingen] ' + wat + ' (fail-soft):', error.message); return []; } return data || []; };
  const [submissions, klanten] = await Promise.all([
    ids.length ? zacht(sb.from('opstartsessie_submissions').select('lead_id, appointment_id').in('appointment_id', ids).not('lead_id', 'is', null).limit(20000), 'submissies') : [],
    emails.length ? zacht(sb.from('customers').select('id, email').in('email', emails).limit(5000), 'klanten') : [],
  ]);
  const leadIds = [...new Set(submissions.map((s) => s.lead_id))];
  const klantIds = [...new Set(klanten.map((k) => k.id))];
  const dealCols = 'id, customer_id, source_lead_id, tl_quotation_status, quote_reference, archived_at, created_at';
  const [dealsLead, dealsKlant] = await Promise.all([
    leadIds.length ? zacht(sb.from('deals').select(dealCols).in('source_lead_id', leadIds).limit(5000), 'deals (lead)') : [],
    klantIds.length ? zacht(sb.from('deals').select(dealCols).in('customer_id', klantIds).limit(5000), 'deals (klant)') : [],
  ]);
  const deals = [...new Map([...dealsLead, ...dealsKlant].map((d) => [d.id, d])).values()];
  return { sessies, verdeling: verdeelBoekingen({ afspraken, sessies, deals, klanten, submissions }) };
}
