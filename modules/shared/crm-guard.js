/* ─── crm-guard.js ─────────────────────────────────────────────────────────
   Harde CRM-toegangsguard — tweede beschermingslaag bovenop RLS.

   WAAROM
   Elk auth-account krijgt via handle_new_user() automatisch een profiles-rij
   met rol 'viewer' (of 'student'). Zo'n account hoort NOOIT in het CRM te
   komen — ook niet "even de sidebar zien". De RLS-hardening
   (docs/sql-migrations/2026-08-19-crm-rls-role-check-hardening.sql) sluit de
   data af; dit bestand sluit de UI af.

   HOE
   1. Bij het laden (synchroon, in <head>, vóór de eerste paint) verbergt dit
      script de pagina — tenzij er een verse "staff"-uitspraak in localStorage
      staat. CRM-staff ziet daardoor geen flits; wie nog geen uitspraak heeft
      ziet niets tot het oordeel binnen is.
   2. supabase-client.js roept na de sessie-warmup CrmGuard.applyVerdict(...)
      aan met het profiel. Staff → pagina vrijgeven. Geen staff → harde
      redirect naar het LMS.

   BEWUST FAIL-OPEN BIJ TWIJFEL
   Kan het profiel niet gelezen worden (netwerk-glitch, PostgREST 406), dan
   geven we de pagina vrij in plaats van staff naar het LMS te schoppen. Dat
   is veilig: RLS is de autoritatieve laag en geeft die gebruiker alsnog geen
   rij te zien. Deze guard is cosmetisch/UX, geen beveiligingsgrens.

   LET OP: dit bestand hoort in <head> te staan, vóór elk ander script.
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Whitelist — moet 1-op-1 gelijk zijn aan public.is_crm_staff() in
  // docs/sql-migrations/2026-08-19-crm-rls-role-check-hardening.sql
  // en aan CRM_STAFF_ROLES in api/_lib/crm-roles.js.
  // BP1 2026-08-31: appointmentsetter toegevoegd (herdefinitie van
  // is_crm_staff() zit in docs/sql-migrations/2026-08-31-bp1-appointmentsetter-foundation.sql).
  var CRM_STAFF_ROLES = [
    'super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing',
    'appointmentsetter',
  ];

  var LMS_URL = 'https://dfo-lms-prototype.vercel.app';

  // Pagina's die GEEN guard krijgen: de pre-login auth-flow (anders kan een
  // student niet meer uitloggen/wachtwoord resetten) en de publieke
  // token-pagina's.
  var EXEMPT_PATHS = [
    '/login.html',
    '/auth-callback.html',
    '/reset-password.html',
    '/modules/event-keuze.html',
    '/modules/assessment.html',
    '/modules/onboarding.html',
  ];

  var CACHE_KEY     = 'dfo_crm_staff_verdict';
  var CACHE_TTL_MS  = 12 * 60 * 60 * 1000;   // 12 uur
  var STYLE_ID      = 'dfo-crm-guard-hide';

  function currentPath() {
    return String(window.location.pathname || '').toLowerCase();
  }

  function isExemptPath() {
    var p = currentPath();
    for (var i = 0; i < EXEMPT_PATHS.length; i++) {
      if (p.slice(-EXEMPT_PATHS[i].length) === EXEMPT_PATHS[i]) return true;
    }
    return false;
  }

  function readCachedStaff() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      var v = JSON.parse(raw);
      if (!v || v.staff !== true || typeof v.ts !== 'number') return false;
      return (Date.now() - v.ts) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function writeCachedStaff(isStaff) {
    try {
      if (isStaff) localStorage.setItem(CACHE_KEY, JSON.stringify({ staff: true, ts: Date.now() }));
      else         localStorage.removeItem(CACHE_KEY);
    } catch (e) { /* private mode / quota — niet fataal */ }
  }

  function hidePage() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = 'html{visibility:hidden!important}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { /* niets kunnen verbergen is niet fataal */ }
  }

  function releasePage() {
    try {
      var st = document.getElementById(STYLE_ID);
      if (st && st.parentNode) st.parentNode.removeChild(st);
    } catch (e) { /* no-op */ }
  }

  var CrmGuard = {
    CRM_STAFF_ROLES: CRM_STAFF_ROLES,
    LMS_URL: LMS_URL,

    isExemptPath: isExemptPath,

    /** Is deze primaire rol (profiles.role) een CRM-medewerkersrol? */
    isStaffRole: function (role) {
      return CRM_STAFF_ROLES.indexOf(String(role || '')) !== -1;
    },

    /** Wist het cache-oordeel — aanroepen bij signOut. */
    clear: function () { writeCachedStaff(false); },

    /** Pagina alsnog tonen (gebruikt door applyVerdict + als noodklep). */
    release: releasePage,

    /**
     * Eindoordeel vellen.
     * @param {object|null} profile   profiles-rij, of null als onbekend
     * @param {boolean}     hasSession of er überhaupt een sessie is
     * @returns {boolean} true als er wordt geredirect (pagina blijft verborgen)
     */
    applyVerdict: function (profile, hasSession) {
      if (isExemptPath()) { releasePage(); return false; }

      // Niet ingelogd → geen student-probleem; requireAuth() stuurt naar login.
      if (!hasSession) { writeCachedStaff(false); releasePage(); return false; }

      // Profiel onleesbaar → fail-open op UI-niveau (RLS blijft dicht).
      if (!profile) {
        console.warn('[crm-guard] profiel onbekend — pagina vrijgegeven, RLS blijft autoritatief');
        releasePage();
        return false;
      }

      if (!this.isStaffRole(profile.role) || profile.is_active === false) {
        writeCachedStaff(false);
        console.warn('[crm-guard] geen CRM-rol (' + profile.role + ') — doorsturen naar LMS');
        window.location.replace(LMS_URL);
        return true;   // pagina bewust verborgen laten
      }

      writeCachedStaff(true);
      releasePage();
      return false;
    },
  };

  window.CrmGuard = CrmGuard;

  // Synchrone eerste stap: verbergen tot het oordeel er is.
  if (!isExemptPath() && !readCachedStaff()) hidePage();
})();
