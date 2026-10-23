// api/_lib/trainingdrops-compute.js
//
// Pure aggregatie voor de module Trainingdrops (wekelijkse training-funnel,
// variant/bron 'training-<dd-mm-jj>'). Geen DB, geen IO: api/trainingdrops.js
// leest de rijen en geeft ze hier door.
//
// Per drop:
//   bezoekers        = unieke sessies met 'landing'            (funnel_events)
//   formulier_gestart= unieke sessies met 'formulier_start'
//   gegevens_ok      = unieke sessies met 'gegevens_ok'
//   lead_ingediend   = unieke sessies met 'lead_ingediend'
//   leads            = unieke leads van deze drop: bron = variant, PLUS leads die
//                      via funnel_events.lead_id aan een sessie van deze variant
//                      hangen. Dat tweede is nodig omdat upsert_lead de bron
//                      overschrijft: wie volgende week weer kijkt, heeft dan de
//                      bron van die week, maar zijn sessie van deze week blijft.
//   conversie_pct    = leads ÷ bezoekers
//
// Fase-telling is BEREIK (zoals funnel-stats-compute): een sessie telt voor een
// fase als dat event er is, ook als eerdere events ontbreken.
//
// Testleads (e-mail met 'test' of 'deforexopleiding', isTestEmail) tellen niet
// mee in de cijfers en hun sessies ook niet; ze staan wel in de leadlijst,
// gemarkeerd, zodat je een testaanmelding kunt terugvinden.
//
// Cadeau (dfo-website #132): de gratis strategiesessie met Dave.
//   cadeau_getoond / cadeau_klik = unieke sessies met dat funnel-event;
//   calls = follow_up_appointments met booking_source = variant, per lead één
//   call (de laatste geldige; een verzette afspraak telt als dezelfde call).
//   Lead ↔ call via opstartsessie_submissions.appointment_id → lead_id (ook via
//   de verzet-keten parent_appointment_id), anders op lead_email. Status:
//   completed = gehouden, no_show = no-show, cancelled = geannuleerd, de rest
//   (scheduled / in_progress / wacht_op_reschedule / verplaatst) = gepland.
//   'verwijderd' en testafspraken (is_test of test-e-mail) tellen niet.
//   lead_call_pct = leads met een call ÷ leads.
//
// Kanaal van de landing-sessie: funnel_events.meta.src (?src=… op de link,
// door dfo-website meegestuurd), anders meta.utm_source, anders 'direct'.
// Onbekende waarden blijven zoals ze zijn (label = de waarde zelf).

import { isTestEmail } from './funnel-stats-compute.js';
import { isTrainingBron, trainingSlug, trainingLabel, trainingDatum, trainingLinks } from './training-bron.js';

/** De kanalen uit de bouwopdracht, in vaste volgorde. Andere waarden komen erachter. */
export const KANALEN = Object.freeze(['ig-story', 'ig-bio', 'nieuwsbrief', 'whatsapp', 'meta-ad', 'direct']);
export const KANAAL_LABELS = Object.freeze({
  'ig-story': 'Instagram story',
  'ig-bio': 'Instagram bio',
  nieuwsbrief: 'Nieuwsbrief',
  whatsapp: 'WhatsApp',
  'meta-ad': 'Meta-advertentie',
  direct: 'Direct',
  onbekend: 'Onbekend (geen sessie)',
});
export const KANAAL_UITLEG = 'Kanaal = src van de link (?src=…), anders utm_source, anders Direct.';

export const FASE_TYPES = Object.freeze(['landing', 'formulier_start', 'gegevens_ok', 'lead_ingediend', 'cadeau_getoond', 'cadeau_klik']);

/** Afspraakstatus → wat de drop telt. */
export const CALL_LABELS = Object.freeze({ gepland: 'Gepland', gehouden: 'Gehouden', no_show: 'No-show', geannuleerd: 'Geannuleerd' });
export function callCategorie(status) {
  const st = String(status || '').trim().toLowerCase();
  if (st === 'completed') return 'gehouden';
  if (st === 'no_show') return 'no_show';
  if (st === 'cancelled') return 'geannuleerd';
  if (st === 'verwijderd') return null;
  return 'gepland';
}

const MAX_KANAAL = 100;

/** meta.src → meta.utm_source → 'direct'. Bekende kanalen ongeacht hoofdletters; de rest zoals hij is. */
export function bepaalKanaal(src, utmSource) {
  for (const x of [src, utmSource]) {
    const w = typeof x === 'string' ? x.trim().slice(0, MAX_KANAAL) : '';
    if (!w) continue;
    const laag = w.toLowerCase();
    return KANAAL_LABELS[laag] ? laag : w;
  }
  return 'direct';
}

export function kanaalLabel(k) {
  return KANAAL_LABELS[k] || k;
}

