// api/finance-dashboard-chart-aging.js
//
// Aging-buckets voor openstaande facturen (chart C2 in roadmap).
// Buckets: 0-30 / 30-60 / 60-90 / 90+ dagen vanaf due_date.
//
// Response:
//   {
//     buckets: [
//       { key: '0-30',  label: '0-30 dagen',  count: number, openAmount: number },
//       { key: '30-60', label: '30-60 dagen', count: number, openAmount: number },
//       { key: '60-90', label: '60-90 dagen', count: number, openAmount: number },
//       { key: '90+',   label: '90+ dagen',   count: number, openAmount: number },
//     ],
//     totalCount: number,
//     totalOpenAmount: number,
//   }
//
// RBAC: finance.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();

function bucketKey(daysOverdue) {
  if (daysOverdue < 0)  return null;        // nog niet verlopen → skip
  if (daysOverdue <= 30)  return '0-30';
  if (daysOverdue <= 60)  return '30-60';
  if (daysOverdue <= 90)  return '60-90';
  return '90+';
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
    // Lees alle openstaande facturen + due_date + open-bedrag.
    // Bij echte schaal (>10k facturen) zou dit naar een RPC moeten, maar voor
    // huidige volumes is een client-side bucket-berekening sub-200ms.
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('id, due_date, amount_total, amount_paid, status')
      .in('status', ['open', 'overdue', 'partially_paid']);
    if (error) throw new Error('aging: ' + error.message);

    const today = new Date();
    const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    const buckets = {
      '0-30':  { count: 0, openAmount: 0 },
      '30-60': { count: 0, openAmount: 0 },
      '60-90': { count: 0, openAmount: 0 },
      '90+':   { count: 0, openAmount: 0 },
    };
    for (const r of (data || [])) {
      if (!r.due_date) continue;
      const due = new Date(r.due_date + 'T00:00:00Z').getTime();
      const days = Math.floor((todayMs - due) / 86400000);
      const k = bucketKey(days);
      if (!k) continue;
      const open = Math.max(0, (Number(r.amount_total) || 0) - (Number(r.amount_paid) || 0));
      buckets[k].count += 1;
      buckets[k].openAmount += open;
    }

    const labels = {
      '0-30':  '0-30 dagen',
      '30-60': '30-60 dagen',
      '60-90': '60-90 dagen',
      '90+':   '90+ dagen',
    };
    const out = Object.keys(buckets).map(k => ({
      key:        k,
      label:      labels[k],
      count:      buckets[k].count,
      openAmount: Math.round(buckets[k].openAmount * 100) / 100,
    }));
    const totalCount = out.reduce((s, b) => s + b.count, 0);
    const totalOpenAmount = Math.round(out.reduce((s, b) => s + b.openAmount, 0) * 100) / 100;

    const body = { buckets: out, totalCount, totalOpenAmount, fromCache: false };
    _cache.set('default', { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-aging]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
