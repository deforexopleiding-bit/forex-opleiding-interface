// api/admin-cancellations-stats.js
//
// GET — annuleringen-statistiek voor manager/super_admin (seesAll). Mentor → 403.
//
// Response 200:
//   {
//     total_count: <number>,
//     total_value: <number, EUR>,
//     by_month: [ { month: 'YYYY-MM', count, value } ],   // laatste ~12 mnd, oudst eerst
//     recent:   [ { onboarding_id, customer_name, cancelled_at, reason, subscription_value } ]
//                 // laatste 10, nieuwste eerst
//   }
//
// subscription_value mag null/NaN zijn → telt als 0 in de som.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

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

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  try {
    // Volledige fetch (cap 5000 — annuleringen blijven zeldzaam; eerder
    // omhoog te schalen dan dat dit ooit krap wordt).
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('onboarding_cancellations')
      .select('onboarding_id, customer_name, reason, subscription_value, created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (rowErr) throw new Error('cancellations fetch: ' + rowErr.message);
    const list = rows || [];

    const total_count = list.length;
    const total_value = list.reduce((sum, r) => {
      const v = Number(r.subscription_value);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

    // by_month: laatste ~12 maanden (oudst eerst voor chart-vriendelijke output).
    const monthMap = new Map(); // 'YYYY-MM' → { count, value }
    for (const r of list) {
      if (!r.created_at) continue;
      const ym = String(r.created_at).slice(0, 7);
      if (!monthMap.has(ym)) monthMap.set(ym, { count: 0, value: 0 });
      const m = monthMap.get(ym);
      m.count += 1;
      const v = Number(r.subscription_value);
      m.value += Number.isFinite(v) ? v : 0;
    }
    const sortedMonths = Array.from(monthMap.keys()).sort();
    const last12 = sortedMonths.slice(-12);
    const by_month = last12.map((ym) => {
      const m = monthMap.get(ym) || { count: 0, value: 0 };
      return { month: ym, count: m.count, value: Math.round(m.value * 100) / 100 };
    });

    // recent: laatste 10, nieuwste eerst.
    const recent = list.slice(0, 10).map((r) => ({
      onboarding_id:      r.onboarding_id,
      customer_name:      r.customer_name || null,
      cancelled_at:       r.created_at,
      reason:             r.reason || null,
      subscription_value: Number.isFinite(Number(r.subscription_value)) ? Number(r.subscription_value) : null,
    }));

    return res.status(200).json({
      total_count,
      total_value: Math.round(total_value * 100) / 100,
      by_month,
      recent,
    });
  } catch (e) {
    console.error('[admin-cancellations-stats]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
