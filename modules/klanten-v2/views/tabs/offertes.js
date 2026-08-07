// modules/klanten-v2/views/tabs/offertes.js
//
// Offertes-tab van klanten-v2 (PR-B4). 17 items uit de INVENTARIS,
// STRIKT READ-ONLY — geen create/edit/verwijder-flow (die blijft in
// /modules/sales.html en /modules/offerte-detail.html). Rij-klik +
// actie-knoppen openen bestaande pagina's in een nieuw tab zodat de
// dossier-context in klanten-v2 behouden blijft.
//
// Data-bron: /api/sales-quotations?customer_id=<uuid> (bestaand).
// Response: { quotations: [{ deal_id, quote_reference, traject_label,
//   total_amount, total_amount_incl, tl_quotation_status, sent_at,
//   accepted_at, declined_at, sales_user, entity, tl_quotation_id,
//   has_subscription, ... }], total, page, page_size, total_pages }
//
// Geen mutation-endpoints van sales aangeraakt.

const K = () => window.KV;

// Status-mapping: label + ds-pill class + ISO-datum-veld dat 'em stuurt.
// Volledig 1-op-1 met QUOTATION_STATUS_LABEL + KO_QBADGE in klanten.html
// r1134-1135 zodat mensen dezelfde termen zien.
const STATUS = {
  draft:    { label: 'Concept',    cls: 'ds-pill-neutral' },
  sent:     { label: 'Verzonden',  cls: 'ds-pill-accent'  },
  accepted: { label: 'Bevestigd',  cls: 'ds-pill-ok'      },
  signed:   { label: 'Getekend',   cls: 'ds-pill-ok'      },
  declined: { label: 'Afgewezen',  cls: 'ds-pill-danger'  },
  expired:  { label: 'Verlopen',   cls: 'ds-pill-neutral' },
  failed:   { label: 'Mislukt',    cls: 'ds-pill-danger'  },
};
function statusPill(st) {
  const m = STATUS[st] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}

// ── Module-state (per tab-mount vers geïnit) ────────────────────────────────
let state = null;

