// api/teamleader-settings.js
// GET  → alle TL-settings (k-v) als object.
// PUT  { key, value } → upsert één setting.
// Permission: admin.integrations.manage.
//
// Gebruikt voor o.a. default_email_template_id, default_department_id.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.integrations.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.integrations.manage)' });
  }

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin.from('teamleader_settings').select('key, value');
      if (error) throw error;
      const settings = {};
      for (const row of data || []) settings[row.key] = row.value;
      return res.status(200).json({ settings });
    }

    if (req.method === 'PUT') {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key vereist' });
      const { error } = await supabaseAdmin.from('teamleader_settings')
        .upsert({ key, value: String(value ?? ''), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'GET of PUT' });
  } catch (e) {
    console.error('[tl-settings]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
