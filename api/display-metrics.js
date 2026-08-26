// api/display-metrics.js
//
// Read-only KPI-endpoint voor tv-dashboard (/display). Token-gated (SHA-256
// van display_tokens.token_hash). Geen CRM-login. Geen mutation. PII =
// voornaam + initiaal server-side getrimd. 10s in-memory cache. Rate-limit
// 30/60s per IP. Alle tijd-velden = ISO-8601 met tijdzone (UTC 'Z').
//
// Bronnen (allemaal server-side, geen self-HTTP):
//   leads   → computeLeadsByTraject (_lib/leads-per-traject-compute)  — total_incl_afwijzer + by_traject_incl_afwijzer, matcht v2-dashboard
//   sales   → computeSignedDealsTotal (_lib/sales-signed-deals-compute) met recent_ids voor bling
//   calls   → follow_up_appointments: zoom_meeting_id IS NOT NULL AND status='completed' (Jeffrey: alleen afgeronde Zoom-calls)
//   dave    → computeMetrics(supabaseAdmin, {ownerScope: daveUserId}) uit follow-up-metrics
//               - retentie_gebeld    = appointments_completed
//               - follow_ups_gedraaid = outcomes_total (ANDERE bron dan retentie)
//               - voicememos_sent    = voicememos_sent
//   1-op-1  → getBubbleOneOnOneCountToday (_lib/bubble-one-on-one-count) — 8-min cache, één Bubble-query all-mentor
//   rank    → activity_log group by user_id (whitelist, env-override)
//   feed    → 6-way UNION, top-15, DESC
//
// Robuustheid: Promise.allSettled over 14 bronnen + eigen safeAwait() voor
// alle secundaire lookups. Falen van één bron degradeert die tegel, rest
// blijft staan. Leads.total = null (niet 0) bij bron-down zodat het bord
// "—" toont i.p.v. misleidend 0.

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { computeMetrics } from './follow-up-metrics.js';
import { nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';
import { computeLeadsByTraject } from './_lib/leads-per-traject-compute.js';
import { computeSignedDealsTotal } from './_lib/sales-signed-deals-compute.js';
import { getBubbleOneOnOneCountToday } from './_lib/bubble-one-on-one-count.js';

const CACHE_TTL_MS = 10_000;
let _cache = { at: 0, payload: null };

// Actie-whitelist voor uitvoer-per-persoon ranglijst. Endpoint-namen én
// permission-keys — activity-logger.js schrijft beide varianten afhankelijk
// van caller. Env-override zonder deploy: DISPLAY_RANKING_ACTIONS="a,b,c".
const RANKING_ACTIONS_DEFAULT = [
  'outcome-save', 'follow-up-outcomes', 'outcome.save',
  'voicememo-send', 'follow-up-voicememo', 'voicememo.send',
  'ghl-send', 'follow-up-ghl-send',
  'kb-item-edit', 'kennisbank-sync', 'kennisbank.item.edit',
  'dunning-call-log-create',
  'follow-up-verplaats', 'follow-up-verplaats-call',
  'generate-task',
  'agent-approval', 'agent-approval-resolve',
];

// Bucket-matchers matchen exact v2-dashboard-v2.js:730-735 (substring-lower).
const BUCKET_MATCHERS = [
  { key: 'challenge', match: ['7-daagse', '7 daagse', '7daagse'] },
  { key: 'event',     match: ['event'] },
  { key: 'webinar',   match: ['webinar'] },
  { key: 'mini',      match: ['mini'] },
];

// ── PII-trim helper ──────────────────────────────────────────────────────
function trimName(name) {
  if (!name || typeof name !== 'string') return '—';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last  = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

// ── Dave-lookup: env-var primair, name-match alleen bij exact 1 hit ──────
async function resolveDave() {
  const envId = process.env.DISPLAY_DAVE_USER_ID;
  if (envId) return { user_id: envId, source: 'env' };
  try {
    const { data } = await supabaseAdmin
      .from('profiles').select('id, full_name')
      .ilike('full_name', '%dave%').eq('is_active', true);
    const rows = data || [];
    if (rows.length === 1) return { user_id: rows[0].id, source: 'name-match' };
    console.warn('[display-metrics] Dave niet eenduidig gevonden: rows=' + rows.length + ' — zet DISPLAY_DAVE_USER_ID');
    return { user_id: null, source: 'unresolved' };
  } catch (e) {
    console.warn('[display-metrics] Dave-lookup fout:', e?.message || e);
    return { user_id: null, source: 'unresolved' };
  }
}

// ── Token-check tegen display_tokens ──────────────────────────────────────
async function verifyToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 16) return false;
  const hash = crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
  const { data } = await supabaseAdmin
    .from('display_tokens').select('id')
    .eq('token_hash', hash).is('revoked_at', null).maybeSingle();
  if (!data) return false;
  // Alleen last_used_at bijwerken. Fire-and-forget zodat token-verificatie
  // niet stil vast blijft zitten op een langzame update.
  supabaseAdmin.from('display_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id).then(() => {}, () => {});
  return true;
}

// ── safeAwait — fallback bij falen zodat één transient fout niet het bord zwart maakt ──
async function safeAwait(promise, fallback, label) {
  try { return await promise; }
  catch (e) { console.warn('[display-metrics] secondary ' + label + ' failed:', e?.message); return fallback; }
}

// ── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const key = String(req.query?.key || '').trim();
  const ok = await verifyToken(key);
  if (!ok) return res.status(401).json({ error: 'Invalid or missing token' });

  const rl = await checkRateLimit({ req, bucket: 'display-metrics', maxHits: 30, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const now = Date.now();
  if (_cache.payload && (now - _cache.at) < CACHE_TTL_MS) {
    return res.status(200).json(_cache.payload);
  }

  try {
    const dayStart = nlDayStart();
    const dayEnd   = nlDayEndExclusive();
    const dayStartIso = dayStart.toISOString();
    const dayEndIso   = dayEnd.toISOString();
    const sinceStr = dayStart.toISOString().slice(0, 10);
    const untilStr = dayEnd.toISOString().slice(0, 10);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const dave = await resolveDave();
    const rankingActions = process.env.DISPLAY_RANKING_ACTIONS
      ? process.env.DISPLAY_RANKING_ACTIONS.split(',').map(s => s.trim()).filter(Boolean)
      : RANKING_ACTIONS_DEFAULT;

    // Primaire bronnen — allSettled. Falen → placeholder.
    const results = await Promise.allSettled([
      /* 0 */ computeLeadsByTraject({ supabaseAdmin, range: { start: dayStart, endExclusive: dayEnd }, skipAllLabels: true }),
      /* 1 */ computeSignedDealsTotal({ supabaseAdmin, since: sinceStr, until: untilStr, includeRecentIds: true }),
      /* 2 */ supabaseAdmin.from('follow_up_appointments').select('id', { count: 'exact', head: true })
                .gte('scheduled_at', dayStartIso).lt('scheduled_at', dayEndIso)
                .not('zoom_meeting_id', 'is', null).eq('status', 'completed'),
      /* 3 */ supabaseAdmin.from('follow_up_appointments')
                .select('id, scheduled_at, lead_name, zoom_meeting_id')
                .gte('scheduled_at', new Date().toISOString()).eq('status', 'scheduled')
                .order('scheduled_at', { ascending: true }).limit(5),
      /* 4 */ supabaseAdmin.from('activity_log').select('user_id')
                .in('action', rankingActions)
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
      /* 5 */ supabaseAdmin.from('email_messages').select('id, from_name, date_received')
                .eq('category', 'Nieuwe Lead').gte('date_received', twoHoursAgo.toISOString())
                .order('date_received', { ascending: false }).limit(5),
      /* 6 */ supabaseAdmin.from('deals').select('id, tl_quotation_accepted_at, customer_id')
                .eq('tl_quotation_status', 'accepted')
                .gte('tl_quotation_accepted_at', twoHoursAgo.toISOString())
                .order('tl_quotation_accepted_at', { ascending: false }).limit(5),
      /* 7 */ supabaseAdmin.from('follow_up_appointments').select('id, lead_name, updated_at')
                .eq('status', 'completed').gte('updated_at', twoHoursAgo.toISOString())
                .order('updated_at', { ascending: false }).limit(5),
      /* 8 */ supabaseAdmin.from('follow_up_appointments').select('id, lead_name, updated_at')
                .eq('voicememo_status', 'sent').gte('updated_at', twoHoursAgo.toISOString())
                .order('updated_at', { ascending: false }).limit(5),
      /* 9 */ supabaseAdmin.from('follow_up_outcomes').select('id, created_at')
                .gte('created_at', twoHoursAgo.toISOString())
                .order('created_at', { ascending: false }).limit(5),
      /*10 */ supabaseAdmin.from('event_signup_inbox').select('id, first_name, event_date_label, created_at')
                .gte('created_at', twoHoursAgo.toISOString())
                .order('created_at', { ascending: false }).limit(5),
      /*11 */ dave.user_id
                ? computeMetrics(supabaseAdmin, { period: 'today', ownerScope: dave.user_id })
                : Promise.resolve(null),
      /*12 */ dave.user_id
                ? supabaseAdmin.from('follow_up_appointments')
                    .select('id, lead_name, scheduled_at').eq('owner_id', dave.user_id)
                    .eq('voicememo_status', 'sent')
                    .gte('updated_at', dayStartIso).lt('updated_at', dayEndIso)
                    .order('updated_at', { ascending: false }).limit(5)
                : Promise.resolve({ data: [] }),
      /*13 */ getBubbleOneOnOneCountToday({ start: dayStart, endExclusive: dayEnd }),
    ]);

    const pick = (i, fallback) => {
      if (results[i].status === 'fulfilled') return results[i].value;
      console.warn('[display-metrics] source #' + i + ' failed:', results[i].reason?.message);
      return fallback;
    };

    const leadsCompute       = pick(0,  { total_incl_afwijzer: null, by_traject_incl_afwijzer: {}, excluded: {} });
    const salesCompute       = pick(1,  { total_incl_vat: null, count: null, recent_ids: [] });
    const callsTodayRes      = pick(2,  { count: null });
    const callsNextRes       = pick(3,  { data: [] });
    const rankingRes         = pick(4,  { data: [] });
    const feedLeadsRes       = pick(5,  { data: [] });
    const feedSalesRes       = pick(6,  { data: [] });
    const feedCallsCompleted = pick(7,  { data: [] });
    const feedVoicememoRes   = pick(8,  { data: [] });
    const feedOutcomesRes    = pick(9,  { data: [] });
    const feedEventsRes      = pick(10, { data: [] });
    const daveMetrics        = pick(11, null);
    const daveVoicememoRes   = pick(12, { data: [] });
    const oneOnOne           = pick(13, { count: null, as_of: new Date().toISOString(), source: 'bubble-error' });

    // ── Secundaire queries — safeAwait ────────────────────────────────────
    const callsBookedRes = await safeAwait(
      supabaseAdmin.from('follow_up_appointments').select('id', { count: 'exact', head: true })
        .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
      { count: null },
      'callsBookedCount'
    );
    const callsBookedCount = callsBookedRes.count;

    // ── Leads-buckets — v2-conventie: total_incl_afwijzer + substring-match ─
    const buckets = { challenge: 0, mini: 0, event: 0, webinar: 0 };
    const unmatched = [];
    for (const label of Object.keys(leadsCompute.by_traject_incl_afwijzer || {})) {
      const l = String(label).toLowerCase();
      const cnt = leadsCompute.by_traject_incl_afwijzer[label] || 0;
      let matched = false;
      for (const b of BUCKET_MATCHERS) {
        if (b.match.some(m => l.includes(m))) { buckets[b.key] += cnt; matched = true; break; }
      }
      if (!matched && cnt > 0) unmatched.push({ label, count: cnt });
    }
    if (unmatched.length) console.log('[display-metrics] leads-buckets unmatched today:', unmatched);

    // ── Sales — geen dubbel-trim; label komt PII-safe uit compute-helper ──
    const salesRecent = salesCompute.recent_ids || [];

    // ── Calls next ────────────────────────────────────────────────────────
    const callsNext = (callsNextRes.data || []).map(a => ({
      id: a.id,
      scheduled_at: new Date(a.scheduled_at).toISOString(),
      lead_label: trimName(a.lead_name || ''),
      type: a.zoom_meeting_id ? 'Zoom' : 'Bel',
    }));

    // ── Staff ranking ─────────────────────────────────────────────────────
    const rankRows = rankingRes.data || [];
    const rankCount = {};
    for (const r of rankRows) {
      const k = r.user_id || 'onbekend';
      rankCount[k] = (rankCount[k] || 0) + 1;
    }
    const rankIds = Object.keys(rankCount).filter(id => id !== 'onbekend');
    let rankMap = new Map();
    if (rankIds.length) {
      const profsRes = await safeAwait(
        supabaseAdmin.from('profiles').select('id, full_name').in('id', rankIds),
        { data: [] },
        'rankProfiles'
      );
      rankMap = new Map((profsRes.data || []).map(p => [p.id, p.full_name]));
    }
    const staffRanking = Object.entries(rankCount)
      .map(([uid, count]) => ({ user_label: trimName(rankMap.get(uid) || 'Onbekend'), count }))
      .sort((a, b) => b.count - a.count).slice(0, 10);

    // ── Feed sales → klant-labels ─────────────────────────────────────────
    const feedSaleDeals = feedSalesRes.data || [];
    let feedSalesCustMap = new Map();
    if (feedSaleDeals.length) {
      const cids = [...new Set(feedSaleDeals.map(d => d.customer_id).filter(Boolean))];
      if (cids.length) {
        const custsRes = await safeAwait(
          supabaseAdmin.from('customers')
            .select('id, is_company, company_name, first_name, last_name').in('id', cids),
          { data: [] },
          'feedSalesCustomers'
        );
        feedSalesCustMap = new Map((custsRes.data || []).map(c => [c.id, c]));
      }
    }
    function custLabel(c) {
      if (!c) return 'nieuwe klant';
      if (c.is_company) return c.company_name || '—';
      return trimName([c.first_name, c.last_name].filter(Boolean).join(' '));
    }

    // ── Feed 6-way ────────────────────────────────────────────────────────
    const feed = [];
    for (const e of (feedLeadsRes.data || [])) feed.push({
      ts: new Date(e.date_received).toISOString(), type: 'lead',
      text: `Nieuwe lead: ${trimName(e.from_name || '')}`,
    });
    for (const s of feedSaleDeals) feed.push({
      ts: new Date(s.tl_quotation_accepted_at).toISOString(), type: 'sale',
      text: `Sale: ${custLabel(feedSalesCustMap.get(s.customer_id))}`,
    });
    for (const a of (feedCallsCompleted.data || [])) feed.push({
      ts: new Date(a.updated_at).toISOString(), type: 'call',
      text: `Call afgerond: ${trimName(a.lead_name || '')}`,
    });
    for (const v of (feedVoicememoRes.data || [])) feed.push({
      ts: new Date(v.updated_at).toISOString(), type: 'voicememo',
      text: `Voicememo: ${trimName(v.lead_name || '')}`,
    });
    for (const o of (feedOutcomesRes.data || [])) feed.push({
      ts: new Date(o.created_at).toISOString(), type: 'followup',
      text: `Follow-up geregistreerd`,
    });
    for (const s of (feedEventsRes.data || [])) feed.push({
      ts: new Date(s.created_at).toISOString(), type: 'event',
      text: `Event-signup: ${trimName(s.first_name || '')}${s.event_date_label ? ' → ' + s.event_date_label : ''}`,
    });
    feed.sort((a, b) => (a.ts < b.ts ? 1 : -1));

    // ── Dave — distinct velden: retentie ≠ follow-ups ─────────────────────
    const daveRetentie          = daveMetrics?.appointments_completed ?? 0;
    const daveFollowups         = daveMetrics?.outcomes_total ?? 0;
    const daveVoicememosSent    = daveMetrics?.voicememos_sent ?? 0;
    const daveVoicememosPending = daveMetrics?.achterstallig_voicememos ?? 0;

    // ── Optionele diagnose-scan (achter env-flag, alleen tijdens tuning) ─
    if (process.env.DISPLAY_DEBUG_ACTIONS === '1') {
      const diagRes = await safeAwait(
        supabaseAdmin.from('activity_log').select('action')
          .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
        { data: [] },
        'diagnoseActionsScan'
      );
      const actionCounts = {};
      for (const r of (diagRes.data || [])) actionCounts[r.action] = (actionCounts[r.action] || 0) + 1;
      const outsideWhitelist = Object.entries(actionCounts)
        .filter(([a]) => !rankingActions.includes(a))
        .sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (outsideWhitelist.length) console.log('[display-metrics] top actions outside whitelist:', outsideWhitelist);
    }

    // ── Payload assembly ─────────────────────────────────────────────────
    // leads.total = null bij bron-down (bord toont "—" i.p.v. misleidend 0).
    const leadsTotal = (leadsCompute.total_incl_afwijzer === null || leadsCompute.total_incl_afwijzer === undefined)
      ? null
      : (leadsCompute.total_incl_afwijzer + (callsBookedCount || 0));

    const payload = {
      generated_at: new Date().toISOString(),
      leads: {
        total: leadsTotal,
        buckets: [
          { key: 'challenge', label: '7-daagse',      count: buckets.challenge },
          { key: 'mini',      label: 'Mini-cursus',   count: buckets.mini      },
          { key: 'event',     label: 'Events',        count: buckets.event     },
          { key: 'webinar',   label: 'Webinar',       count: buckets.webinar   },
          { key: 'calls',     label: 'Nieuwe calls',  count: callsBookedCount ?? null },
        ],
      },
      sales: {
        count: salesCompute.count,
        total_incl_vat: salesCompute.total_incl_vat,
        recent_ids: salesRecent,
      },
      calls: {
        count_today: callsTodayRes.count,
        next: callsNext,
      },
      dave: {
        resolved: dave,
        retentie_gebeld: daveRetentie,
        follow_ups_gedraaid: daveFollowups,
        voicememos_sent: daveVoicememosSent,
        voicememos_pending: daveVoicememosPending,
        voicememos_recent: (daveVoicememoRes?.data || []).map(v => ({
          id: v.id,
          lead_label: trimName(v.lead_name || ''),
          scheduled_at: v.scheduled_at ? new Date(v.scheduled_at).toISOString() : null,
        })),
      },
      one_on_one: {
        count_today: oneOnOne.count,
        source: oneOnOne.source,
        as_of: oneOnOne.as_of,
      },
      staff_ranking: staffRanking,
      feed: feed.slice(0, 15),
    };

    _cache = { at: now, payload };
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[display-metrics]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
