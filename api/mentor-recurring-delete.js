// api/mentor-recurring-delete.js
//
// POST → verwijder mentor_recurring_items rij.
//
// Permission: mentor.payout.manage.
//
// Body: { id: uuid }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { error } = await supabaseAdmin
      .from('mentor_recurring_items')
      .delete()
      .eq('id', id);
    if (error) throw new Error('recurring delete: ' + error.message);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[mentor-recurring-delete]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
