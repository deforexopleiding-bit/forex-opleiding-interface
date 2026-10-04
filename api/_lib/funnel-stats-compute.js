// api/_lib/funnel-stats-compute.js
//
// Pure aggregatie voor het funnel-dashboard (Leadsonderhoud → Funnels).
// Geen DB, geen IO: de endpoint (api/funnel-stats.js) leest de rijen en geeft
// ze hier door. Daardoor volledig unit-testbaar.
//
// Bron: public.funnel_events (first-party tracking vanaf dfo-website). Contract:
//   session_id uuid, variant text, event_type text, stap_nr smallint|null,
//   vraag_id text|null, quiz_versie text|null, ts timestamptz, lead_id uuid|null.
//
// ── Fase-telling: BEREIK, niet strikt-sequentieel ─────────────────────────
// Een sessie telt voor een fase als die sessie dat event in de periode heeft,
// ongeacht of de eerdere fases ook gelogd zijn. Redenen:
//   * het landing-event kan wegvallen (adblocker die pas later laadt, pagina
//     vanuit cache, sessie begon vóór de periode-grens);
//   * een bezoeker kan halverwege terugkomen in een nieuwe tab (nieuwe sessie
//     die direct bij formulier_start begint).
// Strikt tellen zou die echte conversies stilletjes weggooien. Gevolg: een
// conversie_vorige boven 100% is mogelijk en betekent "meer sessies bereikten
// deze fase dan er in de vorige gelogd werden" — een signaal over de tracking,
// geen rekenfout.
//
// ── Afhaken per vraag ───────────────────────────────────────────────────────
// Per quiz_versie apart (versies NOOIT mengen: vraag 3 in v1 is niet vraag 3
// in v2). Voor stap n: gezien = sessies met vraag_getoond stap n (deze versie);
// door = daarvan de sessies die stap n+1 (zelfde versie) zagen óf een lead
// indienden; afgehaakt = gezien − door.

import { nlDateString } from './nl-period.js';

export const FUNNEL_VARIANTEN = Object.freeze([
  'kennismakingscursus-v1',
  'kennismakingscursus-v2',
  'kennismakingscursus-v3',
  'kennismakingscursus-v4',
  '7-daagse-v1',
  '7-daagse-v2',
]);

export const VARIANT_INFO = Object.freeze({
  'kennismakingscursus-v1': { label: 'Mini-cursus (v1)', groep: 'kmc' },
  'kennismakingscursus-v2': { label: 'Mini-cursus (v2)', groep: 'kmc' },
  'kennismakingscursus-v3': { label: 'Mini-cursus (v3)', groep: 'kmc' },
  'kennismakingscursus-v4': { label: 'Mini-cursus (v4)', groep: 'kmc' },
  '7-daagse-v1':            { label: '7-daagse (v1)',    groep: '7-daagse' },
  '7-daagse-v2':            { label: '7-daagse (v2)',    groep: '7-daagse' },
});

// Vaste fase-volgorde. `match` bepaalt welk event de fase vult.
export const FUNNEL_FASES = Object.freeze([
  { fase: 'landing',         label: 'Landing',              match: (e) => e.event_type === 'landing' },
  { fase: 'formulier_start', label: 'Formulier gestart',    match: (e) => e.event_type === 'formulier_start' },
  { fase: 'gegevens_ok',     label: 'Gegevens ingevuld',    match: (e) => e.event_type === 'gegevens_ok' },
  { fase: 'quiz_gestart',    label: 'Quiz gestart',         match: (e) => e.event_type === 'vraag_getoond' && Number(e.stap_nr) === 1 },
  { fase: 'lead_ingediend',  label: 'Lead ingediend',       match: (e) => e.event_type === 'lead_ingediend' },
  { fase: 'toegang',         label: 'Toegang',              match: (e) => e.event_type === 'toegang' },
  { fase: 'slot_gekozen',    label: 'Tijdslot gekozen',     match: (e) => e.event_type === 'slot_gekozen' },
  { fase: 'geboekt',         label: 'Geboekt',              match: (e) => e.event_type === 'geboekt' },
]);

// Alle event-types uit het contract. Alleen deze worden meegeteld; de rest
// (typo's, toekomstige types) wordt genegeerd.
export const BEKENDE_EVENT_TYPES = Object.freeze([
  'landing', 'cta_klik', 'formulier_start', 'gegevens_ok', 'vraag_getoond',
  'vraag_beantwoord', 'terug', 'modal_dicht', 'lead_ingediend', 'toegang',
  'geen_toegang', 'video_gestart', 'drie_ja', 'slot_gekozen', 'akkoord',
  'geboekt', 'overgeslagen',
]);

// De event-types die de endpoint daadwerkelijk ophaalt (de rest is voor deze
// aggregatie niet nodig — scheelt rijen en dus tijd).
export const BENODIGDE_EVENT_TYPES = Object.freeze([
  'landing', 'formulier_start', 'gegevens_ok', 'vraag_getoond',
  'lead_ingediend', 'toegang', 'slot_gekozen', 'geboekt',
]);

