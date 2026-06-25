// api/agents-activity.js
//
// GET → live "hartslag"-stats per agent voor het Agent command center. Read-only.
// Geen secrets, geen PII — alleen aantallen + timestamps.
//
// Permissie: admin.joost_config (mirror van agents-config-list — beheerderslens).
//
// Aanpak:
//   - Trio (finance / events / onboarding) leeft op joost_suggestions +
//     whatsapp_conversations + whatsapp_messages.
//   - Module-koppeling via whatsapp_module_config (module ↔ phone_number_id),
//     1× gefetcht en gemapt.
//   - "open_suggestions" = joost_suggestions.status='PROPOSED' per module.
//   - "handoffs" = idem + jsonb-filter context_snapshot->handoff->>needs_human=true.
//   - "messages_today" = whatsapp_messages.sent_at >= 00:00 lokale start van
//     de dag, conversation_id IN convs van die module.
//   - "active_conversations" = whatsapp_conversations.last_message_at >= 7d.
//   - "last_activity_at" = max(last_message_at) over conv-set.
//
//   Lisa leeft op lisa_conversations + lisa_messages (live, is_sandbox=false):
//   - conversations_today, qualified, call_booked, human_takeover,
//     messages_today, last_activity_at.
//
//   team_totals aggregeert open_suggestions + handoffs (trio) + human_takeover
//   (lisa) → uitgangspunt voor Fase 3 hub-badge.
//
// Efficiëntie:
//   - count: 'exact', head: true waar mogelijk (geen rows mee terug).
//   - Geen full-table-scans buiten today-window of (open) status='PROPOSED'.
//   - Geen joins: per module conv-ids lokaal in JS mappen vanuit 2 lookup-tabellen.
//   - Per module 1 jsonb-needs_human-query → klein subset (alleen PROPOSED).
//
// Errors zijn lokaal-fail-soft per module: een module-stat faal logt + geeft
// nulwaarden terug; het endpoint zelf geeft alleen 500 op de top-level. UI
// blijft dan kaart-zonder-stats tonen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TRIO_MODULES = ['finance', 'events', 'onboarding'];
const ACTIVE_CONV_WINDOW_DAYS = 7;

function startOfTodayIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

async function safeCount(promise, label) {
  try {
    const res = await promise;
    if (res.error) {
      console.warn('[agents-activity] count', label, res.error.message);
      return 0;
    }
    return res.count || 0;
  } catch (e) {
    console.warn('[agents-activity] count-exception', label, e?.message || e);
    return 0;
  }
}

