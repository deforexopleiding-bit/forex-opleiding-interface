/* ─── supabase-client.js ───────────────────────────────────────────────────
   Browser-side Supabase client + AuthShared helper.
   Exporteert: window.supabase, window.AuthShared, window._authSharedReady
   ──────────────────────────────────────────────────────────────────────── */

window._authSharedReady = (async function () {
  'use strict';

  // 1. Load Supabase SDK from CDN
  await new Promise((resolve, reject) => {
    if (window.supabase?.createClient) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  // 2. Fetch public config from server (keeps keys out of source code)
  let supabaseUrl = '', supabaseAnonKey = '';
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    supabaseUrl     = cfg.supabaseUrl     || '';
    supabaseAnonKey = cfg.supabaseAnonKey || '';
  } catch (e) {
    console.error('[supabase-client] config fetch failed:', e.message);
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[supabase-client] Missing Supabase config — auth will not work');
    window.AuthShared = null;
    return;
  }

  // 3. Create browser Supabase client
  window.supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  // ── Role-based landing-URL map ─────────────────────────────────────────
  // Primaire rol (profiles.role) → URL waar deze rol na login op moet
  // landen + waar de Dashboard-nav-link naar wijst. Whitelist-mapping;
  // onbekende of ontbrekende rollen vallen terug op '/index.html'
  // (NOOIT een lege string of redirect-loop). Manager landt op het
  // hoofd-dashboard (/index.html); sales op het sales-dashboard (dat
  // zelf doorverwijst naar sales.html?tab=dashboard) en mentor op het
  // mentor-dashboard. Super_admin / admin / marketing / administratie /
  // viewer / anders → '/index.html' (default).
  const ROLE_LANDING = {
    super_admin:    '/index.html',
    admin:          '/index.html',
    manager:        '/index.html',
    sales:          '/modules/sales-dashboard.html',
    mentor:         '/modules/mentor-dashboard.html',
    marketing:      '/index.html',
    administratie:  '/index.html',
    viewer:         '/index.html',
  };
  function getRoleLandingUrl(role) {
    if (typeof role === 'string' && ROLE_LANDING[role]) return ROLE_LANDING[role];
    return '/index.html';
  }

  // 4. AuthShared helpers
  window.AuthShared = {
    // Role-landing helpers (exposed zodat sidebar.js + login.html dezelfde
    // mapping gebruiken — single source of truth).
    ROLE_LANDING,
    getRoleLandingUrl,
    async getSession() {
      const { data } = await window.supabase.auth.getSession();
      return data?.session || null;
    },

    async getUser() {
      const session = await this.getSession();
      return session?.user || null;
    },

    async getProfile() {
      const user = await this.getUser();
      if (!user) return null;
      // Niet alleen `data` destructureren — bij elke .single()-glitch
      // (PostgREST 406, RLS-race, network) zou een stille null hier de
      // role-based routing kapot kunnen maken (bv. Dashboard-link valt
      // terug op /index.html i.p.v. mentor-/sales-dashboard).
      const { data, error } = await window.supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      if (error) {
        console.warn('[AuthShared.getProfile] supabase error:', error.message || error);
        return null;
      }
      return data || null;
    },

    async signOut() {
      await window.supabase.auth.signOut();
      window.location.href = '/login.html';
    },

    // requireAuth: voor modules die login vereisen (nu alleen admin.html).
    // allowedRoles = null → alleen authenticatie checken, geen rol-check.
    async requireAuth(allowedRoles = null) {
      const session = await this.getSession();
      if (!session) {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login.html?returnTo=${returnTo}`;
        return null;
      }

      const profile = await this.getProfile();
      if (!profile || !profile.is_active) {
        await window.supabase.auth.signOut();
        window.location.href = '/login.html?error=inactive';
        return null;
      }

      if (allowedRoles && !allowedRoles.includes(profile.role)) {
        window.location.href = '/login.html?error=no_access';
        return null;
      }

      // Fire-and-forget last_login_at update (non-critical)
      window.supabase
        .from('profiles')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', profile.id)
        .then(() => {});

      return profile;
    },

    async updateProfile(updates) {
      const user = await this.getUser();
      if (!user) return { data: null, error: new Error('Not authenticated') };
      const { data, error } = await window.supabase
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', user.id)
        .select()
        .single();
      return { data, error };
    },

    // Haal access token op voor API calls met Authorization: Bearer header
    async getAccessToken() {
      const session = await this.getSession();
      return session?.access_token || null;
    },

    // ── Impersonation (admin "Login als <user>") ─────────────────────────
    // Schone wrapper rond supabase.auth.setSession. Wordt gebruikt door de
    // impersonation-flow voor zowel het verifyOtp-pad (na server-side mint)
    // als voor het "Terug naar jezelf"-pad (origin-sessie herstellen).
    async setSession({ access_token, refresh_token }) {
      if (!access_token || !refresh_token) {
        return { data: null, error: new Error('access_token + refresh_token vereist') };
      }
      try {
        const { data, error } = await window.supabase.auth.setSession({
          access_token, refresh_token,
        });
        return { data, error };
      } catch (e) {
        return { data: null, error: e };
      }
    },

    // Bewaar de origin-sessie (de eigen admin-sessie van VÓÓR impersonation)
    // in een aparte storage-sleutel zodat we 'm later kunnen terugzetten.
    // De Supabase-storage-key (sb-<ref>-auth-token) wordt straks overschreven
    // door verifyOtp; daarom MOETEN we de tokens vooraf hier kopiëren.
    saveImpersonationOrigin(originSession) {
      if (!originSession || !originSession.access_token || !originSession.refresh_token) {
        return false;
      }
      try {
        localStorage.setItem('impersonation_origin', JSON.stringify({
          access_token:  originSession.access_token,
          refresh_token: originSession.refresh_token,
        }));
        return true;
      } catch (e) { return false; }
    },
    getImpersonationOrigin() {
      try {
        const raw = localStorage.getItem('impersonation_origin');
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object' || !o.access_token || !o.refresh_token) return null;
        return o;
      } catch (e) { return null; }
    },
    clearImpersonationOrigin() {
      try { localStorage.removeItem('impersonation_origin'); } catch (e) {}
    },

    // Marker-state met target-info. Wordt door de banner (sidebar.js)
    // gebruikt om "Je bekijkt als <naam>" te tonen. Verschilt van
    // origin-sessie omdat we 'm willen kunnen lezen zonder de
    // (mogelijk verlopen) origin-tokens te raken.
    setImpersonationState(state) {
      if (!state || typeof state !== 'object') return false;
      try {
        localStorage.setItem('impersonation_state', JSON.stringify({
          target_name:  state.target_name || '',
          target_email: state.target_email || '',
          target_role:  state.target_role  || '',
          started_at:   state.started_at   || new Date().toISOString(),
        }));
        return true;
      } catch (e) { return false; }
    },
    getImpersonationState() {
      try {
        const raw = localStorage.getItem('impersonation_state');
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || typeof s !== 'object') return null;
        return s;
      } catch (e) { return null; }
    },
    clearImpersonationState() {
      try { localStorage.removeItem('impersonation_state'); } catch (e) {}
    },

    // Shortcut voor banner-conditionals.
    isImpersonating() {
      try {
        return !!localStorage.getItem('impersonation_state');
      } catch (e) { return false; }
    },
  };

  // Sessie-herstel forceren vóór de IIFE returnt. Zonder deze warmup is er een
  // race waarbij pagina's die `await window._authSharedReady` doen, daarna
  // toch een lege sessie + tokenLen=0 zien (Supabase laadt de persisted sessie
  // namelijk lazy bij de eerste auth-call). Door hier 1x getSession() te
  // awaiten is "ready" gegarandeerd "sessie beschikbaar".
  try {
    await window.AuthShared.getSession();
  } catch (e) {
    console.warn('[supabase-client] session warmup faalde:', e?.message || e);
  }
})();
