// modules/klanten-v2/views/detail.js
//
// Dossier-orchestrator voor klanten-v2 detail-view (Fase 1 PR-B1).
// Rendert: terug-link, header (avatar-lg + naam + status-pills + kebab-menu
// met bewerken/archiveren), 7-tabs strip, actieve tab-body via
// TAB_REGISTRY. Popstate + tab-klik doen client-side re-render zonder full
// refetch (klant-object gecached zolang id gelijk blijft).
//
// Tab-inhoud zit in views/tabs/*.js — deze PR levert placeholders per tab.
// Volgende PR-B[2..6] vullen ze in met de INVENTARIS-items uit PR #1112.

import { renderProfielTab }      from './tabs/profiel.js';
import { openEditCustomerModal }    from './modals/edit-customer.js';
import { openArchiveCustomerModal } from './modals/archive-customer.js';
import { renderCommunicatieTab } from './tabs/communicatie.js';
import { renderOffertesTab }     from './tabs/offertes.js?v=1';
import { renderAbonnementenTab } from './tabs/abonnementen.js?v=9';
import { renderFacturenTab }     from './tabs/facturen.js';
import { renderCreditnotasTab }  from './tabs/creditnotas.js?v=2';
import { renderWanbetalersTab }  from './tabs/wanbetalers.js';
import { renderAuditTab }        from './tabs/audit.js';

const K = () => window.KV;

