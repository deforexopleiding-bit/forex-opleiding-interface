// modules/klanten-v2/views/tabs/abonnementen.js
//
// Abonnementen-tab van klanten-v2. Sinds finance-mutaties ronde: OOK write-
// acties per abo (Aanpassen / Uitstellen / Deactiveren) + bulk-postpone
// header-knop. Mutaties gaan via views/modals/subscription-actions.js;
// endpoints POST /api/sales-subscription-{postpone|update|delete} +
// POST /api/sales-customer-postpone-all. Server-side RBAC (403 opgevangen
// als toast in modal). Na success: actLoad(rootEl) opnieuw voor verse lijst.
//
// Data-bron: /api/sales-customer-subscriptions?customer_id=X (bestaand).
// Response:
//   subscriptions: [{ id, deal_id, description, amount, vat_percentage,
//     term_count, start_date, end_date, teamleader_subscription_id,
//     status, line_items, postponed_months, original_start_date,
//     has_any_invoice }]
//   pending_deal_id: uuid | null   (accepted offerte zonder abo → wizard-CTA)
//   bypass_events:   array          (reservation-fee bypass-audit — banner)

import {
  openSubscriptionPostponeModal,
  openSubscriptionPostponeAllModal,
  openSubscriptionUpdateModal,
  openSubscriptionDeleteModal,
} from '../modals/subscription-actions.js';

const K = () => window.KV;

// TL-subscription statuses → ds-pill mapping. Zelfde termen als
// modules/sales.html om verwarring te voorkomen.
const STATUS = {
  active:      { label: 'Actief',      cls: 'ds-pill-ok'      },
  running:     { label: 'Actief',      cls: 'ds-pill-ok'      },
  paused:      { label: 'Gepauzeerd',  cls: 'ds-pill-warn'    },
  overdue:     { label: 'Achterstand', cls: 'ds-pill-danger'  },
  cancelled:   { label: 'Beëindigd',   cls: 'ds-pill-neutral' },
  deactivated: { label: 'Beëindigd',   cls: 'ds-pill-neutral' },
  stopped:     { label: 'Gestopt',     cls: 'ds-pill-neutral' },
};
function statusPill(st) {
  const key = String(st || '').toLowerCase();
  const m = STATUS[key] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}

// ── Module-state ────────────────────────────────────────────────────────────
let state = null;

function initState(customer) {
  state = {
    customerId: customer?.id || null,
    subs: [],
    pendingDealId: null,
    bypassEvents: [],
    loading: true,
    error: null,
    expandedLineItems: new Set(),   // Set<sub_id> — welke rows hebben line-items uitgeklapt
  };
}

// ── Formatters ──────────────────────────────────────────────────────────────

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return EUR.format(Number(n));
}
function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return ''; }
}
function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

// ── API ─────────────────────────────────────────────────────────────────────

async function apiListSubscriptions() {
  const url = `/api/sales-customer-subscriptions?customer_id=${encodeURIComponent(state.customerId)}`;
  return K().authedJson(url);
}

