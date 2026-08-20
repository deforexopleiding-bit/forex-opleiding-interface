// modules/klanten-v2/views/tabs/creditnotas.js
//
// Creditnota's-tab van klanten-v2 (Ronde-11). READ-ONLY. Hergebruikt
// /api/finance-creditnotes-list met de nieuwe ?customer_id-filter.
// Zelfde compacte tabel-look als Facturen (kv-fac-tbl-classes) zodat de
// drie lijsten (Abonnementen / Facturen / Creditnota's) als één set ogen.

const K = () => window.KV;

const STATUS = {
  booked:  { label: 'Geboekt',    cls: 'ds-pill-ok'      },
  sent:    { label: 'Verzonden',  cls: 'ds-pill-ok'      },
  matched: { label: 'Verrekend',  cls: 'ds-pill-ok'      },
  outstanding: { label: 'Open',   cls: 'ds-pill-accent'  },
  draft:   { label: 'Concept',    cls: 'ds-pill-neutral' },
};
function statusPill(st) {
  const m = STATUS[st] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}

let state = null;
function initState(customer) {
  state = {
    customerId: customer?.id || null,
    customer,
    items: [], kpi: null, total: 0,
    loading: true, error: null,
  };
}

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }
function fmtDate(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return ''; } }

async function apiList() {
  const url = `/api/finance-creditnotes-list?customer_id=${encodeURIComponent(state.customerId)}&page_size=200`;
  return K().authedJson(url);
}

async function actLoad(rootEl) {
  state.loading = true; state.error = null;
  render(rootEl);
  try {
    const j = await apiList();
    state.items = Array.isArray(j?.items) ? j.items : [];
    state.kpi   = j?.kpi || null;
    state.total = Number(j?.total) || 0;
  } catch (e) {
    state.error = e?.message || 'Kan creditnota\'s niet laden';
    state.items = []; state.kpi = null; state.total = 0;
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

function renderRow(cn) {
  const nr   = cn.credit_note_number || ('#' + String(cn.id || '').slice(0, 8));
  const invNr = cn.invoice_number || '—';
  return `
    <tr>
      <td><span class="mono">${K().esc(nr)}</span></td>
      <td><span class="mono" style="font-size:11.5px;color:var(--text-3)">${K().esc(invNr)}</span></td>
      <td>${K().esc(fmtDate(cn.credit_note_date))}</td>
      <td class="r kv-fac-amount"><span class="mono">${K().esc(fmtEur(cn.amount_total))}</span></td>
      <td>${statusPill(cn.status)}</td>
    </tr>`;
}

function renderTable() {
  return `
    <div class="ds-tbl-wrap kv-fac-tbl kv-cn-tbl">
      <table class="ds-tbl">
        <thead><tr>
          <th style="min-width:110px">Nummer</th>
          <th style="width:120px">Bij factuur</th>
          <th style="width:130px">Datum</th>
          <th class="r" style="width:130px">Bedrag</th>
          <th style="width:130px">Status</th>
        </tr></thead>
        <tbody>${state.items.map(renderRow).join('')}</tbody>
      </table>
    </div>`;
}

function renderKpiStrip() {
  if (!state.kpi) return '';
  return `
    <div class="ds-kpi-strip">
      <div class="ds-kpi"><div class="ds-kpi-l">Totaal creditnota's</div><div class="ds-kpi-v">${K().esc(String(state.kpi.count || 0))}</div></div>
      <div class="ds-kpi"><div class="ds-kpi-l">Som bedragen</div><div class="ds-kpi-v mono">${K().esc(fmtEur(state.kpi.sum_amount))}</div></div>
    </div>`;
}

function renderEmpty() {
  return `
    <div class="ds-empty" style="padding:56px 20px;">
      <div class="ds-empty-ico" style="background:var(--violet-soft, var(--surface-2)); color:var(--violet, var(--text-3));">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v18l-3-2-2 2-2-2-2 2-2-2-2 2-3-2z"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
      </div>
      <div class="ds-empty-t">Geen creditnota's voor deze klant</div>
      <div class="ds-empty-s">Creditnota's ontstaan door een factuur te crediteren via Finance › Facturen.</div>
    </div>`;
}

function renderError() {
  const isPerm = /Geen rechten|403/.test(state.error || '');
  return `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <strong>${isPerm ? 'Geen leesrechten op creditnota\'s' : 'Kan creditnota\'s niet laden.'}</strong>
        <div style="font-size:12px; opacity:.8; margin-top:2px;">${isPerm ? 'Creditnota\'s zijn zichtbaar voor super_admin en manager.' : K().esc(state.error)}</div>
        ${!isPerm ? '<div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-cn-retry>Opnieuw proberen</button></div>' : ''}
      </div>
    </div>`;
}

function render(rootEl) {
  let body;
  if (state.loading) body = `<div class="ds-empty" style="padding:32px 20px;"><div class="ds-empty-s">Creditnota's laden…</div></div>`;
  else if (state.error) body = renderError();
  else if (!state.items.length) body = renderEmpty();
  else body = renderKpiStrip() + renderTable();

  rootEl.innerHTML = `
    <div class="kv-fac">
      <div class="kv-fac-head">
        <div class="kv-fac-head-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 12h8"/></svg>
          Creditnota's
          <span class="kv-prof-count">${state.loading ? '…' : state.items.length}</span>
        </div>
      </div>
      ${body}
    </div>`;
  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelector('[data-kv-cn-retry]')?.addEventListener('click', () => actLoad(rootEl));
}

export async function renderCreditnotasTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `<div class="ds-empty" style="padding:40px 20px;"><div class="ds-empty-t">Geen klant-data</div><div class="ds-empty-s">Kan creditnota's-tab niet renderen zonder klant.</div></div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
