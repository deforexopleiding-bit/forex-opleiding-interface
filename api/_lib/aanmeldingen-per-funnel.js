// api/_lib/aanmeldingen-per-funnel.js
//
// "Leads per traject" telt sinds 2026-10-25 AANMELDINGEN PER FUNNEL, uit de
// bron zelf, i.p.v. nieuwe unieke leads op leads.traject. Gebruikt door het
// v2-dashboard (api/leads-per-traject-count.js) en het tv-bord
// (api/display-metrics.js) — één definitie, één venster voor tegels én kop.
//
// Waarom: de oude telling (leads-per-traject-compute.js) ziet alleen NIEUWE
// leads (upsert_lead ontdubbelt op e-mail), dus heraanmeldingen vielen weg, een
// event-aanmelding van een bestaande lead telde niet en afgewezen event-
// aanmelders bestonden niet. Audit: docs/diagnose/2026-10-25-leads-per-traject-audit.sql.
//
// ── Definitie per tegel ─────────────────────────────────────────────────────
//   7-daagse / Mini cursus — unieke aanmelders in het venster:
//       A. funnelmeting: sessies met 'lead ingediend' (funnel_events) van de
//          varianten van die funnel — ook heraanmeldingen;
//       B. nieuwe leads (aangemaakt in het venster) met dat traject — vangt
//          wie de meting miste (adblocker, geen toestemming).
//       Eén sleutel per persoon: de lead (als de sessie gekoppeld is), anders
//       de sessie. Daardoor kan een tegel nooit LAGER uitkomen dan de oude.
//       Afgewezen = lead.afwijzer, anders het 'geen_toegang'-event van de sessie.
//   Event-aanmeldingen — elke rij in event_attendees (geen test, niet
//       'verplaatst'), plus APART de afgewezen aanmelders uit de vragenlijst
//       (event_kwalificatie_submissions 'afgewezen', uniek op e-mail, zonder
//       toegelaten inzending of aanmelding in het venster).
//   Webinar — elke rij in webinar_aanmeldingen (geen test).
//   Overig — wat geen eigen tegel heeft: The Lab (lab_aanmeldingen + Lab-leads,
//       uniek op e-mail), Strategie-scan en Training (funnelmeting + nieuwe
//       leads, zoals hierboven), opstartsessie, en de rest van de nieuwe leads
//       (site-formulier, handmatig, …).
//   KOP = som van de tegels + Overig. Altijd, per constructie.
//
// Test-adressen ('test' / 'deforexopleiding' in het e-mailadres) tellen nergens.
// Alleen lezen. Fail-soft per bron: een leesfout zet die bron op 0 en komt in
// `bronfouten` (+ console.error), de rest blijft staan.

import { herkomstVanAanmelding } from './trial-product.js';

const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];
export function isTestEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const s = e.toLowerCase();
  return TEST_EMAIL_MARKERS.some((m) => s.includes(m));
}
const mail = (e) => String(e || '').trim().toLowerCase();
const laag = (t) => String(t || '').trim().toLowerCase();

const is7daagse = (t) => t.includes('7-daagse') || t.includes('7 daagse') || t.includes('7daagse');
const isMini = (t) => t.includes('mini') || t.includes('kennismakingscursus') || t.includes('strategiesessie');

/** Tegels met funnelmeting + nieuwe leads (A ∪ B). */
const FUNNEL_TEGELS = Object.freeze([
  { key: '7-daagse', variant: (v) => v.startsWith('7-daagse-'), traject: is7daagse },
  { key: 'mini', variant: (v) => v.startsWith('kennismakingscursus-') || v.startsWith('strategiesessie-'), traject: isMini },
]);
/** Overig-delen met funnelmeting + nieuwe leads. */
const FUNNEL_OVERIG = Object.freeze([
  { key: 'strategiescan', variant: (v) => v.startsWith('strategiescan-'), lead: (l) => laag(l.traject) === 'strategiescan' || laag(l.bron).startsWith('strategiescan-') },
  { key: 'training', variant: (v) => /^(training|drop)-\d{2}-\d{2}-\d{2}(-\d)?$/.test(v), lead: (l) => /^(training|drop)-\d{2}-\d{2}-\d{2}(-\d)?$/.test(laag(l.bron)) },
]);

export const TEGEL_LABELS = Object.freeze({
  '7-daagse': '7-daagse', mini: 'Mini cursus', event: 'Event-aanmeldingen', webinar: 'Webinar', overig: 'Overig',
});
export const OVERIG_LABELS = Object.freeze({
  'the-lab': 'The Lab', strategiescan: 'Strategie-scan', training: 'Training', opstartsessie: 'Opstartsessie', rest: 'Overige leads',
});

