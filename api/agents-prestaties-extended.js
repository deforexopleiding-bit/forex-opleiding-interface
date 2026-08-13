// api/agents-prestaties-extended.js
//
// GET → uitgebreide analytics voor de Prestaties-tab in de AI Agents-hub:
//   {
//     weekly:         { joost:[{week_start,count}], simone:[...], mila:[...], lisa:[...] },   // 8w
//     response_times: { joost:{avg_seconds,count}, simone:{...}, mila:{...}, lisa:{...} },     // 7d cap
//     feedback_counts:{ joost:{up,down}, simone:{...}, mila:{...}, lisa:{...} },
//     windows: { weekly_weeks:8, response_days:7 },
//     truncated: { … per agent boolean als cap-limiet bereikt }
//   }
//
// Aanpak zonder schema-wijziging:
//   - Weekly: per module conv-ids ophalen uit whatsapp_conversations
//     (via whatsapp_module_config.phone_number_id), dan
//     whatsapp_messages.sent_at (>= 8w) in JS bucketen per ISO-week.
//     Lisa: lisa_messages.sent_at (>= 8w) waar is_sandbox=false.
//   - Response times: per module dezelfde conv-set, messages van laatste 7d,
//     sorteer per conv/sent_at, verzamel per inbound→eerstvolgende-outbound
//     delta's, avg. Cap: max 3000 messages per module. Lisa: idem.
//   - Feedback: agent_suggestion_feedback GROUP BY agent_key, rating.
//     Fail-soft als tabel nog niet bestaat (migratie niet gedraaid).
//
// Fail-soft per sub-analyse; UI toont "—" bij te weinig data of fout.
// Permission: admin.joost_config (mirror van rest van agent-hub).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TRIO = [
  { key: 'joost',  module: 'finance'    },
  { key: 'simone', module: 'events'     },
  { key: 'mila',   module: 'onboarding' },
];

const WEEKLY_WEEKS   = 8;
const RESPONSE_DAYS  = 7;
const MESSAGE_CAP    = 3000;   // per agent, per fase (weekly/response)
const CONV_CAP       = 5000;   // convs per module ophalen (whatsapp_conversations.in-limit)

function daysAgoIso(n) { return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString(); }
function weeksAgoIso(n) { return new Date(Date.now() - n * 7 * 24 * 3600 * 1000).toISOString(); }

// ISO week start (maandag 00:00 UTC) voor bucketing.
function weekStartUtc(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;   // ma=0 .. zo=6
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Bucket sent_ats naar {week_start, count}[] (leeftijd-oplopend).
function bucketWeeks(sentAts, weeks) {
  const now = Date.now();
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(now - i * 7 * 24 * 3600 * 1000);
    buckets.push({ week_start: weekStartUtc(start.toISOString()), count: 0 });
  }
  // Uniek maken op week_start (dedupe bij drift)
  const byStart = new Map();
  for (const b of buckets) if (!byStart.has(b.week_start)) byStart.set(b.week_start, b);
  const list = Array.from(byStart.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));
  for (const iso of sentAts) {
    if (!iso) continue;
    const w = weekStartUtc(iso);
    const b = byStart.get(w);
    if (b) b.count += 1;
  }
  return list;
}

function avgResponseSeconds(rows /* [{conversation_id, direction, sent_at}] al ORDER BY conv, sent_at */) {
  if (!rows || rows.length === 0) return { avg_seconds: null, count: 0 };
  let deltas = [];
  let lastConv = null;
  let openInbound = null;
  for (const r of rows) {
    if (r.conversation_id !== lastConv) { lastConv = r.conversation_id; openInbound = null; }
    const dir = String(r.direction || '').toLowerCase();
    if (dir === 'in' || dir === 'inbound' || dir === 'incoming') {
      if (openInbound == null) openInbound = new Date(r.sent_at).getTime();
    } else if (dir === 'out' || dir === 'outbound' || dir === 'outgoing') {
      if (openInbound != null) {
        const outTs = new Date(r.sent_at).getTime();
        const delta = Math.max(0, Math.round((outTs - openInbound) / 1000));
        // Alleen "redelijke" reacties: cap op 24u (aan de rand: waarschijnlijk niet dezelfde context)
        if (delta <= 86400) deltas.push(delta);
        openInbound = null;
      }
    }
  }
  if (deltas.length === 0) return { avg_seconds: null, count: 0 };
  const sum = deltas.reduce((a, b) => a + b, 0);
  return { avg_seconds: Math.round(sum / deltas.length), count: deltas.length };
}