async function actLoad(rootEl) {
  state.loading = true; state.error = null;
  render(rootEl);
  try {
    const j = await apiListSubscriptions();
    state.subs = Array.isArray(j?.subscriptions) ? j.subscriptions : [];
    state.pendingDealId = j?.pending_deal_id || null;
    state.bypassEvents  = Array.isArray(j?.bypass_events) ? j.bypass_events : [];
  } catch (e) {
    state.error = e?.message || 'Kan abonnementen niet laden';
    state.subs = []; state.pendingDealId = null; state.bypassEvents = [];
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

// ── KPI-strip ──────────────────────────────────────────────────────────────

function calcKpis(subs) {
  let active = 0, overdue = 0, paused = 0, mrr = 0;
  for (const s of subs) {
    const key = String(s.status || '').toLowerCase();
    if (key === 'active' || key === 'running') active++;
    else if (key === 'overdue') overdue++;
    else if (key === 'paused')  paused++;
    // Termijnbedrag (actief) — INCL. BTW, som over actieve subs.
    // Gebruikt dezelfde inclPerTerm-helper als de kaart-header en de
    // expand-tfoot zodat KPI == kaart == expand-totaal. Was eerder
    // Number(s.amount) (EXCL) — dat gaf een lager KPI-bedrag dan de
    // kaart erboven en verwarrend rondom BTW.
    if (key === 'active' || key === 'running') {
      mrr += inclPerTerm(s);
    }
  }
  return { active, overdue, paused, mrr };
}

function renderKpiStrip() {
  if (!state.subs.length) return '';
  const k = calcKpis(state.subs);
  return `
    <div class="ds-kpi-grid kv-abo-kpis">
      <div class="ds-kpi" style="--kc:var(--emerald);--kc-soft:var(--emerald-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Actief</div></div>
        <div class="ds-kpi-val">${k.active}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--rose);--kc-soft:var(--rose-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Achterstand</div></div>
        <div class="ds-kpi-val">${k.overdue}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--amber);--kc-soft:var(--amber-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Gepauzeerd</div></div>
        <div class="ds-kpi-val">${k.paused}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--slate);--kc-soft:var(--slate-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Termijnbedrag (actief)</div></div>
        <div class="ds-kpi-val">${K().esc(fmtEur(k.mrr))}</div>
      </div>
    </div>`;
}

// ── Sub-cards ──────────────────────────────────────────────────────────────

// Correcte veld-mapping voor line_items op subscriptions (bron:
// api/sales-subscriptions-list.js:16-22 inclPerTerm + api/sales-customer-
// subscriptions.js:99):
//   - li.amount           = bedrag EXCL. BTW (1x per termijn — geen quantity)
//   - li.vat_percentage   = BTW-tarief
//   - li.description      = label
// Er is GEEN li.quantity of li.unit_price — die aanname gaf €0 op alle regels.
function renderLineItems(sub) {
  const items = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (!items.length) return '<div class="kv-prof-empty">Geen line-items op deze subscriptie.</div>';
  let totExcl = 0;
  const btwByRate = {};
  const rowsHtml = items.map((li) => {
    const excl = Number(li.amount) || 0;
    const vat  = Number(li.vat_percentage != null ? li.vat_percentage : 0);
    const btwAmt = excl * vat / 100;
    const incl = excl + btwAmt;
    totExcl += excl;
    if (vat > 0) btwByRate[vat] = (btwByRate[vat] || 0) + btwAmt;
    const desc = li.description || li.name || '—';
    return `
      <tr>
        <td>${K().esc(desc)}</td>
        <td class="r mono">${K().esc(fmtEur(excl))}</td>
        <td class="r mono">${vat}%</td>
        <td class="r mono"><b>${K().esc(fmtEur(incl))}</b></td>
      </tr>`;
  }).join('');
  const totBtw = Object.values(btwByRate).reduce((a, b) => a + b, 0);
  const totIncl = totExcl + totBtw;
  return `
    <table class="kv-abo-lines">
      <thead><tr>
        <th>Omschrijving</th>
        <th class="r">Excl. BTW</th>
        <th class="r">BTW</th>
        <th class="r">Incl. BTW</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr><td colspan="3" class="r" style="color:var(--text-2);font-size:12px">Subtotaal excl. BTW</td><td class="r mono">${K().esc(fmtEur(totExcl))}</td></tr>
        ${Object.keys(btwByRate).sort((a, b) => Number(a) - Number(b)).map(r => `
          <tr><td colspan="3" class="r" style="color:var(--text-2);font-size:12px">BTW ${r}%</td><td class="r mono">${K().esc(fmtEur(btwByRate[r]))}</td></tr>`).join('')}
        <tr><td colspan="3" class="r" style="font-weight:700">Totaal incl. BTW / termijn</td><td class="r mono" style="font-weight:700">${K().esc(fmtEur(totIncl))}</td></tr>
      </tfoot>
    </table>`;
}

// Bedrag incl. BTW per termijn — identiek aan expand-tfoot-berekening
// (renderLineItems r194) én aan v1 klanten.html:2479 helper.
// Volgorde: prefer line_items sum (per-regel BTW). Fallback: sub.amount +
// sub.vat_percentage. Extra veiligheid: als vat_percentage null/0 is EN er
// geen line_items zijn, gebruik 21% (default NL) — voorkomt stille
// excl-weergave onder incl-label bij subs zonder complete BTW-metadata.
function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce((s, li) => {
      const excl = Number(li.amount) || 0;
      const vat  = li.vat_percentage != null ? Number(li.vat_percentage) : 21;
      return s + excl * (1 + vat / 100);
    }, 0);
  }
  const excl = Number(sub.amount) || 0;
  const vat  = sub.vat_percentage != null && Number(sub.vat_percentage) > 0
    ? Number(sub.vat_percentage)
    : 21; // NL default — voorkomt incl==excl bij ontbrekende BTW-info
  return excl * (1 + vat / 100);
}