function initState(customer) {
  state = {
    customerId: customer?.id || null,
    rows: [],
    total: 0,
    loading: true,
    error: null,
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

async function apiListQuotations() {
  // page_size 200 = ruim; een klant heeft zelden >50 offertes. Als het ooit
  // meer wordt kunnen we hier client-side pagineren zonder endpoint-wijziging.
  const url = `/api/sales-quotations?customer_id=${encodeURIComponent(state.customerId)}&page_size=200`;
  const j = await K().authedJson(url);
  return {
    rows:  Array.isArray(j?.quotations) ? j.quotations : [],
    total: Number(j?.total) || 0,
  };
}

async function actLoad(rootEl) {
  state.loading = true; state.error = null;
  render(rootEl);
  try {
    const r = await apiListQuotations();
    state.rows = r.rows;
    state.total = r.total;
  } catch (e) {
    state.error = e?.message || 'Kan offertes niet laden';
    state.rows = []; state.total = 0;
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

// ── KPI-strip (afgeleid van state.rows) ─────────────────────────────────────

function calcKpis(rows) {
  let confirmed = 0, open = 0, declined = 0, totalAmount = 0;
  for (const q of rows) {
    const st = q.tl_quotation_status || 'draft';
    if (st === 'accepted' || st === 'signed') confirmed++;
    else if (st === 'draft' || st === 'sent')  open++;
    else if (st === 'declined' || st === 'expired' || st === 'failed') declined++;
    const amt = Number(q.total_amount_incl != null ? q.total_amount_incl : q.total_amount);
    if (!Number.isNaN(amt)) totalAmount += amt;
  }
  return { count: rows.length, confirmed, open, declined, totalAmount };
}

function renderKpiStrip() {
  if (!state.rows.length) return '';
  const k = calcKpis(state.rows);
  return `
    <div class="ds-kpi-grid kv-off-kpis">
      <div class="ds-kpi" style="--kc:var(--blue);--kc-soft:var(--blue-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Offertes totaal</div></div>
        <div class="ds-kpi-val">${k.count}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--emerald);--kc-soft:var(--emerald-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Bevestigd</div></div>
        <div class="ds-kpi-val">${k.confirmed}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--amber);--kc-soft:var(--amber-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Open</div></div>
        <div class="ds-kpi-val">${k.open}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--slate);--kc-soft:var(--slate-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Waarde (incl. BTW)</div></div>
        <div class="ds-kpi-val">${K().esc(fmtEur(k.totalAmount))}</div>
      </div>
    </div>`;
}

// ── Tabel-rendering ─────────────────────────────────────────────────────────

function renderRow(q) {
  const st         = q.tl_quotation_status || 'draft';
  const isFinal    = st === 'accepted' || st === 'signed';
  const isSub      = !!q.has_subscription;
  const ref        = q.quote_reference || (q.deal_id ? '#' + String(q.deal_id).slice(0, 8) : '—');
  const traj       = q.traject_label || '—';
  const amt        = q.total_amount_incl != null ? q.total_amount_incl : q.total_amount;
  const amtTitle   = (q.total_amount_incl != null && q.total_amount != null)
    ? `Excl. BTW: ${fmtEur(q.total_amount)}`
    : '';
  const dateIso    = q.accepted_at || q.declined_at || q.sent_at || q.created_at;
  const dateLabel  = fmtDate(dateIso);
  const dateTitle  = fmtDateTime(dateIso);
  const dateHint   = (st === 'accepted' || st === 'signed') && q.accepted_at ? 'Bevestigd'
                    : st === 'declined' && q.declined_at ? 'Afgewezen'
                    : q.sent_at ? 'Verzonden'
                    : 'Aangemaakt';
  const sales      = q.sales_user || '';
  const entity     = q.entity || '';
  const tlLink     = q.tl_quotation_id
    ? `<a class="ds-icon-btn" href="https://focus.teamleader.eu/quotations/${K().esc(encodeURIComponent(q.tl_quotation_id))}" target="_blank" rel="noopener" title="Open in TeamLeader" onclick="event.stopPropagation()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
       </a>`
    : '';

  return `
    <tr data-kv-off-open="${K().esc(q.deal_id)}" title="Open offerte-detail in nieuw tabblad">
      <td>
        <div class="kv-off-ref">${K().esc(ref)}${isFinal && isSub ? ' <span class="ds-pill ds-pill-ok nodot kv-off-sub-badge" title="Abonnement omgezet">Abbo</span>' : ''}</div>
        ${entity ? `<div class="ds-cell-sub">${K().esc(entity)}</div>` : ''}
      </td>
      <td>
        <div class="ds-cell-main">${K().esc(traj)}</div>
        ${sales ? `<div class="ds-cell-sub">Verkoper: ${K().esc(sales)}</div>` : ''}
      </td>
      <td class="r kv-off-amount" title="${K().esc(amtTitle)}">
        <span class="mono">${K().esc(fmtEur(amt))}</span>
      </td>
      <td>${statusPill(st)}</td>
      <td class="ds-cell-sub" title="${K().esc(dateTitle)}">
        ${dateLabel ? `<span>${K().esc(dateLabel)}</span><div style="opacity:.7;font-size:11px;margin-top:1px">${K().esc(dateHint)}</div>` : '—'}
      </td>
      <td class="r kv-off-actions">
        <a class="ds-icon-btn" href="/modules/offerte-detail.html?id=${K().esc(encodeURIComponent(q.deal_id))}" target="_blank" rel="noopener" title="Offerte-detail" onclick="event.stopPropagation()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </a>
        ${tlLink}
      </td>
    </tr>`;
}

function renderTable() {
  return `
    <div class="ds-tbl-wrap kv-off-tbl">
      <table class="ds-tbl">
        <thead>
          <tr>
            <th style="min-width:120px">Referentie</th>
            <th>Traject</th>
            <th class="r" style="width:130px">Bedrag</th>
            <th style="width:130px">Status</th>
            <th style="width:140px">Datum</th>
            <th class="r" style="width:90px"></th>
          </tr>
        </thead>
        <tbody>
          ${state.rows.map(renderRow).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderEmpty() {
  return `
    <div class="ds-empty" style="padding:56px 20px;">
      <div class="ds-empty-ico" style="background:var(--blue-soft); color:var(--blue);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="ds-empty-t">Nog geen offertes voor deze klant</div>
      <div class="ds-empty-s">
        Maak een offerte aan in de <a href="/modules/sales-wizard.html?customer_id=${K().esc(encodeURIComponent(state.customerId))}" target="_blank" rel="noopener" style="color:var(--m); text-decoration:underline;">Sales-wizard</a>
        (opent in nieuw tabblad).
      </div>
    </div>`;
}

function renderError() {
  return `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <strong>Kan offertes niet laden.</strong>
        <div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(state.error)}</div>
        <div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-off-retry>Opnieuw proberen</button></div>
      </div>
    </div>`;
}

// ── Render + wire ───────────────────────────────────────────────────────────

function render(rootEl) {
  let body;
  if (state.loading) {
    body = `<div class="ds-empty" style="padding:32px 20px;"><div class="ds-empty-s">Offertes laden…</div></div>`;
  } else if (state.error) {
    body = renderError();
  } else if (!state.rows.length) {
    body = renderEmpty();
  } else {
    body = renderKpiStrip() + renderTable();
  }

  rootEl.innerHTML = `
    <div class="kv-off">
      <div class="kv-off-head">
        <div class="kv-off-head-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Offertes
          <span class="kv-prof-count" data-kv-off-count>${state.loading ? '…' : state.rows.length}</span>
        </div>
        <a class="ds-btn ds-btn-primary ds-btn-sm" href="/modules/sales-wizard.html?customer_id=${K().esc(encodeURIComponent(state.customerId))}" target="_blank" rel="noopener" title="Nieuwe offerte in Sales-wizard (nieuw tabblad)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Nieuwe offerte
        </a>
      </div>
      ${body}
    </div>`;

  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelector('[data-kv-off-retry]')?.addEventListener('click', () => actLoad(rootEl));

  // Rij-klik → offerte-detail in nieuw tabblad (dossier-context blijft
  // hier bewaard). Klik op interne icon-btns/tl-links stopt propagatie
  // (event.stopPropagation() in inline onclick).
  rootEl.querySelectorAll('[data-kv-off-open]').forEach((row) => {
    row.addEventListener('click', () => {
      const dealId = row.getAttribute('data-kv-off-open');
      if (!dealId) return;
      window.open(`/modules/offerte-detail.html?id=${encodeURIComponent(dealId)}`, '_blank', 'noopener');
    });
  });
}

// ── Public entry ────────────────────────────────────────────────────────────

export async function renderOffertesTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `
      <div class="ds-empty" style="padding:40px 20px;">
        <div class="ds-empty-t">Geen klant-data</div>
        <div class="ds-empty-s">Kan offertes-tab niet renderen zonder klant.</div>
      </div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
