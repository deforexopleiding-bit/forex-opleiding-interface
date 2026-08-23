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
  // Guard tegen expliciete `null` — default {} kicks alleen bij undefined,
  // dus `authedFetch(url, null)` crashte op `init.headers`. Fix voor
  // email-v2 Sanne-suggest ("Cannot read properties of null (reading 'headers')").
  init = init || {};
  const token = (window.AuthShared && (await window.AuthShared.getAccessToken())) || null;
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

async function authedJson(url, init = {}) {
  init = init || {};
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

// ── klx-softphone dependency shim ───────────────────────────────────────
// Shared klx-softphone.js (r191) roept window.AgentShared.apiFetch aan
// om /api/voys-sip-config te laden. In de v1-shell (klanten.html /
// finance.html / follow-up.html) wordt AgentShared door agent-shared.js
// gezet; de v2-shell laadt dat script BEWUST niet (het overschrijft
// theme-key + injecteert overlays die v2 zelf al biedt).
// Deze shim exposeert alleen wat klx-softphone nodig heeft: apiFetch +
// showToast. Zonder deze shim faalde SIP-init in v2 stilletjes en toonde
// de softphone permanent "Verbinding mislukt". Productie (v1-shell) werd
// niet geraakt — die laadt agent-shared.js gewoon.
window.AgentShared = window.AgentShared || {
  apiFetch : authedFetch,
  showToast: (msg, tone) => toast(msg, tone),
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

// In-shell navigatie naar een klant-dossier vanuit ELKE module — bv. vanuit de
// factuur- of offerte-detail (die draaien onder ?v2preview=finance/sales met
// invoice_id/deal_id). KV.navigate zet enkel id/tab en schakelt NIET van module;
// vandaar deze helper die de detail-context-params wist én naar de klanten-module
// schakelt (die id/tab leest). Voorkomt een nieuw tabblad naar de v1-pagina.
window.KV.openCustomer = function openCustomer(customerId, tab) {
  if (!customerId) return;
  const u = new URL(window.location.href);
  ['v2preview', 'v2tab', 'deal_id', 'invoice_id', 'subscription_id'].forEach((k) => u.searchParams.delete(k));
  u.searchParams.set('id', customerId);
  u.searchParams.set('tab', tab || 'profiel');
  window.history.pushState({}, '', u);
  if (window.DFO && typeof window.DFO.goMod === 'function') {
    try { window.DFO.goMod('klanten'); return; } catch (_) { /* val terug op render */ }
  }
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

// ── Legacy-URL vangnet ──────────────────────────────────────────────────────
// Elke module die nog NIET in v2 is herbouwd, wijst hier naar zijn oude URL.
// V2_MODULES = set van id's die WEL in v2 draaien (klik blijft binnen shell).
// Voor alles daarbuiten: DFO.goMod wordt gewrapt zodat hij door-navigeert
// naar de legacy-URL — zo blijft navigatie werken voor het live-team tijdens
// de gefaseerde uitrol.
const V2_MODULES = new Set(['klanten']);
// V2_ACTIVE_ALLOWLIST = welke v2-view-registraties (via KV_V2_ADD) daadwerkelijk
// active mogen worden. Een view-file kan zichzelf aanmelden, maar zolang zijn
// id niet in deze allowlist zit blijft de klik-in-nav via het legacy-vangnet
// (LEGACY_URLS) naar de oude module gaan. Zo kunnen we module-code
// meemergen zonder dat het live-team er per ongeluk in belandt.
//
// Elke module wordt PAS toegevoegd nadat zijn data-ronde compleet is en de
// nieuwe v2-view alle taken kan (dus geen half-af scherm voor het team).
// Dashboard heeft z'n data-ronde al gehad (#1210) en staat aan; klanten is
// de originele v2-basis.
const V2_ACTIVE_ALLOWLIST = new Set(['klanten', 'dashboard', 'sales', 'leads', 'finance', 'tickets', 'taken', 'onboarding', 'logboek', 'agents', 'events', 'binnenkort', 'verdiensten', 'mentoren', 'email', 'followup', 'inbox', 'leadsonderhoud', 'lisa', 'wanbetalers']);

// ── Preview-override via URL query-param ──────────────────────────────────
// `?v2preview=sales` (of comma-list `?v2preview=sales,finance,lisa`) forceert
// die id's in V2_MODULES + opent de KV_V2_ADD-gate — puur voor layout-review
// van modules die nog dormant zijn. Zonder param: geen effect.
//
// KRITIEK: dit block STAAT VOOR de KV_V2_ADD-definitie + PENDING-drain zodat
// de override al bekend is op moment dat view-files zichzelf aanmelden. Zo
// werkt `?v2preview=<id>` ook voor modules die géén entry in V2_ACTIVE_ALLOWLIST
// hebben (dormant modules) — dat was de oorspronkelijke intentie.
const PREVIEW_OVERRIDE_IDS = new Set();
try {
  const raw = new URLSearchParams(window.location.search).get('v2preview');
  if (raw) {
    raw.split(',').map(s => s.trim()).filter(Boolean).forEach((id) => {
      PREVIEW_OVERRIDE_IDS.add(id);
      V2_MODULES.add(id);
      console.info('[klanten-v2] ?v2preview override active — module in-shell:', id);
    });
  }
} catch (_) { /* URLSearchParams-fail is silent */ }

// Publieke API voor view-files (dashboard-v2.js etc) om zichzelf te
// registreren als v2-native. KV_V2_ADD is allowlist-gated MET
// preview-override-bypass: id is in-shell als 'ie in V2_ACTIVE_ALLOWLIST
// OF in PREVIEW_OVERRIDE_IDS zit. VIEWS-registratie zelf (DFO.VIEWS[key]=fn)
// gebeurt in de view-IIFE ONAFHANKELIJK van deze gate — die is altijd
// beschikbaar zodra de shell 'em opzoekt.
window.KV_V2_ADD = (id) => {
  if (!id || typeof id !== 'string') return;
  if (V2_ACTIVE_ALLOWLIST.has(id) || PREVIEW_OVERRIDE_IDS.has(id)) {
    V2_MODULES.add(id);
  } else {
    console.debug('[klanten-v2] view registered but dormant:', id);
  }
};
// Consumeer eventuele pending-registraties die vóór dit script laadden.
// Zelfde gate (allowlist OF preview-override) toepassen.
if (Array.isArray(window.KV_V2_PENDING)) {
  window.KV_V2_PENDING.forEach((id) => {
    if (V2_ACTIVE_ALLOWLIST.has(id) || PREVIEW_OVERRIDE_IDS.has(id)) V2_MODULES.add(id);
    else console.debug('[klanten-v2] pending-view dormant:', id);
  });
  window.KV_V2_PENDING = null;
}

const LEGACY_URLS = {
  dashboard:        '/index.html',
  inbox:            '/modules/finance.html?tab=inbox',        // finance-inbox is centrale WA-inbox
  taken:            '/modules/taken.html',
  klanten:          null,                                     // V2 — geen redirect
  studenten:        '/modules/mentor-students.html',
  wanbetalers:      '/modules/finance.html?tab=wanbetalers',
  email:            '/modules/email.html',
  tickets:          '/modules/tickets.html',
  followup:         '/modules/follow-up.html',
  sales:            '/modules/sales.html',
  finance:          '/modules/finance.html',
  verdiensten:      '/modules/mentor-home.html',
  lms:              null,                                     // ext-link — DFO opent al new-tab
  events:           null,                                     // V2 GO-LIVE — geen redirect meer
  onboarding:       null,                                     // V2 GO-LIVE — geen redirect meer
  mentoren:         '/modules/mentoren-beheer.html',
  leads:            '/modules/leads.html',
  nieuwsbrief:      null,                                     // bestaat nog niet — placeholder
  leadsonderhoud:   '/modules/leadsonderhoud.html',
  lisa:             '/modules/lisa.html',
  automatiseringen: '/modules/agent-center.html',             // dichtstbijzijnde legacy-equivalent
  agents:           null,                                     // V2 GO-LIVE — geen redirect meer
  logboek:          null,                                     // V2 GO-LIVE — geen redirect meer
  instellingen:     null,                                     // Ronde-31 v=58: instellingen is native geport; geen legacy-fallback meer.
  binnenkort:       null,                                     // placeholder
};

// Wrap DFO.goMod: als target NIET in V2_MODULES én er een legacy-URL is,
// full-page-navigeer naar legacy. Anders normale DFO.goMod-flow.
// Belt-and-suspenders: check ook PREVIEW_OVERRIDE_IDS expliciet (die IDs
// zitten al in V2_MODULES, maar deze extra check maakt de intentie zichtbaar
// en overleeft eventuele V2_MODULES-mutaties elders).
function wireLegacyFallback() {
  if (!window.DFO || !window.DFO.goMod || window.DFO.goMod.__kvLegacyWrapped) return;
  const orig = window.DFO.goMod;
  const wrapped = function (id) {
    if (V2_MODULES.has(id) || PREVIEW_OVERRIDE_IDS.has(id)) return orig.call(this, id);
    const legacyUrl = LEGACY_URLS[id];
    // Module met ext-link (bv. lms) — laat DFO's eigen open-in-new-tab flow doen
    const mod = (window.DFO.MODS || []).find((m) => m.id === id);
    if (mod && mod.ext) return orig.call(this, id);
    if (legacyUrl) {
      console.debug('[klanten-v2] legacy-nav', id, '→', legacyUrl);
      window.location.href = legacyUrl;
      return;
    }
    // Geen legacy-URL bekend (nieuwsbrief/binnenkort/studenten mentor-only zonder legacy):
    // val terug op DFO.goMod → toont genericView-placeholder in shell.
    return orig.call(this, id);
  };
  wrapped.__kvLegacyWrapped = true;
  window.DFO.goMod = wrapped;
}

// Belt-and-suspenders — event-delegation click-catcher op document dat
// legacy-modules direct via window.location.href navigeert, i.p.v. via de
// wrap-flow. Voorkomt dat een edge-case waar de wrap niet aanslaat (bv.
// inline-handler resolvet een ander DFO-object dan de gewrapte, of timing-
// race bij render) tot een 'dode klik' leidt.
// useCapture=true → vuurt vóór de inline-onclick handler.
function wireLegacyNavClickCatcher() {
  if (window.__kvNavCatcherWired) return;
  window.__kvNavCatcherWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('#nav button.nav-item');
    if (!btn) return;
    // Extract module-id uit onclick-attr ("DFO.goMod('instellingen')").
    const oc = btn.getAttribute('onclick') || '';
    const m = oc.match(/DFO\.goMod\('([^']+)'\)/);
    if (!m) return;
    const id = m[1];
    // v2-native active OF preview-override actief — laat shell-flow doen.
    if (V2_MODULES.has(id) || PREVIEW_OVERRIDE_IDS.has(id)) return;
    const legacyUrl = LEGACY_URLS[id];
    if (!legacyUrl) return;         // geen legacy-URL — laat placeholder tonen
    e.preventDefault(); e.stopPropagation();
    console.debug('[klanten-v2] nav-catcher legacy →', id, '→', legacyUrl);
    window.location.href = legacyUrl;
  }, true);
}

// ── Rol-bewuste topbar-actieknoppen ─────────────────────────────────────────
// v=1ek (2026-08-18): topbar-simplificatie — losse shortcut-knoppen (Offerte,
// Factuur, Nieuwe lead, Traject aanmelden) zijn verwijderd. Alleen de primary
// '+ Nieuw'-knop blijft; die opent een rol-gefilterde dropdown met dezelfde
// acties (minus Traject — helemaal weg per opdracht). Dashboard-hero volgt
// dezelfde simplificatie (zie dashboard-v2.js).

function renderTopbarActions() {
  const host = document.getElementById('topbarActions');
  if (!host || !window.DFO || !window.DFO.S) return;
  // Dashboard heeft z'n eigen + Nieuw-knop in de hero-band (naast de
  // periode-schakelaar); verberg de topbar-versie daar om dubbeling
  // te vermijden. Andere modules tonen 'em altijd.
  if (window.DFO.S.mod === 'dashboard') { host.innerHTML = ''; return; }
  const svg  = window.DFO.svg;
  const I    = window.DFO.I;
  host.innerHTML = `<button class="btn btn-primary" onclick="DFO.KV.newAction('nieuw')" title="Nieuw">${svg(I.plus)}<span>Nieuw</span></button>`;
}

// Topbar-acties bedrading: DFO.KV.newAction(kind) delegeert naar de
// bestaande module-handler per kind. De + Nieuw-knop opent een rol-
// gefilterde dropdown die intern dezelfde kinds aanroept.
window.DFO = window.DFO || {};
window.DFO.KV = window.DFO.KV || {};

// Helper: DFO.goMod('X') als current mod !== X, dan een tick wachten
// zodat de view gemount is, dan de callback. Bij zelfde mod: direct.
function _kvGoModAnd(targetMod, cb) {
  const cur = window.DFO && window.DFO.S && window.DFO.S.mod;
  if (cur === targetMod || !window.DFO || typeof window.DFO.goMod !== 'function') {
    try { cb(); } catch (e) { console.error('[kv topbar] handler fail:', e); }
    return;
  }
  try { window.DFO.goMod(targetMod); } catch (_) {}
  // Wacht 2 rAFs zodat DFO.render + view-mount klaar zijn.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { cb(); } catch (e) { console.error('[kv topbar] deferred handler fail:', e); }
  }));
}