function renderSubCard(sub) {
  const st          = sub.status;
  // Beëindigd abonnement (cancelled/deactivated/completed) → geen "Deactiveren"
  // meer tonen; anders blijft de knop staan ná een geslaagde cancel.
  const ended       = ['cancelled', 'deactivated', 'completed'].includes(String(st || '').toLowerCase());
  const isPostponed = Number(sub.postponed_months) > 0;
  const hasInv      = !!sub.has_any_invoice;
  const desc        = sub.description || 'Abonnement';
  const tlId        = sub.teamleader_subscription_id;
  const isExpanded  = state.expandedLineItems.has(sub.id);
  const lineItemsCount = Array.isArray(sub.line_items) ? sub.line_items.length : 0;

  // TeamLeader-knop verwijderd (2026-08-11, per Jeffrey's verzoek). tlId
  // wordt nog wel gebruikt bij pill/status-detectie; alleen de per-abo
  // TL-deep-link-knop is weg.
  const tlLink = '';
  // Bronofferte-link: opent v2 offerte-detail IN-SHELL via __odvOpen(dealId).
  // Fallback naar standalone v2-detail-pagina als __odvOpen niet bestaat
  // (dat zou alleen op oude klanten.html gebeuren; klanten-v2 laadt 'em
  // vanaf de shell).
  const dealLink = sub.deal_id
    ? `<a class="ds-btn ds-btn-ghost ds-btn-sm" href="javascript:void(0)" onclick="if(window.__odvOpen){window.__odvOpen('${K().esc(sub.deal_id)}')}else{window.location.href='/modules/offerte-detail-v2.html?id=${K().esc(encodeURIComponent(sub.deal_id))}'}" title="Naar bronofferte (in-shell)">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
         Bronofferte
       </a>`
    : '';

  return `
    <article class="kv-prof-card kv-abo-card ${isPostponed ? 'is-postponed' : ''}">
      <header class="kv-abo-card-head">
        <div class="kv-abo-card-title">
          <div class="kv-abo-card-name">${K().esc(desc)}</div>
          <div class="kv-abo-card-pills">
            ${statusPill(st)}
            ${isPostponed ? `<span class="ds-pill ds-pill-warn nodot">Uitgesteld · ${K().esc(String(sub.postponed_months))} mnd</span>` : ''}
            ${hasInv ? '<span class="ds-pill ds-pill-accent nodot">Heeft facturen</span>' : ''}
          </div>
        </div>
        <div class="kv-abo-card-amount">
          <div class="mono">${K().esc(fmtEur(inclPerTerm(sub)))}</div>
          <div class="kv-abo-card-amount-sub">per termijn incl. BTW</div>
        </div>
      </header>

      <div class="kv-abo-card-grid">
        <div class="kv-prof-kv kv-prof-kv-sm">
          <span class="kv-prof-kv-l">Termijnen</span>
          <span class="kv-prof-kv-v">${K().esc(String(sub.term_count != null ? sub.term_count : '—'))}</span>
        </div>
        <div class="kv-prof-kv kv-prof-kv-sm">
          <span class="kv-prof-kv-l">Startdatum</span>
          <span class="kv-prof-kv-v">${K().esc(fmtDate(sub.start_date) || '—')}</span>
        </div>
        <div class="kv-prof-kv kv-prof-kv-sm">
          <span class="kv-prof-kv-l">Einddatum</span>
          <span class="kv-prof-kv-v">${K().esc(fmtDate(sub.end_date) || '—')}</span>
        </div>
        ${isPostponed
          ? `<div class="kv-prof-kv kv-prof-kv-sm">
               <span class="kv-prof-kv-l">Origineel start</span>
               <span class="kv-prof-kv-v">${K().esc(fmtDate(sub.original_start_date) || '—')}</span>
             </div>`
          : ''}
      </div>

      <div class="kv-abo-card-foot">
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-abo-toggle-lines="${K().esc(sub.id)}" ${lineItemsCount === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${isExpanded ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'}"/></svg>
          Line-items ${lineItemsCount ? `(${lineItemsCount})` : '(0)'}
        </button>
        ${dealLink}
        ${tlLink}
        <div style="flex:1"></div>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-abo-update="${K().esc(sub.id)}"
          ${hasInv
            ? 'disabled title="Al gefactureerd — aanpassen niet toegestaan. Gebruik crediteren + nieuw abo." style="opacity:.5;cursor:not-allowed"'
            : 'title="Abonnement aanpassen (omschrijving/bedrag/termijnen/data)"'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          ${hasInv ? 'Aanpassen (niet mogelijk)' : 'Aanpassen'}
        </button>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-abo-postpone="${K().esc(sub.id)}" title="Uitstellen of verlengen (1-12 mnd)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Uitstellen
        </button>
        ${ended ? '' : `<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm kv-abo-btn-danger" data-kv-abo-delete="${K().esc(sub.id)}" title="Deactiveren">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
          Deactiveren
        </button>`}
      </div>

      ${isExpanded ? `<div class="kv-abo-card-lines">${renderLineItems(sub)}</div>` : ''}
    </article>`;
}

