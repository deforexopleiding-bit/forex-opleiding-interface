// modules/klanten-v2/views/modals/invoice-create.js
//
// Factuur-nieuw-modal (PR-D6, zesde en laatste van de factuur-modals).
//
// Draft-first als hard default — 3 actie-knoppen in oplopende gevaar:
//   1. "Concept opslaan"           → action='draft' (no guard)
//   2. "Concept + direct boeken"   → action='book'  (2-klik guard)
//   3. "Concept + boeken + verzenden" → 2-step (book → send)
//      met typ-gate "BOEK EN VERZEND" + template-keuze in stap 2
//
// Endpoint (bestaand, NIET aangeraakt):
//   POST /api/finance-invoice-create
//   Body: { customer_id, department_id, lines[], purchase_order_number?,
//           payment_term_id?, language?, action: 'draft'|'book',
//           send?: {...} }
//   Voor boeken+verzenden: 2-step approach —
//   1) create met action='book' → krijgt invoice_id
//   2) POST /api/finance-invoice-send met chosen mail_template_id
//
//   Reden voor 2-step: template-consistentie met D4 (finance-invoice-send
//   heeft de goede template-picker/mailTemplates.list-flow). Trade-off:
//   als de 2e call faalt, is de factuur al geboekt (in TL). We tonen dat
//   expliciet in de foutmelding + suggereren D4-modal als recovery.
//
// Externe side-effects per actie:
//   draft   → reversibel (kan verwijderd)
//   book    → onomkeerbaar in boekhouding (nieuwe factuur, nieuw nummer)
//   book+send → onomkeerbaar + e-mail vertrekt
//
// Guards:
//   - Enter binnen tekst-inputs: gaat naar volgende input, geen submit
//   - Enter binnen numerieke / date: blur(), geen submit
//   - Enter binnen typ-gate: preventDefault + blur
//   - Geen form.submit-listener op de outer form
//   - IN-FLIGHT LOCK per definitieve destructive-knop (alle 3):
//     klik disablet + spinner, verdere klikken genegeerd. Bij timeout
//     "status onbekend, controleer in TL" zonder auto-retry.
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

// Hardcoded ENTITIES uit finance.html — TL department UUIDs zijn stabiel.
// Als er ooit een 4e entiteit bijkomt, wordt dit een shared const in klanten-v2 config.
const ENTITIES = [
  { id: '09d67371-6947-03f6-bd5e-410dd8636344', label: 'Online' },
  { id: '0da396bf-1074-0425-ac5c-fa1141b41cb1', label: 'Fysiek' },
  { id: '9adca043-0ebc-09da-a45e-f21798841cb2', label: 'Retentie' },
];

const VAT_OPTIONS = [0, 6, 9, 21];
const LANG_OPTIONS = [
  { v: 'nl', l: 'Nederlands' },
  { v: 'en', l: 'English' },
];

const TYPE_GATE_TEXT = 'BOEK EN VERZEND';

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(customer, opts) {
  state = {
    customer,                          // {id, first_name, last_name, company_name, email, is_company, tl_contact_id, tl_company_id}
    form: {
      department_id: ENTITIES[0].id,
      lines: [newRow()],
      purchase_order_number: '',
      language: 'nl',
    },
    // Confirm-overlays voor destructive acties
    overlay: null,                     // null | 'book' | 'bookSend'
    // Boek+verzenden state
    templatesLoading: false,
    templatesError:   null,
    templates:        [],              // [{id, name, subject, body, is_default}]
    selectedTemplateId: '',
    // Guards
    confirmBookChecked: false,         // 2-klik voor "book"
    typedGateBookSend:  '',            // typ-gate voor "book+send"
    // Common
    errors:      {},
    globalError: null,
    saving:      false,
    unknownStatus: false,
    onSuccess:   opts?.onSuccess || null,
  };
}
function newRow() { return { description: '', quantity: 1, unit_price_excl: 0, vat_percentage: 21 }; }

// ── Helpers ────────────────────────────────────────────────────────────────