window.DFO.KV.newAction = function newAction(kind) {
  switch (kind) {
    case 'offerte':
      // Sales-wizard opener bestaat op window na sales-wizard-v2.js load.
      if (typeof window.__swOpen === 'function') { window.__swOpen(); return; }
      toast('Sales-wizard niet geladen — probeer opnieuw over een paar seconden.');
      return;
    case 'factuur':
      // BROK B #4 (2026-08-19): defensieve intent-check. Factuur-optie MOET
      // naar __finInvNew (invoice-create-modal), NOOIT naar __swOpen
      // (sales-wizard = offerte-flow). Log welke handler pakt zodat een
      // toekomstige regressie makkelijk gespot wordt. Ook: als __finInvNew
      // niet bestaat is een expliciete toast zichtbaarder dan silent
      // fallback naar iets anders.
      console.debug('[kv topbar] newAction(factuur) → goMod(finance) + __finInvNew');
      _kvGoModAnd('finance', () => {
        if (typeof window.__finInvNew === 'function') {
          window.__finInvNew();
        } else {
          console.warn('[kv topbar] __finInvNew ontbreekt na goMod(finance) — geen fallback naar __swOpen (dat is offerte-flow, niet factuur).');
          toast('Kon nieuwe-factuur-modal niet openen — herlaad de pagina.');
        }
      });
      return;
    case 'lead':
      // Leads-module deep-link: __leadNew zet URL-param 'lead-new=1' en de
      // leads-view rendert de nieuwe-lead-modal. Werkt alleen binnen die
      // module — dus eerst goMod, dan handler.
      _kvGoModAnd('leads', () => {
        if (typeof window.__leadNew === 'function') window.__leadNew();
        else toast('Nieuwe-lead-flow niet beschikbaar.');
      });
      return;
    case 'nieuw':
      // Dropdown-menu met alle beschikbare acties (rol-gefilterd).
      _kvOpenNieuwMenu();
      return;
    default:
      toast(`Actie "${kind}" onbekend.`);
  }
};

