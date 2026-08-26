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
import { nlDayStart, nlDayEndExclusive, nlDateString } from './_lib/nl-period.js';
import { computeLeadsByTraject } from './_lib/leads-per-traject-compute.js';
import { computeSignedDealsTotal } from './_lib/sales-signed-deals-compute.js';
import { getBubbleOneOnOneCountToday } from './_lib/bubble-one-on-one-count.js';

const CACHE_TTL_MS = 10_000;
let _cache = { at: 0, payload: null };

// Actie-whitelist voor de "mutations"-tak (bron D) van de execution-score.
// activity_log logt vooral page-views (.view/.access) — voicememo's/calls/
// outcomes staan er NIET in (die tellen we uit follow_up_* tabellen als
// bronnen A/B/C). Deze whitelist = puur CRM-mutaties. Env-override:
//   DISPLAY_RANKING_ACTIONS="sales.customer.create,sales.deal.create,..."
const RANKING_ACTIONS_DEFAULT = [
  'sales.customer.create', 'sales.deal.create', 'sales.deal.edit',
  'onboarding.create', 'onboarding.assign_mentor',
  'finance.inbox.send', 'email.reply.send',
  'finance.arrangements.approve', 'finance.dunning.execute',
  'finance.incasso.manage', 'finance.invoice.payment.register',
  'agents.approval.act', 'events.team_member.link', 'leads.delete',
];