function customerLabel() {
  const c = state.customer;
  if (c?.is_company) return c.company_name || 'Bedrijfsklant';
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Klant';
}
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
function goodLines() {
  return state.form.lines.filter((l) => String(l.description || '').trim() && Number(l.quantity) > 0);
}

// ── Head ───────────────────────────────────────────────────────────────────

function renderHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Nieuwe factuur</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          <span>${esc(customerLabel())}</span>
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-invnew-close aria-label="Sluiten" ${state.saving ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

// ── Body ───────────────────────────────────────────────────────────────────

function renderLineRow(l, idx) {
  const errKeyDesc = state.errors[`lines.${idx}.description`];
  const errKeyQty  = state.errors[`lines.${idx}.quantity`];
  const errKeyPri  = state.errors[`lines.${idx}.unit_price_excl`];
  const total = (Number(l.quantity) || 0) * (Number(l.unit_price_excl) || 0);
  return `
    <tr>
      <td>
        <input type="text" class="kv-invupd-inp" data-kv-invnew-lf="description" data-kv-invnew-li="${idx}" value="${esc(l.description)}" placeholder="Omschrijving…" />
        ${errKeyDesc ? `<div class="kv-edit-field-msg">${esc(errKeyDesc)}</div>` : ''}
      </td>
      <td class="r">
        <input type="number" class="kv-invupd-inp kv-invupd-inp-num" data-kv-invnew-lf="quantity" data-kv-invnew-li="${idx}" value="${esc(String(l.quantity))}" min="0" step="0.01" inputmode="decimal" />
        ${errKeyQty ? `<div class="kv-edit-field-msg">${esc(errKeyQty)}</div>` : ''}
      </td>
      <td class="r">
        <input type="number" class="kv-invupd-inp kv-invupd-inp-num" data-kv-invnew-lf="unit_price_excl" data-kv-invnew-li="${idx}" value="${esc(String(l.unit_price_excl))}" min="0" step="0.01" inputmode="decimal" />
        ${errKeyPri ? `<div class="kv-edit-field-msg">${esc(errKeyPri)}</div>` : ''}
      </td>
      <td class="r">
        <select class="kv-invupd-inp kv-invupd-inp-vat" data-kv-invnew-lf="vat_percentage" data-kv-invnew-li="${idx}">
          ${VAT_OPTIONS.map((v) => `<option value="${v}" ${Number(l.vat_percentage) === v ? 'selected' : ''}>${v}%</option>`).join('')}
        </select>
      </td>
      <td class="r mono">${esc(fmtEur(total))}</td>
      <td class="r">
        <button type="button" class="ds-icon-btn" data-kv-invnew-del="${idx}" title="Regel verwijderen" ${state.form.lines.length <= 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </td>
    </tr>`;
}

function renderLinesTable() {
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
          <tr><td colspan="4" class="r"><strong>Subtotaal (excl.)</strong></td><td class="r mono"><strong>${esc(fmtEur(totals.excl))}</strong></td><td></td></tr>
          <tr><td colspan="4" class="r">BTW</td><td class="r mono">${esc(fmtEur(totals.tax))}</td><td></td></tr>
          <tr><td colspan="4" class="r"><strong>Totaal (incl. BTW)</strong></td><td class="r mono"><strong>${esc(fmtEur(totals.incl))}</strong></td><td></td></tr>
        </tfoot>
      </table>
    </div>
    <div class="kv-invupd-add-row">
      <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-invnew-add>+ Regel toevoegen</button>
    </div>`;
}

function renderForm() {
  const eDept = state.errors.department_id;
  const eLines = state.errors.lines;
  return `
    <form id="kv-invnew-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-edit-section-h">Entiteit + taal</div>
      <div class="kv-edit-grid">
        <div class="kv-edit-field ${eDept ? 'kv-edit-field-error' : ''}">
          <label for="kv-invnew-dept">Entiteit <span class="kv-edit-req">*</span></label>
          <select id="kv-invnew-dept" name="department_id" data-kv-invnew-meta>
            ${ENTITIES.map((e) => `<option value="${e.id}" ${state.form.department_id === e.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
          </select>
        </div>
        <div class="kv-edit-field">
          <label for="kv-invnew-lang">Taal</label>
          <select id="kv-invnew-lang" name="language" data-kv-invnew-meta>
            ${LANG_OPTIONS.map((o) => `<option value="${o.v}" ${state.form.language === o.v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="kv-edit-section-h">Regels ${eLines ? `<span class="kv-invnew-h-err">${esc(eLines)}</span>` : ''}</div>
      ${renderLinesTable()}

      <div class="kv-edit-section-h">Meta (optioneel)</div>
      <div class="kv-edit-grid">
        <div class="kv-edit-field kv-edit-field-full">
          <label for="kv-invnew-po">PO-nummer</label>
          <input id="kv-invnew-po" name="purchase_order_number" type="text" value="${esc(state.form.purchase_order_number)}" data-kv-invnew-meta />
        </div>
      </div>
    </form>`;
}

// ── Confirm-overlays voor destructive acties ───────────────────────────────

function renderOverlayBook() {
  const totals = computeTotals(goodLines());
  return `
    <div class="kv-invnew-overlay">
      <div class="kv-invnew-overlay-inner">
        ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
        ${state.unknownStatus ? `<div class="kv-edit-banner kv-invsend-banner-unknown">
          <strong>Status onbekend.</strong> Controleer eerst in TeamLeader of deze factuur is aangemaakt/geboekt voordat je opnieuw probeert.</div>` : ''}

        <div class="kv-invsend-notice kv-invcredit-notice-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <div>
            <div class="kv-invsend-notice-t"><strong>Boeken maakt een definitief factuurnummer aan in TeamLeader.</strong></div>
            <div class="kv-invsend-notice-s">Boekhouding krijgt deze binnen. Undo bestaat niet — alleen tegengeboekt met een creditnota.</div>
          </div>
        </div>

        <div class="kv-invsend-recap">
          <div class="kv-invsend-recap-row"><span>Klant</span><span>${esc(customerLabel())}</span></div>
          <div class="kv-invsend-recap-row"><span>Entiteit</span><span>${esc(ENTITIES.find((e) => e.id === state.form.department_id)?.label || '—')}</span></div>
          <div class="kv-invsend-recap-row"><span>Regels</span><span>${goodLines().length}</span></div>
          <div class="kv-invsend-recap-row"><span>Totaal (incl.)</span><span class="mono"><strong>${esc(fmtEur(totals.incl))}</strong></span></div>
        </div>

        <label class="kv-invsend-confirm">
          <input type="checkbox" data-kv-invnew-book-check ${state.confirmBookChecked ? 'checked' : ''} ${state.saving ? 'disabled' : ''} />
          <span>Ik heb de klant, het bedrag en de regels gecontroleerd</span>
        </label>
      </div>
    </div>`;
}

function renderOverlayBookSend() {
  const totals = computeTotals(goodLines());
  const clientEmail = state.customer?.email || '';
  const tpl = state.templates.find((t) => t.id === state.selectedTemplateId);
  return `
    <div class="kv-invnew-overlay">
      <div class="kv-invnew-overlay-inner">
        ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
        ${state.unknownStatus ? `<div class="kv-edit-banner kv-invsend-banner-unknown">
          <strong>Status onbekend.</strong> Controleer eerst in TeamLeader of factuur is geboekt en/of verzonden voordat je opnieuw probeert.</div>` : ''}

        <div class="kv-invsend-notice kv-invsend-notice-danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <div>
            <div class="kv-invsend-notice-t"><strong>Boeken + verzenden = 2 onomkeerbare acties in 1 klik.</strong></div>
            <div class="kv-invsend-notice-s">Als de mail-stap faalt na een succesvolle boeking, is de factuur al aangemaakt en kun je 'm alsnog handmatig verzenden via de detail-modal.</div>
          </div>
        </div>

        <div class="kv-invsend-recap">
          <div class="kv-invsend-recap-row"><span>Klant</span><span>${esc(customerLabel())}</span></div>
          <div class="kv-invsend-recap-row"><span>E-mail</span><span class="mono">${esc(clientEmail || '⚠ (geen)')}</span></div>
          <div class="kv-invsend-recap-row"><span>Entiteit</span><span>${esc(ENTITIES.find((e) => e.id === state.form.department_id)?.label || '—')}</span></div>
          <div class="kv-invsend-recap-row"><span>Totaal (incl.)</span><span class="mono"><strong>${esc(fmtEur(totals.incl))}</strong></span></div>
        </div>

        <div class="kv-edit-field kv-edit-field-full">
          <label>Mail-template <span class="kv-edit-req">*</span></label>
          ${state.templatesLoading ? '<div class="kv-inv-loading">Templates laden…</div>'
            : state.templatesError ? `<div class="kv-inv-warn">Templates niet geladen: ${esc(state.templatesError)}</div>`
            : `<select data-kv-invnew-bs-tpl>
                 ${state.templates.length ? '' : '<option value="">(Geen templates gevonden)</option>'}
                 ${state.templates.map((t) => `<option value="${esc(t.id)}" ${state.selectedTemplateId === t.id ? 'selected' : ''}>
                   ${esc(t.name)}${t.is_default ? ' (default)' : ''}${t.language ? ' · ' + esc(t.language) : ''}
                 </option>`).join('')}
               </select>
               ${tpl ? `<div class="kv-invnew-tpl-preview">
                 <div class="kv-invnew-tpl-subj"><strong>Onderwerp:</strong> ${esc(tpl.subject || '(uit template)')}</div>
               </div>` : ''}
              `}
        </div>

        <div class="kv-invcredit-typegate">
          <label for="kv-invnew-typegate-inp">
            Typ <span class="mono">${TYPE_GATE_TEXT}</span> om te bevestigen:
          </label>
          <input id="kv-invnew-typegate-inp" type="text" value="${esc(state.typedGateBookSend)}"
                 data-kv-invnew-bs-typegate autocomplete="off" spellcheck="false"
                 placeholder="${TYPE_GATE_TEXT}"
                 ${state.saving ? 'disabled' : ''} />
          ${state.typedGateBookSend && state.typedGateBookSend.trim().toUpperCase() !== TYPE_GATE_TEXT
            ? '<div class="kv-edit-field-msg">Komt niet overeen</div>' : ''}
        </div>
      </div>
    </div>`;
}

function renderBody() {
  const base = renderForm();
  if (state.overlay === 'book')     return base + renderOverlayBook();
  if (state.overlay === 'bookSend') return base + renderOverlayBookSend();
  return base;
}

// ── Foot ───────────────────────────────────────────────────────────────────

function renderFootMain() {
  return `
    <div class="kv-edit-foot kv-invnew-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invnew-cancel>Annuleren</button>
      <div class="kv-invnew-foot-actions">
        <button type="button" class="ds-btn ds-btn-primary" data-kv-invnew-act="draft">Concept opslaan</button>
        <button type="button" class="ds-btn" data-kv-invnew-act="book">Concept + direct boeken</button>
        <button type="button" class="ds-btn kv-invnew-btn-danger-soft" data-kv-invnew-act="bookSend">Concept + boeken + verzenden</button>
      </div>
    </div>`;
}

function renderFootOverlayBook() {
  const canSubmit = state.confirmBookChecked && !state.saving && !state.unknownStatus;
  return `
    <div class="kv-edit-foot kv-invsend-foot-danger">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invnew-overlay-back ${state.saving ? 'disabled' : ''}>← Terug naar concept</button>
      <button type="button" class="ds-btn ds-btn-danger" data-kv-invnew-book-submit
              ${canSubmit ? '' : 'disabled'} aria-busy="${state.saving ? 'true' : 'false'}">
        ${state.saving ? '<span class="kv-inv-spinner"></span> Boeken…' : 'Boeken nu'}
      </button>
    </div>`;
}
function renderFootOverlayBookSend() {
  const gateOk    = state.typedGateBookSend.trim().toUpperCase() === TYPE_GATE_TEXT;
  const canSubmit = gateOk && state.selectedTemplateId && !state.saving && !state.unknownStatus;
  return `
    <div class="kv-edit-foot kv-invsend-foot-danger">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invnew-overlay-back ${state.saving ? 'disabled' : ''}>← Terug naar concept</button>
      <button type="button" class="ds-btn ds-btn-danger" data-kv-invnew-bs-submit
              ${canSubmit ? '' : 'disabled'} aria-busy="${state.saving ? 'true' : 'false'}">
        ${state.saving ? '<span class="kv-inv-spinner"></span> Boeken en verzenden…' : 'Boeken en verzenden'}
      </button>
    </div>`;
}
function renderFoot() {
  if (state.overlay === 'book')     return renderFootOverlayBook();
  if (state.overlay === 'bookSend') return renderFootOverlayBookSend();
  return renderFootMain();
}

// ── Validatie ──────────────────────────────────────────────────────────────

function validateForm() {
  const errors = {};
  if (!state.form.department_id) errors.department_id = 'Kies een entiteit';
  const good = goodLines();
  if (!good.length) errors.lines = 'Minimaal 1 regel met omschrijving + aantal > 0';
  state.form.lines.forEach((l, i) => {
    // Rij is optioneel als 'ie helemaal leeg is (dan is het een "extra" rij)
    if (!String(l.description || '').trim() && Number(l.quantity) === 0 && Number(l.unit_price_excl) === 0) return;
    if (!String(l.description || '').trim()) errors[`lines.${i}.description`] = 'Omschrijving verplicht';
    const q = Number(l.quantity);
    if (!Number.isFinite(q) || q <= 0) errors[`lines.${i}.quantity`] = 'Aantal > 0';
    const u = Number(l.unit_price_excl);
    if (!Number.isFinite(u) || u < 0) errors[`lines.${i}.unit_price_excl`] = 'Prijs ≥ 0';
  });
  return errors;
}

// ── API-calls ──────────────────────────────────────────────────────────────

function buildBasePayload(action) {
  return {
    customer_id:  state.customer.id,
    department_id: state.form.department_id,
    lines: goodLines().map((l) => ({
      description:     String(l.description).trim(),
      quantity:        Number(l.quantity),
      unit_price_excl: Number(l.unit_price_excl) || 0,
      vat_percentage:  Number(l.vat_percentage) || 21,
    })),
    purchase_order_number: state.form.purchase_order_number || undefined,
    language: state.form.language,
    action,
  };
}

async function doDraft() {
  if (state.saving) return;
  state.errors = validateForm();
  if (Object.keys(state.errors).length) { state.globalError = 'Formulier onvolledig'; rerender(); return; }
  state.saving = true; state.globalError = null;
  rerender();
  try {
    const r = await K().authedJson('/api/finance-invoice-create', {
      method: 'POST',
      body: JSON.stringify(buildBasePayload('draft')),
    });
    K().toast(`Concept aangemaakt${r?.invoice_number ? ' — ' + r.invoice_number : ''}`);
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || '';
    if (/timeout|network|502|503|504|Failed to fetch/i.test(msg)) {
      state.unknownStatus = true; state.globalError = null;
    } else {
      state.globalError = msg || 'Aanmaken mislukt';
    }
    state.saving = false; rerender();
  }
}

async function doBook() {
  if (state.saving || state.unknownStatus) return;   // in-flight lock
  if (!state.confirmBookChecked) return;
  state.saving = true; state.globalError = null;
  rerender();
  try {
    const r = await K().authedJson('/api/finance-invoice-create', {
      method: 'POST',
      body: JSON.stringify(buildBasePayload('book')),
    });
    if (r?.bookErr) throw new Error('Concept aangemaakt maar boeken faalde: ' + (r.bookErr.error || JSON.stringify(r.bookErr)));
    K().toast(`Factuur geboekt${r?.invoice_number ? ' — ' + r.invoice_number : ''}`);
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || '';
    if (/timeout|network|502|503|504|Failed to fetch/i.test(msg)) {
      state.unknownStatus = true; state.globalError = null;
    } else {
      state.globalError = msg || 'Boeken mislukt';
    }
    state.saving = false; rerender();
  }
}

async function doBookAndSend() {
  if (state.saving || state.unknownStatus) return;
  if (state.typedGateBookSend.trim().toUpperCase() !== TYPE_GATE_TEXT) return;
  if (!state.selectedTemplateId) return;

  state.saving = true; state.globalError = null;
  rerender();

  // 2-step: book + send. Faalt de tweede stap, dan is de factuur al geboekt.
  let bookedInvoiceId = null;
  let bookedInvoiceNumber = null;
  try {
    const r = await K().authedJson('/api/finance-invoice-create', {
      method: 'POST',
      body: JSON.stringify(buildBasePayload('book')),
    });
    if (r?.bookErr) throw new Error('Concept aangemaakt maar boeken faalde: ' + (r.bookErr.error || JSON.stringify(r.bookErr)));
    bookedInvoiceId     = r?.invoice_id || null;
    bookedInvoiceNumber = r?.invoice_number || null;
    if (!bookedInvoiceId) throw new Error('Boeken gelukt maar geen invoice_id ontvangen — controleer in TL');
  } catch (e) {
    const msg = e?.message || '';
    if (/timeout|network|502|503|504|Failed to fetch/i.test(msg)) {
      state.unknownStatus = true; state.globalError = null;
    } else {
      state.globalError = msg || 'Boeken mislukt';
    }
    state.saving = false; rerender();
    return;
  }

  // Stap 2 — send. Factuur bestaat al; failure = graceful degrade naar handmatig.
  try {
    await K().authedJson('/api/finance-invoice-send', {
      method: 'POST',
      body: JSON.stringify({
        invoice_id:       bookedInvoiceId,
        mail_template_id: state.selectedTemplateId,
      }),
    });
    K().toast(`Factuur geboekt en verzonden${bookedInvoiceNumber ? ' — ' + bookedInvoiceNumber : ''}`);
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || 'Verzenden mislukt';
    state.globalError = `Factuur is GEBOEKT (${bookedInvoiceNumber || bookedInvoiceId.slice(0, 8)}) maar verzenden faalde: ${msg}. Sluit deze modal en open de factuur in Facturen-tab → "Verzenden" om alsnog te versturen.`;
    state.saving = false;
    // unknownStatus NIET zetten — factuur bestaat, alleen mail is dubieus.
    // User moet zelf via detail-modal alsnog verzenden.
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-invnew-close], [data-kv-invnew-cancel]').forEach((b) => {
    b.addEventListener('click', () => { if (!state.saving) D().closeModal(); });
  });

  // Overlay-back
  box.querySelector('[data-kv-invnew-overlay-back]')?.addEventListener('click', () => {
    if (state.saving) return;
    state.overlay = null;
    state.confirmBookChecked = false;
    state.typedGateBookSend = '';
    state.globalError = null;
    state.unknownStatus = false;
    rerender();
  });

  // Base form inputs — meta
  box.querySelectorAll('[data-kv-invnew-meta]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      state.form[e.target.name] = e.target.value;
      if (state.errors[e.target.name]) { delete state.errors[e.target.name]; }
    });
    inp.addEventListener('change', (e) => { state.form[e.target.name] = e.target.value; });
  });
  // Base form inputs — line-fields
  box.querySelectorAll('[data-kv-invnew-lf]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = Number(e.target.getAttribute('data-kv-invnew-li'));
      const field = e.target.getAttribute('data-kv-invnew-lf');
      if (!state.form.lines[idx]) return;
      if (field === 'description') state.form.lines[idx][field] = e.target.value;
      else state.form.lines[idx][field] = e.target.value === '' ? '' : Number(e.target.value);
      const errKey = `lines.${idx}.${field}`;
      if (state.errors[errKey]) delete state.errors[errKey];
      rerenderBody();
    });
  });
  box.querySelector('[data-kv-invnew-add]')?.addEventListener('click', () => {
    state.form.lines.push(newRow()); rerenderBody();
  });
  box.querySelectorAll('[data-kv-invnew-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-kv-invnew-del'));
      if (state.form.lines.length <= 1) return;
      state.form.lines.splice(idx, 1);
      state.errors = {};
      rerenderBody();
    });
  });

  // Main-foot actie-knoppen — openen overlay of doDraft (dat één-knop-guard)
  box.querySelectorAll('[data-kv-invnew-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-kv-invnew-act');
      // Valideer altijd eerst — geen overlay openen op onvolledig formulier
      state.errors = validateForm();
      if (Object.keys(state.errors).length) {
        state.globalError = 'Corrigeer eerst de gemarkeerde velden.';
        rerender();
        return;
      }
      state.globalError = null;
      if (act === 'draft') { doDraft(); return; }
      if (act === 'book')  { state.overlay = 'book'; state.confirmBookChecked = false; rerender(); return; }
      if (act === 'bookSend') {
        state.overlay = 'bookSend';
        state.typedGateBookSend = '';
        // Templates lazy laden bij eerste opening van deze overlay
        if (!state.templates.length && !state.templatesLoading && !state.templatesError) {
          loadTemplates();
        }
        rerender();
        return;
      }
    });
  });

  // Overlay book — checkbox + submit
  box.querySelector('[data-kv-invnew-book-check]')?.addEventListener('change', (e) => {
    state.confirmBookChecked = !!e.target.checked;
    rerenderFoot();
  });
  box.querySelector('[data-kv-invnew-book-submit]')?.addEventListener('click', doBook);

  // Overlay bookSend — template + typegate + submit
  box.querySelector('[data-kv-invnew-bs-tpl]')?.addEventListener('change', (e) => {
    state.selectedTemplateId = e.target.value;
    rerenderBody();
  });
  const typeInp = box.querySelector('[data-kv-invnew-bs-typegate]');
  if (typeInp) {
    typeInp.addEventListener('input', (e) => {
      state.typedGateBookSend = e.target.value;
      rerenderFoot();
      // Hint sync — als match-status verandert, body bij
      const wasMatch = state.typedGateBookSend.trim().toUpperCase() === TYPE_GATE_TEXT;
      const hint = box.querySelector('.kv-invcredit-typegate .kv-edit-field-msg');
      const shouldShowHint = state.typedGateBookSend && !wasMatch;
      if (shouldShowHint && !hint) rerenderBody();
      else if (!shouldShowHint && hint) rerenderBody();
    });
    typeInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); typeInp.blur(); }
    });
  }
  box.querySelector('[data-kv-invnew-bs-submit]')?.addEventListener('click', doBookAndSend);
}

// ── Templates laden (lazy voor bookSend overlay) ───────────────────────────

async function loadTemplates() {
  state.templatesLoading = true;
  rerenderBody();
  try {
    const j = await K().authedJson('/api/finance-mail-templates');
    const tpls = Array.isArray(j?.templates) ? j.templates : [];
    state.templates = tpls;
    const def = tpls.find((t) => t.is_default) || tpls[0];
    if (def) state.selectedTemplateId = def.id;
  } catch (e) {
    state.templatesError = e?.message || 'Templates niet geladen';
  } finally {
    state.templatesLoading = false;
    rerenderBody();
  }
}

// ── Micro-render ───────────────────────────────────────────────────────────

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderBody() {
  const bd = document.querySelector('#dfoModalBody');
  const ft = document.querySelector('#dfoModalFoot');
  if (bd) bd.innerHTML = renderBody();
  if (ft) ft.innerHTML = renderFoot();
  wire();
}
function rerenderFoot() {
  const ft = document.querySelector('#dfoModalFoot');
  if (ft) ft.innerHTML = renderFoot();
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openInvoiceCreateModal({ customer, onSuccess })
 */
export function openInvoiceCreateModal({ customer, onSuccess } = {}) {
  if (!customer?.id) { K().toast('Geen klant geselecteerd'); return; }
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar.'); return; }
  initState(customer, { onSuccess });
  rerender();
}
