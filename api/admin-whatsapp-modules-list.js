// api/admin-whatsapp-modules-list.js
// GET → lijst alle whatsapp_module_config rijen (module->phone_number_id mapping).
// SUPER_ADMIN ONLY. Read-only — geen mutaties, geen audit-log.
//
// Response: { items: [{ id, module, phone_number_id, business_account_id,
//                        display_label, is_active,
//                        afdeling_telefoon, afdeling_whatsapp,
//                        afdeling_email, afdeling_ondertekenaar,
//                        created_at, updated_at }] }
//
// Tabel: whatsapp_module_config (zie docs/sql-migrations/2026-06-08-whatsapp-module-config.sql).
// RLS: read-policy staat 'authenticated' toe; super_admin-gate hier is extra
// app-laag voorzichtigheid (config bevat phone_number_ids van Meta-lijnen).

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Auth: Bearer-token → user → profile.role === 'super_admin'.
  try {
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

    // Read config-rijen (service-role bypasst RLS — irrelevant want we hebben net gecheckt).
    const { data, error } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('id, module, phone_number_id, business_account_id, display_label, is_active, afdeling_telefoon, afdeling_whatsapp, afdeling_email, afdeling_ondertekenaar, created_at, updated_at')
      .order('module', { ascending: true });

    if (error) {
      console.error('[admin-whatsapp-modules-list] select:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[admin-whatsapp-modules-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
