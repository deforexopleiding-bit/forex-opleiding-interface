// api/mentor-payouts-list-self.js
//
// GET → self-scope historie van mentor_payouts voor de ingelogde mentor.
// Read-only. RBAC: mentor.module.access.
//
// Response 200:
//   { ok: true, scope: 'self', payouts: [
//       { id, period_month, total, status, created_at, paid_at }, ...
//   ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('mentor_payouts')
      .select('id, period_month, total, status, created_at, paid_at')
      .eq('mentor_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error('payouts fetch: ' + error.message);

    const payouts = (data || []).map((p) => ({
      id           : p.id,
      period_month : p.period_month,
      total        : Number(p.total) || 0,
      status       : p.status || null,
      created_at   : p.created_at,
      paid_at      : p.paid_at,
    }));

    return res.status(200).json({ ok: true, scope: 'self', payouts });
  } catch (e) {
    console.error('[mentor-payouts-list-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
