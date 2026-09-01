/**
 * modules/shared/design-system/roles.js — Rol-helpers (browser)
 *
 * Spiegelt api/_lib/roles.js voor gebruik in module-boot + shell-render.
 * Exposeert alles op window.DFORoles zodat non-module scripts (klassieke
 * <script src>) er ook bij kunnen.
 *
 * Bron van waarheid:
 *   - Supabase-rollen: 8 (super_admin/admin/manager/sales/mentor/marketing/
 *     administratie/viewer) — komt uit api/admin-users.js VALID_ROLES.
 *   - Shell-rollen: 5 (super_admin/manager/sales/mentor/marketing) — komt
 *     uit MODS in app-shell.js. 'admin' en 'viewer' bestaan niet in de shell.
 *   - Mapping: admin -> super_admin, viewer -> administratie (niet in shell,
 *     wordt gefilterd door pickShellRoles).
 *   - Rol-sets A / SA / SAM / SAMS / SAMSM / SAMMK — bron BOUWPLAN §2.
 */

(function () {
  'use strict';

  const VALID_SUPABASE_ROLES = [
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'marketing', 'administratie', 'viewer',
  ];

  const ROLE_PRIORITY = [
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'administratie', 'marketing', 'viewer',
  ];

  // BP2 (2026-09-01): 'appointmentsetter' toegevoegd zodat Romy in de
  // klanten-v2-shell zichtbaar is met haar eigen rol (i.p.v. de default-
  // fallback op 'super_admin' die haar per ongeluk admin-toegang zou geven).
  const SHELL_ROLES = ['super_admin', 'manager', 'sales', 'mentor', 'marketing', 'appointmentsetter'];

  const ROLE_SETS = Object.freeze({
    A:     ['super_admin', 'manager', 'sales', 'mentor', 'marketing'],
    SA:    ['super_admin'],
    SAM:   ['super_admin', 'manager'],
    SAMS:  ['super_admin', 'manager', 'sales'],
    SAMSM: ['super_admin', 'manager', 'sales', 'mentor'],
    SAMMK: ['super_admin', 'manager', 'marketing'],
  });

  function computeHighestRole(roles) {
    if (!roles || roles.length === 0) return 'viewer';
    for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
    return 'viewer';
  }

  function mapRoleForShell(supabaseRole) {
    const map = {
      super_admin:   'super_admin',
      admin:         'super_admin',
      manager:       'manager',
      sales:         'sales',
      mentor:        'mentor',
      marketing:     'marketing',
      administratie: 'administratie',
      viewer:        'administratie',
      // BP2 setter-attributie (2026-09-01) — Romy heeft haar eigen shell-rol.
      appointmentsetter: 'appointmentsetter',
    };
    return map[String(supabaseRole || '').toLowerCase()] || 'super_admin';
  }

  function pickShellRoles(supabaseRoles) {
    const arr = Array.isArray(supabaseRoles) ? supabaseRoles : [supabaseRoles];
    const mapped = new Set();
    for (const r of arr) {
      const shell = mapRoleForShell(r);
      if (shell && SHELL_ROLES.includes(shell)) mapped.add(shell);
    }
    const ordered = [];
    for (const r of ROLE_PRIORITY) if (mapped.has(r)) ordered.push(r);
    return ordered;
  }

  function hasAnyRole(userRoles, requiredSet) {
    const have = new Set(Array.isArray(userRoles) ? userRoles : [userRoles]);
    const need = Array.isArray(requiredSet) ? requiredSet : [requiredSet];
    for (const r of need) if (have.has(r)) return true;
    return false;
  }

  /**
   * Fetch effectieve rollen voor de ingelogde user via /api/user-effective-roles.
   * Vereist een Bearer-token uit AuthShared. Retourneert
   *   { primary_role, roles: [], shell_roles: [] }
   * of null bij een niet-ingelogde user / netwerkfout. Caller kiest zelf de
   * fallback (bv. terugvallen op profile.role of shell-boot skippen).
   */
  async function fetchEffectiveRoles() {
    try {
      if (!window.AuthShared || typeof window.AuthShared.getAccessToken !== 'function') {
        console.warn('[DFORoles] AuthShared niet aanwezig — kan rollen niet ophalen.');
        return null;
      }
      const token = await window.AuthShared.getAccessToken();
      if (!token) return null;
      const resp = await fetch('/api/user-effective-roles', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        console.warn('[DFORoles] fetchEffectiveRoles HTTP', resp.status);
        return null;
      }
      return await resp.json();
    } catch (e) {
      console.warn('[DFORoles] fetchEffectiveRoles fail:', e?.message);
      return null;
    }
  }

  window.DFORoles = {
    VALID_SUPABASE_ROLES,
    ROLE_PRIORITY,
    SHELL_ROLES,
    ROLE_SETS,
    computeHighestRole,
    mapRoleForShell,
    pickShellRoles,
    hasAnyRole,
    fetchEffectiveRoles,
  };
})();
