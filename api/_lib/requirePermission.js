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
 * Fail-open variant: returnt TRUE bij elk twijfelgeval (geen token, token-fout,
 * RPC-fout). ALLEEN FALSE als de RPC bewezen 'false' teruggeeft (geen permission).
 * Gebruik tijdens de migratiefase zodat DB-/auth-problemen niemand buitensluiten.
 * Let op: een request zonder Bearer-token → fail-open (allow). Endpoints die via
 * window.open of raw fetch (zonder auth-header) worden aangeroepen, worden hierdoor
 * dus NIET afgedwongen tot de frontend de token meestuurt.
 * @returns {Promise<boolean>}
 */
export async function requirePermissionFailOpen(req, featureKey) {
  try {
    const authHeader = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return true;        // geen token → fail-open
    const token = authHeader.slice(7);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return true;                          // token-validatie faalt → fail-open

    const { data, error } = await supabaseAdmin.rpc('user_has_permission', {
      user_uuid: user.id,
      fkey: featureKey,
    });
    if (error) { console.error('[requirePermissionFailOpen] RPC fout (fail-open):', error.message); return true; }
    return data !== false;                                      // ALLEEN false = bewezen-geen-permission
  } catch (err) {
    console.error('[requirePermissionFailOpen] fout (fail-open):', err.message);
    return true;                                                // elke fout → fail-open
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
