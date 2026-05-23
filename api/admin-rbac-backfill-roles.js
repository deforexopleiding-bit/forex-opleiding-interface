// api/admin-rbac-backfill-roles.js
// Eenmalig: sync profiles.role (primair, voor legacy requireAuth) met de hoogste
// rol uit user_roles, voor ALLE bestaande users. Alleen super_admin.
// Backend-only (geen DB-trigger). Idempotent — herhaald draaien is veilig.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

// Houd identiek aan ROLE_PRIORITY in api/admin-users.js.
const ROLE_PRIORITY = ['super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing', 'viewer'];

function computeHighestRole(roles) {
  if (!roles || roles.length === 0) return 'viewer';
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
  return 'viewer';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Alleen super_admin (verifyAdmin geeft { user, profile } of null).
  const admin = await verifyAdmin(req);
  if (!admin || admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin.' });
  }

  try {
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, email, role');
    if (profErr) return res.status(500).json({ error: profErr.message });

    // Eén query voor alle user_roles → groeperen (geen N+1).
    const { data: roleRows, error: rolesErr } = await supabaseAdmin
      .from('user_roles')
      .select('user_id, role');
    if (rolesErr) return res.status(500).json({ error: rolesErr.message });

    const rolesByUser = {};
    (roleRows || []).forEach((r) => { (rolesByUser[r.user_id] ||= []).push(r.role); });

    const results = [];
    let changed = 0;
    for (const p of (profiles || [])) {
      const roleNames = rolesByUser[p.id] || [];
      const newRole = computeHighestRole(roleNames);
      if (newRole !== p.role) {
        const { error: updErr } = await supabaseAdmin.from('profiles').update({ role: newRole }).eq('id', p.id);
        if (updErr) { results.push({ email: p.email, error: updErr.message }); continue; }
        changed++;
        results.push({ email: p.email, oldRole: p.role, newRole, allRoles: roleNames, changed: true });
      } else {
        results.push({ email: p.email, role: p.role, allRoles: roleNames, changed: false });
      }
    }

    return res.status(200).json({ total: (profiles || []).length, changed, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