/* ── + Nieuw dropdown-menu (rol-gefilterd) ────────────────────────────── */
function _kvCloseNieuwMenu() {
  const m = document.getElementById('kvNieuwMenu');
  if (m) m.remove();
  document.removeEventListener('click', _kvNieuwMenuOutside, true);
  document.removeEventListener('keydown', _kvNieuwMenuKey, true);
}
function _kvNieuwMenuOutside(e) {
  const m = document.getElementById('kvNieuwMenu');
  if (m && !m.contains(e.target)) _kvCloseNieuwMenu();
}
function _kvNieuwMenuKey(e) { if (e.key === 'Escape') _kvCloseNieuwMenu(); }
function _kvOpenNieuwMenu() {
  _kvCloseNieuwMenu();
  const roles = (window.DFO && window.DFO.S && window.DFO.S.roles) || [];
  const has  = (r) => roles.includes(r);
  const anyAdmin = has('super_admin') || has('manager');
  const items = [];
  // v=1ek: Traject aanmelden verwijderd uit het menu (per opdracht).
  // Rol-filter gespiegeld aan de vorige losse-knoppen-config.
  if (has('sales') || anyAdmin) items.push({ kind: 'offerte', label: 'Offerte',     icon: '📝' });
  if (has('sales') || anyAdmin) items.push({ kind: 'factuur', label: 'Factuur',     icon: '📄' });
  if (has('sales') || has('marketing') || anyAdmin) items.push({ kind: 'lead', label: 'Nieuwe lead', icon: '🎯' });
  if (!items.length) { toast('Geen acties beschikbaar voor je rol.'); return; }
  // Positie: rechter-topbar. Anker: de + Nieuw knop.
  const anchor = document.querySelector('#topbarActions .btn.btn-primary');
  const rect = anchor ? anchor.getBoundingClientRect() : { bottom: 60, right: window.innerWidth - 20 };
  const menu = document.createElement('div');
  menu.id = 'kvNieuwMenu';
  menu.setAttribute('role', 'menu');
  menu.style.cssText = 'position:fixed;top:' + (rect.bottom + 6) + 'px;right:' + (window.innerWidth - rect.right) + 'px;z-index:2500;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:0 12px 32px rgba(0,0,0,.18);min-width:220px;padding:6px;overflow:hidden';
  menu.innerHTML = items.map((it) => `<button role="menuitem" data-kind="${it.kind}" style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;background:transparent;color:var(--text-1);font:inherit;font-size:13px;text-align:left;border-radius:6px;cursor:pointer" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'"><span style="font-size:15px">${it.icon}</span>${it.label}</button>`).join('');
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn) return;
    const kind = btn.getAttribute('data-kind');
    _kvCloseNieuwMenu();
    if (kind) window.DFO.KV.newAction(kind);
  });
  setTimeout(() => {
    document.addEventListener('click', _kvNieuwMenuOutside, true);
    document.addEventListener('keydown', _kvNieuwMenuKey, true);
  }, 0);
}

