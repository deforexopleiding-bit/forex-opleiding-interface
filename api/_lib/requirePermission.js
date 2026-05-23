// api/_lib/requirePermission.js
// RBAC permission-check voor API-endpoints (server-side enforcement).
// Map start met '_' → Vercel behandelt dit NIET als route, alleen als helper.
//
// Gebruikt de DB-functie user_has_permission(user_uuid, fkey) uit migratie 002
// (super_admin = altijd true; anders union over user_roles × role_permissions).
//
// NB (Fase 2, voorbereidend): nog nergens aangeroepen. role_permissions is leeg,
// dus inschakelen zou alles behalve super_admin blokkeren. Wire pas in zodra de
// matrix gevuld is.

import { supabase, supabaseAdmin } from '../supabase.js';

/**
 * @returns {Promise<boolean>} true als de Bearer-user de feature mag.
 * Zelfde token-patroon als verifyAdmin(): anon-client valideert de token,
 * service-role draait de RPC.
 */
export async function requirePermission(req, featureKey) {
  try {
    const authHeader = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return false;

    const { data, error } = await supabaseAdmin.rpc('user_has_permission', {
      user_uuid: user.id,
      fkey: featureKey,
    });
    if (error) { console.error('[requirePermission] RPC fout:', error.message); return false; }
    return data === true;
  } catch (err) {
    console.error('[requirePermission] fout:', err.message);
    return false;
  }
}

/**
 * Stuurt 403 en returnt false als de user de feature niet mag; anders true.
 *   if (!(await checkPermissionOrDeny(req, res, 'email.reclassify.run'))) return;
 */
export async function checkPermissionOrDeny(req, res, featureKey) {
  const allowed = await requirePermission(req, featureKey);
  if (!allowed) {
    res.status(403).json({ error: 'Insufficient permissions', feature: featureKey });
    return false;
  }
  return true;
}
