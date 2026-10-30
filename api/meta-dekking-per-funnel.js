// api/meta-dekking-per-funnel.js
//
// "Meta-dekking per funnel": hoeveel van de ADVERTENTIE-leads per funnel
// daadwerkelijk een Lead-event naar Meta kregen, en hoeveel we missen. Dit is
// de echte tracking-/consent-miss, niet het ruwe CRM-vs-Meta-verschil.
//
// READ-ONLY. Raakt de verzending, de lead_<id>-dedup en de site-repo NIET aan.
// Permission: leads.view.
//
// ── Definities (zie ook de PR-omschrijving) ─────────────────────────────────
//   PERIODE (noemer-basis = leads.aangemaakt in de range):
//     - '30d' (default): rollende laatste 30 dagen (NL-dagen).
//     - 'maand': huidige kalendermaand (NL).
//     - 'vorige-maand': vorige volledige kalendermaand (NL) = de stevigste meting.
//     De laatste ~2-3 dagen onderrapporteren: lead_attribution wordt asynchroon
//     vanuit GHL gevuld (webhook/poll/backfill), niet bij lead-aanmaak.
//
//   AD-LEAD (noemer): een periode-lead die via lead_attribution een Meta-
//     advertentie-attributie heeft:
//        fbclid IS NOT NULL  OF  lower(utm_source) IN
//        {facebook, fb, instagram, ig, meta}.
//     JOIN lead -> lead_attribution:
//        primair  leads.source_ref->>'ghl_contact_id' = lead_attribution.ghl_contact_id
//        fallback lower(leads.email) = lower(lead_attribution.email) (beide niet-null)
//     Leads zonder GHL-contact en zonder matchende attributie-e-mail kunnen niet
//     als ad-lead geclassificeerd worden -> de ad-lead-teller is een lichte
//     ONDERSCHATTING. We vermijden een brittle grote .in() op het jsonb-pad door
//     eerst de ghl_contact_id's/e-mails op te halen en in batches te joinen.
//
//   VERSTUURD (teller): een ad-lead met een Lead-event status sent/verstuurd,
//     gematcht op event_id = 'lead_' + lead.id, uit de drie logtabellen samen
//     (meta_lead_events + lab_meta_events + meta_capi_uitgaand). Ontdubbeld op
//     event_id (per lead telt 1 verzending, ongeacht via welk kanaal).
//
//   GEMIST = ad-leads - verstuurd.  DEKKING% = verstuurd / ad-leads.
//
//   REDEN van de miss (waar beschikbaar): meta_lead_events/lab_meta_events
//     skip_reason 'geen advertentie-toestemming' / 'al geteld (dedup)';
//     site-funnels loggen geen skips -> 'onbekend'.
//
//   SCOPE: alleen funnels met een lead_<id>-Lead-sender krijgen een dekking%
//     (opstartsessie, webinar, The Lab, en de site-funnels 7-daagse, mini-cursus,
//     strategiescan, training). Funnels zonder zo'n sender - m.n. de Event-funnel
//     (die sleutelt op event_<id>) en overige/handmatige leads - worden apart
//     getoond als "geen Lead-koppeling (n.v.t.)", NIET als gemist.
//
//   Fail-soft per bron: faalt een leesquery, dan komt die bron in `bronfouten`
//   (+ console.warn) en tonen we de rest.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  nlDayStart, nlDayEndExclusive, nlMonthStart, nlDateString, periodRange,
} from './_lib/nl-period.js';

// ── Funnel-predicaten. Gelijk aan api/_lib/aanmeldingen-per-funnel.js +
//    api/meta-lead-events.js (bewust gedupliceerd, geen cross-lib coupling). ──
const laag = (t) => String(t || '').trim().toLowerCase();
const is7daagse = (t) => t.includes('7-daagse') || t.includes('7 daagse') || t.includes('7daagse');
const isMini = (t) => t.includes('mini') || t.includes('kennismakingscursus') || t.includes('strategiesessie');
const isTraining = (b) => /^(training|drop)-\d{2}-\d{2}-\d{2}(-\d)?$/.test(b);

