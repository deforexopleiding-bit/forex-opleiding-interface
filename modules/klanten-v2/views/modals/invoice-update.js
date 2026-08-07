// modules/klanten-v2/views/modals/invoice-update.js
//
// Factuur-update-modal (PR-D2, tweede van de 6 factuur-modals).
// ALLEEN concept-facturen. Server-side guard: /api/finance-invoice-update
// geeft 409 als status !== 'concept'. UI verbergt de knop in dat geval
// (via canEdit-check in invoice-detail-modal); deze modal is de fallback
// als iemand er toch inkomt via een verouderde state.
//
// Wat wél mag: line-items (beschrijving/aantal/eenheidsprijs/BTW),
// PO-nummer, taal (nl/en). Diff-only submit — alleen gewijzigde velden.
// Wat NIET in deze modal: factuur-datum, vervaldatum, klant-wisselen,
// betaal-term-id (list onbekend zonder extra endpoint). Die kunnen later
// als PR-D2.1 uitbreiden mocht behoefte ontstaan.
//
// Endpoint: POST /api/finance-invoice-update
// Body-shape (diff-only):
//   { invoice_id,
//     lines?: [{ description, quantity, unit_price_excl, vat_percentage }],
//     purchase_order_number?, language? }
//
// TL-side effect: TL /invoices.update wordt gecalled — reversibel binnen
// concept-status (elk update overschrijft). Geen mail, geen betaling.
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

const VAT_OPTIONS = [0, 6, 9, 21];
const LANG_OPTIONS = [
  { v: 'nl', l: 'Nederlands' },
  { v: 'en', l: 'English' },
];

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(invoice, opts) {
  state = {
    invoiceId:  invoice?.id || null,
    invoice,
    linesLoading: true,
    linesError:   null,
    // originalLines: raw uit /finance-invoice-lines — baseline voor diff
    originalLines: [],
    form: {
      lines: [],                                      // editable copy
      purchase_order_number: invoice?.purchase_order_number || '',
      language:               invoice?.language || 'nl',
    },
    originalForm: {                                   // baseline voor diff
      purchase_order_number: invoice?.purchase_order_number || '',
      language:               invoice?.language || 'nl',
    },
    errors:      {},        // { 'lines.0.description': 'msg', purchase_order_number: 'msg', ... }
    globalError: null,
    saving:      false,
    onSuccess:   opts?.onSuccess || null,
  };
}

// ── Data-loaders ───────────────────────────────────────────────────────────

async function loadLines() {
  try {
    const j = await K().authedJson(`/api/finance-invoice-lines?invoice_id=${encodeURIComponent(state.invoiceId)}`);
    const raw = Array.isArray(j?.lines) ? j.lines : [];
    // Normaliseer naar wat het update-endpoint accepteert.
    state.originalLines = raw.map((l) => ({
      description:      String(l.description || ''),
      quantity:         Number(l.quantity) || 1,
      unit_price_excl:  Number(l.unit_price_excl) || 0,
      vat_percentage:   Number.isFinite(Number(l.tax_rate)) ? Number(l.tax_rate) : 21,
    }));
    // Editable copy (deep-clone via JSON — waarden zijn primitieven).
    state.form.lines = state.originalLines.map((l) => ({ ...l }));
    if (!state.form.lines.length) {
      // Nieuwe/lege draft — voeg 1 lege rij toe zodat de user meteen kan typen.
      state.form.lines.push(newRow());
    }
  } catch (e) {
    state.linesError = e?.message || 'Line-items niet geladen';
  } finally {
    state.linesLoading = false;
    rerender();
  }
}

