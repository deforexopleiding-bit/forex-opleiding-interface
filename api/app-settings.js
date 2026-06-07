// api/app-settings.js
// GET → één key of alle settings. PUT → één key updaten (super_admin only).
//
// GET   ?key=<string>  — returnt { key, value }; zonder key returnt { settings: {...} }
// PUT   body { key, value }  — updates / upsert. Super_admin only.

import { createUserClient, supabaseAdmin, verifyAdmin } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (req.method === 'GET') {
    const key = String(req.query?.key || '').trim();
    try {
      if (key) {
        const { data, error } = await supabaseAdmin
          .from('app_settings').select('key, value, updated_at').eq('key', key).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return res.status(404).json({ error: 'key niet gevonden' });
        return res.status(200).json(data);
      }
      // Alle keys.
      const { data, error } = await supabaseAdmin
        .from('app_settings').select('key, value, updated_at');
      if (error) throw new Error(error.message);
      const settings = {};
      for (const r of (data || [])) settings[r.key] = r.value;
      return res.status(200).json({ settings });
    } catch (e) {
      console.error('[app-settings GET]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PUT') {
    // Alleen super_admin mag settings wijzigen — write-impact is app-breed.
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Admin only' });
    if (admin.profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin mag settings wijzigen' });
    }

    const { key, value } = req.body || {};
    if (!key || typeof key !== 'string' || key.length > 100) {
      return res.status(400).json({ error: 'key (string, max 100 chars) vereist' });
    }
    if (value === undefined) {
      return res.status(400).json({ error: 'value vereist (mag null zijn)' });
    }

    try {
      // Upsert: 2-staps SELECT → UPDATE/INSERT (consistent met andere
      // fasen, robuust tegen race-conditions op partial indexes).
      const { data: existing } = await supabaseAdmin
        .from('app_settings').select('key').eq('key', key).maybeSingle();
      const row = {
        key, value,
        updated_by_user_id: user.id,
      };
      if (existing) {
        const { error } = await supabaseAdmin.from('app_settings').update(row).eq('key', key);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabaseAdmin.from('app_settings').insert(row);
        if (error) throw new Error(error.message);
      }

      // Audit-log (fail-soft).
      try {
        await supabaseAdmin.from('audit_log').insert({
          user_id:     user.id,
          action:      'app_settings.update',
          entity_type: 'app_setting',
          entity_id:   null,
          after_json:  { key, value },
          reason_text: `App-setting '${key}' bijgewerkt`,
          ip_address:  getClientIp(req),
        });
      } catch (e) { console.error('[app-settings] audit', e.message); }

      return res.status(200).json({ success: true, key, value });
    } catch (e) {
      console.error('[app-settings PUT]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
