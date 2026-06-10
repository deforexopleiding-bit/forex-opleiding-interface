// api/finance-dashboard-counts.js
//
// Fast-aggregator voor de Finance Dashboard KPI-strip (Groep C, C1 in roadmap).
// Returnt 12 KPI-velden in één call zodat het dashboard met minimaal aantal
// round-trips kan renderen. Target sub-200ms via bulk-queries + count-only heads.
//
// Query-params:
//   period = today | week | month | quarter | year (default month)
//
// Response:
//   {
//     period,
//     periodStart,                    // ISO-string van periode-begin (UTC)
//     totaalOpenstaand,               // som amount_total - amount_paid op open + overdue + partially_paid
//     openFacturen,                   // count status=open
//     overdueFacturen,                // count status=overdue OF (open + due_date<now)
//     actieveArrangements,            // count status=ACTIEF
//     openVerifyPayment,              // count pending_actions action_type=MANUAL_VERIFY_PAYMENT status=PENDING
//     openEscalations,                // count pending_actions action_type=MANUAL_ESCALATION status=PENDING
//     bankBalans: { value, fetchedAt, accountCount },
//     cashflowVerwacht30d,            // som van openstaande facturen + actieve subs (rough)
//     joostStats: { sent, blocked, intents: { [intent]: count } },
//     conversieWanbetalersFlow,       // % opgelost (NAGEKOMEN) over begonnen (ACTIEF + NAGEKOMEN + VERBROKEN) in periode
//     mentorBonusPending,             // som amount van bonuses status='pending'
//     mrrSubscriptions,               // sum(amount / billing_cycle_in_months)
//   }
//
// Cache: SWR ~5min in-memory (module-scope). Eenvoudige implementatie acceptabel
// voor MVP (Vercel-cold-start gooit cache weg → eerst-call doet alles fresh).
// Persistent cache via app_settings is TODO in vervolg-PR.
//
// RBAC: finance.module.access via requirePermission fail-soft (geeft 403).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { aggregateActiveBankBalances } from './_lib/bank-balance.js';

const VALID_PERIODS = ['today', 'week', 'month', 'quarter', 'year'];
const SWR_TTL_MS = 5 * 60 * 1000; // 5 min

// In-memory cache (per Vercel-instance). Key = period.
const _cache = new Map();

function nowMs() { return Date.now(); }

function periodStartIso(period) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (period) {
    case 'today':   return d.toISOString();
    case 'week': {
      // Maandag = start van week (NL conventie).
      const day = d.getUTCDay() || 7;          // zondag=7
      d.setUTCDate(d.getUTCDate() - (day - 1));
      return d.toISOString();
    }
    case 'month':   d.setUTCDate(1); return d.toISOString();
    case 'quarter': {
      const q = Math.floor(d.getUTCMonth() / 3);
      d.setUTCMonth(q * 3, 1);
      return d.toISOString();
    }
    case 'year':    d.setUTCMonth(0, 1); return d.toISOString();
    default:        d.setUTCDate(1); return d.toISOString();
  }
}