function newRow() {
  return { description: '', quantity: 1, unit_price_excl: 0, vat_percentage: 21 };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function computeTotals(lines) {
  let excl = 0, tax = 0;
  for (const l of lines) {
    const q = Number(l.quantity) || 0;
    const u = Number(l.unit_price_excl) || 0;
    const v = Number(l.vat_percentage) || 0;
    const line = q * u;
    excl += line;
    tax += line * (v / 100);
  }
  return { excl, tax, incl: excl + tax };
}

function linesChanged() {
  const a = state.originalLines, b = state.form.lines;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (String(x.description).trim()      !== String(y.description).trim())      return true;
    if (Number(x.quantity)                !== Number(y.quantity))                 return true;
    if (Number(x.unit_price_excl)         !== Number(y.unit_price_excl))          return true;
    if (Number(x.vat_percentage)          !== Number(y.vat_percentage))           return true;
  }
  return false;
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderHead() {
  const nr = state.invoice?.invoice_number || (state.invoiceId ? '#' + String(state.invoiceId).slice(0, 8) : '—');
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Conceptfactuur bewerken</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          <span class="mono">${esc(nr)}</span>
          <span class="ds-pill ds-pill-neutral">Concept</span>
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-invupd-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderLineRow(l, idx) {
  const eDesc = state.errors[`lines.${idx}.description`];
  const eQty  = state.errors[`lines.${idx}.quantity`];
  const eUnit = state.errors[`lines.${idx}.unit_price_excl`];
  const eVat  = state.errors[`lines.${idx}.vat_percentage`];
  const total = (Number(l.quantity) || 0) * (Number(l.unit_price_excl) || 0);
  return `
    <tr data-kv-invupd-row="${idx}">
      <td>
        <input type="text" class="kv-invupd-inp" data-kv-invupd-field="description" data-kv-invupd-idx="${idx}" value="${esc(l.description)}" placeholder="Omschrijving…" />
        ${eDesc ? `<div class="kv-edit-field-msg">${esc(eDesc)}</div>` : ''}
      </td>
      <td class="r">
        <input type="number" class="kv-invupd-inp kv-invupd-inp-num" data-kv-invupd-field="quantity" data-kv-invupd-idx="${idx}" value="${esc(String(l.quantity))}" min="0" step="0.01" inputmode="decimal" />
        ${eQty ? `<div class="kv-edit-field-msg">${esc(eQty)}</div>` : ''}
      </td>
      <td class="r">
        <input type="number" class="kv-invupd-inp kv-invupd-inp-num" data-kv-invupd-field="unit_price_excl" data-kv-invupd-idx="${idx}" value="${esc(String(l.unit_price_excl))}" min="0" step="0.01" inputmode="decimal" />
        ${eUnit ? `<div class="kv-edit-field-msg">${esc(eUnit)}</div>` : ''}
      </td>
      <td class="r">
        <select class="kv-invupd-inp kv-invupd-inp-vat" data-kv-invupd-field="vat_percentage" data-kv-invupd-idx="${idx}">
          ${VAT_OPTIONS.map((v) => `<option value="${v}" ${Number(l.vat_percentage) === v ? 'selected' : ''}>${v}%</option>`).join('')}
        </select>
        ${eVat ? `<div class="kv-edit-field-msg">${esc(eVat)}</div>` : ''}
      </td>
      <td class="r mono">${esc(fmtEur(total))}</td>
      <td class="r">
        <button type="button" class="ds-icon-btn" data-kv-invupd-del="${idx}" title="Regel verwijderen" ${state.form.lines.length <= 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </td>
    </tr>`;
}

function renderLinesTable() {
  if (state.linesLoading) return `<div class="kv-inv-loading">Line-items laden…</div>`;
  if (state.linesError)  return `<div class="kv-inv-warn">Line-items niet geladen: ${esc(state.linesError)}</div>`;
  const totals = computeTotals(state.form.lines);
  return `
    <div class="ds-tbl-wrap kv-invupd-tbl-wrap">
      <table class="ds-tbl kv-invupd-tbl">
        <thead><tr>
          <th>Omschrijving</th>
          <th class="r" style="width:90px">Aantal</th>
          <th class="r" style="width:120px">Prijs excl.</th>
          <th class="r" style="width:90px">BTW</th>
          <th class="r" style="width:110px">Regel-totaal</th>
          <th class="r" style="width:44px"></th>
        </tr></thead>
        <tbody>${state.form.lines.map((l, i) => renderLineRow(l, i)).join('')}</tbody>
        <tfoot>
          <tr>
            <td colspan="4" class="r"><strong>Subtotaal (excl.)</strong></td>
            <td class="r mono"><strong>${esc(fmtEur(totals.excl))}</strong></td>
            <td></td>
          </tr>
          <tr>
            <td colspan="4" class="r">BTW</td>
            <td class="r mono">${esc(fmtEur(totals.tax))}</td>
            <td></td>
          </tr>
          <tr>
            <td colspan="4" class="r"><strong>Totaal (incl. BTW)</strong></td>
            <td class="r mono"><strong>${esc(fmtEur(totals.incl))}</strong></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div class="kv-invupd-add-row">
      <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-invupd-add>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Regel toevoegen
      </button>
    </div>`;
}

function renderBody() {
  const ePo   = state.errors.purchase_order_number;
  const eLang = state.errors.language;
  return `
    <form id="kv-invupd-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-edit-hint kv-invupd-hint">
        Alleen conceptfacturen kunnen worden aangepast. Wijzigingen synchroniseren direct met TeamLeader.
      </div>

      <div class="kv-edit-section-h">Regels</div>
      ${renderLinesTable()}

      <div class="kv-edit-section-h">Meta</div>
      <div class="kv-edit-grid">
        <div class="kv-edit-field kv-edit-field-full ${ePo ? 'kv-edit-field-error' : ''}">
          <label for="kv-invupd-po">PO-nummer</label>
          <input id="kv-invupd-po" name="purchase_order_number" type="text" value="${esc(state.form.purchase_order_number)}" data-kv-invupd-meta />
          ${ePo ? `<div class="kv-edit-field-msg">${esc(ePo)}</div>` : ''}
        </div>
        <div class="kv-edit-field ${eLang ? 'kv-edit-field-error' : ''}">
          <label for="kv-invupd-lang">Taal</label>
          <select id="kv-invupd-lang" name="language" data-kv-invupd-meta>
            ${LANG_OPTIONS.map((o) => `<option value="${o.v}" ${state.form.language === o.v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}
          </select>
          ${eLang ? `<div class="kv-edit-field-msg">${esc(eLang)}</div>` : ''}
        </div>
      </div>
    </form>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invupd-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-invupd-submit ${state.saving || state.linesLoading ? 'disabled' : ''}>
        ${state.saving ? 'Opslaan…' : 'Opslaan'}
      </button>
    </div>`;
}

// ── Validatie (client-side pre-check, server is autoritatief) ─────────────

function clientValidate() {
  const errors = {};
  state.form.lines.forEach((l, i) => {
    if (!String(l.description || '').trim()) errors[`lines.${i}.description`] = 'Omschrijving is verplicht';
    const q = Number(l.quantity);
    if (!Number.isFinite(q) || q <= 0) errors[`lines.${i}.quantity`] = 'Aantal moet > 0 zijn';
    const u = Number(l.unit_price_excl);
    if (!Number.isFinite(u) || u < 0) errors[`lines.${i}.unit_price_excl`] = 'Prijs moet ≥ 0 zijn';
    const v = Number(l.vat_percentage);
    if (!VAT_OPTIONS.includes(v)) errors[`lines.${i}.vat_percentage`] = 'Ongeldig BTW-percentage';
  });
  return errors;
}

// ── Submit ─────────────────────────────────────────────────────────────────

async function doSave() {
  state.errors = clientValidate();
  state.globalError = null;
  if (Object.keys(state.errors).length) {
    rerender();
    return;
  }

  // Diff-only patch.
  const patch = { invoice_id: state.invoiceId };
  if (linesChanged()) {
    patch.lines = state.form.lines.map((l) => ({
      description:     String(l.description || '').trim(),
      quantity:        Number(l.quantity) || 1,
      unit_price_excl: Number(l.unit_price_excl) || 0,
      vat_percentage:  Number(l.vat_percentage) || 21,
    }));
  }
  if (state.form.purchase_order_number !== state.originalForm.purchase_order_number) {
    patch.purchase_order_number = String(state.form.purchase_order_number || '');
  }
  if (state.form.language !== state.originalForm.language) {
    patch.language = state.form.language;
  }

  const changedKeys = Object.keys(patch).filter((k) => k !== 'invoice_id');
  if (changedKeys.length === 0) {
    state.globalError = 'Geen wijzigingen om op te slaan.';
    rerender();
    return;
  }

  state.saving = true;
  rerender();

  try {
    await K().authedJson('/api/finance-invoice-update', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    K().toast('Conceptfactuur bijgewerkt');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || 'Opslaan mislukt';
    // 409 (niet-concept) is een terminale toestand voor deze modal — melden en sluiten.
    if (/409|Alleen conceptfacturen/i.test(msg)) {
      state.globalError = 'Deze factuur is niet meer een concept en kan niet meer bewerkt worden. Vernieuw de klant-tab.';
    } else {
      state.globalError = msg;
    }
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-invupd-close], [data-kv-invupd-cancel]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelector('[data-kv-invupd-submit]')?.addEventListener('click', doSave);
  box.querySelector('#kv-invupd-form')?.addEventListener('submit', (e) => { e.preventDefault(); doSave(); });

  // Line-item inputs — mutate state and lazy re-render totals via row-level update.
  box.querySelectorAll('[data-kv-invupd-field]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = Number(e.target.getAttribute('data-kv-invupd-idx'));
      const field = e.target.getAttribute('data-kv-invupd-field');
      if (!state.form.lines[idx]) return;
      if (field === 'description') {
        state.form.lines[idx][field] = e.target.value;
      } else {
        // Numeriek — parse maar sta lege string toe tijdens typen
        const raw = e.target.value;
        state.form.lines[idx][field] = raw === '' ? '' : Number(raw);
      }
      // Errors op dit veld wegen; totals re-render volledige body om te syncen.
      const errKey = `lines.${idx}.${field}`;
      if (state.errors[errKey]) delete state.errors[errKey];
      rerenderBody();
    });
  });

  // Meta inputs
  box.querySelectorAll('[data-kv-invupd-meta]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      state.form[e.target.name] = e.target.value;
      if (state.errors[e.target.name]) { delete state.errors[e.target.name]; rerenderBody(); }
    });
    inp.addEventListener('change', (e) => {
      state.form[e.target.name] = e.target.value;
    });
  });

  // Add / remove rows
  box.querySelector('[data-kv-invupd-add]')?.addEventListener('click', () => {
    state.form.lines.push(newRow());
    rerenderBody();
  });
  box.querySelectorAll('[data-kv-invupd-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-kv-invupd-del'));
      if (state.form.lines.length <= 1) return;
      state.form.lines.splice(idx, 1);
      // Errors met hoger index nummer wissen (index-shift).
      state.errors = {};
      rerenderBody();
    });
  });
}

// ── Micro-render (body-only om focus te sparen — head/foot blijven staan) ──

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderBody() {
  const bodyEl = document.querySelector('#dfoModalBody');
  const footEl = document.querySelector('#dfoModalFoot');
  if (bodyEl) bodyEl.innerHTML = renderBody();
  if (footEl) footEl.innerHTML = renderFoot();
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openInvoiceUpdateModal({ invoice, onSuccess })
 *   invoice   — factuur-object (moet status='concept'|'draft' hebben; caller
 *               moet dat afdwingen — server geeft 409 als niet).
 *   onSuccess — callback() na geslaagde update; caller herlaadt list + evt.
 *               heropent detail-modal.
 */
export function openInvoiceUpdateModal({ invoice, onSuccess } = {}) {
  if (!invoice?.id) {
    K().toast('Geen factuur om te bewerken');
    return;
  }
  const st = invoice.display_status || invoice.status;
  if (st !== 'concept' && st !== 'draft') {
    K().toast('Alleen conceptfacturen kunnen worden bewerkt.');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(invoice, { onSuccess });
  rerender();
  loadLines();
}
