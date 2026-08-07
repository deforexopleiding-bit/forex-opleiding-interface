// modules/klanten-v2/views/tabs/facturen.js
//
// Facturen-tab van klanten-v2 (PR-B6, deel 1 van 3). 14 items, STRIKT
// READ-ONLY. Modals (detail/betaal/verzenden/credit/update/nieuwe)
// blijven in Finance-module en komen in PR-C als nette modal-primitive
// via de shared DFO modal. Hier alleen preview + externe deep-links.
//
// Data-bron: /api/finance-invoices?customer_id=X (bestaand). Permission
// gate: finance.invoice.view (super_admin + manager) — sales zonder
// permission ziet 403 → error-state met duidelijke boodschap.

import { openInvoiceDetailModal } from '../modals/invoice-detail.js';
import { openInvoiceUpdateModal } from '../modals/invoice-update.js';
import { openInvoicePaymentModal } from '../modals/invoice-payment.js';
import { openInvoiceSendModal } from '../modals/invoice-send.js';
import { openInvoiceCreditModal } from '../modals/invoice-credit.js';
import { openInvoiceCreateModal } from '../modals/invoice-create.js';

const K = () => window.KV;

const STATUS = {
  open:                { label: 'Open',            cls: 'ds-pill-accent'  },
  overdue:             { label: 'Verlopen',        cls: 'ds-pill-danger'  },
  paid:                { label: 'Betaald',         cls: 'ds-pill-ok'      },
  partially_paid:      { label: 'Deels betaald',   cls: 'ds-pill-warn'    },
  credited:            { label: 'Gecrediteerd',    cls: 'ds-pill-neutral' },
  partially_credited:  { label: 'Deels gecrediteerd', cls: 'ds-pill-neutral' },
  concept:             { label: 'Concept',         cls: 'ds-pill-neutral' },
};
function statusPill(st) {
  const m = STATUS[st] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}

let state = null;
function initState(customer) {
  state = {
    customerId: customer?.id || null,
    customer,                          // volledige customer-obj — nodig voor D6 "Nieuwe factuur"
    items: [], kpis: null, total: 0,
    loading: true, error: null,
  };
}

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }
function fmtDate(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return ''; } }
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso), b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

async function apiList() {
  const url = `/api/finance-invoices?customer_id=${encodeURIComponent(state.customerId)}&page_size=200`;
  return K().authedJson(url);
}