// Actieve staff-rollen — voorkomt dat een toevallige viewer-actie in de
// ranglijst sluipt. profiles.role wordt gejoined via één batch-fetch.
const STAFF_ROLES = new Set([
  'super_admin', 'admin', 'manager', 'sales', 'mentor', 'marketing', 'administratie',
]);

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
    // [Fix 1 · 2026-08-26] Was `.slice(0,10)` op UTC-instant → gaf gister-datum
    // (dayStart NL 00:00 = 22:00 UTC → sinceStr='2026-08-25' i.p.v. '2026-08-26'
    // in zomertijd). Sales van vandaag vielen buiten range → count=0.
    // nlDateString() geeft NL-tz-aware YYYY-MM-DD.
    const sinceStr = nlDateString(dayStart);
    const untilStr = nlDateString(dayEnd);
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
      /* 3 */ // 2026-08-26: limit 5→10 nu ranglijst weg is (up-list-tegel groter).
              supabaseAdmin.from('follow_up_appointments')
                .select('id, scheduled_at, lead_name, zoom_meeting_id')
                .gte('scheduled_at', new Date().toISOString()).eq('status', 'scheduled')
                .order('scheduled_at', { ascending: true }).limit(10),
      /* 4 */ supabaseAdmin.from('activity_log').select('user_id')
                .in('action', rankingActions)
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
      // v3 (2026-08-26): feed-bronnen op HELE NL-vandaag i.p.v. 2h-window,
      // zodat de feed altijd gevuld is en aflopend blijft stromen.
      // Elk .limit(20) → samen max 100 kandidaten → top-15 in payload.
      /* 5 */ supabaseAdmin.from('email_messages').select('id, from_name, date_received')
                .eq('category', 'Nieuwe Lead').gte('date_received', dayStartIso).lt('date_received', dayEndIso)
                .order('date_received', { ascending: false }).limit(20),
      /* 6 */ // Feed sales: LEEG. We deriveren uit salesCompute.recent_ids
              // (clean-set die ook sales.count/total voedt). Index blijft
              // bezet zodat pick(7-13) niet schuift.
              Promise.resolve({ data: [] }),
      /* 7 */ supabaseAdmin.from('follow_up_appointments').select('id, lead_name, updated_at')
                .eq('status', 'completed').gte('updated_at', dayStartIso).lt('updated_at', dayEndIso)
                .order('updated_at', { ascending: false }).limit(20),
      /* 8 */ // v3-fix: voicememo_sent_at (echte send-timestamp) i.p.v.
              // updated_at (batch-updates clusterden alles → feed leek bevroren).
              supabaseAdmin.from('follow_up_appointments').select('id, lead_name, voicememo_sent_at')
                .eq('voicememo_status', 'sent').gte('voicememo_sent_at', dayStartIso).lt('voicememo_sent_at', dayEndIso)
                .order('voicememo_sent_at', { ascending: false }).limit(20),
      /* 9 */ supabaseAdmin.from('follow_up_outcomes').select('id, created_at')
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso)
                .order('created_at', { ascending: false }).limit(20),
      /*10 */ supabaseAdmin.from('event_signup_inbox').select('id, first_name, event_date_label, created_at')
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso)
                .order('created_at', { ascending: false }).limit(20),
      /*11 */ dave.user_id
                ? computeMetrics(supabaseAdmin, { period: 'today', ownerScope: dave.user_id })
                : Promise.resolve(null),
      /*12 */ dave.user_id
                ? supabaseAdmin.from('follow_up_appointments')
                    .select('id, lead_name, scheduled_at').eq('owner_id', dave.user_id)
                    .eq('voicememo_status', 'sent')
                    // [Fix 4] voicememo_sent_at (echte send-timestamp) i.p.v. updated_at
                    .gte('voicememo_sent_at', dayStartIso).lt('voicememo_sent_at', dayEndIso)
                    .order('voicememo_sent_at', { ascending: false }).limit(10)
                : Promise.resolve({ data: [] }),
      /*13 */ getBubbleOneOnOneCountToday({ start: dayStart, endExclusive: dayEnd }),
      // ─── execution-score bronnen (APPENDED, geen index-shift van 5-13) ───
      /*14 */ // A: afgeronde calls per owner (NL-vandaag)
              supabaseAdmin.from('follow_up_appointments').select('owner_id')
                .eq('status', 'completed')
                .gte('scheduled_at', dayStartIso).lt('scheduled_at', dayEndIso),
      /*15 */ // B: verstuurde voicememo's per owner (NL-vandaag).
              // [Fix 4 · 2026-08-26] Was updated_at → overtelde batch/RLS-updates
              // die eergister voicememo-rijen aanraakten (2026-08-26: Dave 16 vs
              // realiteit 6). voicememo_sent_at wordt alleen door POST-verzend-
              // flow gezet → echte "vandaag verstuurd" count.
              supabaseAdmin.from('follow_up_appointments').select('owner_id')
                .eq('voicememo_status', 'sent')
                .gte('voicememo_sent_at', dayStartIso).lt('voicememo_sent_at', dayEndIso),
      /*16 */ // C: outcomes per owner via PostgREST inner-join op appointment.owner_id
              supabaseAdmin.from('follow_up_outcomes')
                .select('id, appointment_id, created_at, follow_up_appointments!inner(owner_id)')
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
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
    // Execution-score bronnen A/B/C (appended):
    const rankCallsRes       = pick(14, { data: [] });
    const rankVoicememoRes   = pick(15, { data: [] });
    const rankOutcomesRes    = pick(16, { data: [] });

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

    // ── Staff execution-score (A + B + C + D per user) ────────────────────
    // A: afgeronde calls (owner_id), B: voicememo's (owner_id),
    // C: outcomes (via appointment.owner_id join), D: activity_log CRM-mutaties.
    // A/B/C zijn owner_id-attributie, D is user_id — beide keys zijn een
    // profile-uuid dus we mergen in één map. Voicememo/call/outcome staan
    // NIET in activity_log → geen dubbeltelling.
    const rankAgg = new Map(); // uid → { calls, voicememos, outcomes, mutations }
    const bump = (uid, key) => {
      if (!uid) return;
      let row = rankAgg.get(uid);
      if (!row) { row = { calls: 0, voicememos: 0, outcomes: 0, mutations: 0 }; rankAgg.set(uid, row); }
      row[key] += 1;
    };
    for (const r of (rankCallsRes.data     || [])) bump(r.owner_id, 'calls');
    for (const r of (rankVoicememoRes.data || [])) bump(r.owner_id, 'voicememos');
    for (const r of (rankOutcomesRes.data  || [])) {
      // PostgREST-join levert het gerelateerde record als object of array — beide vormen zien we.
      const fa = r.follow_up_appointments;
      const ownerId = Array.isArray(fa) ? fa[0]?.owner_id : fa?.owner_id;
      bump(ownerId, 'outcomes');
    }
    for (const r of (rankingRes.data || [])) bump(r.user_id, 'mutations');

    // Batch: profiles voor alle uids (naam + rol-filter tegelijk).
    const uids = [...rankAgg.keys()];
    let profMap = new Map(); // uid → { full_name, role, is_active }
    if (uids.length) {
      const profsRes = await safeAwait(
        supabaseAdmin.from('profiles').select('id, full_name, role, is_active').in('id', uids),
        { data: [] },
        'rankProfiles'
      );
      profMap = new Map((profsRes.data || []).map(p => [p.id, p]));
    }

    const staffRanking = [...rankAgg.entries()]
      .filter(([uid]) => {
        // Alleen actieve CRM-staff — voorkomt viewer/student in de lijst.
        const p = profMap.get(uid);
        if (!p || p.is_active === false) return false;
        return STAFF_ROLES.has(p.role);
      })
      .map(([uid, br]) => {
        const count = br.calls + br.voicememos + br.outcomes + br.mutations;
        // Voornaam voluit — interne collega's, geen klant-PII-trim.
        const full = (profMap.get(uid)?.full_name || 'Onbekend').trim();
        const firstName = full.split(/\s+/)[0] || 'Onbekend';
        return { user_label: firstName, count, breakdown: br };
      })
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ── Feed sales derive uit salesCompute.recent_ids ─────────────────────
    // Fix 1 (2026-08-26): oude losse deals-query miste test-deal- +
    // declined/archived-filters → feed toonde soms sale die sales.count NIET
    // telde ("Sale: Andrea M." bij sales.count=0). Nu gebruiken we dezelfde
    // clean-set als sales.count/total, gefilterd op accepted_at binnen laatste
    // 2h. Klant-labels zijn al PII-veilig getrimd door compute-helper.
    const twoHoursAgoIso = twoHoursAgo.toISOString();
    const feedSalesClean = (salesCompute.recent_ids || [])
      .filter(s => s.accepted_at && s.accepted_at >= twoHoursAgoIso)
      .slice(0, 5);

    // ── Feed 6-way ────────────────────────────────────────────────────────
    const feed = [];
    for (const e of (feedLeadsRes.data || [])) feed.push({
      ts: new Date(e.date_received).toISOString(), type: 'lead',
      text: `Nieuwe lead: ${trimName(e.from_name || '')}`,
    });
    for (const s of feedSalesClean) feed.push({
      ts: s.accepted_at, type: 'sale',
      text: `Sale: ${s.customer_label}`,
    });
    for (const a of (feedCallsCompleted.data || [])) feed.push({
      ts: new Date(a.updated_at).toISOString(), type: 'call',
      text: `Call afgerond: ${trimName(a.lead_name || '')}`,
    });
    for (const v of (feedVoicememoRes.data || [])) feed.push({
      // v3: voicememo_sent_at (echte send-timestamp) matcht teller/ranglijst.
      ts: new Date(v.voicememo_sent_at).toISOString(), type: 'voicememo',
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
    // Fix 2 (2026-08-26): voicememos_sent uit dezelfde bron als ranking-B
    // (rankVoicememoRes = updated_at NL-vandaag). computeMetrics gebruikte
    // scheduled_at-in-vandaag → gaf Dave 6 terwijl ranglijst 16 telde. Beide
    // tegels tonen nu identiek getal — 1 bron, 0 dubbeltelling.
    const daveVoicememosSent = dave.user_id
      ? (rankVoicememoRes.data || []).filter(r => r.owner_id === dave.user_id).length
      : 0;
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
    // [Fix 2 · 2026-08-26] Hero "Nieuwe leads" = alleen echte lead-bronnen
    // (challenge/mini/event/webinar). Calls-bucket blijft als aparte 5e tegel
    // in .leads.buckets[], telt NIET mee in het hero-totaal. Matcht v2-hero.
    const leadsTotal = (leadsCompute.total_incl_afwijzer === null || leadsCompute.total_incl_afwijzer === undefined)
      ? null
      : leadsCompute.total_incl_afwijzer;

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
        count_today:  callsTodayRes.count,     // afgeronde Zoom-calls vandaag (foot v-calls-sub)
        booked_today: callsBookedCount,        // GEBOEKTE calls vandaag (created_at) → hero v-calls
        next:         callsNext,
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