// Volgorde + labels + icon-SVG (tabler) 1-op-1 uit modules/klanten.html
// r512-534 zodat de tab-strip visueel matcht met wat mensen kennen.
const TABS = [
  { key: 'profiel',      label: 'Profiel',      renderer: renderProfielTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>' },
  { key: 'communicatie', label: 'Communicatie', renderer: renderCommunicatieTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
  { key: 'offertes',     label: 'Offertes',     renderer: renderOffertesTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' },
  { key: 'abonnementen', label: 'Abonnementen', renderer: renderAbonnementenTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>' },
  { key: 'facturen',     label: 'Facturen',     renderer: renderFacturenTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v18l-3-2-2 2-2-2-2 2-2-2-2 2-3-2z"/><path d="M8 9h8M8 13h5"/></svg>' },
  { key: 'creditnotas',  label: "Creditnota's", renderer: renderCreditnotasTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 12h8"/></svg>' },
  { key: 'wanbetalers',  label: 'Wanbetalers',  renderer: renderWanbetalersTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/></svg>' },
  { key: 'audit',        label: 'Audit',        renderer: renderAuditTab,
    ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="14"/></svg>' },
];

// 2026-08-26 (v=1cc, Route A — allowlist) — definitieve tab-set voor
// niet-privileged rollen (mentor). Privileged rollen (super_admin/admin/
// manager/sales) blijven alles zien = geen regressie.
//
// Mentor-tabset (4): Profiel · Communicatie · Offertes · Facturen.
// Verborgen voor mentor: Abonnementen, Creditnota's, Wanbetalers (incasso-
// zone), Audit. Facturen = inkijk-only (incasso-actieknoppen ook verborgen
// via _isPrivilegedRole()-check in de tab-render, hierbeneden).
//
// Route-keuze: allowlist ipv per-tab RBAC-keys omdat mentor nu de enige
// niet-privileged rol met module-toegang is. Nieuwe RBAC-keys + migratie
// zouden overkill zijn. Als er in de toekomst rollen bijkomen met een
// andere gewenste subset, dan alsnog naar per-tab-keys (Route B).
var NON_PRIV_VISIBLE_TABS = new Set(['profiel', 'communicatie', 'offertes', 'facturen']);
function _isPrivilegedRole() {
  try {
    var r = String(window.DFO?.S?.role || '').toLowerCase();
    return r === 'super_admin' || r === 'admin' || r === 'manager' || r === 'sales';
  } catch (_) { return false; }
}
function mayViewTab(tabKey) {
  if (_isPrivilegedRole()) return true;
  return NON_PRIV_VISIBLE_TABS.has(String(tabKey || '').toLowerCase());
}
function visibleTabs() { return TABS.filter(t => mayViewTab(t.key)); }

const VALID_TAB_KEYS = TABS.map(t => t.key);
const DEFAULT_TAB    = 'profiel';

function normalizeTab(tab) {
  var key = String(tab || '').toLowerCase();
  // Als de gevraagde tab niet zichtbaar is voor deze user → val terug op profiel.
  if (!VALID_TAB_KEYS.includes(key)) return DEFAULT_TAB;
  if (!mayViewTab(key)) return DEFAULT_TAB;
  return key;
}

// Dossier-cache per open-sessie. Bevat de FULL response van /api/customer
// (customer + linked_company + linked_persons + link_available) zodat
// tab-renderers alles hebben zonder aparte fetches. Wordt gereset zodra
// een andere id opent.
let cache = { id: null, dossier: null, loading: false, error: null };

async function fetchDossier(id) {
  const j = await K().authedJson(`/api/customer?id=${encodeURIComponent(id)}`);
  return {
    customer:       j?.customer || null,
    linked_company: j?.linked_company || null,
    linked_persons: Array.isArray(j?.linked_persons) ? j.linked_persons : [],
    link_available: !!j?.link_available,
  };
}

function customerDisplayName(c) {
  if (!c) return 'Klant';
  const name = (c.is_company && c.company_name)
    ? c.company_name
    : [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return name || c.email || 'Klant';
}

function statusPill(status) {
  const map = {
    active:     { cls: 'ds-pill-ok',      label: 'Actief' },
    archived:   { cls: 'ds-pill-neutral', label: 'Gearchiveerd' },
    anonymized: { cls: 'ds-pill-violet',  label: 'Geanonimiseerd' },
  };
  const m = map[status] || { cls: 'ds-pill-neutral', label: status || '—' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}

function renderShell({ customer, tab }) {
  const name = customerDisplayName(customer);
  const initials = K().initials(name);
  const meta = [
    customer?.email && `<span>${K().esc(customer.email)}</span>`,
    customer?.phone && `<span>${K().esc(customer.phone)}</span>`,
    customer?.address_city && `<span>${K().esc(customer.address_city)}</span>`,
  ].filter(Boolean).join(' · ');
  const isCompany = !!customer?.is_company;
  const risk = !!customer?.risk_tag_auto;

  return `
    <div class="ds-pad kv-detail" data-customer-id="${K().esc(customer?.id || '')}">
      <div class="kv-detail-back">
        <a href="?" data-kv-back class="kv-detail-back-link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          Terug naar klant-overzicht
        </a>
      </div>

      <header class="kv-detail-head">
        <div class="ds-avatar-lg" style="background:linear-gradient(140deg,#0EA271,#076B4A)">${K().esc(initials)}</div>
        <div class="kv-detail-head-info">
          <h1 class="kv-detail-name">${K().esc(name)}</h1>
          <div class="kv-detail-head-pills">
            ${statusPill(customer?.status)}
            <span class="ds-pill ${isCompany ? 'ds-pill-accent' : 'ds-pill-neutral'} nodot">${isCompany ? 'Bedrijf' : 'Particulier'}</span>
            ${risk ? '<span class="ds-pill ds-pill-danger">Risico</span>' : ''}
          </div>
          ${meta ? `<div class="kv-detail-head-meta">${meta}</div>` : ''}
        </div>
        <div class="kv-detail-head-actions">
          ${_isPrivilegedRole() ? `
          <button type="button" class="ds-btn ds-btn-ghost" data-kv-action="edit" title="Bewerken (PR-C)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            Bewerken
          </button>
          ${customer?.archived_at
            ? `<button type="button" class="ds-btn ds-btn-ghost" data-kv-action="unarchive" title="Heractiveren">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>
                Heractiveren
              </button>`
            : `<button type="button" class="ds-btn ds-btn-ghost" data-kv-action="archive" title="Archiveren">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                Archiveren
              </button>`
          }
          ` : ''/* v=1cc: header-acties Bewerken/Archiveren verborgen voor niet-privileged (bv. mentor). Server-side gates blijven (verifyAdmin) — cosmetische fix om 403-knoppen weg te halen. */}
        </div>
      </header>

      <nav class="kv-detail-tabs" role="tablist" aria-label="Klant-secties">
        ${visibleTabs().map(t => `
          <button type="button" class="kv-detail-tab ${t.key === tab ? 'active' : ''}"
                  role="tab" aria-selected="${t.key === tab ? 'true' : 'false'}"
                  data-kv-tab="${t.key}">
            <span class="kv-detail-tab-ico" aria-hidden="true">${t.ico}</span>
            <span>${t.label}</span>
          </button>
        `).join('')}
      </nav>

      <section class="kv-detail-tabbody" id="kv-tabbody" role="tabpanel" aria-live="polite"></section>
    </div>`;
}

function wireShell(rootEl, { customer, tab }) {
  // Terug-link → clear ?id → DFO re-render (klantenView switcht naar list)
  rootEl.querySelector('[data-kv-back]')?.addEventListener('click', (e) => {
    e.preventDefault();
    K().navigate({ id: null, tab: null });
  });

  // Tab-buttons → alleen ?tab= updaten (id blijft); cache hit → geen refetch
  rootEl.querySelectorAll('[data-kv-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-kv-tab');
      if (next === tab) return;
      K().navigate({ tab: next });
    });
  });

  // Header-acties: Edit (PR-C1), Archive/Unarchive (PR-C2).
  // onSuccess in beide gevallen: cache-reset + re-render zodat het
  // nieuwe klant-object (met bijgewerkte fields of archived_at) doorloopt.
  // Bij archive expliciet: klant staat niet meer in de actieve lijst,
  // maar het detail-scherm blijft open — user ziet de "Heractiveren"-knop
  // en de status-pill switcht naar "Gearchiveerd". Terug naar de lijst
  // is één klik.
  rootEl.querySelectorAll('[data-kv-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-kv-action');
      const refreshDetail = () => {
        resetDetailCache();
        const url = new URL(window.location.href);
        const id  = url.searchParams.get('id');
        const tab = url.searchParams.get('tab');
        if (id) renderDetailView(rootEl, { id, tab, profile: null });
      };
      if (action === 'edit') {
        openEditCustomerModal({ customer, onSuccess: refreshDetail });
      } else if (action === 'archive' || action === 'unarchive') {
        openArchiveCustomerModal({ customer, mode: action, onSuccess: refreshDetail });
      } else {
        K().toast('Deze actie komt in een volgende PR-C.');
      }
    });
  });
}

async function mountTabBody({ customer, dossier, tab, profile }) {
  const host = document.getElementById('kv-tabbody');
  if (!host) return;
  const entry = TABS.find(t => t.key === tab) || TABS[0];
  host.innerHTML = `<div class="ds-empty" style="padding:24px;"><div class="ds-empty-s">Tab laden…</div></div>`;
  try {
    await entry.renderer(host, { customer, dossier, profile });
  } catch (e) {
    console.error('[klanten-v2 detail] tab render error:', e);
    host.innerHTML = `
      <div class="ds-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <div><strong>Kan tab niet laden.</strong><div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(e?.message || 'Onbekende fout')}</div></div>
      </div>`;
  }
}

/**
 * Publieke entry (aangeroepen door klantenView() in klanten-v2.js).
 * Werkt async omdat de klant-fetch mogelijk vereist is. Popstate/tab-wissel
 * hergebruikt de cache zolang id gelijk blijft.
 */
export async function renderDetailView(rootEl, { id, tab, profile }) {
  const normTab = normalizeTab(tab);

  // Fetch (or use cache) — id-wissel = clean state
  if (cache.id !== id) {
    cache = { id, dossier: null, loading: true, error: null };
    rootEl.innerHTML = `
      <div class="ds-pad kv-detail">
        <div class="ds-empty" style="padding:64px 20px;">
          <div class="ds-empty-t">Klant laden…</div>
        </div>
      </div>`;
    try {
      cache.dossier = await fetchDossier(id);
      cache.loading = false;
    } catch (e) {
      cache.error = e?.message || 'Onbekende fout';
      cache.loading = false;
      rootEl.innerHTML = `
        <div class="ds-pad kv-detail">
          <div class="ds-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
            <div>
              <strong>Kan klant niet laden.</strong>
              <div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(cache.error)}</div>
              <div style="margin-top:8px;"><a href="?" data-kv-back style="color:var(--m); text-decoration:underline;">Terug naar lijst</a></div>
            </div>
          </div>
        </div>`;
      rootEl.querySelector('[data-kv-back]')?.addEventListener('click', (e) => {
        e.preventDefault();
        K().navigate({ id: null, tab: null });
      });
      return;
    }
  }

  const customer = cache.dossier?.customer || null;

  // Render shell (header + tab-strip) — telkens vers zodat active-state klopt
  rootEl.innerHTML = renderShell({ customer, tab: normTab });
  wireShell(rootEl, { customer, tab: normTab });

  // Mount tab-body async (fire-and-forget — geen await zodat DFO's
  // scroll-restore direct kan lopen). Elke tab render zichzelf leeg-first
  // + async-fetches. Tabs krijgen zowel `customer` (backward-compat) als
  // `dossier` (voor tabs die linked_company / linked_persons nodig hebben).
  mountTabBody({ customer, dossier: cache.dossier, tab: normTab, profile });
}

// Reset-hook voor list-view: als klantenView() naar de lijst terugvalt,
// wil je NIET dat een oude cache aan een verse id-open klopt. Wordt
// aangeroepen door klanten-v2.js op switch naar list.
export function resetDetailCache() {
  cache = { id: null, dossier: null, loading: false, error: null };
}
