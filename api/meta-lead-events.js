// api/meta-lead-events.js
//
// Overzicht voor het Meta-koppeling-paneel: ALLE echte Lead-events naar Meta, uit
// drie log-tabellen (zelfde Supabase), samengevoegd + genormaliseerd. READ-ONLY:
// raakt de verzending en de lead_<id>-dedup NIET aan.
//
//   - meta_lead_events   (CRM-funnels: opstartsessie + webinar)
//   - lab_meta_events    (The Lab)            waar event_name='Lead'
//   - meta_capi_uitgaand (site-funnels)       waar event_name='Lead'
//
// Dedup over de bronnen op event_id (= lead_<id>): één echte verzending wint van
// een CRM-skip (Verstuurd > Fout > Overgeslagen). Dagtellers: "Verstuurd" over alle
// drie; "Geen toestemming" en "Al geteld (dedup)" blijven CRM-funnel-only (de site
// logt geen skips) - de UI labelt die twee expliciet als (CRM-funnels).
//
// Permission: leads.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';

const LIMIET = 60;

// ── Normalisatie-helpers ────────────────────────────────────────────────────
function normStatus(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'sent' || x === 'verstuurd') return 'Verstuurd';
  if (x === 'failed' || x === 'mislukt' || x === 'opgegeven') return 'Fout';
  if (x === 'skipped') return 'Overgeslagen';
  return 'Onbekend';
}
const STATUS_PRIO = { Verstuurd: 1, Fout: 2, Overgeslagen: 3, Onbekend: 4 };

// match_keys (jsonb booleans) → X/totaal; match_sleutels (text[]) → alleen aantal.
function matchJsonb(mk) {
  if (!mk || typeof mk !== 'object') return { match: null, match_totaal: null };
  const keys = Object.keys(mk);
  if (!keys.length) return { match: null, match_totaal: null };
  return { match: keys.filter((k) => mk[k] === true).length, match_totaal: keys.length };
}
function matchArr(arr) {
  return { match: Array.isArray(arr) ? arr.filter(Boolean).length : null, match_totaal: null };
}

// Funnel-labels. Predicaten gelijk aan api/_lib/aanmeldingen-per-funnel.js.
const laag = (t) => String(t || '').trim().toLowerCase();
const is7daagse = (t) => t.includes('7-daagse') || t.includes('7 daagse') || t.includes('7daagse');
const isMini = (t) => t.includes('mini') || t.includes('kennismakingscursus') || t.includes('strategiesessie');
const isTraining = (b) => /^(training|drop)-\d{2}-\d{2}-\d{2}(-\d)?$/.test(b);
function siteFunnelLabel(lead) {
  const t = laag(lead?.traject); const b = laag(lead?.bron);
  if (b === 'the-lab' || t === 'the-lab') return 'The Lab';
  if (isTraining(b)) return 'Training';
  if (b.startsWith('strategiescan-') || t === 'strategiescan') return 'Strategie-scan';
  if (t.includes('webinar') || b.startsWith('webinar')) return 'Webinar';
  if (is7daagse(t) || is7daagse(b)) return '7-daagse';
  if (isMini(t) || isMini(b)) return 'Mini-cursus';
  if (b === 'opstartsessie' || t === 'opstartsessie') return 'Opstartsessie';
  return lead?.bron || 'Site-funnel';
}
function crmFunnelLabel(bron) {
  const b = laag(bron);
  if (b === 'opstartsessie') return 'Opstartsessie';
  if (b.startsWith('webinar')) return 'Webinar';
  return bron || 'CRM-funnel';
}