const VARIANT_SET = new Set(FUNNEL_VARIANTEN);
const EVENT_SET = new Set(BEKENDE_EVENT_TYPES);
const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];

export function isTestEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const s = e.toLowerCase();
  return TEST_EMAIL_MARKERS.some((m) => s.includes(m));
}

/** Percentage met 1 decimaal; null bij deler 0 (geen deling door nul). */
export function pct(teller, noemer) {
  if (!noemer) return null;
  return Math.round((teller / noemer) * 1000) / 10;
}

function tsMs(v) {
  if (v == null) return NaN;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

function inPeriode(v, startMs, eindMs) {
  const t = tsMs(v);
  if (!Number.isFinite(t)) return false;
  return t >= startMs && t < eindMs;
}

function leegResultaat(variant) {
  const info = VARIANT_INFO[variant] || { label: variant, groep: 'overig' };
  return { variant, label: info.label, groep: info.groep };
}

/** Bouwt de funnel-fases uit een Map<fase, Set<session_id>>. */
export function bouwFunnel(sessiesPerFase) {
  const out = [];
  let vorige = null;
  let landing = null;
  for (const f of FUNNEL_FASES) {
    const n = (sessiesPerFase.get(f.fase) || new Set()).size;
    if (landing === null) landing = n;
    out.push({
      fase: f.fase,
      label: f.label,
      sessions: n,
      conversie_vorige: vorige === null ? null : pct(n, vorige),
      conversie_landing: pct(n, landing),
    });
    vorige = n;
  }
  return out;
}

/**
 * Afhaken per vraag voor één variant. `events` zijn al gefilterd op variant
 * en periode. Retourneert per quiz_versie een blok.
 */
export function bouwAfhakenPerVraag(events) {
  // versie → stap → { sessies:Set, vraagIds: Map<id,count> }
  const perVersie = new Map();
  const leadSessies = new Set();
  for (const e of events) {
    if (e.event_type === 'lead_ingediend' && e.session_id) leadSessies.add(e.session_id);
    if (e.event_type !== 'vraag_getoond' || !e.session_id) continue;
    const stap = Number(e.stap_nr);
    if (!Number.isInteger(stap) || stap < 1) continue;
    const versie = e.quiz_versie == null || e.quiz_versie === '' ? 'onbekend' : String(e.quiz_versie);
    if (!perVersie.has(versie)) perVersie.set(versie, new Map());
    const stappen = perVersie.get(versie);
    if (!stappen.has(stap)) stappen.set(stap, { sessies: new Set(), vraagIds: new Map() });
    const s = stappen.get(stap);
    s.sessies.add(e.session_id);
    if (e.vraag_id) s.vraagIds.set(String(e.vraag_id), (s.vraagIds.get(String(e.vraag_id)) || 0) + 1);
  }

  const blokken = [];
  const versies = [...perVersie.keys()].sort((a, b) => a.localeCompare(b, 'nl', { numeric: true }));
  for (const versie of versies) {
    const stappen = perVersie.get(versie);
    const nummers = [...stappen.keys()].sort((a, b) => a - b);
    const vragen = nummers.map((n) => {
      const s = stappen.get(n);
      const volgende = stappen.get(n + 1);
      let door = 0;
      for (const sid of s.sessies) {
        if ((volgende && volgende.sessies.has(sid)) || leadSessies.has(sid)) door += 1;
      }
      const gezien = s.sessies.size;
      const afgehaakt = gezien - door;
      let vraagId = null, max = 0;
      for (const [id, c] of s.vraagIds) if (c > max) { max = c; vraagId = id; }
      return { stap_nr: n, vraag_id: vraagId, gezien, door, afgehaakt, afhaak_pct: pct(afgehaakt, gezien) };
    });
    const gestart = stappen.get(1) ? stappen.get(1).sessies : new Set();
    let voltooid = 0;
    for (const sid of gestart) if (leadSessies.has(sid)) voltooid += 1;
    blokken.push({
      quiz_versie: versie,
      sessies_gestart: gestart.size,
      voltooid,
      voltooid_pct: pct(voltooid, gestart.size),
      vragen,
    });
  }
  return blokken;
}

/**
 * Hoofd-aggregatie.
 *
 * @param {object} p
 * @param {Array}  p.events     funnel_events-rijen (session_id, variant, event_type, stap_nr, vraag_id, quiz_versie, ts, lead_id)
 * @param {Array}  p.leads      leads-rijen (id, bron, kwalificatie, email, aangemaakt, afspraak_op)
 * @param {Array}  p.boekingen  opstartsessie_submissions-rijen (booking_source, appointment_id, lead_id, created_at)
 * @param {Iterable} p.gekoppeldeLeadIds  lead-ids die in funnel_events voorkomen (dekking)
 * @param {string[]} p.varianten  gevraagde varianten (subset van FUNNEL_VARIANTEN)
 * @param {Date}   p.start       UTC-moment = NL 00:00 van `van`
 * @param {Date}   p.eindExclusief UTC-moment = NL 00:00 van de dag na `tot`
 * @param {boolean} p.trackingActief  false → funnel/afhaken blijven leeg (null)
 */
export function aggregeerFunnelStats({
  events = [], leads = [], boekingen = [], gekoppeldeLeadIds = [],
  varianten = FUNNEL_VARIANTEN, start, eindExclusief, trackingActief = true,
} = {}) {
  const startMs = start instanceof Date ? start.getTime() : tsMs(start);
  const eindMs = eindExclusief instanceof Date ? eindExclusief.getTime() : tsMs(eindExclusief);
  const gevraagd = (varianten || []).filter((v) => VARIANT_SET.has(v));
  const gekoppeld = new Set(gekoppeldeLeadIds || []);

  // Events: alleen bekende variant + bekend type + binnen de NL-periode.
  const eventsPerVariant = new Map(gevraagd.map((v) => [v, []]));
  let genegeerd = 0;
  for (const e of events || []) {
    if (!e || !eventsPerVariant.has(e.variant) || !EVENT_SET.has(e.event_type) || !e.session_id) { genegeerd += 1; continue; }
    if (!inPeriode(e.ts, startMs, eindMs)) { genegeerd += 1; continue; }
    eventsPerVariant.get(e.variant).push(e);
  }

  const perVariant = {};
  for (const variant of gevraagd) {
    const r = leegResultaat(variant);
    const evs = eventsPerVariant.get(variant);

    if (trackingActief) {
      const sessiesPerFase = new Map();
      const alleSessies = new Set();
      for (const e of evs) {
        alleSessies.add(e.session_id);
        for (const f of FUNNEL_FASES) {
          if (!f.match(e)) continue;
          if (!sessiesPerFase.has(f.fase)) sessiesPerFase.set(f.fase, new Set());
          sessiesPerFase.get(f.fase).add(e.session_id);
        }
      }
      r.sessies_totaal = alleSessies.size;
      r.funnel = bouwFunnel(sessiesPerFase);
      r.afhaken_per_vraag = bouwAfhakenPerVraag(evs);
    } else {
      r.sessies_totaal = null;
      r.funnel = null;
      r.afhaken_per_vraag = null;
    }

    // Lead-resultaat: leads met bron = variant, aangemaakt in de NL-periode.
    const vLeads = (leads || []).filter((l) => l && l.bron === variant && !isTestEmail(l.email)
      && inPeriode(l.aangemaakt, startMs, eindMs));
    let toegang = 0, geenToegang = 0, onbekend = 0, metAfspraak = 0, metSessie = 0;
    for (const l of vLeads) {
      const k = String(l.kwalificatie || '').trim().toLowerCase();
      if (k === 'toegang') toegang += 1;
      else if (k === 'geen toegang' || k === 'geen_toegang') geenToegang += 1;
      else onbekend += 1;
      if (l.afspraak_op) metAfspraak += 1;
      if (l.id && gekoppeld.has(l.id)) metSessie += 1;
    }
    const vBoek = (boekingen || []).filter((b) => b && b.booking_source === variant && b.appointment_id
      && inPeriode(b.created_at, startMs, eindMs));
    r.lead_resultaat = {
      leads: vLeads.length,
      toegang,
      geen_toegang: geenToegang,
      kwalificatie_onbekend: onbekend,
      toegang_pct: pct(toegang, vLeads.length),
      geboekt: vBoek.length,
      leads_met_afspraak: metAfspraak,
      leads_met_sessie: trackingActief ? metSessie : null,
      dekking_pct: trackingActief ? pct(metSessie, vLeads.length) : null,
    };
    perVariant[variant] = r;
  }

  return { per_variant: perVariant, events_genegeerd: genegeerd };
}

/** Blinde vlekken als leesbare NL-zinnen voor de UI. */
export function bepaalBlindeVlekken({ tabelBestaat, eersteEventTs, start, afgekapt, maxEvents, leesfout }) {
  const out = [];
  if (!tabelBestaat) {
    out.push('Tracking nog niet actief (migratie funnel_events niet gedraaid) — funnel en afhaken zijn leeg; de lead-resultaten komen uit de leads-tabel.');
    return out;
  }
  if (leesfout) {
    out.push('funnel_events kon niet (volledig) gelezen worden: ' + leesfout);
    if (!eersteEventTs) return out;
  }
  if (!eersteEventTs) {
    out.push('Tabel funnel_events bestaat, maar er zijn nog geen events binnengekomen.');
    return out;
  }
  const eersteMs = tsMs(eersteEventTs);
  const startMs = start instanceof Date ? start.getTime() : tsMs(start);
  if (Number.isFinite(eersteMs) && Number.isFinite(startMs) && eersteMs > startMs) {
    out.push(`Tracking pas actief vanaf ${nlDateString(new Date(eersteMs))}— leads vóór die datum hebben geen sessie.`);
  }
  if (afgekapt) out.push(`Meer events dan het maximum (${maxEvents}) of de tijdslimiet in deze periode — telling is afgekapt; kies een kortere periode.`);
  out.push('Bezoekers die tracking blokkeren (adblocker, geen JavaScript) ontbreken; hun leads hebben geen gekoppelde sessie.');
  return out;
}