async function convIdsForModule(moduleKey, pnIdMap) {
  const pnIds = pnIdMap.get(moduleKey) || [];
  if (pnIds.length === 0) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id')
      .in('phone_number_id', pnIds)
      .limit(CONV_CAP);
    if (error) { console.warn('[prestaties-ext] convs', moduleKey, error.message); return []; }
    return (data || []).map((r) => r.id);
  } catch (e) {
    console.warn('[prestaties-ext] convs-exception', moduleKey, e?.message || e);
    return [];
  }
}

async function fetchSentAts(convIds, sinceIso, cap) {
  if (!convIds.length) return { rows: [], truncated: false };
  // Chunk .in() bij grote conv-sets (Postgrest heeft ~1000 IN-limit)
  const CHUNK = 500;
  const collected = [];
  let truncated = false;
  for (let i = 0; i < convIds.length && collected.length < cap; i += CHUNK) {
    const slice = convIds.slice(i, i + CHUNK);
    try {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('sent_at')
        .in('conversation_id', slice)
        .gte('sent_at', sinceIso)
        .order('sent_at', { ascending: false })
        .limit(cap - collected.length);
      if (error) { console.warn('[prestaties-ext] msgs', error.message); continue; }
      for (const r of (data || [])) {
        if (collected.length >= cap) { truncated = true; break; }
        collected.push(r.sent_at);
      }
    } catch (e) {
      console.warn('[prestaties-ext] msgs-exception', e?.message || e);
    }
  }
  return { rows: collected, truncated };
}

async function fetchDirectionRows(convIds, sinceIso, cap) {
  if (!convIds.length) return { rows: [], truncated: false };
  const CHUNK = 500;
  const collected = [];
  let truncated = false;
  for (let i = 0; i < convIds.length && collected.length < cap; i += CHUNK) {
    const slice = convIds.slice(i, i + CHUNK);
    try {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('conversation_id, direction, sent_at')
        .in('conversation_id', slice)
        .gte('sent_at', sinceIso)
        .order('conversation_id', { ascending: true })
        .order('sent_at', { ascending: true })
        .limit(cap - collected.length);
      if (error) { console.warn('[prestaties-ext] dir', error.message); continue; }
      for (const r of (data || [])) {
        if (collected.length >= cap) { truncated = true; break; }
        collected.push(r);
      }
    } catch (e) {
      console.warn('[prestaties-ext] dir-exception', e?.message || e);
    }
  }
  return { rows: collected, truncated };
}

async function lisaSentAts(sinceIso, cap) {
  try {
    const { data, error } = await supabaseAdmin
      .from('lisa_messages')
      .select('sent_at')
      .gte('sent_at', sinceIso)
      .order('sent_at', { ascending: false })
      .limit(cap);
    if (error) { console.warn('[prestaties-ext] lisa-msgs', error.message); return { rows: [], truncated: false }; }
    const rows = (data || []).map((r) => r.sent_at);
    return { rows, truncated: rows.length >= cap };
  } catch (e) {
    console.warn('[prestaties-ext] lisa-msgs-exception', e?.message || e);
    return { rows: [], truncated: false };
  }
}
async function lisaDirectionRows(sinceIso, cap) {
  try {
    const { data, error } = await supabaseAdmin
      .from('lisa_messages')
      .select('conversation_id, direction, sent_at')
      .gte('sent_at', sinceIso)
      .order('conversation_id', { ascending: true })
      .order('sent_at', { ascending: true })
      .limit(cap);
    if (error) { console.warn('[prestaties-ext] lisa-dir', error.message); return { rows: [], truncated: false }; }
    return { rows: data || [], truncated: (data || []).length >= cap };
  } catch (e) {
    console.warn('[prestaties-ext] lisa-dir-exception', e?.message || e);
    return { rows: [], truncated: false };
  }
}

