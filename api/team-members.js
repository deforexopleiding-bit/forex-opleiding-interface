// api/team-members.js
//
// GET → lijst actieve team-members (id, name, role, type).
//
// [H-09 fix 2026-08-25] Voorheen géén auth-gate + anon-client → staf-
// directory-leak voor iedereen die de URL kent. Nu Bearer + CRM-staff-rol
// vereist (super_admin/admin/manager/sales/mentor/marketing/administratie).
// Client-side query gebruikt supabaseAdmin zodat we onafhankelijk van RLS
// een consistente lijst leveren; auth wordt bewezen in app-laag.

import { supabaseAdmin } from './supabase.js';
import { requireCrmStaff } from './_lib/crm-roles.js';
import { safeError } from './_lib/safe-error.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const auth = await requireCrmStaff(req);
  if (!auth) return res.status(403).json({ error: 'Toegang geweigerd. CRM-staff-rol vereist.' });

  try {
    const { data, error } = await supabaseAdmin
      .from('team_members')
      .select('id, name, role, type')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return res.status(200).json({ members: data || [] });
  } catch (err) {
    return safeError(res, 500, err);
  }
}
