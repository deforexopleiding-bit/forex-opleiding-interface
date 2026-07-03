// api/follow-up-lead-note-add.js
// POST { lead_id, note } → insert follow_up_lead_notes-rij.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  const note   = typeof body.note === 'string' ? body.note.trim() : '';
  if (!leadId || !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });
  if (!note) return res.status(400).json({ error: 'note vereist' });

  try {
    const { data, error } = await supabaseAdmin
      .from('follow_up_lead_notes')
      .insert({ lead_id: leadId, note: note.slice(0, 4000), created_by_user_id: user.id })
      .select('id, lead_id, note, created_by_user_id, created_at')
      .maybeSingle();
    if (error) {
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_lead_notes ontbreekt', code: 'MIGRATION_REQUIRED' });
      throw new Error(error.message);
    }
    return res.status(200).json({ ok: true, note: data });
  } catch (e) {
    console.error('[follow-up-lead-note-add]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