/** Sessies uit funnel_events → Map(session_id → { variant, lead_id, ingediend, toegang, geen }). */
function sessies(funnelEvents) {
  const per = new Map();
  for (const e of funnelEvents || []) {
    if (!e || !e.session_id || !e.variant) continue;
    let s = per.get(e.session_id);
    if (!s) { s = { variant: String(e.variant), lead_id: null, ingediend: false, toegang: false, geen: false }; per.set(e.session_id, s); }
    if (e.lead_id && !s.lead_id) s.lead_id = String(e.lead_id);
    if (e.event_type === 'lead_ingediend') s.ingediend = true;
    else if (e.event_type === 'toegang') s.toegang = true;
    else if (e.event_type === 'geen_toegang') s.geen = true;
  }
  return per;
}

/** A ∪ B → { totaal, toegelaten, afgewezen }. Sleutel = lead, anders sessie. */
function telUnie(sessieMap, variantFn, leads, leadFn) {
  const sleutels = new Map();   // sleutel → afgewezen (bool)
  for (const [sid, s] of sessieMap) {
    if (!s.ingediend || !variantFn(s.variant)) continue;
    const k = s.lead_id ? 'lead:' + s.lead_id : 'sessie:' + sid;
    const afg = s.geen && !s.toegang;
    sleutels.set(k, sleutels.has(k) ? (sleutels.get(k) && afg) : afg);
  }
  for (const l of leads) {
    if (!leadFn(l)) continue;
    sleutels.set('lead:' + l.id, l.afwijzer === true);   // de lead (server) wint
  }
  let afgewezen = 0;
  for (const a of sleutels.values()) if (a) afgewezen += 1;
  return { totaal: sleutels.size, toegelaten: sleutels.size - afgewezen, afgewezen };
}

/**
 * Pure telling. Alle rijen zijn al op het venster gefilterd door de lezer.
 * @param {object} p
 * @param {Array} p.funnelEvents       { session_id, variant, event_type, lead_id }
 * @param {Array} p.nieuweLeads        { id, email, bron, traject, afwijzer } — aangemaakt in het venster
 * @param {Array} p.eventAanmeldingen  { id, email, status, is_test }
 * @param {Array} p.eventInzendingen   { email, resultaat, attendee_id }
 * @param {Array} p.webinarAanmeldingen { id, email, is_test }
 * @param {Array} p.labAanmeldingen    { email }
 */
export function telAanmeldingen({
  funnelEvents = [], nieuweLeads = [], eventAanmeldingen = [], eventInzendingen = [],
  webinarAanmeldingen = [], labAanmeldingen = [],
} = {}) {
  // GHL-import (bron Import / Import-telefoon, 2026-10-26) is geen aanmelding.
  const leads = (nieuweLeads || []).filter((l) => l && l.id && !isTestEmail(l.email) && l.bron !== 'Import' && l.bron !== 'Import-telefoon');
  const sMap = sessies(funnelEvents);
  const tegels = {};

  for (const t of FUNNEL_TEGELS) {
    tegels[t.key] = telUnie(sMap, t.variant, leads, (l) => t.traject(laag(l.traject)));
  }

  // Event: aanmeldingen + apart de afgewezen aanmelders.
  const ev = (eventAanmeldingen || []).filter((a) => a && !a.is_test && a.status !== 'switched_to_other_event' && !isTestEmail(a.email));
  const evMails = new Set(ev.map((a) => mail(a.email)).filter(Boolean));
  const toegelatenMails = new Set();
  const afgewezenMails = new Set();
  for (const s of eventInzendingen || []) {
    const m = mail(s && s.email);
    if (!m || isTestEmail(m)) continue;
    if (laag(s.resultaat) === 'toegelaten') toegelatenMails.add(m);
    else if (laag(s.resultaat) === 'afgewezen') afgewezenMails.add(m);
  }
  let evAfgewezen = 0;
  for (const m of afgewezenMails) if (!toegelatenMails.has(m) && !evMails.has(m)) evAfgewezen += 1;
  tegels.event = { totaal: ev.length + evAfgewezen, toegelaten: ev.length, afgewezen: evAfgewezen };

  const web = (webinarAanmeldingen || []).filter((w) => w && !w.is_test && !isTestEmail(w.email));
  tegels.webinar = { totaal: web.length, toegelaten: web.length, afgewezen: 0 };

  // Overig.
  const delen = {};
  const lab = new Set();
  for (const r of labAanmeldingen || []) {
    if (herkomstVanAanmelding(r).product !== 'the-lab') continue; // trial van een andere belofte
    const m = mail(r && r.email); if (m && !isTestEmail(m)) lab.add(m);
  }
  for (const l of leads) if (laag(l.traject) === 'the-lab') { const m = mail(l.email); if (m) lab.add(m); else lab.add('lead:' + l.id); }
  delen['the-lab'] = lab.size;
  for (const o of FUNNEL_OVERIG) delen[o.key] = telUnie(sMap, o.variant, leads, o.lead).totaal;

  // De rest van de nieuwe leads: niet in een tegel of een ander Overig-deel.
  let opstart = 0, rest = 0;
  for (const l of leads) {
    const t = laag(l.traject);
    if (FUNNEL_TEGELS.some((x) => x.traject(t))) continue;           // 7-daagse / mini
    if (t.includes('event') || t.includes('webinar')) continue;      // telt via event_attendees / webinar_aanmeldingen
    if (t === 'the-lab' || FUNNEL_OVERIG.some((o) => o.lead(l))) continue;
    if (t === 'opstartsessie' || laag(l.bron) === 'opstartsessie') opstart += 1;
    else rest += 1;
  }
  delen.opstartsessie = opstart;
  delen.rest = rest;
  const overigTotaal = Object.values(delen).reduce((a, b) => a + b, 0);
  tegels.overig = { totaal: overigTotaal, toegelaten: overigTotaal, afgewezen: 0, delen };

  const totaal = Object.values(tegels).reduce((a, t) => a + t.totaal, 0);
  return { totaal, tegels };
}