function pct(teller, noemer) {
  if (!noemer) return null;
  return Math.round((teller / noemer) * 1000) / 10;
}

function tsMs(v) {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : NaN;
}

/** Kanaal-telling { sleutel: n } → [{ kanaal, label, n }] in vaste volgorde, nullen voor de vaste kanalen. */
export function kanaalLijst(teller) {
  const extra = Object.keys(teller).filter((k) => !KANALEN.includes(k)).sort();
  return [...KANALEN, ...extra].map((k) => ({ kanaal: k, label: kanaalLabel(k), n: teller[k] || 0 }));
}

function naamVan(l) {
  const n = [l.voornaam, l.achternaam].filter((x) => x && String(x).trim()).join(' ').trim();
  return n || null;
}

/**
 * @param {object} p
 * @param {Array} p.leads   leads-rijen (id, voornaam, achternaam, email, telefoon, bron, campagne, status,
 *                          kwalificatie, aangemaakt, laatste_aanmelding) — bron training-* én de leads
 *                          die via funnel_events.lead_id aan een training-sessie hangen
 * @param {Array} p.events  funnel_events-rijen (session_id, variant, event_type, ts, lead_id, src, utm)
 *                          — src = meta->>src, utm = meta->>utm_source
 * @returns {{ drops: Array, totaal: object }}
 */
