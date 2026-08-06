// modules/klanten-v2/klanten-v2.js
//
// Bootstrap voor Klanten-v2. Regelt:
//   - Auth-gate (herbruikt window.AuthShared uit shared/supabase-client.js)
//   - Dark-mode toggle (uit shared/design-system/theme.js)
//   - Route-shell: ?id=<uuid>&tab=<slug> voor detail-view (PR-B), anders lijst.
//   - Kleine helpers (toast, esc, avatar-render, authedFetch) die de views
//     via `window.KV` gebruiken. Views importeren ES-modules zelf.
//
// PR-A rendert alleen de lijst-view (views/list.js). Detail-view (PR-B) en
// modals (PR-C) plakken later in dezelfde route-shell.

import { bindThemeToggle, avatarGradient, initialsOf } from '../shared/design-system/theme.js';
import { renderListView } from './views/list.js';

// ── Globale helpers ──────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);

function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _toastTimer = null;
function toast(msg, opts = {}) {
  const el = $('#kv-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), opts.duration || 2400);
}

/**
 * Fetch met Bearer-token uit AuthShared. Herbruikt de bestaande auth-cookie
 * flow; als er geen sessie is, wordt AuthShared.requireAuth de gebruiker
 * al naar /login geredirect hebben tegen de tijd dat we hier komen.
 */
async function authedFetch(url, init = {}) {
  const token = (window.AuthShared && (await window.AuthShared.getAccessToken())) || null;
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

async function authedJson(url, init = {}) {
  const resp = await authedFetch(url, init);
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave null */ }
  if (!resp.ok) {
    const err = new Error((json && (json.error || json.message)) || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

function initials(name) { return initialsOf(name); }

/** Kleine avatar in tabelrij / topbar */
function renderAvatar(seed, name, size = 28) {
  const bg = avatarGradient(seed || name || '?');
  return `<div class="ds-avatar" style="background:${bg}; width:${size}px; height:${size}px; font-size:${Math.round(size * .38)}px;">${esc(initials(name))}</div>`;
}

// Expose voor views
window.KV = {
  $, esc, toast, authedFetch, authedJson, renderAvatar, initials,
};

// ── Auth-gate ─────────────────────────────────────────────────────────────────

async function initAuth() {
  if (!window._authSharedReady) {
    console.error('[klanten-v2] supabase-client niet geladen — auth kan niet initialiseren.');
    return null;
  }
  await window._authSharedReady;
  if (!window.AuthShared) {
    console.error('[klanten-v2] AuthShared niet aanwezig.');
    return null;
  }

  // requireAuth redirect naar /login.html?returnTo=… bij niet-ingelogd
  // of niet-actief profiel. ADMIN_ROLES = super_admin/admin/manager.
  // Retourneert het profile-object direct (of null als er geredirect is).
  const profile = await window.AuthShared.requireAuth(['super_admin', 'admin', 'manager']);
  if (!profile) return null;

  const name = profile.full_name || profile.email || 'Onbekend';
  const role = profile.role || '—';

  const avEl = $('#kv-user-avatar');
  if (avEl) {
    avEl.style.background = avatarGradient(profile.id || name);
    avEl.textContent = initials(name);
  }
  const nameEl = $('#kv-user-name');   if (nameEl) nameEl.textContent = name;
  const roleEl = $('#kv-user-role');   if (roleEl) roleEl.textContent = role;

  return ctx;
}

// ── Router (minimaal) ────────────────────────────────────────────────────────

function parseRoute() {
  const u = new URL(window.location.href);
  return {
    id: u.searchParams.get('id') || null,
    tab: u.searchParams.get('tab') || null,
  };
}

async function mountRoute(ctx) {
  const view = $('#kv-view');
  const route = parseRoute();

  if (route.id) {
    // Detail-view: PR-B. Placeholder tot dan.
    view.innerHTML = `
      <div class="ds-pad">
        <div class="ds-banner ds-banner-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>Detail-view volgt in PR-B. Klant-ID <code>${esc(route.id)}</code> ${route.tab ? `· tab <code>${esc(route.tab)}</code>` : ''}.</span>
        </div>
        <div class="ds-empty" style="padding:40px 20px;">
          <div class="ds-empty-t">Nog niet beschikbaar</div>
          <div class="ds-empty-s">Ga <a href="?" style="color:var(--m); text-decoration:underline;">terug naar de lijst</a> of open de klant in het oude scherm via <a href="/modules/klanten.html?id=${esc(route.id)}" style="color:var(--m); text-decoration:underline;">klanten.html</a>.</div>
        </div>
      </div>`;
    const crumbSep = $('#kv-crumb-sep');   if (crumbSep) crumbSep.hidden = false;
    const crumbCur = $('#kv-crumb-cur');   if (crumbCur) { crumbCur.hidden = false; crumbCur.textContent = 'Detail'; }
    return;
  }

  // Lijst-view (PR-A scope)
  await renderListView(view, { ctx });
}

// Reageer op back/forward
window.addEventListener('popstate', () => {
  // Volledige re-mount is prima; er is nog geen zware state om te bewaren.
  const ctx = window.__kvAuthCtx || null;
  mountRoute(ctx).catch((e) => {
    console.error('[klanten-v2] mountRoute error:', e);
    toast('Fout bij laden view');
  });
});

// Hook voor views om te navigeren zonder hard-refresh.
window.KV.navigate = function navigate(params = {}) {
  const u = new URL(window.location.href);
  const keys = ['id', 'tab'];
  for (const k of keys) {
    if (params[k] === null) u.searchParams.delete(k);
    else if (params[k] !== undefined) u.searchParams.set(k, params[k]);
  }
  window.history.pushState({}, '', u);
  const ctx = window.__kvAuthCtx || null;
  return mountRoute(ctx);
};

// ── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  // Dark-mode toggle wire
  bindThemeToggle($('#kv-theme-toggle'));

  // Topbar-search → forward naar lijst-view via event
  const topSearch = $('#kv-topbar-search');
  if (topSearch) {
    let deb = null;
    topSearch.addEventListener('input', (ev) => {
      if (deb) clearTimeout(deb);
      const val = String(ev.target.value || '');
      deb = setTimeout(() => {
        window.dispatchEvent(new CustomEvent('kv:topbar-search', { detail: { value: val } }));
      }, 220);
    });
    topSearch.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { topSearch.value = ''; window.dispatchEvent(new CustomEvent('kv:topbar-search', { detail: { value: '' } })); }
    });
  }
  // ⌘K / Ctrl+K focus topbar-search
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      topSearch && topSearch.focus();
    }
  });

  const profile = await initAuth();
  window.__kvAuthCtx = profile;
  if (!profile) return;

  await mountRoute(profile);
})().catch((e) => {
  console.error('[klanten-v2] boot fatal:', e);
  const view = document.getElementById('kv-view');
  if (view) view.innerHTML = `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div><strong>Kan module niet starten.</strong><div style="font-size:12px; opacity:.8; margin-top:2px;">${(e && e.message) ? String(e.message) : 'Onbekende fout'}</div></div>
    </div>`;
});
