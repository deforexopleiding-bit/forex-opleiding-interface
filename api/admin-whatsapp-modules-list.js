// api/admin-whatsapp-modules-list.js
// GET → lijst whatsapp_module_config rijen (WABA-modules voor templatebeheer).
// Read-only — geen mutaties, geen audit-log.
//
// Gate: requirePermission('admin.meta_templates.manage') — dezelfde key die de
// template-endpoints (list/upsert/submit/sync) al gebruiken; super_admin bypasst
// via wildcard. Zo kan o.a. de appointmentsetter de actieve WABA-module resolven
// en templates beheren, zonder toegang tot module-BEHEER (dat blijft in admin.html
// super_admin-only).
//
// Least-privilege (Optie B): super_admin krijgt de volledige config-rij; elke
// andere rol met de permissie krijgt PER module ALLEEN de velden die de
// template-UI nodig heeft (id, business_account_id, display_label, is_active).
// phone_number_id + de afdeling-contactvelden + overige config worden voor
// niet-super_admin WEGGELATEN (Meta-lijn-identifiers van álle WABA's).
//
// Response super_admin: { items: [{ id, module, phone_number_id,
//   business_account_id, display_label, is_active, afdeling_telefoon,
//   afdeling_whatsapp, afdeling_email, afdeling_ondertekenaar,
//   created_at, updated_at }] }
// Response overige rollen: { items: [{ id, business_account_id, display_label,
//   is_active }] }
//
// Tabel: whatsapp_module_config (zie docs/sql-migrations/2026-06-08-whatsapp-module-config.sql).

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

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });

    // RBAC-gate (zelfde key als de template-endpoints; super_admin via wildcard).
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const isSuperAdmin = profile.role === 'super_admin';

    const { data, error } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('id, module, phone_number_id, business_account_id, display_label, is_active, afdeling_telefoon, afdeling_whatsapp, afdeling_email, afdeling_ondertekenaar, created_at, updated_at')
      .order('module', { ascending: true });

    if (error) {
      console.error('[admin-whatsapp-modules-list] select:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const rows = data || [];
    // Optie B: super_admin ziet de volledige rij; andere rollen alleen de
    // template-UI-velden (geen phone_number_id / afdeling-contactvelden).
    const items = isSuperAdmin
      ? rows
      : rows.map((m) => ({
          id: m.id,
          business_account_id: m.business_account_id,
          display_label: m.display_label,
          is_active: m.is_active,
        }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[admin-whatsapp-modules-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
