// api/finance-dashboard-chart-top-debtors.js
//
// Top 10 grootste openstaande klanten (chart C3 in roadmap).
//
// Strategie: lees alle open-status facturen (open / overdue / partially_paid),
// aggregeer client-side per customer_id, sorteer aflopend op open_amount, top N.
//
// Response:
//   {
//     items: [
//       { customerId, customerName, openAmount, openCount }, ...
//     ],
//     limit,
//   }
//
// RBAC: finance.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
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

  const limit = clampInt(req.query?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const force = String(req.query?.force || '').toLowerCase() === 'true';
  const cacheKey = `limit:${limit}`;
  if (!force) {
    const hit = _cache.get(cacheKey);
    if (hit && (Date.now() - hit.t) < SWR_TTL_MS) {
      return res.status(200).json({ ...hit.body, fromCache: true });
    }
  }

  try {
    const { data: invs, error } = await supabaseAdmin
      .from('invoices')
      .select('customer_id, amount_total, amount_paid')
      .in('status', ['open', 'overdue', 'partially_paid']);
    if (error) throw new Error('top-debtors invoices: ' + error.message);

    const perCustomer = new Map(); // customerId → { openAmount, openCount }
    for (const r of (invs || [])) {
      if (!r.customer_id) continue;
      const open = Math.max(0, (Number(r.amount_total) || 0) - (Number(r.amount_paid) || 0));
      if (open <= 0) continue;
      const cur = perCustomer.get(r.customer_id) || { openAmount: 0, openCount: 0 };
      cur.openAmount += open;
      cur.openCount  += 1;
      perCustomer.set(r.customer_id, cur);
    }

    const sorted = [...perCustomer.entries()]
      .map(([customerId, agg]) => ({ customerId, ...agg }))
      .sort((a, b) => b.openAmount - a.openAmount)
      .slice(0, limit);

    if (sorted.length === 0) {
      const body = { items: [], limit, fromCache: false };
      _cache.set(cacheKey, { t: Date.now(), body });
      return res.status(200).json(body);
    }

    // Resolve customer-naam in 1 call.
    const ids = sorted.map(s => s.customerId);
    const { data: custs, error: ce } = await supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name')
      .in('id', ids);
    if (ce) console.error('[top-debtors] customer-name fail:', ce.message);

    const nameMap = new Map();
    for (const c of (custs || [])) nameMap.set(c.id, customerDisplayName(c, '(onbekend)'));

    const items = sorted.map(s => ({
      customerId:   s.customerId,
      customerName: nameMap.get(s.customerId) || '(onbekend)',
      openAmount:   Math.round(s.openAmount * 100) / 100,
      openCount:    s.openCount,
    }));

    const body = { items, limit, fromCache: false };
    _cache.set(cacheKey, { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-top-debtors]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
