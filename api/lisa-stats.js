// api/lisa-stats.js
// Aggregeert Lisa-performance metrics voor het Stats-dashboard (alleen live, niet-sandbox).
//   GET ?period=today|week|month|all
// Auth: verifyAdmin (read). Service role voor de aggregatie-queries.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const ALL_PHASES = ['intro', 'doel', 'situatie', 'band', 'call', 'qualified', 'disqualified', 'done', 'cold'];
const MSG_LIMIT = 10000;

function computeSince(period) {
  const now = new Date();
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  if (period === 'month') return new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  if (period === 'all') return '2020-01-01T00:00:00Z';
  return new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString(); // week (default)
}

function aggregateByPhase(rows) {
  const counts = {};
  ALL_PHASES.forEach((p) => { counts[p] = 0; });
  rows.forEach((r) => { const p = r.phase || 'intro'; counts[p] = (counts[p] || 0) + 1; });
  return counts;
}

function aggregateDisqualified(rows) {
  const counts = {};
  rows.forEach((r) => {
    const reason = (r.disqualified_reason || 'onbekend').trim().toLowerCase();
    counts[reason] = (counts[reason] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));
}

function aggregateFollowups(rows) {
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    scheduled: rows.filter((r) => r.status === 'scheduled').length,
    delayed: rows.filter((r) => r.is_delayed_response).length,
    regular: rows.filter((r) => r.is_regular_followup).length,
  };
}

// Ruwe kostenschatting (US$/M tokens, gemengd in/out). Mag later verfijnd.
function modelRate(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 30;
  if (m.includes('sonnet')) return 6;
  if (m.includes('haiku')) return 1;
  return 10;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const period = req.query.period || 'week';
    const since = computeSince(period);
    const liveConv = () => supabaseAdmin.from('lisa_conversations').select('id', { count: 'exact', head: true }).eq('is_sandbox', false).gte('created_at', since);

    const [
      conversationsTotal, conversationsQualified, conversationsBooked,
      conversationsByPhase, disqualifiedReasons, messages, followups, settings,
    ] = await Promise.all([
      liveConv(),
      liveConv().eq('qualified', true),
      liveConv().eq('call_booked', true),
      supabaseAdmin.from('lisa_conversations').select('phase').eq('is_sandbox', false).gte('created_at', since),
      supabaseAdmin.from('lisa_conversations').select('disqualified_reason').eq('is_sandbox', false).not('disqualified_reason', 'is', null).gte('created_at', since),
      // Eén message-query voedt zowel berichten-aggregatie als kosten (geen dubbele 10k-fetch).
      supabaseAdmin.from('lisa_messages').select('direction, is_followup, ai_generated, tokens_used, model_used').gte('sent_at', since).limit(MSG_LIMIT),
      supabaseAdmin.from('lisa_followups').select('status, is_regular_followup, is_delayed_response').gte('created_at', since),
      supabaseAdmin.from('lisa_settings').select('*').eq('id', 1).maybeSingle(),
    ]);

    const msgRows = messages.data || [];
    const messagesAgg = {
      in: msgRows.filter((r) => r.direction === 'in').length,
      out: msgRows.filter((r) => r.direction === 'out').length,
      followup_out: msgRows.filter((r) => r.is_followup && r.direction === 'out').length,
      ai_out: msgRows.filter((r) => r.ai_generated && r.direction === 'out').length,
    };

    const costBreakdown = {};
    let totalTokens = 0, totalCostUsd = 0;
    for (const r of msgRows) {
      if (!r.ai_generated) continue;
      const tokens = r.tokens_used || 0;
      if (!tokens) continue;
      const model = r.model_used || 'unknown';
      const cost = (tokens / 1_000_000) * modelRate(model);
      if (!costBreakdown[model]) costBreakdown[model] = { tokens: 0, cost: 0 };
      costBreakdown[model].tokens += tokens;
      costBreakdown[model].cost = +(costBreakdown[model].cost + cost).toFixed(4);
      totalTokens += tokens; totalCostUsd += cost;
    }

    const followupAgg = aggregateFollowups(followups.data || []);
    const totalConv = conversationsTotal.count || 0;
    const qualifiedCount = conversationsQualified.count || 0;
    const bookedCount = conversationsBooked.count || 0;
    const pct = (n) => (totalConv > 0 ? +(n / totalConv * 100).toFixed(1) : 0);

    return res.status(200).json({
      period, since,
      totals: {
        conversations: totalConv, qualified: qualifiedCount, call_booked: bookedCount,
        messages_in: messagesAgg.in, messages_out: messagesAgg.out,
        followups_sent: followupAgg.sent, followups_cancelled: followupAgg.cancelled,
      },
      conversion_funnel: { new: totalConv, qualified: qualifiedCount, booked: bookedCount, qualified_pct: pct(qualifiedCount), booked_pct: pct(bookedCount) },
      phase_distribution: aggregateByPhase(conversationsByPhase.data || []),
      disqualified_top5: aggregateDisqualified(disqualifiedReasons.data || []),
      followups: {
        sent: followupAgg.sent, cancelled: followupAgg.cancelled, delayed: followupAgg.delayed, regular: followupAgg.regular,
        success_rate: followupAgg.total > 0 ? +(followupAgg.sent / followupAgg.total * 100).toFixed(1) : 0,
      },
      cost: { total_tokens: totalTokens, total_cost_usd: totalCostUsd.toFixed(2), total_cost_eur: (totalCostUsd * 0.92).toFixed(2), breakdown: costBreakdown },
      settings: settings.data || {},
    });
  } catch (err) {
    console.error('lisa-stats error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
