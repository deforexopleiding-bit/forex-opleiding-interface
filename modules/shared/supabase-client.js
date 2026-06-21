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

  // 4. AuthShared helpers
  window.AuthShared = {
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
      const { data } = await window.supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
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