export function bouwTrainingdrops({ leads = [], events = [], afspraken = [], koppelingen = [] } = {}) {
  const leadById = new Map();
  for (const l of leads || []) if (l && l.id) leadById.set(l.id, l);
  const isTestLead = (id) => {
    const l = id ? leadById.get(id) : null;
    return !!(l && isTestEmail(l.email));
  };

  // Varianten = alles wat als training herkend wordt, uit leads, events en afspraken.
  const varianten = new Set();
  for (const l of leadById.values()) if (isTrainingBron(l.bron)) varianten.add(l.bron);
  for (const e of events || []) if (e && isTrainingBron(e.variant)) varianten.add(e.variant);
  const callsPerVariant = bouwCalls({ afspraken, koppelingen, leadById });
  for (const variant of callsPerVariant.keys()) varianten.add(variant);

  // Per variant: sessies (met kanaal, lead, eerste ts) en lead-koppelingen.
  const perVariant = new Map();
  const v = (variant) => {
    if (!perVariant.has(variant)) perVariant.set(variant, { sessies: new Map(), leadTs: new Map() });
    return perVariant.get(variant);
  };
  for (const e of events || []) {
    if (!e || !isTrainingBron(e.variant) || !e.session_id || !FASE_TYPES.includes(e.event_type)) continue;
    const pv = v(e.variant);
    let s = pv.sessies.get(e.session_id);
    if (!s) { s = { fases: new Set(), kanaal: null, leadId: null, landingMs: NaN }; pv.sessies.set(e.session_id, s); }
    s.fases.add(e.event_type);
    if (e.lead_id) s.leadId = e.lead_id;
    // Kanaal: van het (eerste) landing-event; anders van het eerste event met src/utm.
    const ms = tsMs(e.ts);
    if (e.event_type === 'landing' && (!Number.isFinite(s.landingMs) || ms < s.landingMs)) {
      s.landingMs = ms;
      s.kanaal = bepaalKanaal(e.src, e.utm);
    } else if (!s.kanaal && (e.src || e.utm)) {
      s.kanaal = bepaalKanaal(e.src, e.utm);
    }
    // Aanmeldmoment per lead: het lead_ingediend-event, anders het eerste event met die lead.
    if (e.lead_id) {
      const oud = pv.leadTs.get(e.lead_id);
      const ingediend = e.event_type === 'lead_ingediend';
      if (!oud || (ingediend && !oud.ingediend)) pv.leadTs.set(e.lead_id, { ts: e.ts || null, ingediend });
    }
  }

  const drops = [];
  for (const variant of varianten) {
    const pv = perVariant.get(variant) || { sessies: new Map(), leadTs: new Map() };
    const fases = { landing: 0, formulier_start: 0, gegevens_ok: 0, lead_ingediend: 0, cadeau_getoond: 0, cadeau_klik: 0 };
    const bezoekersPerKanaal = {};
    const kliksPerKanaal = {};
    let testSessies = 0;
    const kanaalPerLead = new Map();
    for (const s of pv.sessies.values()) {
      // Meerdere sessies van één lead: een echt kanaal wint van 'direct'.
      if (s.leadId) {
        const k = s.kanaal || 'direct';
        const oud = kanaalPerLead.get(s.leadId);
        if (!oud || (oud === 'direct' && k !== 'direct')) kanaalPerLead.set(s.leadId, k);
      }
      if (isTestLead(s.leadId)) { testSessies += 1; continue; }
      for (const f of s.fases) fases[f] += 1;
      const k = s.kanaal || 'direct';
      if (s.fases.has('landing')) bezoekersPerKanaal[k] = (bezoekersPerKanaal[k] || 0) + 1;
      if (s.fases.has('cadeau_klik')) kliksPerKanaal[k] = (kliksPerKanaal[k] || 0) + 1;
    }

    // Leads van deze drop: bron = variant ∪ gekoppeld via een sessie ∪ een call uit deze drop.
    const calls = callsPerVariant.get(variant) || new Map();
    const ids = new Set();
    for (const l of leadById.values()) if (l.bron === variant) ids.add(l.id);
    for (const id of pv.leadTs.keys()) if (leadById.has(id)) ids.add(id);
    for (const c of calls.values()) if (c.leadId && leadById.has(c.leadId)) ids.add(c.leadId);

    const lijst = [];
    const leadsPerKanaal = {};
    const callsPerKanaal = {};
    const callTelling = { gepland: 0, gehouden: 0, no_show: 0, geannuleerd: 0 };
    let testLeads = 0;
    let leadsMetCall = 0;
    const telCall = (c, kanaal, vanLead) => {
      callTelling[c.categorie] += 1;
      const t = callsPerKanaal[kanaal] || (callsPerKanaal[kanaal] = { calls: 0, leads_met_call: 0, gepland: 0, gehouden: 0, no_show: 0, geannuleerd: 0 });
      t.calls += 1;
      t[c.categorie] += 1;
      if (vanLead) t.leads_met_call += 1;
    };
    for (const id of ids) {
      const l = leadById.get(id);
      const test = isTestEmail(l.email);
      const kanaal = kanaalPerLead.get(id) || 'onbekend';
      const call = calls.get('lead:' + id) || null;
      const viaSessie = pv.leadTs.get(id);
      const aangemeld = (viaSessie && viaSessie.ts) || l.laatste_aanmelding || l.aangemaakt || null;
      lijst.push({
        id,
        naam: naamVan(l),
        email: l.email || null,
        telefoon: l.telefoon || null,
        status: l.status || null,
        campagne: l.campagne || null,
        huidige_bron: l.bron || null,
        bron_elders: l.bron !== variant,
        kanaal,
        kanaal_label: kanaalLabel(kanaal),
        aangemeld_op: aangemeld,
        lead_aangemaakt: l.aangemaakt || null,
        call: call ? { scheduled_at: call.scheduled_at, status: call.status, categorie: call.categorie, label: CALL_LABELS[call.categorie] } : null,
        test,
      });
      if (test) { testLeads += 1; continue; }
      leadsPerKanaal[kanaal] = (leadsPerKanaal[kanaal] || 0) + 1;
      if (call) { leadsMetCall += 1; telCall(call, kanaal, true); }
    }
    // Calls waarvan de lead niet te vinden is (geen koppeling, onbekend adres): wel tellen, kanaal onbekend.
    for (const [sleutel, c] of calls) {
      if (sleutel.startsWith('lead:') && leadById.has(c.leadId)) continue;
      telCall(c, 'onbekend', false);
    }
    lijst.sort((a, b) => (tsMs(b.aangemeld_op) || 0) - (tsMs(a.aangemeld_op) || 0));

    const nLeads = lijst.length - testLeads;
    const nCalls = callTelling.gepland + callTelling.gehouden + callTelling.no_show + callTelling.geannuleerd;
    const kanaalKeys = new Set([...KANALEN, ...Object.keys(leadsPerKanaal), ...Object.keys(bezoekersPerKanaal), ...Object.keys(kliksPerKanaal), ...Object.keys(callsPerKanaal)]);
    const kanalen = kanaalLijst(Object.fromEntries([...kanaalKeys].map((k) => [k, 0]))).map(({ kanaal, label }) => {
      const c = callsPerKanaal[kanaal] || {};
      return {
        kanaal, label,
        bezoekers: bezoekersPerKanaal[kanaal] || 0,
        leads: leadsPerKanaal[kanaal] || 0,
        cadeau_klik: kliksPerKanaal[kanaal] || 0,
        calls: c.calls || 0,
        gepland: c.gepland || 0, gehouden: c.gehouden || 0, no_show: c.no_show || 0, geannuleerd: c.geannuleerd || 0,
        lead_call_pct: pct(c.leads_met_call || 0, leadsPerKanaal[kanaal] || 0),
      };
    });
    drops.push({
      variant,
      slug: trainingSlug(variant),
      label: trainingLabel(variant),
      datum: trainingDatum(variant),
      links: trainingLinks(variant),
      bezoekers: fases.landing,
      formulier_gestart: fases.formulier_start,
      gegevens_ok: fases.gegevens_ok,
      lead_ingediend: fases.lead_ingediend,
      leads: nLeads,
      conversie_pct: pct(nLeads, fases.landing),
      formulier_pct: pct(fases.formulier_start, fases.landing),
      cadeau_getoond: fases.cadeau_getoond,
      cadeau_klik: fases.cadeau_klik,
      calls: nCalls,
      calls_gepland: callTelling.gepland,
      calls_gehouden: callTelling.gehouden,
      calls_no_show: callTelling.no_show,
      calls_geannuleerd: callTelling.geannuleerd,
      leads_met_call: leadsMetCall,
      lead_call_pct: pct(leadsMetCall, nLeads),
      test_leads: testLeads,
      test_sessies: testSessies,
      kanalen,
      leads_per_kanaal: kanaalLijst(leadsPerKanaal),
      bezoekers_per_kanaal: kanaalLijst(bezoekersPerKanaal),
      lead_lijst: lijst,
    });
  }
  // Nieuwste bovenaan (datum uit de slug; bij gelijke datum op variant).
  drops.sort((a, b) => (b.datum || '').localeCompare(a.datum || '') || b.variant.localeCompare(a.variant));

  const som = (k) => drops.reduce((n, d) => n + (d[k] || 0), 0);
  const totaal = {
    drops: drops.length,
    bezoekers: som('bezoekers'),
    formulier_gestart: som('formulier_gestart'),
    leads: som('leads'),
    cadeau_klik: som('cadeau_klik'),
    calls: som('calls'),
    calls_gehouden: som('calls_gehouden'),
    leads_met_call: som('leads_met_call'),
  };
  totaal.conversie_pct = pct(totaal.leads, totaal.bezoekers);
  totaal.lead_call_pct = pct(totaal.leads_met_call, totaal.leads);
  return { drops, totaal };
}