// Hook: DFO.setRoles / setRole / goMod triggeren re-render van actiebalk.
// We wrappen na boot zodat elke rol-wissel (via de rolebox) meteen doorwerkt.
function wireTopbarActionsToShell() {
  if (!window.DFO) return;
  ['setRoles', 'setRole', 'goMod', 'render'].forEach((fn) => {
    const orig = window.DFO[fn];
    if (typeof orig !== 'function' || orig.__kvWrapped) return;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      try { renderTopbarActions(); } catch (_) { /* noop */ }
      return r;
    };
    wrapped.__kvWrapped = true;
    window.DFO[fn] = wrapped;
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
  // Wrap DFO.goMod met legacy-vangnet (redirect naar oude module-URL voor
  // nog-niet-herbouwde v2-modules) + wrap re-render van topbar-actiebalk.
  wireLegacyFallback();
  wireLegacyNavClickCatcher();
  wireTopbarActionsToShell();

  window.DFO.setRoles(shellRoles);

  // Sync rolebox-select met huidige primary rol + toon 'em (voor preview).
  const roleSel = document.getElementById('roleSel');
  if (roleSel && window.DFO.S && window.DFO.S.roles && window.DFO.S.roles[0]) {
    roleSel.value = window.DFO.S.roles[0];
  }
  // Rolebox is nu zichtbaar (inline style display:none uit index.html
  // verwijderd) — geen extra JS nodig.

  // Boot-module: default 'klanten', maar bij `?v2preview=<id>` start op die
  // module zodat de preview-URL direct de juiste view rendert (voorheen
  // landde `?v2preview=taken` op klanten-content omdat goMod('klanten')
  // hier hardcoded was — bug ontdekt bij taken-dataronde).
  // Bij comma-list (`?v2preview=a,b,c`) pakt hij het eerste id dat een
  // shell-tab heeft; anders eerste van de lijst.
  let bootMod = 'klanten';
  try {
    const raw = new URLSearchParams(window.location.search).get('v2preview');
    if (raw) {
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const modsList = window.DFO.MODS || [];
      const viable = ids.find((id) => modsList.find((m) => m.id === id));
      if (viable) bootMod = viable;
    }
  } catch (_) { /* URLSearchParams-fail: houd 'klanten' als default */ }
  window.DFO.goMod(bootMod);
  // Ronde-31 FIX 3: `?v2tab=<naam>` schakelt direct naar die tab. Gebruikt door
  // admin.html legacy-redirect (#approval-queue → v2preview=wanbetalers&v2tab=Acties)
  // zodat oude bookmarks in de queue zelf landen, niet in de Vandaag-default.
  try {
    const wantTab = new URLSearchParams(window.location.search).get('v2tab');
    if (wantTab) {
      const modsList = window.DFO.MODS || [];
      const mm = modsList.find((m) => m.id === bootMod);
      const tabs = (mm && Array.isArray(mm.tabs)) ? mm.tabs : [];
      const hit = tabs.find((t) => t === wantTab) || tabs.find((t) => String(t).toLowerCase() === String(wantTab).toLowerCase());
      if (hit) window.DFO.goTab(hit);
    }
  } catch (_) { /* fail-soft */ }

  // Eerste render van topbar-actions (na goMod triggert wrap 'em ook, maar
  // eerste render moet expliciet want boot-goMod is idempotent na wrap).
  renderTopbarActions();

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