async function feedbackCounts() {
  const empty = { joost:{up:0,down:0}, simone:{up:0,down:0}, mila:{up:0,down:0}, lisa:{up:0,down:0} };
  try {
    const { data, error } = await supabaseAdmin
      .from('agent_suggestion_feedback')
      .select('agent_key, rating');
    if (error) {
      // Tabel bestaat nog niet (migratie niet gedraaid) → geef lege telling terug, geen 500.
      console.warn('[prestaties-ext] feedback (tabel-vraag skipt):', error.message);
      return { counts: empty, unavailable: true };
    }
    const out = { ...empty };
    for (const r of (data || [])) {
      const k = String(r.agent_key || '').toLowerCase();
      if (!out[k]) out[k] = { up:0, down:0 };
      if (r.rating === 'up') out[k].up++;
      else if (r.rating === 'down') out[k].down++;
    }
    return { counts: out, unavailable: false };
  } catch (e) {
    console.warn('[prestaties-ext] feedback-exception:', e?.message || e);
    return { counts: empty, unavailable: true };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const sinceWeekly   = weeksAgoIso(WEEKLY_WEEKS);
  const sinceResponse = daysAgoIso(RESPONSE_DAYS);

  try {
    // 1) Module → phone_number_ids
    const { data: modCfg } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('module, phone_number_id, is_active');
    const pnIdMap = new Map();
    for (const r of (modCfg || [])) {
      if (!r.module || !r.phone_number_id) continue;
      const arr = pnIdMap.get(r.module) || [];
      arr.push(r.phone_number_id); pnIdMap.set(r.module, arr);
    }

    // 2) Trio: conv-ids ophalen (1× per module, gedeeld tussen weekly + response)
    const trioConvIds = {};
    await Promise.all(TRIO.map(async (t) => {
      trioConvIds[t.key] = await convIdsForModule(t.module, pnIdMap);
    }));

    // 3) Weekly: sent_at ophalen + bucketen
    const weekly = {};
    const weeklyTruncated = {};
    await Promise.all([
      ...TRIO.map(async (t) => {
        const { rows, truncated } = await fetchSentAts(trioConvIds[t.key], sinceWeekly, MESSAGE_CAP);
        weekly[t.key] = bucketWeeks(rows, WEEKLY_WEEKS);
        weeklyTruncated[t.key] = truncated;
      }),
      (async () => {
        const { rows, truncated } = await lisaSentAts(sinceWeekly, MESSAGE_CAP);
        weekly.lisa = bucketWeeks(rows, WEEKLY_WEEKS);
        weeklyTruncated.lisa = truncated;
      })(),
    ]);

    // 4) Response times
    const responseTimes = {};
    const responseTruncated = {};
    await Promise.all([
      ...TRIO.map(async (t) => {
        const { rows, truncated } = await fetchDirectionRows(trioConvIds[t.key], sinceResponse, MESSAGE_CAP);
        responseTimes[t.key] = avgResponseSeconds(rows);
        responseTruncated[t.key] = truncated;
      }),
      (async () => {
        const { rows, truncated } = await lisaDirectionRows(sinceResponse, MESSAGE_CAP);
        responseTimes.lisa = avgResponseSeconds(rows);
        responseTruncated.lisa = truncated;
      })(),
    ]);

    // 5) Feedback
    const fb = await feedbackCounts();

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      windows: { weekly_weeks: WEEKLY_WEEKS, response_days: RESPONSE_DAYS, message_cap: MESSAGE_CAP },
      weekly,
      response_times: responseTimes,
      feedback_counts: fb.counts,
      feedback_unavailable: fb.unavailable === true,
      truncated: { weekly: weeklyTruncated, response: responseTruncated },
    });
  } catch (e) {
    console.error('[prestaties-ext]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
