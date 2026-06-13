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

        // ── BACKEND-SYMMETRIC SUPER_ADMIN-BYPASS ─────────────────────────
        // Backend-RPC user_has_permission (migratie 002, regel 112-132) is
        // SECURITY DEFINER en heeft een onafhankelijke OR-tak
        // `EXISTS user_roles.role='super_admin'`. Daardoor bypasst de API
        // altijd voor super_admin, ook bij:
        //   - transiente user_roles RLS-glitches (de DEFINER omzeilt RLS)
        //   - mixed-role configs waarin user_roles 'admin' bevat maar
        //     profile.role 'super_admin' is.
        // De oude frontend-code controleerde super_admin pas NA de
        // user_roles-query, en alleen op de roles-array. Daardoor:
        //   - rolesRes.error -> immediate return new Set() (geen bypass)
        //   - mixed-role -> roles=['admin'], fallback fired niet (lengte>0),
        //     'super_admin' niet in array -> geen bypass
        //   - netto: UI ontzegt alles terwijl API alles toestaat.
        // Fix: explicit short-circuit op profile.role==='super_admin'.
        // Niet-super_admin gedrag is byte-identiek — code-pad hieronder
        // ongewijzigd.
        if (profile.role === 'super_admin') {
          _rolesCache = ['super_admin'];
          return new Set(['*']);
        }

        // 1) Alle rollen van de user (RLS: eigen rijen leesbaar).
        var rolesRes = await supa.from('user_roles').select('role').eq('user_id', userId);
        if (rolesRes.error) { console.warn('[RBAC] user_roles:', rolesRes.error.message); return new Set(); }
        var roles = (rolesRes.data || []).map(function (r) { return r.role; });
        // Fallback op profiles.role als user_roles (nog) leeg is — backward compatible.
        if (roles.length === 0 && profile.role) roles = [profile.role];
        _rolesCache = roles;

        // Defense-in-depth: user_roles kan na fix-1 (profile.role-bypass)
        // alsnog 'super_admin' bevatten zonder dat profile.role gezet was —
        // we honoreren dat ook (bestaand gedrag).
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
