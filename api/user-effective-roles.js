// api/user-effective-roles.js
//
// GET → { primary_role, roles: [], shell_roles: [] }
//   - primary_role : profiles.role (bron van waarheid voor legacy requireAuth)
//   - roles        : union van profiles.role + user_roles.role (Supabase-rollen)
//   - shell_roles  : gemapt naar de 5 DFO-shell-rollen (super_admin, manager,
//                    sales, mentor, marketing) — bruikbaar in DFO.setRoles().
//
// Vereist een geldige user-JWT (Bearer). Retourneert 401 bij ontbrekende /
// verlopen sessie. Retourneert altijd een defensief object; als de user
// bestaat maar geen rollen (edge-case), krijgt shell_roles = ['administratie']
// als fail-safe zodat de shell niet crasht op een lege rol-set.

import { supabase, supabaseAdmin } from './supabase.js';
import { getEffectiveRoles, pickShellRoles, computeHighestRole } from './_lib/roles.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token vereist' });
  }
  const token = authHeader.slice(7);

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) {
    return res.status(401).json({ error: 'Ongeldige sessie' });
  }

  try {
    const roles = await getEffectiveRoles(user.id, supabaseAdmin);
    const primary_role = computeHighestRole(roles);
    // BP2 (2026-09-01) fail-closed: als pickShellRoles geen match vindt
    // (bv. onbekende rol / lege set), val NIET terug op 'administratie'
    // die per abuis lees-toegang zou kunnen geven. Return lege array;
    // caller ziet "geen shell-toegang" en handelt dat af (client-shell
    // toont dan geen nav-items; RBAC-feature-keys blijven autoritatief
    // voor endpoint-toegang).
    const shell_roles = pickShellRoles(roles);
    return res.status(200).json({
      user_id: user.id,
      primary_role,
      roles,
      shell_roles,
    });
  } catch (e) {
    console.error('[user-effective-roles] error:', e?.message);
    return res.status(500).json({ error: 'Kan rollen niet ophalen' });
  }
}
