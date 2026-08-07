// modules/klanten-v2/klanten-v2.js
//
// Bootstrap voor Klanten-v2. Sinds PR 0-C aangehaakt op de gedeelde
// app-shell (modules/shared/design-system/app-shell.js). Dit bestand
// regelt nog:
//   - Auth-gate (herbruikt window.AuthShared uit shared/supabase-client.js)
//   - Rol-mapping Supabase-rol -> DFO-rol
//   - Registratie van de klanten-VIEW in DFO.VIEWS zodat de shell weet
//     welk view te renderen wanneer de klanten-module actief is.
//   - Route-shell: ?id=<uuid>&tab=<slug> voor detail-view (PR-B).
//   - Kleine helpers (toast, esc, avatar-render, authedFetch) die de views
//     via `window.KV` gebruiken. Views importeren ES-modules zelf.
//
// PR-A rendert alleen de lijst-view (views/list.js). Detail-view (PR-B) en
// modals (PR-C) plakken later in dezelfde route-shell.

import { renderListView } from './views/list.js';
import { renderDetailView, resetDetailCache } from './views/detail.js';

// ── Kleine utils (voorheen uit theme.js — dat bestand is niet meer nodig
//    nu DFO de theme-toggle levert). Zelfstandig zodat deze module niet
//    hoeft te weten van app-shell.js internals.

function avatarGradient(seed) {
  const s = String(seed || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const palette = [
    ['#2D74D6', '#1B4EA0'], // blue
    ['#7C4FE0', '#5B2FB8'], // violet
    ['#0EA271', '#076B4A'], // emerald
    ['#E08628', '#B45E10'], // amber
    ['#D63A4E', '#A62232'], // rose
    ['#1F8FA6', '#0E6B7E'], // teal
    ['#B23FA8', '#832883'], // magenta
  ];
  const [a, b] = palette[hash % palette.length];
  return `linear-gradient(140deg, ${a}, ${b})`;
}

function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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

/** Kleine avatar in tabelrij */
function renderAvatar(seed, name, size = 28) {
  const bg = avatarGradient(seed || name || '?');
  return `<div class="ds-avatar" style="background:${bg}; width:${size}px; height:${size}px; font-size:${Math.round(size * .38)}px;">${esc(initials(name))}</div>`;
}

// Expose voor views
window.KV = {
  $, esc, toast, authedFetch, authedJson, renderAvatar, initials,
};

// ── Auth-gate ─────────────────────────────────────────────────────────────────
// Rol-mapping Supabase -> DFO is sinds PR 0-D gecentraliseerd in
// modules/shared/design-system/roles.js (window.DFORoles) en de spiegel
// api/_lib/roles.js. Deze module gebruikt window.DFORoles.fetchEffectiveRoles()
// + window.DFO.setRoles() — geen eigen mapping meer.

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
  // of niet-actief profiel. ADMIN_ROLES = super_admin/admin/manager/sales.
  const profile = await window.AuthShared.requireAuth(['super_admin', 'admin', 'manager', 'sales']);
  if (!profile) return null;

  return profile;
}

/**
 * Vervang de shell-sidebar user-info met werkelijke Supabase-user.
 * DFO.setRole() zet deze velden al op basis van de rol-persona; we
 * overschrijven ze met de échte user zodat de mock-persona uit
 * ROLES niet aan de gebruiker getoond wordt.
 */