// Fail-soft bron-query: faalt er één, dan null (caller slaat 'm over).
async function leesBron(bouw, label) {
  try {
    const { data, error } = await bouw();
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn(`[meta-lead-events] ${label} faalde (soft):`, e?.message || e);
    return null;
  }
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

  const startIso = nlDayStart().toISOString();
  const endIso = nlDayEndExclusive().toISOString();

  try {
    // ── Recente events uit de drie bronnen (fail-soft per bron) ───────────────
    const [rijenLead, rijenLab, rijenSite] = await Promise.all([
      leesBron(() => supabaseAdmin.from('meta_lead_events')
        .select('bron, status, skip_reason, event_id, match_keys, aangemaakt')
        .order('aangemaakt', { ascending: false }).limit(LIMIET), 'meta_lead_events'),
      leesBron(() => supabaseAdmin.from('lab_meta_events')
        .select('status, skip_reason, event_id, match_keys, aangemaakt')
        .eq('event_name', 'Lead').order('aangemaakt', { ascending: false }).limit(LIMIET), 'lab_meta_events'),
      leesBron(() => supabaseAdmin.from('meta_capi_uitgaand')
        .select('status, event_id, match_sleutels, aangemaakt')
        .eq('event_name', 'Lead').order('aangemaakt', { ascending: false }).limit(LIMIET), 'meta_capi_uitgaand'),
    ]);

    const alles = [];
    for (const r of rijenLead || []) {
      alles.push({ herkomst: 'CRM-funnel', funnel_label: crmFunnelLabel(r.bron), status: normStatus(r.status), skip_reason: r.skip_reason || null, ...matchJsonb(r.match_keys), event_id: r.event_id, aangemaakt: r.aangemaakt });
    }
    for (const r of rijenLab || []) {
      alles.push({ herkomst: 'The Lab', funnel_label: 'The Lab', status: normStatus(r.status), skip_reason: r.skip_reason || null, ...matchJsonb(r.match_keys), event_id: r.event_id, aangemaakt: r.aangemaakt });
    }
    // Site: funnel-label afleiden uit event_id (lead_<uuid> → batched leads-join; event_<id> → Events).
    const siteRijen = rijenSite || [];
    const leadIds = [...new Set(siteRijen
      .map((r) => (String(r.event_id || '').startsWith('lead_') ? String(r.event_id).slice(5) : null))
      .filter(Boolean))];
    let leadMap = new Map();
    if (leadIds.length) {
      try {
        const { data } = await supabaseAdmin.from('leads').select('id, bron, traject').in('id', leadIds);
        leadMap = new Map((data || []).map((l) => [l.id, l]));
      } catch (e) { console.warn('[meta-lead-events] leads-join (soft):', e?.message || e); }
    }
    for (const r of siteRijen) {
      const id = String(r.event_id || '');
      const label = id.startsWith('lead_') ? siteFunnelLabel(leadMap.get(id.slice(5)))
        : id.startsWith('event_') ? 'Events'
          : 'Site-funnel';
      alles.push({ herkomst: 'Site-funnel', funnel_label: label, status: normStatus(r.status), skip_reason: null, ...matchArr(r.match_sleutels), event_id: r.event_id, aangemaakt: r.aangemaakt });
    }

    // ── Ontdubbelen op event_id (echte verzending wint van een CRM-skip) ──────
    const best = new Map();
    let losNr = 0;
    for (const e of alles) {
      const k = e.event_id || ('zonder-id-' + (losNr++));
      const prev = best.get(k);
      if (!prev) { best.set(k, e); continue; }
      const pe = STATUS_PRIO[e.status] || 9;
      const pp = STATUS_PRIO[prev.status] || 9;
      if (pe < pp || (pe === pp && String(e.aangemaakt) > String(prev.aangemaakt))) best.set(k, e);
    }
    const events = [...best.values()]
      .sort((a, b) => String(b.aangemaakt).localeCompare(String(a.aangemaakt)))
      .slice(0, LIMIET);

    // ── Dagtellers ────────────────────────────────────────────────────────────
    // Verstuurd over alle drie (een lead verzendt maar via één kanaal → geen
    // dubbeltelling); de twee skip-tellers blijven CRM-funnel-only.
    const telCount = async (bouw) => { try { const { count } = await bouw(); return count || 0; } catch { return 0; } };
    const inVandaag = (q) => q.gte('aangemaakt', startIso).lt('aangemaakt', endIso);

    const { data: leadVandaag } = await supabaseAdmin.from('meta_lead_events')
      .select('status, skip_reason').gte('aangemaakt', startIso).lt('aangemaakt', endIso).limit(5000);
    let leadSent = 0; const tellers = { verstuurd: 0, geen_toestemming: 0, al_geteld: 0 };
    for (const r of leadVandaag || []) {
      if (r.status === 'sent') leadSent += 1;
      else if (r.skip_reason === 'geen advertentie-toestemming') tellers.geen_toestemming += 1;
      else if (r.skip_reason === 'al geteld (dedup)') tellers.al_geteld += 1;
    }
    const labSent = await telCount(() => inVandaag(supabaseAdmin.from('lab_meta_events').select('*', { count: 'exact', head: true }).eq('event_name', 'Lead').eq('status', 'sent')));
    const siteSent = await telCount(() => inVandaag(supabaseAdmin.from('meta_capi_uitgaand').select('*', { count: 'exact', head: true }).eq('event_name', 'Lead').eq('status', 'verstuurd')));
    tellers.verstuurd = leadSent + labSent + siteSent;

    return res.status(200).json({ tellers, events });
  } catch (e) {
    console.error('[meta-lead-events]', e?.message || e);
    return res.status(500).json({ error: 'Kon events niet laden' });
  }
}