// ── Overige blokken ─────────────────────────────────────────────────────────

function renderBypassBanner() {
  if (!state.bypassEvents.length) return '';
  return `
    <div class="ds-banner ds-banner-warn kv-abo-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/></svg>
      <div>
        <strong>${K().esc(String(state.bypassEvents.length))} × reservering€-bypass</strong> — informatief (audit-events).
        <div style="font-size:11.5px; opacity:.8; margin-top:2px;">
          ${state.bypassEvents.slice(0, 3).map(b => `${K().esc(b.by_name || 'onbekend')} op ${K().esc(fmtDateTime(b.at))}`).join(' · ')}
          ${state.bypassEvents.length > 3 ? ` · +${state.bypassEvents.length - 3} meer` : ''}
        </div>
      </div>
    </div>`;
}

function renderEmpty() {
  return `
    <div class="ds-empty" style="padding:56px 20px;">
      <div class="ds-empty-ico" style="background:var(--teal-soft); color:var(--teal);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
      </div>
      <div class="ds-empty-t">Nog geen abonnementen voor deze klant</div>
      <div class="ds-empty-s">
        Zodra een <a href="?tab=offertes" data-kv-goto-tab="offertes" style="color:var(--m);text-decoration:underline;">bevestigde offerte</a>
        wordt omgezet in de <a href="/modules/subscription-wizard.html?customer_id=${K().esc(encodeURIComponent(state.customerId))}" target="_blank" rel="noopener" style="color:var(--m);text-decoration:underline;">Subscription-wizard</a> (nieuw tabblad),
        verschijnt hij hier.
      </div>
    </div>`;
}

