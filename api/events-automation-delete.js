import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  const id = body && typeof body.id === 'string' ? body.id.trim() : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
  try {
    const { error } = await supabaseAdmin.from('event_automations').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, deleted_id: id });
  } catch (e) {
    console.error('[events-automation-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