async function fetchModuleStats(moduleKey, modPnIds, sinceTodayIso, sinceWeekIso) {
  // 1) Open suggestions (PROPOSED) voor deze module.
  const openP = supabaseAdmin
    .from('joost_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('module', moduleKey)
    .eq('status', 'PROPOSED');

  // 2) Handoffs binnen open suggestions: jsonb-pad context_snapshot.handoff.needs_human=true.
  //    PostgREST jsonb-filter: kolom -> filter eq.true op tekstcoercie.
  const handoffP = supabaseAdmin
    .from('joost_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('module', moduleKey)
    .eq('status', 'PROPOSED')
    .eq('context_snapshot->handoff->>needs_human', 'true');

  // 3-5) Vereisen module-conversation-ids.
  let convIds = [];
  let activeConvCount = 0;
  let lastActivityAt = null;
  let messagesToday = 0;

  if (modPnIds.length > 0) {
    try {
      // Pak conv-ids + last_message_at voor active-count + last_activity in 1 query.
      const { data: convs, error: convErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, last_message_at')
        .in('phone_number_id', modPnIds)
        .limit(5000);
      if (convErr) {
        console.warn('[agents-activity] convs', moduleKey, convErr.message);
      } else {
        convIds = (convs || []).map((c) => c.id);
        const weekCutoff = new Date(sinceWeekIso).getTime();
        let maxTs = 0;
        for (const c of (convs || [])) {
          const ts = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
          if (ts >= weekCutoff) activeConvCount += 1;
          if (ts > maxTs) maxTs = ts;
        }
        if (maxTs > 0) lastActivityAt = new Date(maxTs).toISOString();
      }
    } catch (e) {
      console.warn('[agents-activity] convs-exception', moduleKey, e?.message || e);
    }
  }

  // Messages today — chunked .in() bij grote conv-sets (PostgREST IN-limit ~1000).
  if (convIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < convIds.length; i += CHUNK) {
      const slice = convIds.slice(i, i + CHUNK);
      messagesToday += await safeCount(
        supabaseAdmin
          .from('whatsapp_messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', slice)
          .gte('sent_at', sinceTodayIso),
        'msgs-today-' + moduleKey
      );
    }
  }

  const [openSuggestions, handoffs] = await Promise.all([
    safeCount(openP,    'open-' + moduleKey),
    safeCount(handoffP, 'handoff-' + moduleKey),
  ]);

  return {
    module:                moduleKey,
    open_suggestions:      openSuggestions,
    handoffs,
    messages_today:        messagesToday,
    active_conversations:  activeConvCount,
    last_activity_at:      lastActivityAt,
  };
}

async function fetchLisaStats(sinceTodayIso) {
  const out = {
    conversations_today: 0,
    qualified:           0,
    call_booked:         0,
    human_takeover:      0,
    messages_today:      0,
    last_activity_at:    null,
  };

  // 4 counts in parallel — allemaal head:true.
  const baseLisaConv = () => supabaseAdmin
    .from('lisa_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('is_sandbox', false)
    .gte('created_at', sinceTodayIso);

  const [conv, qua, bk, hto] = await Promise.all([
    safeCount(baseLisaConv(), 'lisa-conv-today'),
    safeCount(baseLisaConv().eq('qualified', true), 'lisa-qualified-today'),
    safeCount(baseLisaConv().eq('call_booked', true), 'lisa-booked-today'),
    safeCount(baseLisaConv().eq('human_takeover', true), 'lisa-takeover-today'),
  ]);
  out.conversations_today = conv;
  out.qualified           = qua;
  out.call_booked         = bk;
  out.human_takeover      = hto;

  // Messages today.
  out.messages_today = await safeCount(
    supabaseAdmin
      .from('lisa_messages')
      .select('id', { count: 'exact', head: true })
      .gte('sent_at', sinceTodayIso),
    'lisa-msgs-today'
  );

  // Last activity (max sent_at vandaag) — 1 row, order desc.
  try {
    const { data, error } = await supabaseAdmin
      .from('lisa_messages')
      .select('sent_at')
      .gte('sent_at', sinceTodayIso)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data?.sent_at) out.last_activity_at = data.sent_at;
  } catch (e) {
    console.warn('[agents-activity] lisa-last-activity', e?.message || e);
  }

  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const sinceTodayIso = startOfTodayIso();
  const sinceWeekIso  = daysAgoIso(ACTIVE_CONV_WINDOW_DAYS);

  try {
    // Module → phone_number_id map ophalen.
    const { data: modCfgRows, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('module, phone_number_id, is_active');
    if (modErr) {
      console.warn('[agents-activity] module-config:', modErr.message);
    }
    const pnIdsByModule = new Map();
    for (const r of (modCfgRows || [])) {
      if (!r.module || !r.phone_number_id) continue;
      const arr = pnIdsByModule.get(r.module) || [];
      arr.push(r.phone_number_id);
      pnIdsByModule.set(r.module, arr);
    }

    // Trio + Lisa parallel.
    const [trioResults, lisa] = await Promise.all([
      Promise.all(TRIO_MODULES.map((m) =>
        fetchModuleStats(m, pnIdsByModule.get(m) || [], sinceTodayIso, sinceWeekIso)
      )),
      fetchLisaStats(sinceTodayIso),
    ]);

    // team_totals: som van handoffs (trio) + human_takeover (lisa).
    const team_totals = {
      open_suggestions: trioResults.reduce((acc, r) => acc + (r.open_suggestions || 0), 0),
      handoffs:         trioResults.reduce((acc, r) => acc + (r.handoffs || 0), 0)
                        + (lisa.human_takeover || 0),
    };

    return res.status(200).json({
      ok:           true,
      generated_at: new Date().toISOString(),
      trio:         trioResults,
      lisa,
      team_totals,
    });
  } catch (e) {
    console.error('[agents-activity]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