function paintUser(profile) {
  if (!profile) return;
  const name = profile.full_name || profile.email || 'Onbekend';
  const role = profile.role || '—';

  const un = document.getElementById('userName');   if (un) un.textContent = name;
  const ur = document.getElementById('userRole');   if (ur) ur.textContent = role;
  const av = document.getElementById('userAv');
  if (av) {
    av.style.background = avatarGradient(profile.id || name);
    av.textContent = initials(name);
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

function parseRoute() {
  const u = new URL(window.location.href);
  return {
    id: u.searchParams.get('id') || null,
    tab: u.searchParams.get('tab') || null,
  };
}

/**
 * VIEW-callback voor DFO shell. Wordt aangeroepen op elke DFO.render() als
 * de klanten-module actief is. Returnt sync HTML zodat DFO 'em kan
 * innerHTML'en; async werk (data-fetches) hangen we via queueMicrotask
 * op zodat het pas start nadat de root-node in de DOM zit.
 */
function klantenView() {
  const route = parseRoute();
  const profile = window.__kvAuthCtx || null;

  if (route.id) {
    // Detail-view (PR-B1: orchestrator + header + tab-strip + placeholders).
    // Async mount na innerHTML-flush zodat #kv-view aan de DOM hangt.
    queueMicrotask(() => {
      const rootEl = document.getElementById('kv-view');
      if (!rootEl) return;
      renderDetailView(rootEl, { id: route.id, tab: route.tab, profile }).catch((e) => {
        console.error('[klanten-v2] detail mount error:', e);
        toast('Fout bij laden dossier');
      });
    });
    return `<div id="kv-view"></div>`;
  }

  // Lijst-view: mount async in de zojuist-ingevoegde container.
  // Reset detail-cache zodat een verse open-klant-actie geen stale data
  // uit een vorige sessie oppikt.
  resetDetailCache();
  queueMicrotask(() => {
    const rootEl = document.getElementById('kv-view');
    if (!rootEl) return;
    renderListView(rootEl, { profile }).catch((e) => {
      console.error('[klanten-v2] list mount error:', e);
      toast('Fout bij laden lijst');
    });
  });
  return `<div id="kv-view"></div>`;
}

// Reageer op back/forward: her-render via DFO
window.addEventListener('popstate', () => {
  if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
});

// Publieke navigatie-hook voor views (klik op rij -> pushState + re-render).
window.KV.navigate = function navigate(params = {}) {
  const u = new URL(window.location.href);
  const keys = ['id', 'tab'];
  for (const k of keys) {
    if (params[k] === null) u.searchParams.delete(k);
    else if (params[k] !== undefined) u.searchParams.set(k, params[k]);
  }
  window.history.pushState({}, '', u);
  if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
};

// ── Topbar-search + ⌘K (aansluitend op shell topbar) ─────────────────────────

function wireTopbarSearch() {
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
      if (ev.key === 'Escape') {
        topSearch.value = '';
        window.dispatchEvent(new CustomEvent('kv:topbar-search', { detail: { value: '' } }));
      }
    });
  }
  // ⌘K / Ctrl+K focust de topbar-search
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      topSearch && topSearch.focus();
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  // 1) Wacht tot DFO shell klaar staat (script src staat vóór dit type=module,
  //    maar zowel scripts als modules kunnen in willekeurige volgorde parsen).
  if (!window.DFO || typeof window.DFO.setRole !== 'function') {
    console.error('[klanten-v2] DFO shell niet geladen — module-boot geannuleerd.');
    return;
  }

  // 2) Registreer de klanten-VIEW voor het enige tab dat de module heeft
  //    (MODS: id 'klanten', tabs ['Overzicht']). Ook fallback 'klanten/'.
  window.DFO.VIEWS['klanten/Overzicht'] = klantenView;
  window.DFO.VIEWS['klanten/']          = klantenView;

  wireTopbarSearch();

  // 3) Auth (redirect naar /login als niet ingelogd)
  const profile = await initAuth();
  window.__kvAuthCtx = profile;
  if (!profile) return;

  // 4) Rollen zetten in DFO shell (rendert dashboard-default of eerste
  //    zichtbare module). We halen de EFFECTIEVE rollen op (union van
  //    profiles.role + user_roles) zodat iemand met bv. mentor+marketing
  //    beide module-sets in de nav ziet. Fallback op profile.role als het
  //    endpoint faalt (offline / netwerkfout) — dan werkt de shell nog
  //    steeds, alleen zonder de additieve rollen.
  let shellRoles = null;
  if (window.DFORoles && typeof window.DFORoles.fetchEffectiveRoles === 'function') {
    const eff = await window.DFORoles.fetchEffectiveRoles();
    if (eff && Array.isArray(eff.shell_roles) && eff.shell_roles.length) {
      shellRoles = eff.shell_roles;
    }
  }
  if (!shellRoles) {
    const fallback = (window.DFORoles && window.DFORoles.pickShellRoles)
      ? window.DFORoles.pickShellRoles([profile.role])
      : [String(profile.role || 'super_admin').toLowerCase()];
    shellRoles = fallback.length ? fallback : ['super_admin'];
  }
  window.DFO.setRoles(shellRoles);
  window.DFO.goMod('klanten');

  // 5) Vervang shell-sidebar user-persona met échte Supabase-user.
  paintUser(profile);
})().catch((e) => {
  console.error('[klanten-v2] boot fatal:', e);
  const view = document.getElementById('content') || document.getElementById('kv-view');
  if (view) view.innerHTML = `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div><strong>Kan module niet starten.</strong><div style="font-size:12px; opacity:.8; margin-top:2px;">${(e && e.message) ? String(e.message) : 'Onbekende fout'}</div></div>
    </div>`;
});