// Classificeer een lead (bron/traject) naar een funnel-key. Volgorde = specifiek
// eerst, zodat bv. 'the-lab' niet in 'rest' belandt.
function funnelVanLead(lead) {
  const t = laag(lead && lead.traject);
  const b = laag(lead && lead.bron);
  if (b === 'the-lab' || t === 'the-lab') return 'the-lab';
  if (isTraining(b)) return 'training';
  if (b.startsWith('strategiescan-') || t === 'strategiescan') return 'strategiescan';
  if (t.includes('webinar') || b.startsWith('webinar')) return 'webinar';
  if (is7daagse(t) || is7daagse(b)) return '7-daagse';
  if (isMini(t) || isMini(b)) return 'mini';
  if (b === 'opstartsessie' || t === 'opstartsessie') return 'opstartsessie';
  if (t.includes('event') || b.includes('event')) return 'event';
  return 'rest';
}

// Funnels met een lead_<id>-Lead-sender: alleen deze krijgen een dekking%.
const SENDER_FUNNELS = new Set(['opstartsessie', 'webinar', 'the-lab', '7-daagse', 'mini', 'strategiescan', 'training']);
const FUNNEL_LABELS = {
  'opstartsessie': 'Opstartsessie', 'webinar': 'Webinar', 'the-lab': 'The Lab',
  '7-daagse': '7-daagse', 'mini': 'Mini-cursus', 'strategiescan': 'Strategie-scan',
  'training': 'Training', 'event': 'Event-aanmeldingen', 'rest': 'Overige leads',
};
// Vaste volgorde voor de output (sender-funnels eerst, dan n.v.t.).
const FUNNEL_VOLGORDE = ['opstartsessie', 'webinar', 'the-lab', '7-daagse', 'mini', 'strategiescan', 'training', 'event', 'rest'];

// Meta-advertentie-set voor de ad-lead-herkenning op utm_source.
const META_SOURCES = new Set(['facebook', 'fb', 'instagram', 'ig', 'meta']);
function isAdAttributie(attr) {
  if (!attr) return false;
  if (attr.fbclid != null && String(attr.fbclid).trim() !== '') return true;
  return META_SOURCES.has(laag(attr.utm_source));
}

const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];
function isTestEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const s = e.toLowerCase();
  return TEST_EMAIL_MARKERS.some((m) => s.includes(m));
}

// Periode -> { start, endExclusive, label, note }.
function bepaalPeriode(period) {
  const p = String(period || '30d').toLowerCase();
  if (p === 'maand') {
    const r = periodRange('maand');
    return { start: r.start, endExclusive: r.endExclusive, key: 'maand', label: 'Deze maand' };
  }
  if (p === 'vorige-maand') {
    // Een moment in de vorige maand: deze-maand-start minus 1 dag.
    const ref = new Date(nlMonthStart().getTime() - 24 * 3600 * 1000);
    const r = periodRange('maand', ref);
    return { start: r.start, endExclusive: r.endExclusive, key: 'vorige-maand', label: 'Vorige maand' };
  }
  // Default: rollende laatste 30 dagen (NL-dagen), eindigend aan het eind van vandaag.
  const endExclusive = nlDayEndExclusive();
  const start = new Date(nlDayStart().getTime() - 29 * 24 * 3600 * 1000);
  return { start, endExclusive, key: '30d', label: 'Laatste 30 dagen' };
}

// Chunk een array in stukken van n (voor .in()-batches).
function chunk(arr, n) {
  const uit = [];
  for (let i = 0; i < arr.length; i += n) uit.push(arr.slice(i, i + n));
  return uit;
}
const BATCH = 300;

