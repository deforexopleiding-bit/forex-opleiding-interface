import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  try {
    const { data, error } = await supabaseAdmin
      .from('event_automations')
      .select('id, name, description, enabled, enabled_at, trigger_type, trigger_config, scope_type, scope_config, enroll_mode, steps, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, automations: data || [] });
  } catch (e) {
    console.error('[events-automations-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