function renderError() {
  return `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <strong>Kan abonnementen niet laden.</strong>
        <div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(state.error)}</div>
        <div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-abo-retry>Opnieuw proberen</button></div>
      </div>
    </div>`;
}

// ── Render + wire ───────────────────────────────────────────────────────────

function render(rootEl) {
  let body;
  if (state.loading) {
    body = `<div class="ds-empty" style="padding:32px 20px;"><div class="ds-empty-s">Abonnementen laden…</div></div>`;
  } else if (state.error) {
    body = renderError();
  } else if (!state.subs.length) {
    body = `${renderBypassBanner()}${renderEmpty()}`;
  } else {
    body = `
      ${renderKpiStrip()}
      ${renderBypassBanner()}
      <div class="kv-abo-list">
        ${state.subs.map(renderSubCard).join('')}
      </div>`;
  }

  // Bulk-postpone header-knop: alleen als er >=2 actieve abo's zijn.
  const activeCount = state.subs.filter((s) => {
    const k = String(s.status || '').toLowerCase();
    return k === 'active' || k === 'running';
  }).length;
  const bulkBtn = activeCount >= 2
    ? `<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-abo-postpone-all title="Alle ${activeCount} actieve abo's tegelijk uitstellen">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
         Alle uitstellen (${activeCount})
       </button>`
    : '';

  rootEl.innerHTML = `
    <div class="kv-abo">
      <div class="kv-abo-head">
        <div class="kv-abo-head-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
          Abonnementen
          <span class="kv-prof-count">${state.loading ? '…' : state.subs.length}</span>
        </div>
        <div class="kv-abo-head-actions" style="margin-left:auto; display:flex; gap:8px;">${bulkBtn}</div>
      </div>
      ${body}
    </div>`;
  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelector('[data-kv-abo-retry]')?.addEventListener('click', () => actLoad(rootEl));
  rootEl.querySelectorAll('[data-kv-abo-toggle-lines]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-abo-toggle-lines');
      if (state.expandedLineItems.has(id)) state.expandedLineItems.delete(id);
      else state.expandedLineItems.add(id);
      render(rootEl);
    });
  });
  rootEl.querySelectorAll('[data-kv-goto-tab]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = a.getAttribute('data-kv-goto-tab');
      if (tab) K().navigate({ tab });
    });
  });

  // Mutatie-buttons per card (finance-mutaties ronde).
  const findSub = (id) => state.subs.find((s) => s.id === id);
  const refresh = () => actLoad(rootEl);
  rootEl.querySelectorAll('[data-kv-abo-update]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const sub = findSub(btn.getAttribute('data-kv-abo-update'));
      if (sub) openSubscriptionUpdateModal({ sub, onSuccess: refresh });
    });
  });
  rootEl.querySelectorAll('[data-kv-abo-postpone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = findSub(btn.getAttribute('data-kv-abo-postpone'));
      if (sub) openSubscriptionPostponeModal({ sub, onSuccess: refresh });
    });
  });
  rootEl.querySelectorAll('[data-kv-abo-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = findSub(btn.getAttribute('data-kv-abo-delete'));
      if (sub) openSubscriptionDeleteModal({ sub, onSuccess: refresh });
    });
  });
  rootEl.querySelector('[data-kv-abo-postpone-all]')?.addEventListener('click', () => {
    const activeCount = state.subs.filter((s) => {
      const k = String(s.status || '').toLowerCase();
      return k === 'active' || k === 'running';
    }).length;
    openSubscriptionPostponeAllModal({ customerId: state.customerId, count: activeCount, onSuccess: refresh });
  });
}

// ── Public entry ────────────────────────────────────────────────────────────

export async function renderAbonnementenTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `
      <div class="ds-empty" style="padding:40px 20px;">
        <div class="ds-empty-t">Geen klant-data</div>
        <div class="ds-empty-s">Kan abonnementen-tab niet renderen zonder klant.</div>
      </div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
