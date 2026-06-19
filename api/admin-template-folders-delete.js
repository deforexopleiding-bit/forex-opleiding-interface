// api/admin-template-folders-delete.js
// DELETE → verwijder een map. Templates erin blijven bestaan (folder_id wordt
// NULL via ON DELETE SET NULL).
// SUPER_ADMIN ONLY.
//
// Query: ?id=<uuid>
// Response 200: { ok: true, id }

import { createUserClient, supabaseAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'DELETE only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles').select('id, role, is_active').eq('id', user.id).single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

    const id = (req.query?.id || '').toString().trim();
    if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

    const { error: delErr } = await supabaseAdmin
      .from('whatsapp_template_folders')
      .delete()
      .eq('id', id);
    if (delErr) {
      console.error('[admin-template-folders-delete] delete:', delErr.message);
      return res.status(500).json({ error: delErr.message });
    }
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error('[admin-template-folders-delete] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
