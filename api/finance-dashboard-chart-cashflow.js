// api/finance-dashboard-chart-cashflow.js
//
// 3-maands cashflow trend (chart C7 in roadmap). Twee series:
//   1) "Binnenkomend" — payments.payment_date in [today-90d ... today].
//   2) "Verwacht"     — open invoices.due_date in [today ... today+30d].
//
// Bucketeren per dag (UTC) en cumulatief klaarmaken voor de Recharts line-chart.
// Frontend bepaalt zelf of incoming + expected gestackt of als losse lijnen
// gerenderd worden.
//
// Query-strategie:
//   - payments → SELECT payment_date, amount WHERE payment_date >= today-90d
//   - invoices → SELECT due_date, amount_total, amount_paid WHERE
//                status IN ('open','overdue','partially_paid')
//                AND due_date BETWEEN today AND today+30d
//
// Response:
//   {
//     incoming: [ { date, amount }, ... ],   // 90 dagen retrospectief
//     expected: [ { date, amount }, ... ],   // 30 dagen vooruit
//     totals:   { incoming, expected },
//     fromCache,
//   }
//
// RBAC: finance.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();
const PAST_DAYS = 90;
const FUTURE_DAYS = 30;

function dayKeyUTC(d) {
  return d.toISOString().slice(0, 10);
}

function buildDayWindow(daysBack, daysForward) {
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const out = [];
  for (let i = daysBack; i >= 1; i--) {
    out.push(dayKeyUTC(new Date(todayUtc.getTime() - i * 86400000)));
  }
  out.push(dayKeyUTC(todayUtc)); // today
  for (let i = 1; i <= daysForward; i++) {
    out.push(dayKeyUTC(new Date(todayUtc.getTime() + i * 86400000)));
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

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.module.access)' });
  }

  const force = String(req.query?.force || '').toLowerCase() === 'true';
  if (!force) {
    const hit = _cache.get('default');
    if (hit && (Date.now() - hit.t) < SWR_TTL_MS) {
      return res.status(200).json({ ...hit.body, fromCache: true });
    }
  }

  try {
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const since = new Date(todayUtc.getTime() - PAST_DAYS * 86400000).toISOString().slice(0, 10);
    const until = new Date(todayUtc.getTime() + FUTURE_DAYS * 86400000).toISOString().slice(0, 10);
    const todayKey = dayKeyUTC(todayUtc);

    // --- Series A: binnengekomen payments (laatste 90 dagen) ---
    const incomingMap = new Map();
    {
      const { data, error } = await supabaseAdmin
        .from('payments')
        .select('payment_date, amount')
        .gte('payment_date', since)
        .lte('payment_date', todayKey)
        .limit(10000);
      if (error) throw new Error('cashflow incoming: ' + error.message);
      for (const r of (data || [])) {
        if (!r.payment_date) continue;
        const dk = String(r.payment_date).slice(0, 10);
        const amt = Number(r.amount) || 0;
        incomingMap.set(dk, (incomingMap.get(dk) || 0) + amt);
      }
    }

    // --- Series B: verwachte cashflow (open facturen, due_date in 30d) ---
    const expectedMap = new Map();
    {
      const { data, error } = await supabaseAdmin
        .from('invoices')
        .select('due_date, amount_total, amount_paid, status')
        .in('status', ['open', 'overdue', 'partially_paid'])
        .gte('due_date', todayKey)
        .lte('due_date', until)
        .limit(5000);
      if (error) throw new Error('cashflow expected: ' + error.message);
      for (const r of (data || [])) {
        if (!r.due_date) continue;
        const dk = String(r.due_date).slice(0, 10);
        const open = Math.max(0, (Number(r.amount_total) || 0) - (Number(r.amount_paid) || 0));
        if (open <= 0) continue;
        expectedMap.set(dk, (expectedMap.get(dk) || 0) + open);
      }
    }

    const window = buildDayWindow(PAST_DAYS, FUTURE_DAYS);
    const incoming = [];
    const expected = [];
    for (const d of window) {
      if (d <= todayKey) {
        incoming.push({ date: d, amount: Math.round((incomingMap.get(d) || 0) * 100) / 100 });
      }
      if (d >= todayKey) {
        expected.push({ date: d, amount: Math.round((expectedMap.get(d) || 0) * 100) / 100 });
      }
    }

    const totalIncoming = incoming.reduce((s, p) => s + p.amount, 0);
    const totalExpected = expected.reduce((s, p) => s + p.amount, 0);

    const body = {
      incoming,
      expected,
      totals: {
        incoming: Math.round(totalIncoming * 100) / 100,
        expected: Math.round(totalExpected * 100) / 100,
      },
      windowStart: since,
      windowEnd:   until,
      today:       todayKey,
      fromCache:   false,
    };
    _cache.set('default', { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-cashflow]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
