/* ============================================================
   RBAC permission-helper (frontend) — De Forex Opleiding
   Exporteert window.RBAC met can()/canSync()/ensurePermissionsLoaded().

   Bron: migratie 002 (user_roles + role_permissions).
   - super_admin → impliciet alles ('*').
   - andere rollen → union van role_permissions.allowed over alle user_roles.

   NB (Fase 2, voorbereidend): role_permissions is nog LEEG en er wordt nog
   NERGENS afgedwongen. Niet-super_admins krijgen dus voorlopig een lege set —
   wire can()-checks pas in zodra de matrix gevuld is, anders sluit je iedereen
   buiten. Deze helper voegt alleen de infrastructuur toe.
   ============================================================ */
(function () {
  'use strict';

  var _permsCache = null;     // Set<string> | null
  var _rolesCache = null;     // string[] | null
  var _loadPromise = null;    // Promise<Set<string>> | null

  async function loadPermissions() {
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async function () {
      try {
        if (window._authSharedReady) await window._authSharedReady;
        var supa = window.supabase;
        var profile = window.AuthShared ? await window.AuthShared.getProfile() : null;
        var userId = profile && profile.id;
        if (!supa || !userId) return new Set();

        // 1) Alle rollen van de user (RLS: eigen rijen leesbaar).
        var rolesRes = await supa.from('user_roles').select('role').eq('user_id', userId);
        if (rolesRes.error) { console.warn('[RBAC] user_roles:', rolesRes.error.message); return new Set(); }
        var roles = (rolesRes.data || []).map(function (r) { return r.role; });
        // Fallback op profiles.role als user_roles (nog) leeg is — backward compatible.
        if (roles.length === 0 && profile.role) roles = [profile.role];
        _rolesCache = roles;

        if (roles.indexOf('super_admin') !== -1) return new Set(['*']);
        if (roles.length === 0) return new Set();

        // 2) Toegestane feature_keys voor deze rollen (RLS: role_permissions leesbaar voor iedereen).
        var permsRes = await supa.from('role_permissions')
          .select('feature_key').in('role', roles).eq('allowed', true);
        if (permsRes.error) { console.warn('[RBAC] role_permissions:', permsRes.error.message); return new Set(); }
        return new Set((permsRes.data || []).map(function (p) { return p.feature_key; }));
      } catch (err) {
        console.warn('[RBAC] load mislukt:', err && err.message);
        return new Set();
      }
    })();

    _permsCache = await _loadPromise;
    return _permsCache;
  }

  // Async check: `if (await window.RBAC.can('email.reclassify.run')) {...}`
  async function can(featureKey) {
    var perms = await loadPermissions();
    return perms.has('*') || perms.has(featureKey);
  }

  // Synchrone check — alleen ná ensurePermissionsLoaded().
  function canSync(featureKey) {
    if (!_permsCache) { console.warn('[RBAC] canSync vóór load'); return false; }
    return _permsCache.has('*') || _permsCache.has(featureKey);
  }

  async function ensurePermissionsLoaded() {
    return _permsCache || await loadPermissions();
  }

  function getUserRoles() { return _rolesCache || []; }

  function resetPermissionsCache() { _permsCache = null; _rolesCache = null; _loadPromise = null; }

  window.RBAC = {
    can: can,
    canSync: canSync,
    ensurePermissionsLoaded: ensurePermissionsLoaded,
    getUserRoles: getUserRoles,
    resetPermissionsCache: resetPermissionsCache
  };
})();
