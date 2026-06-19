// api/admin-template-folder-move.js
// POST → verplaats een template naar een map (of naar 'ongegroepeerd').
// SUPER_ADMIN ONLY.
//
// Body:
//   { template_id: uuid, folder_id: uuid|null }
//   folder_id=null → maakt template ongegroepeerd.
//
// Validatie: als folder_id niet null is, MOET folder.business_account_id ==
// template.business_account_id (anders 409 — kan geen cross-WABA verplaatsing).
//
// Response 200: { ok: true, template_id, folder_id }

import { createUserClient, supabaseAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles').select('id, role, is_active').eq('id', user.id).single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

    const templateId = (body.template_id || '').toString().trim();
    if (!templateId || !UUID_RE.test(templateId)) {
      return res.status(400).json({ error: 'template_id (uuid) vereist' });
    }
    let folderId = null;
    if (body.folder_id != null && String(body.folder_id).trim() !== '') {
      folderId = String(body.folder_id).trim();
      if (!UUID_RE.test(folderId)) return res.status(400).json({ error: 'folder_id (uuid) of null vereist' });
    }

    // Template bestaat + WABA
    const { data: tpl, error: tplErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, business_account_id, folder_id')
      .eq('id', templateId)
      .maybeSingle();
    if (tplErr) throw new Error('template fetch: ' + tplErr.message);
    if (!tpl) return res.status(404).json({ error: 'Template niet gevonden' });

    // Cross-WABA-validatie als 'ie naar een map gaat
    if (folderId) {
      const { data: folder, error: fErr } = await supabaseAdmin
        .from('whatsapp_template_folders')
        .select('id, business_account_id')
        .eq('id', folderId)
        .maybeSingle();
      if (fErr) throw new Error('folder fetch: ' + fErr.message);
      if (!folder) return res.status(404).json({ error: 'Map niet gevonden' });
      if (folder.business_account_id !== tpl.business_account_id) {
        return res.status(409).json({ error: 'Map hoort niet bij dezelfde WABA als template' });
      }
    }

    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .update({ folder_id: folderId, updated_at: new Date().toISOString() })
      .eq('id', templateId);
    if (updErr) {
      console.error('[admin-template-folder-move] update:', updErr.message);
      return res.status(500).json({ error: updErr.message });
    }

    return res.status(200).json({ ok: true, template_id: templateId, folder_id: folderId });
  } catch (e) {
    console.error('[admin-template-folder-move] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
