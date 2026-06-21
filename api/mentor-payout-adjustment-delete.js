// api/mentor-payout-adjustment-delete.js
//
// POST → verwijder mentor_payout_adjustments rij + recompute concept van de
// betrokken (mentor, maand).
//
// Permission: mentor.payout.manage.
//
// Body: { id: uuid }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeAndUpsertConcept } from './_lib/payout-generate-core.js';

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
    // 1) Eerst lookup voor (mentor, periode) zodat we daarna kunnen recompute'n.
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('mentor_payout_adjustments')
      .select('mentor_user_id, period_month')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('adjustment lookup: ' + lookupErr.message);
    if (!row) return res.status(404).json({ error: 'Post niet gevonden' });

    // 2) Verwijderen.
    const { error: delErr } = await supabaseAdmin
      .from('mentor_payout_adjustments')
      .delete()
      .eq('id', id);
    if (delErr) throw new Error('adjustment delete: ' + delErr.message);

    // 3) Recompute concept.
    let recompute = null;
    try {
      recompute = await computeAndUpsertConcept({
        mentorUserId: row.mentor_user_id,
        monthStart  : row.period_month,
        actorId     : user.id,
      });
    } catch (e) {
      console.warn('[mentor-payout-adjustment-delete] recompute faalde:', e?.message || e);
      recompute = { error: e?.message || String(e) };
    }

    return res.status(200).json({ ok: true, recompute });
  } catch (e) {
    console.error('[mentor-payout-adjustment-delete]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
