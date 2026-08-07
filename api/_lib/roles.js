/**
 * api/_lib/roles.js — Centrale rol-helpers (server-side)
 *
 * Bron van waarheid voor:
 *   - de acht Supabase-rollen die profiles.role / user_roles kent
 *   - de vijf "shell-rollen" die de DFO app-shell rendert (BOUWPLAN §2)
 *   - de rol-sets A / SA / SAM / SAMS / SAMSM / SAMMK (BOUWPLAN §2)
 *   - de mapping Supabase → shell (admin -> super_admin, viewer -> administratie)
 *   - getEffectiveRoles(userId) — union van profiles.role + user_roles.role
 *   - hasAnyRole(rolesArray, requiredSet) — additief checken
 *
 * De DB heeft al een many-to-many `user_roles(user_id,role)` + de Postgres
 * helper `has_any_role(text[])` die zelf ook een union doet. Deze module
 * spiegelt die logica in JS zodat we in endpoints + shell-boot dezelfde
 * beslissing kunnen nemen zonder round-trip naar een DB-functie.
 */

// ── Supabase-rollen (bron: VALID_ROLES in api/admin-users.js) ───────────────
export const VALID_SUPABASE_ROLES = [
  'super_admin',
  'admin',
  'manager',
  'sales',
  'mentor',
  'marketing',
  'administratie',
  'viewer',
];

// Rol-hiërarchie (hoog → laag). Gebruikt voor "primary role"-afleiding
// (profiles.role sync + shell-persona keuze). Identiek aan
// api/admin-users.js `ROLE_PRIORITY`.
export const ROLE_PRIORITY = [
  'super_admin',
  'admin',
  'manager',
  'sales',
  'mentor',
  'administratie',
  'marketing',
  'viewer',
];

export function computeHighestRole(roles) {
  if (!roles || roles.length === 0) return 'viewer';
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
  return 'viewer';
}

// ── DFO shell-rollen (bron: MODS in modules/shared/design-system/app-shell.js) ──
// De shell rendert 5 rollen; 'admin' en 'viewer' bestaan daar niet.
export const SHELL_ROLES = ['super_admin', 'manager', 'sales', 'mentor', 'marketing'];

// Rol-sets uit BOUWPLAN §2 (autoritatief).
export const ROLE_SETS = Object.freeze({
  A:     ['super_admin', 'manager', 'sales', 'mentor', 'marketing'],
  SA:    ['super_admin'],
  SAM:   ['super_admin', 'manager'],
  SAMS:  ['super_admin', 'manager', 'sales'],
  SAMSM: ['super_admin', 'manager', 'sales', 'mentor'],
  SAMMK: ['super_admin', 'manager', 'marketing'],
});

/**
 * Map één Supabase-rol naar een shell-rol.
 * - 'admin' -> 'super_admin' (huidige RBAC-praktijk: admin heeft dezelfde
 *   management-toegang als super_admin binnen de UI-gating)
 * - 'viewer' -> 'administratie' (leest, mutatie-endpoints zijn RBAC-geleerd)
 * - onbekend / null -> 'super_admin' (fail-safe voor developers; productie-
 *   endpoints filteren op VALID_SUPABASE_ROLES voor die inputs)
 */
export function mapRoleForShell(supabaseRole) {
  const map = {
    super_admin:   'super_admin',
    admin:         'super_admin',
    manager:       'manager',
    sales:         'sales',
    mentor:        'mentor',
    marketing:     'marketing',
    administratie: 'administratie',
    viewer:        'administratie',
  };
  return map[String(supabaseRole || '').toLowerCase()] || 'super_admin';
}

/**
 * Filter een array Supabase-rollen naar de subset die de shell kent.
 * Deduplicatie + volgorde uit ROLE_PRIORITY. Levert een lege array (nooit
 * null) op zodat callers veilig .length / .some() kunnen doen.
 */
export function pickShellRoles(supabaseRoles) {
  const arr = Array.isArray(supabaseRoles) ? supabaseRoles : [supabaseRoles];
  const mapped = new Set();
  for (const r of arr) {
    const shell = mapRoleForShell(r);
    if (shell && SHELL_ROLES.includes(shell)) mapped.add(shell);
  }
  // Volgorde forceren zodat "primary" (roles[0]) deterministisch is
  const ordered = [];
  for (const r of ROLE_PRIORITY) {
    if (mapped.has(r)) ordered.push(r);
  }
  return ordered;
}

/**
 * Additive check: heeft de gebruiker minstens één van de vereiste rollen?
 * Callers geven Supabase-rollen door — mapping naar shell gebeurt intern
 * omdat de rol-sets uit ROLE_SETS in Supabase-taal zijn.
 */
export function hasAnyRole(userRoles, requiredSet) {
  const have = new Set(Array.isArray(userRoles) ? userRoles : [userRoles]);
  const need = Array.isArray(requiredSet) ? requiredSet : [requiredSet];
  for (const r of need) if (have.has(r)) return true;
  return false;
}

/**
 * Haal alle effectieve rollen op voor een user_id — union van profiles.role
 * (primair, voor legacy requireAuth) en user_roles.role (additief). Geeft
 * een gededupliceerde array terug in ROLE_PRIORITY-volgorde. Geen throws;
 * bij lookup-error retourneren we [] zodat callers kunnen fail-closed.
 *
 * Vereist een `supabaseAdmin`-client (service-role) omdat de user_roles
 * tabel via RLS beperkt is (self-read only voor gewone users; admin voor
 * beheer). Gebruik binnen server-side endpoints na verifyAdmin/etc.
 */
export async function getEffectiveRoles(userId, supabaseAdmin) {
  if (!userId || !supabaseAdmin) return [];
  const [profileRes, rolesRes] = await Promise.all([
    supabaseAdmin.from('profiles').select('role').eq('id', userId).single(),
    supabaseAdmin.from('user_roles').select('role').eq('user_id', userId),
  ]);
  if (profileRes.error && profileRes.error.code !== 'PGRST116') {
    console.warn('[roles] getEffectiveRoles profile lookup:', profileRes.error.message);
  }
  if (rolesRes.error) {
    console.warn('[roles] getEffectiveRoles user_roles lookup:', rolesRes.error.message);
  }
  const set = new Set();
  if (profileRes.data?.role) set.add(profileRes.data.role);
  for (const row of rolesRes.data || []) if (row.role) set.add(row.role);
  const ordered = [];
  for (const r of ROLE_PRIORITY) if (set.has(r)) ordered.push(r);
  return ordered;
}
