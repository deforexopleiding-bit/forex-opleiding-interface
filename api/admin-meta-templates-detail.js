// api/admin-meta-templates-detail.js
// GET → enkele whatsapp_meta_templates rij ophalen via ?id=<uuid>.
// Gate: requirePermission('admin.meta_templates.manage')
// (BP1 2026-08-31; delete blijft super_admin-only).
//
// Query: ?id=<uuid> (required)
//
// Response: { item: row } of 404.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const id = (req.query?.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'id vereist (query ?id=<uuid>)' });

    const { data, error } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, business_account_id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, rejection_reason, submitted_at, approved_at, last_synced_at, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[admin-meta-templates-detail] select:', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Template niet gevonden' });

    return res.status(200).json({ item: data });
  } catch (e) {
    console.error('[admin-meta-templates-detail] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