/**
 * Calls per drop: Map<variant, Map<sleutel, call>>. Sleutel 'lead:<id>' als de
 * lead bekend is, anders 'mail:<adres>' of 'afspraak:<id>'. Per sleutel één call:
 * de laatst aangemaakte afspraak die niet 'verplaatst' is (een verzetting maakt
 * een nieuwe rij; de oude krijgt 'verplaatst'), anders de laatste.
 * Test en 'verwijderd' vallen weg.
 */
export function bouwCalls({ afspraken = [], koppelingen = [], leadById = new Map() } = {}) {
  const leadVoorAfspraak = new Map();
  for (const k of koppelingen || []) if (k && k.appointment_id && k.lead_id) leadVoorAfspraak.set(k.appointment_id, k.lead_id);
  const leadOpMail = new Map();
  for (const l of leadById.values()) if (l.email) leadOpMail.set(String(l.email).toLowerCase(), l.id);
  const afspraakById = new Map((afspraken || []).filter((a) => a && a.id).map((a) => [a.id, a]));
  const leadVan = (a) => {
    // Eigen koppeling, anders die van een voorganger in de verzet-keten (max 10 stappen).
    let cur = a;
    for (let i = 0; cur && i < 10; i += 1) {
      if (leadVoorAfspraak.has(cur.id)) return leadVoorAfspraak.get(cur.id);
      cur = cur.parent_appointment_id ? afspraakById.get(cur.parent_appointment_id) : null;
    }
    const mail = a.lead_email ? String(a.lead_email).toLowerCase() : '';
    return (mail && leadOpMail.get(mail)) || null;
  };

  const uit = new Map();
  for (const a of afspraken || []) {
    if (!a || !a.id || !isTrainingBron(a.booking_source)) continue;
    const categorie = callCategorie(a.status);
    if (!categorie || a.is_test === true || isTestEmail(a.lead_email)) continue;
    const leadId = leadVan(a);
    if (leadId && leadById.has(leadId) && isTestEmail(leadById.get(leadId).email)) continue;
    const sleutel = leadId ? 'lead:' + leadId
      : a.lead_email ? 'mail:' + String(a.lead_email).toLowerCase() : 'afspraak:' + a.id;
    if (!uit.has(a.booking_source)) uit.set(a.booking_source, new Map());
    const perDrop = uit.get(a.booking_source);
    const oud = perDrop.get(sleutel);
    const verplaatst = String(a.status || '').toLowerCase() === 'verplaatst';
    const beter = !oud
      || (oud.verplaatst && !verplaatst)
      || (oud.verplaatst === verplaatst && (tsMs(a.created_at) || 0) > (tsMs(oud.created_at) || 0));
    if (beter) {
      perDrop.set(sleutel, {
        id: a.id, leadId, scheduled_at: a.scheduled_at || null, status: a.status || null,
        categorie, created_at: a.created_at || null, verplaatst,
      });
    }
  }
  return uit;
}
