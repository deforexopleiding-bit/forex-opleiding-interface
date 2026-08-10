// modules/klanten-v2/views/tabs/abonnementen.js
//
// Abonnementen-tab van klanten-v2 (PR-B5). 25 items uit de INVENTARIS,
// STRIKT READ-ONLY. Pauze/stop-flow blijft in /modules/sales.html;
// hier alleen visuele preview + externe deep-links (nieuw tabblad,
// dossier blijft open). Geen create/edit/mutation vanuit deze tab.
//
// Data-bron: /api/sales-customer-subscriptions?customer_id=X (bestaand).
// Response:
//   subscriptions: [{ id, deal_id, description, amount, vat_percentage,
//     term_count, start_date, end_date, teamleader_subscription_id,
//     status, line_items, postponed_months, original_start_date,
//     has_any_invoice }]
//   pending_deal_id: uuid | null   (accepted offerte zonder abo → wizard-CTA)
//   bypass_events:   array          (reservation-fee bypass-audit — banner)

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
    // MRR heel simpel: alleen actieve subs, elke term als één maand
    // (voldoende voor deze read-only preview; ware MRR-berekening zit
    // in sales-mrr-report.js — daar geen refactor van, alleen tonen).
    if (key === 'active' || key === 'running') {
      mrr += Number(s.amount) || 0;
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

function renderLineItems(sub) {
  const items = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (!items.length) return '<div class="kv-prof-empty">Geen line-items op deze subscriptie.</div>';
  return `
    <table class="kv-abo-lines">
      <thead><tr>
        <th>Omschrijving</th>
        <th class="r">Aantal</th>
        <th class="r">Prijs</th>
        <th class="r">BTW</th>
        <th class="r">Subtotaal</th>
      </tr></thead>
      <tbody>
        ${items.map((li) => {
          const qty  = Number(li.quantity || 1);
          const unit = Number(li.unit_price || 0);
          const vat  = Number(li.vat_percentage != null ? li.vat_percentage : 21);
          const sub  = qty * unit;
          const desc = li.description || li.name || '—';
          return `
            <tr>
              <td>${K().esc(desc)}</td>
              <td class="r mono">${qty}</td>
              <td class="r mono">${K().esc(fmtEur(unit))}</td>
              <td class="r mono">${vat}%</td>
              <td class="r mono">${K().esc(fmtEur(sub))}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderSubCard(sub) {
  const st          = sub.status;
  const isPostponed = Number(sub.postponed_months) > 0;
  const hasInv      = !!sub.has_any_invoice;
  const desc        = sub.description || 'Abonnement';
  const tlId        = sub.teamleader_subscription_id;
  const isExpanded  = state.expandedLineItems.has(sub.id);
  const lineItemsCount = Array.isArray(sub.line_items) ? sub.line_items.length : 0;

  const tlLink = tlId
    ? `<a class="ds-btn ds-btn-ghost ds-btn-sm" href="https://focus.teamleader.eu/subscriptions/${K().esc(encodeURIComponent(tlId))}" target="_blank" rel="noopener" title="Open subscriptie in TeamLeader">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
         TeamLeader
       </a>`
    : '';
  const dealLink = sub.deal_id
    ? `<a class="ds-btn ds-btn-ghost ds-btn-sm" href="/modules/offerte-detail-v2.html?id=${K().esc(encodeURIComponent(sub.deal_id))}" target="_blank" rel="noopener" title="Naar bronoffertte">
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
          <div class="mono">${K().esc(fmtEur(sub.amount))}</div>
          <div class="kv-abo-card-amount-sub">per termijn · ${K().esc(String(sub.vat_percentage != null ? sub.vat_percentage : 21))}% BTW</div>
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
      </div>

      ${isExpanded ? `<div class="kv-abo-card-lines">${renderLineItems(sub)}</div>` : ''}
    </article>`;
}

// ── Overige blokken ─────────────────────────────────────────────────────────

function renderPendingCta() {
  if (!state.pendingDealId) return '';
  return `
    <div class="ds-banner ds-banner-warn kv-abo-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <span>Er is een <strong>bevestigde offerte</strong> die nog niet is omgezet naar een abonnement.</span>
      <a class="ds-btn ds-btn-primary ds-btn-sm" href="/modules/subscription-wizard.html?deal_id=${K().esc(encodeURIComponent(state.pendingDealId))}" target="_blank" rel="noopener" style="margin-left:auto;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/></svg>
        Omzetten in Wizard
      </a>
    </div>`;
}

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
    body = `${renderPendingCta()}${renderBypassBanner()}${renderEmpty()}`;
  } else {
    body = `
      ${renderKpiStrip()}
      ${renderPendingCta()}
      ${renderBypassBanner()}
      <div class="kv-abo-list">
        ${state.subs.map(renderSubCard).join('')}
      </div>`;
  }

  rootEl.innerHTML = `
    <div class="kv-abo">
      <div class="kv-abo-head">
        <div class="kv-abo-head-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
          Abonnementen
          <span class="kv-prof-count">${state.loading ? '…' : state.subs.length}</span>
        </div>
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