// ── Lezen ──────────────────────────────────────────────────────────────────

const PAGINA = 1000;
const MAX_PAGINAS = 50;

async function leesAlles(maakQuery, label, fouten) {
  const uit = [];
  for (let p = 0; p < MAX_PAGINAS; p += 1) {
    try {
      const { data, error } = await maakQuery().range(p * PAGINA, p * PAGINA + PAGINA - 1);
      if (error) {
        console.error('[aanmeldingen-per-funnel] ' + label + ':', error.message);
        fouten.push(label);
        return uit;
      }
      uit.push(...(data || []));
      if (!data || data.length < PAGINA) return uit;
    } catch (e) {
      console.error('[aanmeldingen-per-funnel] ' + label + ' exception:', e?.message || e);
      fouten.push(label);
      return uit;
    }
  }
  console.warn('[aanmeldingen-per-funnel] ' + label + ': afgekapt op ' + PAGINA * MAX_PAGINAS + ' rijen');
  return uit;
}

/**
 * Leest alle bronnen voor het venster en telt.
 * @param {object} o
 * @param {object} o.supabaseAdmin
 * @param {{start:Date, endExclusive:Date}|null} o.range  null = alles
 */
export async function computeAanmeldingenPerFunnel({ supabaseAdmin, range = null }) {
  const van = range ? range.start.toISOString() : null;
  const tot = range ? range.endExclusive.toISOString() : null;
  const venster = (q, kol) => (range ? q.gte(kol, van).lt(kol, tot) : q);
  const fouten = [];

  const [funnelEvents, nieuweLeads, eventAanmeldingen, eventInzendingen, webinarAanmeldingen, labAanmeldingen] = await Promise.all([
    leesAlles(() => venster(supabaseAdmin.from('funnel_events').select('session_id,variant,event_type,lead_id')
      .in('event_type', ['lead_ingediend', 'toegang', 'geen_toegang']), 'ts').order('id', { ascending: true }), 'funnel_events', fouten),
    leesAlles(() => venster(supabaseAdmin.from('leads').select('id,email,bron,traject,afwijzer')
      .is('verwijderd_op', null), 'aangemaakt').order('id', { ascending: true }), 'leads', fouten),
    leesAlles(() => venster(supabaseAdmin.from('event_attendees').select('id,email,status,is_test'), 'created_at')
      .order('id', { ascending: true }), 'event_attendees', fouten),
    leesAlles(() => venster(supabaseAdmin.from('event_kwalificatie_submissions').select('email,resultaat,attendee_id'), 'created_at')
      .order('id', { ascending: true }), 'event_kwalificatie_submissions', fouten),
    leesAlles(() => venster(supabaseAdmin.from('webinar_aanmeldingen').select('id,email,is_test'), 'created_at')
      .order('id', { ascending: true }), 'webinar_aanmeldingen', fouten),
    // '*': product/landingspagina bepalen of het een Lab-aanmelding is of een
    // trial van een andere belofte (26 okt 2026) — die telt al in haar eigen tegel.
    leesAlles(() => venster(supabaseAdmin.from('lab_aanmeldingen').select('*'), 'aangemaakt')
      .order('id', { ascending: true }), 'lab_aanmeldingen', fouten),
  ]);

  const uit = telAanmeldingen({ funnelEvents, nieuweLeads, eventAanmeldingen, eventInzendingen, webinarAanmeldingen, labAanmeldingen });
  return { ...uit, labels: TEGEL_LABELS, overig_labels: OVERIG_LABELS, bronfouten: fouten };
}
