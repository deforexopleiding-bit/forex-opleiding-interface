// api/finance-dashboard-chart-payments.js
//
// Nieuwe vs herhaal-betalingen per maand (chart C8 in roadmap). Aanpak:
//   - Lees alle payments laatste N maanden (default 6).
//   - Voor elke payment: bepaal of het de EERSTE payment van deze customer is
//     binnen het volledige payments-bestand (window-functie equivalent in JS).
//   - Bucketeer per maand (YYYY-MM, UTC) -> { firstCount, repeatCount,
//     firstAmount, repeatAmount }.
//
// Window-functie SQL niet beschikbaar in PostgREST/supabase-js; we lossen
// dit elegant op door alle payments in 1 read te ordenen op (customer_id,
// payment_date asc) en client-side een Set<customerId> bij te houden van
// "al eens gezien". Eerste keer een customer voorkomt -> firstCount/Amount.
//
// Response:
//   {
//     buckets: [
//       { month: '2026-05', firstCount, repeatCount, firstAmount, repeatAmount },
//       ...
//     ],
//     totals: { firstCount, repeatCount, firstAmount, repeatAmount },
//     monthsBack,
//     fromCache,
//   }
//
// RBAC: finance.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();
const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 24;

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function monthKey(d) {
  // YYYY-MM (UTC). Stable sort.
  return d.toISOString().slice(0, 7);
}

function buildMonthWindow(monthsBack) {
  const today = new Date();
  const out = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    out.push(monthKey(d));
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

  const monthsBack = clampInt(req.query?.months, DEFAULT_MONTHS, 1, MAX_MONTHS);
  const force = String(req.query?.force || '').toLowerCase() === 'true';
  const cacheKey = `m:${monthsBack}`;
  if (!force) {
    const hit = _cache.get(cacheKey);
    if (hit && (Date.now() - hit.t) < SWR_TTL_MS) {
      return res.status(200).json({ ...hit.body, fromCache: true });
    }
  }

  try {
    // We hebben ALLE payments nodig om "eerste payment per customer"
    // betrouwbaar te bepalen, niet alleen die in het venster. Anders zou
    // een herhaal-payment in maand-X met de eerste in maand-(X-Y) als
    // "first" geclassificeerd worden. Order by customer_id, payment_date asc.
    const { data, error } = await supabaseAdmin
      .from('payments')
      .select('id, customer_id, payment_date, amount')
      .order('customer_id', { ascending: true })
      .order('payment_date', { ascending: true })
      .limit(20000);
    if (error) throw new Error('payments-chart: ' + error.message);

    const windowMonths = buildMonthWindow(monthsBack);
    const windowSet = new Set(windowMonths);
    const seen = new Set();

    // bucket map: month -> agg.
    const bucketMap = new Map(windowMonths.map(m => [m, {
      month:        m,
      firstCount:   0,
      repeatCount:  0,
      firstAmount:  0,
      repeatAmount: 0,
    }]));

    let totFirstCount = 0;
    let totRepeatCount = 0;
    let totFirstAmount = 0;
    let totRepeatAmount = 0;

    for (const r of (data || [])) {
      if (!r.customer_id || !r.payment_date) continue;
      const dk = new Date(r.payment_date);
      if (Number.isNaN(dk.getTime())) continue;
      const mk = monthKey(dk);

      const isFirst = !seen.has(r.customer_id);
      if (isFirst) seen.add(r.customer_id);

      // Alleen meetellen als in window.
      if (!windowSet.has(mk)) continue;

      const amt = Number(r.amount) || 0;
      const b = bucketMap.get(mk);
      if (!b) continue;
      if (isFirst) {
        b.firstCount  += 1;
        b.firstAmount += amt;
        totFirstCount += 1;
        totFirstAmount += amt;
      } else {
        b.repeatCount  += 1;
        b.repeatAmount += amt;
        totRepeatCount += 1;
        totRepeatAmount += amt;
      }
    }

    const buckets = windowMonths.map(m => {
      const b = bucketMap.get(m);
      return {
        month:        b.month,
        firstCount:   b.firstCount,
        repeatCount:  b.repeatCount,
        firstAmount:  Math.round(b.firstAmount * 100) / 100,
        repeatAmount: Math.round(b.repeatAmount * 100) / 100,
      };
    });

    const body = {
      buckets,
      totals: {
        firstCount:   totFirstCount,
        repeatCount:  totRepeatCount,
        firstAmount:  Math.round(totFirstAmount * 100) / 100,
        repeatAmount: Math.round(totRepeatAmount * 100) / 100,
      },
      monthsBack,
      fromCache: false,
    };
    _cache.set(cacheKey, { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-payments]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
