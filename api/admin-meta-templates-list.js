// api/admin-meta-templates-list.js
// GET → lijst alle whatsapp_meta_templates rijen voor een WABA.
// Gate: requirePermission('admin.meta_templates.manage')
// (super_admin bypass via wildcard; toegekend aan admin/manager/
// appointmentsetter via role_permissions seed). Read-only — geen audit-log.
//
// Query: ?business_account_id=<text> (required)
//
// Response: { items: [{ id, business_account_id, meta_template_id, name, language,
//                       category, header_type, header_content, body_text, body_examples,
//                       footer_text, buttons, status, rejection_reason, submitted_at,
//                       approved_at, last_synced_at, created_at, updated_at }] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    // BP1 2026-08-31: refactored van hardcoded super_admin naar RBAC-feature-
    // key admin.meta_templates.manage. Delete blijft super_admin-only
    // (bescherm live gate-templates) — zie admin-meta-templates-delete.js.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const businessAccountId = (req.query?.business_account_id || '').toString().trim();
    if (!businessAccountId) {
      return res.status(400).json({ error: 'business_account_id vereist (query ?business_account_id=<text>)' });
    }

    const { data, error } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, business_account_id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, folder_id, status, rejection_reason, submitted_at, approved_at, last_synced_at, created_at, updated_at')
      .eq('business_account_id', businessAccountId)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[admin-meta-templates-list] select:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[admin-meta-templates-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
