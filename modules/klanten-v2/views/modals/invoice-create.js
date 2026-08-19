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

// BROK FINANCE-INVOICE (2026-08-19): factuur-niveau BTW-regime.
// Bepaalt tax_rate_id-lookup server-side (taxRateIdFor(vat, dept, saleType)).
// Vereiste envs op productie:
//   - TEAMLEADER_TAX_RATE_ID_INTRA (intracommunautair, 0% btw-verlegd)
//   - TEAMLEADER_TAX_RATE_ID_INTRA_ONLINE / _FYSIEK / _RETENTIE (dept-override, optioneel)
// Zonder INTRA-env → server 500 met "Geen TEAMLEADER_TAX_RATE_ID_INTRA geconfigureerd".
const SALE_TYPE_OPTIONS = [
  { v: 'domestic',           l: 'Binnenland (21% / 9% / 0%)' },
  { v: 'intracommunautair',  l: 'Intracommunautair (0% btw verlegd)' },
];

const TYPE_GATE_TEXT = 'BOEK EN VERZEND';

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(customer, opts) {
  state = {
    customer,                          // {id, first_name, last_name, company_name, email, is_company, tl_contact_id, tl_company_id}
    // BROK FINANCE-INVOICE: als zonder customer geopend → klant-selector.
    needsCustomer: !customer?.id,
    customerSearch: { q: '', loading: false, results: [], error: null },
    form: {
      department_id: ENTITIES[0].id,
      lines: [newRow()],
      purchase_order_number: '',
      language: 'nl',
      sale_type: 'domestic',  // BROK FINANCE-INVOICE: factuur-niveau BTW-regime
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
function newRow() {
  // BROK FINANCE-INVOICE: incl/excl per regel. Default: excl-invoer (huidige
  // gedrag; user typt in "Prijs excl." kolom). Bij typen in "Prijs incl."
  // wordt price_includes_vat=true gezet en unit_price_excl afgeleid uit
  // unit_price_incl / (1 + vat/100). Server neemt de kant die true is.
  return { description: '', quantity: 1, unit_price_excl: 0, unit_price_incl: 0, vat_percentage: 21, price_includes_vat: false };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function customerLabel() {
  const c = state.customer;
  if (!c) return '— kies eerst een klant —';   // BROK FINANCE-INVOICE selector-mode
  // BROK WB-FIX-4 minor: also accept c.name (samengestelde weergave uit
  // ctx.customer / overzicht-rij) zodat wanbetalers-drawer klantnaam
  // netjes toont i.p.v. "Klant"-fallback.
  if (c.is_company) return c.company_name || c.name || 'Bedrijfsklant';
  const composed = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return composed || c.name || 'Klant';
}
// BROK FINANCE-INVOICE: helper voor incl→excl conversie per regel.
function lineExclAmount(l) {
  const q = Number(l.quantity) || 0;
  const v = Number(l.vat_percentage) || 0;
  if (l.price_includes_vat === true) {
    const uIncl = Number(l.unit_price_incl) || 0;
    const uExcl = v > 0 ? (uIncl / (1 + v / 100)) : uIncl;
    return { excl: q * uExcl, vatPct: v };
  }
  const uExcl = Number(l.unit_price_excl) || 0;
  return { excl: q * uExcl, vatPct: v };
}
function computeTotals(lines) {
  let excl = 0, tax = 0;
  for (const l of lines) {
    const { excl: lineExcl, vatPct } = lineExclAmount(l);
    excl += lineExcl;
    tax += lineExcl * (vatPct / 100);
  }
  return { excl, tax, incl: excl + tax };
}
function goodLines() {
  return state.form.lines.filter((l) => String(l.description || '').trim() && Number(l.quantity) > 0);
}

// In-place DOM updates zodat de <input> die de user aan het bewerken is
// niet wordt vernietigd (behoudt focus + caret). Zie wire() line-handler.
function updateLineTotal(idx) {
  const l = state.form.lines[idx];
  if (!l) return;
  // BROK FINANCE-INVOICE: regel-totaal = qty * unit_excl (voor 'Regel-totaal'-
  // kolom die "excl" toont). tfoot toont subtotaal + BTW + incl.
  const { excl } = lineExclAmount(l);
  const cell = document.querySelector(`[data-kv-invnew-row-total="${idx}"]`);
  if (cell) cell.textContent = fmtEur(excl);
}
function updateFootTotals() {
  const totals = computeTotals(state.form.lines);
  const eEx = document.querySelector('[data-kv-invnew-total="excl"]');
  const eTx = document.querySelector('[data-kv-invnew-total="tax"]');
  const eIn = document.querySelector('[data-kv-invnew-total="incl"]');
  if (eEx) eEx.innerHTML = `<strong>${K().esc(fmtEur(totals.excl))}</strong>`;
  if (eTx) eTx.textContent = fmtEur(totals.tax);
  if (eIn) eIn.innerHTML = `<strong>${K().esc(fmtEur(totals.incl))}</strong>`;
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
        <input type="number" class="kv-invupd-inp kv-invupd-inp-num" data-kv-invnew-lf="unit_price_excl" data-kv-invnew-li="${idx}" value="${esc(String(l.unit_price_excl))}" min="0" step="0.01" inputmode="decimal" title="Prijs exclusief BTW (bewerken zet regel op excl-modus)" />
        ${errKeyPri ? `<div class="kv-edit-field-msg">${esc(errKeyPri)}</div>` : ''}
      </td>
      <td class="r">
        <input type="number" class="kv-invupd-inp kv-invupd-inp-num" data-kv-invnew-lf="unit_price_incl" data-kv-invnew-li="${idx}" value="${esc(String(l.unit_price_incl))}" min="0" step="0.01" inputmode="decimal" title="Prijs inclusief BTW (bewerken zet regel op incl-modus)" />
      </td>
      <td class="r">
        <select class="kv-invupd-inp kv-invupd-inp-vat" data-kv-invnew-lf="vat_percentage" data-kv-invnew-li="${idx}">
          ${VAT_OPTIONS.map((v) => `<option value="${v}" ${Number(l.vat_percentage) === v ? 'selected' : ''}>${v}%</option>`).join('')}
        </select>
      </td>
      <td class="r mono" data-kv-invnew-row-total="${idx}">${esc(fmtEur(total))}</td>
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
          <th class="r" style="width:80px">Aantal</th>
          <th class="r" style="width:110px">Prijs excl.</th>
          <th class="r" style="width:110px">Prijs incl.</th>
          <th class="r" style="width:80px">BTW</th>
          <th class="r" style="width:110px">Regel excl.</th>
          <th class="r" style="width:44px"></th>
        </tr></thead>
        <tbody>${state.form.lines.map((l, i) => renderLineRow(l, i)).join('')}</tbody>
        <tfoot>
          <tr><td colspan="5" class="r"><strong>Subtotaal (excl.)</strong></td><td class="r mono" data-kv-invnew-total="excl"><strong>${esc(fmtEur(totals.excl))}</strong></td><td></td></tr>
          <tr><td colspan="5" class="r">BTW</td><td class="r mono" data-kv-invnew-total="tax">${esc(fmtEur(totals.tax))}</td><td></td></tr>
          <tr><td colspan="5" class="r"><strong>Totaal (incl. BTW)</strong></td><td class="r mono" data-kv-invnew-total="incl"><strong>${esc(fmtEur(totals.incl))}</strong></td><td></td></tr>
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

      <div class="kv-edit-section-h">BTW-regime + meta</div>
      <div class="kv-edit-grid">
        <div class="kv-edit-field">
          <label for="kv-invnew-saletype">BTW-regime</label>
          <select id="kv-invnew-saletype" name="sale_type" data-kv-invnew-meta title="Kies 'Intracommunautair' voor B2B binnen EU met geldig VAT-nummer">
            ${SALE_TYPE_OPTIONS.map((o) => `<option value="${o.v}" ${state.form.sale_type === o.v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}
          </select>
        </div>
        <div class="kv-edit-field">
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

// BROK FINANCE-INVOICE (2026-08-19): klant-selector als modal opent zonder
// customer (bv. vanuit Finance-tab "+ Nieuwe factuur" of snelknop).
// Gebruikt bestaand /api/inbox-customer-search endpoint (RBAC: finance/
// events/onboarding-send OR). Selectie → state.customer + needsCustomer=false
// + rerender. Voorkomt duplicatie tussen Finance-tab en klant-detail modals.
function renderCustomerSelector() {
  const cs = state.customerSearch;
  const results = cs.results || [];
  return `
    <div class="kv-edit-form">
      <div class="kv-edit-section-h">Kies een klant</div>
      <div class="kv-edit-field kv-edit-field-full">
        <label for="kv-invnew-custq">Zoek op naam / e-mail / bedrijf</label>
        <input id="kv-invnew-custq" type="text" value="${esc(cs.q || '')}"
               data-kv-invnew-custq placeholder="Minimaal 2 tekens…" autocomplete="off" autofocus />
      </div>
      <div id="kv-invnew-custresults" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)">
        ${cs.loading ? '<div style="padding:14px;color:var(--text-3);font-size:12.5px">Zoeken…</div>'
          : cs.error ? `<div style="padding:14px;color:var(--rose);font-size:12.5px">⚠ ${esc(cs.error)}</div>`
          : !cs.q || cs.q.trim().length < 2 ? '<div style="padding:14px;color:var(--text-3);font-size:12.5px">Typ minimaal 2 tekens.</div>'
          : !results.length ? '<div style="padding:14px;color:var(--text-3);font-size:12.5px">Geen klanten gevonden.</div>'
          : results.map((r) => {
              const name = r.is_company ? (r.name || r.company_name || 'Bedrijf') : (r.name || '(onbekend)');
              return `<div data-kv-invnew-custpick="${esc(r.id)}" style="padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12.5px" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
                <div style="font-weight:500">${esc(name)}${r.is_company ? ' <span style="font-size:10px;color:var(--text-3)">· bedrijf</span>' : ''}</div>
                <div style="font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(r.email || '(geen e-mail)')}${r.phone ? ' · ' + esc(r.phone) : ''}</div>
              </div>`;
            }).join('')}
      </div>
    </div>`;
}

function renderBody() {
  // BROK FINANCE-INVOICE: klant-selector-view als opened zonder customer.
  if (state.needsCustomer) return renderCustomerSelector();
  const base = renderForm();
  if (state.overlay === 'book')     return base + renderOverlayBook();
  if (state.overlay === 'bookSend') return base + renderOverlayBookSend();
  return base;
}

// ── Foot ───────────────────────────────────────────────────────────────────

function renderFootMain() {
  // BROK FINANCE-INVOICE (2026-08-19): "Concept opslaan" verwijderd —
  // was verwarrend (concept moest je toch nog boeken/versturen). Nu 2
  // knoppen: "Direct boeken" (2-klik guard) + "Boeken + verzenden"
  // (type-gate). Beide onomkeerbaar (creditnota is enige undo).
  return `
    <div class="kv-edit-foot kv-invnew-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invnew-cancel>Annuleren</button>
      <div class="kv-invnew-foot-actions">
        <button type="button" class="ds-btn" data-kv-invnew-act="book">Direct boeken</button>
        <button type="button" class="ds-btn ds-btn-primary kv-invnew-btn-danger-soft" data-kv-invnew-act="bookSend">Boeken + verzenden</button>
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
  // BROK FINANCE-INVOICE: selector-mode heeft alleen Annuleren.
  if (state.needsCustomer) return `
    <div class="kv-edit-foot kv-invnew-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invnew-cancel>Annuleren</button>
    </div>`;
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
    // BROK FINANCE-INVOICE: sale_type meesturen (default 'domestic'
    // → backward-compat). Endpoint routet 'intracommunautair' naar
    // taxRateIdFor met INTRA-envs (server vereiste: TEAMLEADER_TAX_RATE_ID_INTRA).
    sale_type: state.form.sale_type || 'domestic',
    lines: goodLines().map((l) => ({
      description:     String(l.description).trim(),
      quantity:        Number(l.quantity),
      // BROK FINANCE-INVOICE: incl/excl per regel. Server neemt de zijde
      // die matched met price_includes_vat en zet TL unit_price.tax
      // ('including' of 'excluding') zodat TL zelf narekent — geen
      // sub-cent-drift tussen client-berekening en TL-narekening.
      unit_price_excl: Number(l.unit_price_excl) || 0,
      unit_price_incl: Number(l.unit_price_incl) || 0,
      price_includes_vat: l.price_includes_vat === true,
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

// BROK SALES-2 (v=2, 2026-08-19): idempotente bindOnce.
// FIX: freeze bij TYPEN in "BOEK EN VERZEND" type-gate. rerenderFoot()
// vervangt alleen #dfoModalFoot; type-gate zit in body → body-nodes
// blijven bestaan → wire()'s addEventListener stapelde 2^N listeners op
// (exponential explosion, freeze bij ~14 keystrokes = 2^13 = 8192
// listeners). bindOnce markeert node[__kvBound_<evt>]=true zodat ze
// niet 2× gebind worden.
function bindOnce(node, evt, handler) {
  if (!node) return;
  const k = '__kvBound_' + evt;
  if (node[k]) return;
  node[k] = true;
  node.addEventListener(evt, handler);
}

// BROK FINANCE-INVOICE: surgical repaint van klant-selector results
// zodat de zoek-input z'n focus behoudt bij elke keystroke.
function _repaintCustResults() {
  const el = document.getElementById('kv-invnew-custresults');
  if (!el) return;
  // Bouw de results-div HTML opnieuw uit renderCustomerSelector.
  const wrap = document.createElement('div');
  wrap.innerHTML = renderCustomerSelector();
  const fresh = wrap.querySelector('#kv-invnew-custresults');
  if (!fresh) return;
  el.innerHTML = fresh.innerHTML;
  // Rewire click-handlers op de nieuwe rijen.
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-invnew-custpick]').forEach((it) => {
    // bindOnce is idempotent
    bindOnce(it, 'click', async () => {
      const id = it.getAttribute('data-kv-invnew-custpick');
      const picked = (state.customerSearch.results || []).find((r) => String(r.id) === String(id));
      if (!picked) return;
      state.customer = {
        id: picked.id, email: picked.email || null,
        is_company: !!picked.is_company,
        company_name: picked.is_company ? (picked.name || picked.company_name) : null,
        first_name: !picked.is_company ? (picked.name || '').split(' ')[0] : null,
        last_name:  !picked.is_company ? (picked.name || '').split(' ').slice(1).join(' ') : null,
      };
      state.needsCustomer = false;
      state.customerSearch = { q: '', loading: false, results: [], error: null };
      rerender();
    });
  });
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-invnew-close], [data-kv-invnew-cancel]').forEach((b) => {
    bindOnce(b, 'click', () => { if (!state.saving) D().closeModal(); });
  });

  // BROK FINANCE-INVOICE (2026-08-19): klant-selector inputs
  const custQ = box.querySelector('[data-kv-invnew-custq]');
  if (custQ) {
    bindOnce(custQ, 'input', (e) => {
      state.customerSearch.q = e.target.value;
      state.customerSearch.error = null;
      if (state._custTimer) clearTimeout(state._custTimer);
      state._custTimer = setTimeout(async () => {
        const q = (state.customerSearch.q || '').trim();
        if (q.length < 2) {
          state.customerSearch.results = [];
          _repaintCustResults();
          return;
        }
        state.customerSearch.loading = true;
        _repaintCustResults();
        try {
          const j = await K().authedJson('/api/inbox-customer-search?q=' + encodeURIComponent(q) + '&limit=25');
          state.customerSearch.results = Array.isArray(j?.results) ? j.results : [];
        } catch (e) {
          state.customerSearch.error = e?.message || 'Zoeken mislukt';
          state.customerSearch.results = [];
        } finally {
          state.customerSearch.loading = false;
          _repaintCustResults();
        }
      }, 220);
    });
  }
  box.querySelectorAll('[data-kv-invnew-custpick]').forEach((el) => {
    bindOnce(el, 'click', async () => {
      const id = el.getAttribute('data-kv-invnew-custpick');
      const picked = (state.customerSearch.results || []).find((r) => String(r.id) === String(id));
      if (!picked) return;
      // Zet compact customer-obj; overige velden worden server-side gefetched
      // in api/finance-invoice-create (het select't customer volledig via id).
      state.customer = {
        id: picked.id,
        email: picked.email || null,
        is_company: !!picked.is_company,
        company_name: picked.is_company ? (picked.name || picked.company_name) : null,
        first_name: !picked.is_company ? (picked.name || '').split(' ')[0] : null,
        last_name:  !picked.is_company ? (picked.name || '').split(' ').slice(1).join(' ') : null,
      };
      state.needsCustomer = false;
      state.customerSearch = { q: '', loading: false, results: [], error: null };
      rerender();
    });
  });

  // Overlay-back
  bindOnce(box.querySelector('[data-kv-invnew-overlay-back]'), 'click', () => {
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
    bindOnce(inp, 'input', (e) => {
      state.form[e.target.name] = e.target.value;
      if (state.errors[e.target.name]) { delete state.errors[e.target.name]; }
    });
    bindOnce(inp, 'change', (e) => { state.form[e.target.name] = e.target.value; });
  });
  // Base form inputs — line-fields.
  // KRITIEK: NIET rerenderBody() bij typen. Dat vernietigt het <input>
  // element en de cursor verliest focus → user kan maar 1 char per keer
  // typen (bug pre-1d8). Update state + doe alleen surgical DOM-updates
  // op de cellen die daadwerkelijk veranderen (regel-totaal + tfoot).
  box.querySelectorAll('[data-kv-invnew-lf]').forEach((inp) => {
    const handler = (e) => {
      const idx = Number(e.target.getAttribute('data-kv-invnew-li'));
      const field = e.target.getAttribute('data-kv-invnew-lf');
      const line = state.form.lines[idx];
      if (!line) return;
      if (field === 'description') {
        line[field] = e.target.value;
      } else {
        line[field] = e.target.value === '' ? '' : Number(e.target.value);
      }
      // BROK FINANCE-INVOICE: incl/excl-sync per regel.
      // - Typ in "Prijs excl." → price_includes_vat=false, unit_price_incl = excl * (1 + vat/100)
      // - Typ in "Prijs incl." → price_includes_vat=true,  unit_price_excl = incl / (1 + vat/100)
      // - Wissel BTW% → herbereken de "andere" op basis van huidige modus.
      const vat = Number(line.vat_percentage) || 0;
      const factor = 1 + vat / 100;
      if (field === 'unit_price_excl') {
        line.price_includes_vat = false;
        line.unit_price_incl = Math.round((Number(line.unit_price_excl) || 0) * factor * 100) / 100;
        const otherInp = document.querySelector(`[data-kv-invnew-lf="unit_price_incl"][data-kv-invnew-li="${idx}"]`);
        if (otherInp && document.activeElement !== otherInp) otherInp.value = String(line.unit_price_incl);
      } else if (field === 'unit_price_incl') {
        line.price_includes_vat = true;
        line.unit_price_excl = factor > 0 ? Math.round((Number(line.unit_price_incl) || 0) / factor * 100) / 100 : 0;
        const otherInp = document.querySelector(`[data-kv-invnew-lf="unit_price_excl"][data-kv-invnew-li="${idx}"]`);
        if (otherInp && document.activeElement !== otherInp) otherInp.value = String(line.unit_price_excl);
      } else if (field === 'vat_percentage') {
        // Herbereken op basis van huidige modus.
        if (line.price_includes_vat === true) {
          line.unit_price_excl = factor > 0 ? Math.round((Number(line.unit_price_incl) || 0) / factor * 100) / 100 : 0;
          const otherInp = document.querySelector(`[data-kv-invnew-lf="unit_price_excl"][data-kv-invnew-li="${idx}"]`);
          if (otherInp) otherInp.value = String(line.unit_price_excl);
        } else {
          line.unit_price_incl = Math.round((Number(line.unit_price_excl) || 0) * factor * 100) / 100;
          const otherInp = document.querySelector(`[data-kv-invnew-lf="unit_price_incl"][data-kv-invnew-li="${idx}"]`);
          if (otherInp) otherInp.value = String(line.unit_price_incl);
        }
      }
      // Error surgical wissen (msg-div is next-sibling van de input)
      const errKey = `lines.${idx}.${field}`;
      if (state.errors[errKey]) {
        delete state.errors[errKey];
        const td = e.target.closest('td');
        td?.querySelector('.kv-edit-field-msg')?.remove();
      }
      // Description raakt totalen niet — alleen state-update, klaar.
      if (field === 'description') return;
      // Numeriek/VAT — regel-totaal + tfoot totalen bijwerken in-place.
      updateLineTotal(idx);
      updateFootTotals();
    };
    // Numerieke inputs vuren 'input' events; <select> vuurt 'change'. Beide binden.
    bindOnce(inp, 'input', handler);
    bindOnce(inp, 'change', handler);
  });
  bindOnce(box.querySelector('[data-kv-invnew-add]'), 'click', () => {
    state.form.lines.push(newRow()); rerenderBody();
  });
  box.querySelectorAll('[data-kv-invnew-del]').forEach((btn) => {
    bindOnce(btn, 'click', () => {
      const idx = Number(btn.getAttribute('data-kv-invnew-del'));
      if (state.form.lines.length <= 1) return;
      state.form.lines.splice(idx, 1);
      state.errors = {};
      rerenderBody();
    });
  });

  // Main-foot actie-knoppen — openen overlay of doDraft (dat één-knop-guard)
  box.querySelectorAll('[data-kv-invnew-act]').forEach((btn) => {
    bindOnce(btn, 'click', () => {
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
  bindOnce(box.querySelector('[data-kv-invnew-book-check]'), 'change', (e) => {
    state.confirmBookChecked = !!e.target.checked;
    rerenderFoot();
  });
  bindOnce(box.querySelector('[data-kv-invnew-book-submit]'), 'click', doBook);

  // Overlay bookSend — template + typegate + submit
  bindOnce(box.querySelector('[data-kv-invnew-bs-tpl]'), 'change', (e) => {
    state.selectedTemplateId = e.target.value;
    rerenderBody();
  });
  const typeInp = box.querySelector('[data-kv-invnew-bs-typegate]');
  if (typeInp) {
    bindOnce(typeInp, 'input', (e) => {
      state.typedGateBookSend = e.target.value;
      // BROK FINANCE-INVOICE-2 (v=4): surgical DOM-updates i.p.v.
      // rerenderBody/rerenderFoot bij elke keystroke. Voorheen: match-flip
      // triggerde volledige body-rerender → input-node vervangen → focus
      // weg midden in het typen. Nu: alleen (a) fout-hint toggle in de
      // typegate-container en (b) submit-knop disabled-flag. Zelfde
      // patroon als inbox-zoek + case-sheet callback-err fix.
      const val = state.typedGateBookSend.trim().toUpperCase();
      const isMatch = val === TYPE_GATE_TEXT;
      const gate = box.querySelector('.kv-invcredit-typegate');
      if (gate) {
        const hint = gate.querySelector('.kv-edit-field-msg');
        const shouldShow = state.typedGateBookSend && !isMatch;
        if (shouldShow && !hint) {
          const div = document.createElement('div');
          div.className = 'kv-edit-field-msg';
          div.textContent = 'Komt niet overeen';
          gate.appendChild(div);
        } else if (!shouldShow && hint) {
          hint.remove();
        }
      }
      // Submit-knop enable/disable + label — surgical, geen render.
      const submitBtn = box.querySelector('[data-kv-invnew-bs-submit]');
      if (submitBtn) {
        const canSubmit = isMatch && state.selectedTemplateId && !state.saving && !state.unknownStatus;
        submitBtn.disabled = !canSubmit;
        submitBtn.style.opacity = canSubmit ? '' : '.55';
        submitBtn.style.cursor  = canSubmit ? 'pointer' : 'not-allowed';
      }
    });
    bindOnce(typeInp, 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); typeInp.blur(); }
    });
  }
  bindOnce(box.querySelector('[data-kv-invnew-bs-submit]'), 'click', doBookAndSend);
}

// ── Templates laden (lazy voor bookSend overlay) ───────────────────────────

async function loadTemplates() {
  state.templatesLoading = true;
  rerenderBody();
  try {
    const j = await K().authedJson('/api/finance-mail-templates');
    const tpls = Array.isArray(j?.templates) ? j.templates : [];
    state.templates = tpls;
    // BROK FINANCE-INVOICE-2 (v=4, 2026-08-19): default expliciet FACTUUR-template
    // + downrank "herinnering/reminder" zodat die NOOIT preselect wordt.
    // Volgorde: (1) name/subject bevat 'factuur' of 'invoice' EN NIET
    // 'herinnering'/'reminder' → gepakt. (2) is_default van TL, mits geen
    // herinnering. (3) eerste NIET-herinnering. (4) laatste fallback tpls[0].
    const isReminder = (t) => {
      const s = ((t.name || '') + ' ' + (t.subject || '')).toLowerCase();
      return /herinner|reminder|aanmaning|sommatie|ingebrek/.test(s);
    };
    const looksInvoice = (t) => {
      const s = ((t.name || '') + ' ' + (t.subject || '')).toLowerCase();
      return (s.includes('factuur') || s.includes('invoice')) && !isReminder(t);
    };
    const def = tpls.find(looksInvoice)
             || tpls.find((t) => t.is_default && !isReminder(t))
             || tpls.find((t) => !isReminder(t))
             || tpls[0];
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
 * BROK FINANCE-INVOICE-2 (v=4, 2026-08-19): oude early-return op ontbrekende
 * customer is weggehaald. Zonder customer opent modal in selector-mode
 * (needsCustomer=true → renderCustomerSelector) zodat "+ Nieuwe factuur"
 * vanuit Finance-tab/topbar-snelknop de klant-typeahead toont.
 */
export function openInvoiceCreateModal({ customer, onSuccess } = {}) {
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar.'); return; }
  initState(customer || null, { onSuccess });
  rerender();
}
