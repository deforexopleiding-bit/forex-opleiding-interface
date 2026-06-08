// api/admin-meta-templates-list.js
// GET → lijst alle whatsapp_meta_templates rijen voor een WABA.
// SUPER_ADMIN ONLY. Read-only — geen audit-log.
//
// Query: ?business_account_id=<text> (required)
//
// Response: { items: [{ id, business_account_id, meta_template_id, name, language,
//                       category, header_type, header_content, body_text, body_examples,
//                       footer_text, buttons, status, rejection_reason, submitted_at,
//                       approved_at, last_synced_at, created_at, updated_at }] }

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    // Auth: Bearer → user → profile.role === 'super_admin'.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    const businessAccountId = (req.query?.business_account_id || '').toString().trim();
    if (!businessAccountId) {
      return res.status(400).json({ error: 'business_account_id vereist (query ?business_account_id=<text>)' });
    }

    const { data, error } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, business_account_id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, rejection_reason, submitted_at, approved_at, last_synced_at, created_at, updated_at')
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
