// api/admin-template-folders-create.js
// POST → maak een nieuwe map voor een WABA.
// Gate (BP3 v9, 2026-09-02): admin.meta_templates.manage — Romy mag folders
// aanmaken voor overzicht. Delete blijft super_admin-only via folders-delete.
//
// Body: { business_account_id: text, name: text (1..64) }
// Response 200: { folder: { id, business_account_id, name, sort_order, created_at } }
// 409 op unique-conflict (business_account_id, lower(name)).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
    const baid = (body.business_account_id || '').toString().trim();
    if (!baid) return res.status(400).json({ error: 'business_account_id vereist' });
    const name = (body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name vereist' });
    if (name.length > 64) return res.status(400).json({ error: 'name: max 64 chars' });

    // sort_order = max(sort_order)+1 voor consistente volgorde.
    const { data: maxRow } = await supabaseAdmin
      .from('whatsapp_template_folders')
      .select('sort_order')
      .eq('business_account_id', baid)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSort = (Number(maxRow?.sort_order) || 0) + 1;

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_template_folders')
      .insert({
        business_account_id: baid,
        name,
        sort_order:          nextSort,
        created_by_user_id:  user.id,
      })
      .select('id, business_account_id, name, sort_order, created_at')
      .single();

    if (insErr) {
      if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
        return res.status(409).json({ error: `Map '${name}' bestaat al voor deze WABA` });
      }
      console.error('[admin-template-folders-create] insert:', insErr.message);
      return res.status(500).json({ error: insErr.message });
    }

    return res.status(200).json({ folder: inserted });
  } catch (e) {
    console.error('[admin-template-folders-create] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