async function actLoad(rootEl) {
  state.loading = true; state.error = null;
  render(rootEl);
  try {
    const j = await apiList();
    state.items = Array.isArray(j?.items) ? j.items : [];
    state.kpis  = j?.kpis || null;
    state.total = Number(j?.total) || 0;
  } catch (e) {
    state.error = e?.message || 'Kan facturen niet laden';
    state.items = []; state.kpis = null; state.total = 0;
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

function calcLocalKpis(items) {
  let count = items.length, openCount = 0, openAmount = 0, overdueCount = 0, paidCount = 0;
  for (const i of items) {
    const st = i.display_status || i.status;
    const amt = Number(i.amount_total) || 0;
    const paidAmt = Number(i.paid_amount) || 0;
    const openAmt = Math.max(0, amt - paidAmt - (Number(i.credited_amount) || 0));
    if (st === 'open')       { openCount++; openAmount += openAmt; }
    if (st === 'overdue')    { overdueCount++; openCount++; openAmount += openAmt; }
    if (st === 'paid')       paidCount++;
  }
  return { count, openCount, openAmount, overdueCount, paidCount };
}

function renderKpiStrip() {
  if (!state.items.length) return '';
  const k = calcLocalKpis(state.items);
  return `
    <div class="ds-kpi-grid kv-fac-kpis">
      <div class="ds-kpi" style="--kc:var(--blue);--kc-soft:var(--blue-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Facturen totaal</div></div>
        <div class="ds-kpi-val">${k.count}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--amber);--kc-soft:var(--amber-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Open</div></div>
        <div class="ds-kpi-val">${k.openCount}</div>
        <div class="ds-kpi-foot"><span>${K().esc(fmtEur(k.openAmount))} openstaand</span></div>
      </div>
      <div class="ds-kpi" style="--kc:var(--rose);--kc-soft:var(--rose-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Verlopen</div></div>
        <div class="ds-kpi-val">${k.overdueCount}</div>
      </div>
      <div class="ds-kpi" style="--kc:var(--emerald);--kc-soft:var(--emerald-soft)">
        <div class="ds-kpi-top"><div class="ds-kpi-label">Betaald</div></div>
        <div class="ds-kpi-val">${k.paidCount}</div>
      </div>
    </div>`;
}

function renderRow(inv) {
  const st         = inv.display_status || inv.status;
  const nr         = inv.invoice_number || (inv.id ? '#' + String(inv.id).slice(0, 8) : '—');
  const invDate    = fmtDate(inv.invoice_date);
  const dueDate    = fmtDate(inv.due_date);
  const overdueDays = st === 'overdue' && inv.due_date
    ? daysBetween(inv.due_date, new Date().toISOString().slice(0,10))
    : null;
  const amt        = Number(inv.amount_total) || 0;
  const paidAmt    = Number(inv.paid_amount) || 0;
  const openAmt    = Math.max(0, amt - paidAmt - (Number(inv.credited_amount) || 0));
  const tlLink     = inv.tl_invoice_id
    ? `<a class="ds-icon-btn" href="https://focus.teamleader.eu/invoices/${K().esc(encodeURIComponent(inv.tl_invoice_id))}" target="_blank" rel="noopener" title="Open in TeamLeader" onclick="event.stopPropagation()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
       </a>`
    : '';
  return `
    <tr data-kv-fac-open="${K().esc(inv.id)}" title="Open in Finance">
      <td><span class="mono">${K().esc(nr)}</span></td>
      <td class="ds-cell-sub">${K().esc(invDate || '—')}</td>
      <td class="ds-cell-sub">
        ${K().esc(dueDate || '—')}
        ${overdueDays != null && overdueDays > 0 ? `<div style="color:var(--rose);font-size:11px;margin-top:1px;">${overdueDays}d verlopen</div>` : ''}
      </td>
      <td class="r kv-fac-amount">
        <div class="mono">${K().esc(fmtEur(amt))}</div>
        ${openAmt > 0 && st !== 'paid' ? `<div class="ds-cell-sub mono">open: ${K().esc(fmtEur(openAmt))}</div>` : ''}
      </td>
      <td>${statusPill(st)}</td>
      <td class="r kv-fac-actions">
        <button type="button" class="ds-icon-btn" data-kv-fac-open-btn="${K().esc(inv.id)}" title="Open factuur-detail" onclick="event.stopPropagation()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        ${tlLink}
      </td>
    </tr>`;
}

function renderTable() {
  return `
    <div class="ds-tbl-wrap kv-fac-tbl">
      <table class="ds-tbl">
        <thead><tr>
          <th style="min-width:110px">Nummer</th>
          <th style="width:110px">Factuur</th>
          <th style="width:130px">Vervaldatum</th>
          <th class="r" style="width:130px">Bedrag</th>
          <th style="width:130px">Status</th>
          <th class="r" style="width:90px"></th>
        </tr></thead>
        <tbody>${state.items.map(renderRow).join('')}</tbody>
      </table>
    </div>`;
}

function renderEmpty() {
  return `
    <div class="ds-empty" style="padding:56px 20px;">
      <div class="ds-empty-ico" style="background:var(--amber-soft); color:var(--amber);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v18l-3-2-2 2-2-2-2 2-2-2-2 2-3-2z"/></svg>
      </div>
      <div class="ds-empty-t">Nog geen facturen voor deze klant</div>
      <div class="ds-empty-s">
        Facturen worden aangemaakt vanuit Abonnementen of via <a href="/modules/finance.html" target="_blank" rel="noopener" style="color:var(--m);text-decoration:underline;">Finance › Facturen</a> (nieuw tabblad).
      </div>
    </div>`;
}

function renderError() {
  const isPerm = /Geen rechten|403/.test(state.error || '');
  return `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <strong>${isPerm ? 'Geen leesrechten op facturen' : 'Kan facturen niet laden.'}</strong>
        <div style="font-size:12px; opacity:.8; margin-top:2px;">${isPerm ? 'Facturen zijn zichtbaar voor super_admin en manager. Vraag je admin om toegang als je ze nodig hebt.' : K().esc(state.error)}</div>
        ${!isPerm ? '<div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-fac-retry>Opnieuw proberen</button></div>' : ''}
      </div>
    </div>`;
}

function render(rootEl) {
  let body;
  if (state.loading) body = `<div class="ds-empty" style="padding:32px 20px;"><div class="ds-empty-s">Facturen laden…</div></div>`;
  else if (state.error) body = renderError();
  else if (!state.items.length) body = renderEmpty();
  else body = renderKpiStrip() + renderTable();

  rootEl.innerHTML = `
    <div class="kv-fac">
      <div class="kv-fac-head">
        <div class="kv-fac-head-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v18l-3-2-2 2-2-2-2 2-2-2-2 2-3-2z"/></svg>
          Facturen
          <span class="kv-prof-count">${state.loading ? '…' : state.items.length}</span>
        </div>
        <button type="button" class="ds-btn ds-btn-primary ds-btn-sm" data-kv-fac-new title="Nieuwe factuur voor deze klant">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nieuwe factuur
        </button>
      </div>
      ${body}
    </div>`;
  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelector('[data-kv-fac-retry]')?.addEventListener('click', () => actLoad(rootEl));
  rootEl.querySelector('[data-kv-fac-new]')?.addEventListener('click', () => {
    openInvoiceCreateModal({
      customer:  state.customer,
      onSuccess: () => actLoad(rootEl),
    });
  });
  // Rij-klik → intern factuur-detail-modal (PR-D1). Vervangt de eerdere
  // externe hop naar /modules/finance.html#invoice-X zodat de dossier-
  // context blijft staan en de sub-modals (PR-D2..D5) allemaal in
  // klanten-v2 blijven leven.
  const openDetailForId = (id) => {
    const inv = state.items.find((i) => i.id === id);
    if (!inv) return K().toast('Factuur niet gevonden in huidige lijst');
    openInvoiceDetailModal({
      invoice: inv,
      // PR-D2 (bewerken) is live; PR-D3..D5 volgen als placeholder-toasts
      // en worden per PR omgezet naar openXxxModal({...}) met refresh-callback.
      onEdit:   (i) => openInvoiceUpdateModal({
        invoice:   i,
        onSuccess: () => actLoad(rootEl),   // list opnieuw laden, detail sluit vanzelf
      }),
      onPay:    (i) => openInvoicePaymentModal({
        invoice:   i,
        onSuccess: () => actLoad(rootEl),
      }),
      onSend:   (i) => openInvoiceSendModal({
        invoice:   i,
        onSuccess: () => actLoad(rootEl),
      }),
      onCredit: (i) => openInvoiceCreditModal({
        invoice:   i,
        onSuccess: () => actLoad(rootEl),
      }),
    });
  };
  rootEl.querySelectorAll('[data-kv-fac-open]').forEach((row) => {
    row.addEventListener('click', () => openDetailForId(row.getAttribute('data-kv-fac-open')));
  });
  rootEl.querySelectorAll('[data-kv-fac-open-btn]').forEach((btn) => {
    btn.addEventListener('click', () => openDetailForId(btn.getAttribute('data-kv-fac-open-btn')));
  });
}

export async function renderFacturenTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `<div class="ds-empty" style="padding:40px 20px;"><div class="ds-empty-t">Geen klant-data</div><div class="ds-empty-s">Kan facturen-tab niet renderen zonder klant.</div></div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
