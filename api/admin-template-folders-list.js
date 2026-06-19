// api/admin-template-folders-list.js
// GET → mappen voor een WABA met aantal templates per map.
// SUPER_ADMIN ONLY (zelfde gate als de overige admin-meta-templates-* endpoints).
//
// Query: ?business_account_id=<text>
// Response: { folders: [{ id, name, sort_order, created_at, template_count }] }

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles').select('id, role, is_active').eq('id', user.id).single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

    const baid = (req.query?.business_account_id || '').toString().trim();
    if (!baid) return res.status(400).json({ error: 'business_account_id vereist' });

    const { data: folders, error: fErr } = await supabaseAdmin
      .from('whatsapp_template_folders')
      .select('id, name, sort_order, created_at')
      .eq('business_account_id', baid)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (fErr) {
      console.error('[admin-template-folders-list] select:', fErr.message);
      return res.status(500).json({ error: fErr.message });
    }

    // Counts per map: 1 round-trip op whatsapp_meta_templates, in JS aggregaten.
    const { data: counts, error: cErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('folder_id')
      .eq('business_account_id', baid)
      .not('folder_id', 'is', null);
    if (cErr) {
      console.error('[admin-template-folders-list] count select:', cErr.message);
      // Soft-fail counts; lever 0 zodat de UI niet breekt.
    }
    const byFolder = {};
    for (const r of (counts || [])) {
      byFolder[r.folder_id] = (byFolder[r.folder_id] || 0) + 1;
    }

    const out = (folders || []).map((f) => ({
      id            : f.id,
      name          : f.name,
      sort_order    : f.sort_order,
      created_at    : f.created_at,
      template_count: byFolder[f.id] || 0,
    }));
    return res.status(200).json({ folders: out });
  } catch (e) {
    console.error('[admin-template-folders-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