function billingCycleMonths(cycle) {
  if (!cycle) return 1; // ontbrekend → behandelen als monthly (per lesson learned)
  const c = String(cycle).toLowerCase();
  if (c === 'per_month')      return 1;
  if (c === 'per_2_months')   return 2;
  if (c === 'per_quarter')    return 3;
  if (c === 'per_6_months')   return 6;
  if (c === 'per_year')       return 12;
  const m = c.match(/per_(\d+)_months/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

async function safeCount(builder, label) {
  try {
    const { count, error } = await builder;
    if (error) {
      console.error('[finance-dashboard-counts] count fail', label, error.message);
      return 0;
    }
    return typeof count === 'number' ? count : 0;
  } catch (e) {
    console.error('[finance-dashboard-counts] count exception', label, e?.message);
    return 0;
  }
}

async function computeTotaalOpenstaand() {
  // Som van amount_total - amount_paid voor open + overdue + partially_paid.
  // We doen dit met aparte select op de open-statussen ipv RPC om Supabase
  // dependencies minimaal te houden.
  try {
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('amount_total, amount_paid')
      .in('status', ['open', 'overdue', 'partially_paid']);
    if (error) {
      console.error('[finance-dashboard-counts] totaalOpenstaand fail:', error.message);
      return 0;
    }
    let sum = 0;
    for (const r of (data || [])) {
      const tot = Number(r.amount_total) || 0;
      const paid = Number(r.amount_paid) || 0;
      sum += Math.max(0, tot - paid);
    }
    return Math.round(sum * 100) / 100;
  } catch (e) {
    console.error('[finance-dashboard-counts] totaalOpenstaand exception:', e?.message);
    return 0;
  }
}

async function computeOpenAndOverdueFacturen() {
  // open = status=open. overdue = (status=overdue) UNION (status=open AND due_date<today).
  // We doen dit met 2 count-queries + 1 extra om dubbele te tellen indien nodig.
  // Voor sub-200ms: 3 head-counts parallel.
  const todayIso = new Date().toISOString().slice(0, 10);

  const [openCount, overdueExplicitCount, openOverdueCount] = await Promise.all([
    safeCount(
      supabaseAdmin.from('invoices').select('id', { count: 'exact', head: true })
        .eq('status', 'open'),
      'open',
    ),
    safeCount(
      supabaseAdmin.from('invoices').select('id', { count: 'exact', head: true })
        .eq('status', 'overdue'),
      'overdue_explicit',
    ),
    safeCount(
      supabaseAdmin.from('invoices').select('id', { count: 'exact', head: true })
        .eq('status', 'open').lt('due_date', todayIso),
      'open_overdue',
    ),
  ]);
  return {
    openFacturen:    openCount,
    overdueFacturen: overdueExplicitCount + openOverdueCount,
  };
}

async function computeActieveArrangements() {
  return safeCount(
    supabaseAdmin.from('payment_arrangements').select('id', { count: 'exact', head: true })
      .eq('status', 'ACTIEF'),
    'actieveArrangements',
  );
}

async function computeOpenVerifyPayment() {
  return safeCount(
    supabaseAdmin.from('pending_actions').select('id', { count: 'exact', head: true })
      .eq('action_type', 'MANUAL_VERIFY_PAYMENT').eq('status', 'PENDING'),
    'openVerifyPayment',
  );
}

async function computeOpenEscalations() {
  return safeCount(
    supabaseAdmin.from('pending_actions').select('id', { count: 'exact', head: true })
      .eq('action_type', 'MANUAL_ESCALATION').eq('status', 'PENDING'),
    'openEscalations',
  );
}

async function computeBankBalans() {
  try {
    const r = await aggregateActiveBankBalances({ force: false });
    return {
      value:        Math.round((r.total || 0) * 100) / 100,
      fetchedAt:    r.oldestFetchedAt,
      accountCount: r.accountCount,
    };
  } catch (e) {
    console.error('[finance-dashboard-counts] bankBalans exception:', e?.message);
    return { value: 0, fetchedAt: null, accountCount: 0 };
  }
}

async function computeCashflowVerwacht30d() {
  // Som van openstaande facturen (open / overdue / partially_paid) met due_date
  // binnen 30 dagen. Eenvoudige proxy voor 30d cashflow.
  try {
    const today = new Date();
    const target = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('amount_total, amount_paid')
      .in('status', ['open', 'overdue', 'partially_paid'])
      .lte('due_date', target);
    if (error) {
      console.error('[finance-dashboard-counts] cashflow30d fail:', error.message);
      return 0;
    }
    let sum = 0;
    for (const r of (data || [])) {
      const tot = Number(r.amount_total) || 0;
      const paid = Number(r.amount_paid) || 0;
      sum += Math.max(0, tot - paid);
    }
    return Math.round(sum * 100) / 100;
  } catch (e) {
    console.error('[finance-dashboard-counts] cashflow30d exception:', e?.message);
    return 0;
  }
}

async function computeJoostStats(periodStart) {
  // sent = status=SENT_AUTONOMOUSLY. blocked = status LIKE 'BLOCKED_%'.
  // intents = group-by detected_intent voor suggestions in periode.
  try {
    const [{ count: sentCount }, { data: blockedData }, { data: intentRows }] = await Promise.all([
      supabaseAdmin.from('joost_suggestions').select('id', { count: 'exact', head: true })
        .eq('status', 'SENT_AUTONOMOUSLY').gte('created_at', periodStart),
      supabaseAdmin.from('joost_suggestions').select('status')
        .like('status', 'BLOCKED_%').gte('created_at', periodStart).limit(500),
      supabaseAdmin.from('joost_suggestions').select('detected_intent')
        .gte('created_at', periodStart).not('detected_intent', 'is', null).limit(1000),
    ]);
    const intents = {};
    for (const r of (intentRows || [])) {
      const k = String(r.detected_intent || '').trim();
      if (!k) continue;
      intents[k] = (intents[k] || 0) + 1;
    }
    return {
      sent: typeof sentCount === 'number' ? sentCount : 0,
      blocked: Array.isArray(blockedData) ? blockedData.length : 0,
      intents,
    };
  } catch (e) {
    console.error('[finance-dashboard-counts] joostStats exception:', e?.message);
    return { sent: 0, blocked: 0, intents: {} };
  }
}

async function computeConversieWanbetalersFlow(periodStart) {
  // % opgelost van begonnen workflows in periode.
  // Bron: payment_arrangements created sinds periodStart.
  try {
    const { data, error } = await supabaseAdmin
      .from('payment_arrangements')
      .select('status')
      .gte('created_at', periodStart)
      .in('status', ['ACTIEF', 'NAGEKOMEN', 'VERBROKEN']);
    if (error) {
      console.error('[finance-dashboard-counts] conversie fail:', error.message);
      return 0;
    }
    const total = (data || []).length;
    if (total === 0) return 0;
    const success = (data || []).filter(r => r.status === 'NAGEKOMEN').length;
    return Math.round((success / total) * 1000) / 10; // 0.1 precisie
  } catch (e) {
    console.error('[finance-dashboard-counts] conversie exception:', e?.message);
    return 0;
  }
}

async function computeMentorBonusPending() {
  // Som van bonuses.amount waar status='pending'.
  try {
    const { data, error } = await supabaseAdmin
      .from('bonuses')
      .select('amount')
      .eq('status', 'pending');
    if (error) {
      console.error('[finance-dashboard-counts] mentorBonus fail:', error.message);
      return 0;
    }
    let sum = 0;
    for (const r of (data || [])) sum += Number(r.amount) || 0;
    return Math.round(sum * 100) / 100;
  } catch (e) {
    console.error('[finance-dashboard-counts] mentorBonus exception:', e?.message);
    return 0;
  }
}

async function computeMrrSubscriptions() {
  // Som van amount / billingCycleMonths(billing_cycle) over actieve subs.
  try {
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('amount, billing_cycle')
      .eq('status', 'active');
    if (error) {
      console.error('[finance-dashboard-counts] MRR fail:', error.message);
      return 0;
    }
    let mrr = 0;
    for (const r of (data || [])) {
      const amt = Number(r.amount) || 0;
      const months = billingCycleMonths(r.billing_cycle);
      mrr += amt / months;
    }
    return Math.round(mrr * 100) / 100;
  } catch (e) {
    console.error('[finance-dashboard-counts] MRR exception:', e?.message);
    return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.module.access)' });
  }

  // Period.
  const period = VALID_PERIODS.includes(String(req.query?.period || '').toLowerCase())
    ? String(req.query.period).toLowerCase()
    : 'month';
  const force = String(req.query?.force || '').toLowerCase() === 'true';
  const periodStart = periodStartIso(period);

  // SWR cache hit.
  if (!force) {
    const hit = _cache.get(period);
    if (hit && (nowMs() - hit.t) < SWR_TTL_MS) {
      return res.status(200).json({ ...hit.body, fromCache: true });
    }
  }

  try {
    const [
      totaalOpenstaand,
      facturen,
      actieveArrangements,
      openVerifyPayment,
      openEscalations,
      bankBalans,
      cashflowVerwacht30d,
      joostStats,
      conversieWanbetalersFlow,
      mentorBonusPending,
      mrrSubscriptions,
    ] = await Promise.all([
      computeTotaalOpenstaand(),
      computeOpenAndOverdueFacturen(),
      computeActieveArrangements(),
      computeOpenVerifyPayment(),
      computeOpenEscalations(),
      computeBankBalans(),
      computeCashflowVerwacht30d(),
      computeJoostStats(periodStart),
      computeConversieWanbetalersFlow(periodStart),
      computeMentorBonusPending(),
      computeMrrSubscriptions(),
    ]);

    const body = {
      period,
      periodStart,
      totaalOpenstaand,
      openFacturen:        facturen.openFacturen,
      overdueFacturen:     facturen.overdueFacturen,
      actieveArrangements,
      openVerifyPayment,
      openEscalations,
      bankBalans,
      cashflowVerwacht30d,
      joostStats,
      conversieWanbetalersFlow,
      mentorBonusPending,
      mrrSubscriptions,
      fromCache: false,
    };

    _cache.set(period, { t: nowMs(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-counts] handler exception:', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
