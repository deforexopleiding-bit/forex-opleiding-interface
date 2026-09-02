// api/admin-template-folders-rename.js
// PATCH → hernoem een bestaande map.
// Gate (BP3 v9, 2026-09-02): admin.meta_templates.manage. Folder-delete
// blijft super_admin-only (zie admin-template-folders-delete.js).
//
// Query: ?id=<uuid>
// Body:  { name: text (1..64) }
// Response 200: { folder: { id, business_account_id, name, sort_order, updated_at } }
// 409 op unique-conflict.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'PATCH only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const id = (req.query?.id || '').toString().trim();
    if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
    const name = (body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name vereist' });
    if (name.length > 64) return res.status(400).json({ error: 'name: max 64 chars' });

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('whatsapp_template_folders')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, business_account_id, name, sort_order, updated_at')
      .maybeSingle();

    if (updErr) {
      if (updErr.code === '23505' || /duplicate key/i.test(updErr.message || '')) {
        return res.status(409).json({ error: `Map '${name}' bestaat al voor deze WABA` });
      }
      console.error('[admin-template-folders-rename] update:', updErr.message);
      return res.status(500).json({ error: updErr.message });
    }
    if (!updated) return res.status(404).json({ error: 'Map niet gevonden' });

    return res.status(200).json({ folder: updated });
  } catch (e) {
    console.error('[admin-template-folders-rename] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
