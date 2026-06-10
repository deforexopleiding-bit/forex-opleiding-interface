// api/finance-dashboard-chart-arrangements.js
//
// Arrangements per status (donut-chart C5 in roadmap).
// Statussen: VOORGESTELD / ACTIEF / NAGEKOMEN / VERBROKEN / GEANNULEERD.
//
// Response:
//   {
//     items: [ { status, label, count }, ... ],
//     totalCount,
//   }
//
// RBAC: finance.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();

const STATUSES = ['VOORGESTELD', 'ACTIEF', 'NAGEKOMEN', 'VERBROKEN', 'GEANNULEERD'];
const STATUS_LABELS = {
  VOORGESTELD: 'Voorgesteld',
  ACTIEF:      'Actief',
  NAGEKOMEN:   'Nagekomen',
  VERBROKEN:   'Verbroken',
  GEANNULEERD: 'Geannuleerd',
};

async function countByStatus(status) {
  try {
    const { count, error } = await supabaseAdmin
      .from('payment_arrangements')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (error) {
      console.error('[arrangements-chart]', status, error.message);
      return 0;
    }
    return typeof count === 'number' ? count : 0;
  } catch (e) {
    console.error('[arrangements-chart] exception', status, e?.message);
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
    const counts = await Promise.all(STATUSES.map(s => countByStatus(s)));
    const items = STATUSES.map((s, i) => ({
      status: s,
      label:  STATUS_LABELS[s],
      count:  counts[i],
    }));
    const totalCount = items.reduce((sum, it) => sum + it.count, 0);

    const body = { items, totalCount, fromCache: false };
    _cache.set('default', { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-arrangements]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