// Paginerend lezen (zelfde patroon als aanmeldingen-per-funnel.js).
const PAGINA = 1000;
const MAX_PAGINAS = 50;
async function leesAlles(maakQuery, label, fouten) {
  const uit = [];
  for (let p = 0; p < MAX_PAGINAS; p += 1) {
    try {
      const { data, error } = await maakQuery().range(p * PAGINA, p * PAGINA + PAGINA - 1);
      if (error) { console.warn(`[meta-dekking] ${label}:`, error.message); fouten.push(label); return uit; }
      uit.push(...(data || []));
      if (!data || data.length < PAGINA) return uit;
    } catch (e) {
      console.warn(`[meta-dekking] ${label} exception:`, e?.message || e); fouten.push(label); return uit;
    }
  }
  return uit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const periode = bepaalPeriode(req.query?.period);
  const vanIso = periode.start.toISOString();
  const totIso = periode.endExclusive.toISOString();
  const fouten = [];

  try {
    // ── 1) Periode-leads (noemer-basis = leads.aangemaakt). ───────────────────
    const leads = await leesAlles(
      () => supabaseAdmin.from('leads')
        .select('id, email, bron, traject, source_ref')
        .is('verwijderd_op', null)
        .gte('aangemaakt', vanIso).lt('aangemaakt', totIso)
        .order('id', { ascending: true }),
      'leads', fouten,
    );
    // Test-adressen tellen nergens mee (zelfde conventie als de funnel-telling).
    const echteLeads = leads.filter((l) => l && l.id && !isTestEmail(l.email));

    // Lead -> funnel + de join-sleutels verzamelen.
    const perLead = new Map(); // id -> { funnel, ghlId, email }
    const ghlIds = new Set();
    const emails = new Set();
    for (const l of echteLeads) {
      const ghlId = (l.source_ref && typeof l.source_ref === 'object' && l.source_ref.ghl_contact_id)
        ? String(l.source_ref.ghl_contact_id) : null;
      const email = l.email ? String(l.email) : null;
      perLead.set(String(l.id), { funnel: funnelVanLead(l), ghlId, email });
      if (ghlId) ghlIds.add(ghlId);
      if (email) emails.add(email);
    }

    // ── 2) Ad-lead-bepaling via lead_attribution (batched; primair ghl, fallback email). ──
    //    Bouw twee lookup-maps van ATTRIBUTIE-rijen die Meta-ad zijn.
    const adByGhl = new Map();       // ghl_contact_id -> true (is Meta-ad)
    const adByEmailLower = new Map(); // lower(email)   -> true (is Meta-ad)
    async function laadAttributie(kolom, waarden, label) {
      for (const stuk of chunk([...waarden], BATCH)) {
        const rows = await leesAlles(
          () => supabaseAdmin.from('lead_attribution')
            .select('ghl_contact_id, email, fbclid, utm_source')
            .in(kolom, stuk)
            .order('ghl_contact_id', { ascending: true }),
          label, fouten,
        );
        for (const r of rows) {
          if (!isAdAttributie(r)) continue;
          if (r.ghl_contact_id) adByGhl.set(String(r.ghl_contact_id), true);
          if (r.email) adByEmailLower.set(laag(r.email), true);
        }
      }
    }
    if (ghlIds.size) await laadAttributie('ghl_contact_id', ghlIds, 'lead_attribution(ghl)');
    if (emails.size) await laadAttributie('email', emails, 'lead_attribution(email)');

    // Per lead: is het een ad-lead? Primair via ghl_contact_id, fallback email.
    const adLeadIds = [];
    for (const [id, info] of perLead) {
      const viaGhl = info.ghlId && adByGhl.get(info.ghlId);
      const viaMail = info.email && adByEmailLower.get(laag(info.email));
      if (viaGhl || viaMail) adLeadIds.push(id);
    }

    // ── 3) Verstuurd + skip-reden per ad-lead, via event_id = 'lead_' + id. ────
    const eventIdVanLead = (id) => 'lead_' + id;
    const eventIds = adLeadIds.map(eventIdVanLead);
    const sentSet = new Set();           // event_id met een verstuurd/sent Lead-event
    const skipReason = new Map();        // event_id -> 'geen_toestemming' | 'al_geteld'

    function noteerSkip(eventId, reason) {
      const r = String(reason || '');
      let code = null;
      if (r === 'geen advertentie-toestemming') code = 'geen_toestemming';
      else if (r === 'al geteld (dedup)') code = 'al_geteld';
      if (code && !skipReason.has(eventId)) skipReason.set(eventId, code);
    }

    if (eventIds.length) {
      // meta_lead_events (CRM): sent -> verstuurd; skipped -> reden. Geen event_name-filter
      //   (de tabel is dedicated aan Lead-events).
      for (const stuk of chunk(eventIds, BATCH)) {
        const rows = await leesAlles(
          () => supabaseAdmin.from('meta_lead_events')
            .select('event_id, status, skip_reason')
            .in('event_id', stuk).order('event_id', { ascending: true }),
          'meta_lead_events', fouten,
        );
        for (const r of rows) {
          if (r.status === 'sent') sentSet.add(String(r.event_id));
          else if (r.status === 'skipped') noteerSkip(String(r.event_id), r.skip_reason);
        }
      }
      // lab_meta_events (The Lab): Lead + sent -> verstuurd; skipped -> reden.
      for (const stuk of chunk(eventIds, BATCH)) {
        const rows = await leesAlles(
          () => supabaseAdmin.from('lab_meta_events')
            .select('event_id, status, skip_reason')
            .eq('event_name', 'Lead').in('event_id', stuk).order('event_id', { ascending: true }),
          'lab_meta_events', fouten,
        );
        for (const r of rows) {
          if (r.status === 'sent') sentSet.add(String(r.event_id));
          else if (r.status === 'skipped') noteerSkip(String(r.event_id), r.skip_reason);
        }
      }
      // meta_capi_uitgaand (site): Lead + verstuurd -> verstuurd. Site logt geen skips.
      for (const stuk of chunk(eventIds, BATCH)) {
        const rows = await leesAlles(
          () => supabaseAdmin.from('meta_capi_uitgaand')
            .select('event_id, status')
            .eq('event_name', 'Lead').eq('status', 'verstuurd')
            .in('event_id', stuk).order('event_id', { ascending: true }),
          'meta_capi_uitgaand', fouten,
        );
        for (const r of rows) sentSet.add(String(r.event_id));
      }
    }

    // ── 4) Aggregatie per funnel. ─────────────────────────────────────────────
    const adLeadSet = new Set(adLeadIds);
    const agg = {}; // funnel -> { ad_leads, verstuurd, gemist, geen_toestemming, al_geteld, onbekend }
    for (const key of FUNNEL_VOLGORDE) agg[key] = { ad_leads: 0, verstuurd: 0, gemist: 0, geen_toestemming: 0, al_geteld: 0, onbekend: 0 };

    for (const id of adLeadSet) {
      const info = perLead.get(id);
      if (!info) continue;
      const a = agg[info.funnel] || agg.rest;
      a.ad_leads += 1;
      if (sentSet.has(eventIdVanLead(id))) {
        a.verstuurd += 1;
      } else {
        a.gemist += 1;
        const code = skipReason.get(eventIdVanLead(id));
        if (code === 'geen_toestemming') a.geen_toestemming += 1;
        else if (code === 'al_geteld') a.al_geteld += 1;
        else a.onbekend += 1;
      }
    }

    // ── 5) Output: sender-funnels met dekking%, de rest als n.v.t. ────────────
    const funnels = [];
    const totaal = { ad_leads: 0, verstuurd: 0, gemist: 0, geen_toestemming: 0, al_geteld: 0, onbekend: 0 };
    const nvt = [];
    let nvtAdLeads = 0;
    for (const key of FUNNEL_VOLGORDE) {
      const a = agg[key];
      if (SENDER_FUNNELS.has(key)) {
        const dekking = a.ad_leads > 0 ? Math.round((a.verstuurd / a.ad_leads) * 1000) / 10 : null;
        funnels.push({
          funnel: key, label: FUNNEL_LABELS[key], heeft_sender: true,
          ad_leads: a.ad_leads, verstuurd: a.verstuurd, gemist: a.gemist, dekking_pct: dekking,
          redenen: { geen_toestemming: a.geen_toestemming, al_geteld: a.al_geteld, onbekend: a.onbekend },
        });
        totaal.ad_leads += a.ad_leads; totaal.verstuurd += a.verstuurd; totaal.gemist += a.gemist;
        totaal.geen_toestemming += a.geen_toestemming; totaal.al_geteld += a.al_geteld; totaal.onbekend += a.onbekend;
      } else {
        nvt.push({ funnel: key, label: FUNNEL_LABELS[key], heeft_sender: false, ad_leads: a.ad_leads });
        nvtAdLeads += a.ad_leads;
      }
    }
    const dekkingTotaal = totaal.ad_leads > 0 ? Math.round((totaal.verstuurd / totaal.ad_leads) * 1000) / 10 : null;

    return res.status(200).json({
      periode: { key: periode.key, label: periode.label, start: nlDateString(periode.start), eind: nlDateString(new Date(periode.endExclusive.getTime() - 1)) },
      funnels,
      nvt,
      nvt_ad_leads: nvtAdLeads,
      totaal: { ...totaal, dekking_pct: dekkingTotaal },
      bronfouten: [...new Set(fouten)],
    });
  } catch (e) {
    console.error('[meta-dekking-per-funnel]', e?.message || e);
    return res.status(500).json({ error: 'Kon Meta-dekking niet berekenen' });
  }
}
