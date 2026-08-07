// modules/klanten-v2/views/modals/invoice-credit.js
//
// Factuur-crediteren-modal (PR-D5, vijfde van de 6 factuur-modals).
//
// KRITIEK: creditnota is onomkeerbaar in boekhouding. Krijgt eigen
// nummer, gaat naar Rogier / e-boekhouden. "Uncrediteren" bestaat
// niet — alleen tegengeboekt via nieuwe factuur.
//
// Endpoint: POST /api/finance-invoice-credit
// Body: { invoice_id, description? }  — FULL-CREDIT ONLY.
//
// Ontwerp-wijziging op review: "Deels crediteren"-optie geschrapt.
// Het endpoint is full-credit-only ({invoice_id, description?}) —
// een deel-bedrag-veld tonen dat de backend negeert = gevaarlijke
// mismatch. Alleen volledig crediteren beschikbaar. Deel-crediteren
// = aparte backend-scope, niet nu.
//
// Twee-staps flow:
//   Stap 1 = type=FULL (vast) + reden (verplicht) + waarschuwing
//            over eventuele bestaande deelbetaling
//   Stap 2 = rode banner + recap + directe bevestig-knop
//
// Ontwerp-wijziging 1d8: typ-factuurnummer-gate uit stap 2 gehaald.
// Guard-stack is nu: amber-warning stap 1 + rode danger-banner stap 2
// + in-flight lock + no-auto-retry. De typ-gate voegde geen extra
// veiligheid toe boven de expliciete 2-staps klik + in-flight lock;
// de UX-friction was groter dan de defensieve winst.
//
// Guards:
//   - Enter in stap 1 -> volgende
//   - Rode knop in stap 2 direct actief (geen typeveld meer)
//   - In-flight lock: klik disablet + spinner, verdere klikken
//     genegeerd. Bij timeout -> "status onbekend, check in TL"
//     zonder auto-retry (endpoint niet idempotent).
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

const REASON_OPTIONS = [
  { v: 'klachtafhandeling',  l: 'Klachtafhandeling' },
  { v: 'verkeerde_factuur',  l: 'Verkeerde factuur' },
  { v: 'deal_cancellation',  l: 'Deal-cancellation' },
  { v: 'anders',             l: 'Anders (specificeer)' },
];

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(invoice, opts) {
  state = {
    invoiceId: invoice?.id || null,
    invoice,
    step: 1,
    form: {
      reason_key:   '',
      reason_text:  '',
    },
    errors: {},
    globalError: null,
    saving: false,
    unknownStatus: false,
    onSuccess: opts?.onSuccess || null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hasPartialPayment() {
  return Number(state.invoice?.amount_paid || state.invoice?.paid_amount || 0) > 0;
}
function paidAmount() {
  return Number(state.invoice?.amount_paid || state.invoice?.paid_amount || 0);
}
function fullDescription() {
  const key = state.form.reason_key;
  const label = REASON_OPTIONS.find((r) => r.v === key)?.l || '';
  const txt = String(state.form.reason_text || '').trim();
  if (key === 'anders') return txt;
  if (txt) return `${label} — ${txt}`;
  return label;
}

// ── Head ───────────────────────────────────────────────────────────────────

function renderHead() {
  const nr = state.invoice?.invoice_number || (state.invoiceId ? '#' + String(state.invoiceId).slice(0, 8) : '—');
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Factuur crediteren ${state.step === 2 ? '· stap 2 van 2' : '· stap 1 van 2'}</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          <span class="mono">${esc(nr)}</span>
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-invcredit-close aria-label="Sluiten" ${state.saving ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

// ── Stap 1 ─────────────────────────────────────────────────────────────────

function renderStep1() {
  const total = Number(state.invoice?.amount_total) || 0;
  const eReason = state.errors.reason;
  return `
    <form id="kv-invcredit-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-invsend-notice kv-invcredit-notice-warn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <div>
          <div class="kv-invsend-notice-t"><strong>Crediteren maakt een creditnota in TeamLeader.</strong></div>
          <div class="kv-invsend-notice-s">Deze verschijnt in de boekhouding en kan niet worden verwijderd — alleen tegengeboekt met een nieuwe factuur.</div>
        </div>
      </div>

      <div class="kv-invcredit-type">
        <div class="kv-invcredit-type-l">Type</div>
        <div class="kv-invcredit-type-v">
          <span class="ds-pill ds-pill-neutral">Volledig crediteren</span>
          <div class="kv-edit-hint kv-invcredit-type-hint">
            Deel-crediteren is nog niet ondersteund in de backend — kies deze modal alleen voor volledig terugboeken van ${esc(fmtEur(total))}.
          </div>
        </div>
      </div>

      ${hasPartialPayment() ? `
        <div class="kv-invcredit-warn-partial">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <div>
            <strong>⚠ Deelbetaling aanwezig: ${esc(fmtEur(paidAmount()))} ontvangen.</strong>
            Deze blijft in TeamLeader staan als vooruitbetaling nadat je crediteert. Overweeg handmatig terug te storten aan de klant.
          </div>
        </div>
      ` : ''}

      <div class="kv-edit-grid">
        <div class="kv-edit-field kv-edit-field-full ${eReason ? 'kv-edit-field-error' : ''}">
          <label for="kv-invcredit-reason">Reden <span class="kv-edit-req">*</span></label>
          <select id="kv-invcredit-reason" name="reason_key" data-kv-invcredit-input>
            <option value="">— Kies een reden —</option>
            ${REASON_OPTIONS.map((r) => `<option value="${r.v}" ${state.form.reason_key === r.v ? 'selected' : ''}>${esc(r.l)}</option>`).join('')}
          </select>
          ${eReason ? `<div class="kv-edit-field-msg">${esc(eReason)}</div>` : ''}
        </div>
        <div class="kv-edit-field kv-edit-field-full">
          <label for="kv-invcredit-text">
            ${state.form.reason_key === 'anders' ? 'Toelichting (verplicht, min. 10 tekens)' : 'Toelichting (optioneel)'}
          </label>
          <textarea id="kv-invcredit-text" name="reason_text" rows="3" data-kv-invcredit-input placeholder="Wordt meegestuurd in de audit-log en zichtbaar op de creditnota-omschrijving.">${esc(state.form.reason_text)}</textarea>
        </div>
      </div>
    </form>`;
}

function renderStep1Foot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invcredit-cancel>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-invcredit-next>
        Volgende: bevestigen →
      </button>
    </div>`;
}

// ── Stap 2 — Typ-factuurnummer-bevestiging ────────────────────────────────

function renderStep2() {
  const nr    = state.invoice?.invoice_number || '';
  const total = fmtEur(state.invoice?.amount_total);
  const desc  = fullDescription();
  return `
    <div class="kv-edit-form">
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
      ${state.unknownStatus ? `
        <div class="kv-edit-banner kv-invsend-banner-unknown">
          <strong>Status onbekend.</strong> Controleer eerst in TeamLeader of de creditnota is aangemaakt voordat je opnieuw probeert.
        </div>` : ''}

      <div class="kv-invsend-notice kv-invsend-notice-danger">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          <div class="kv-invsend-notice-t"><strong>Onomkeerbaar:</strong> creditnota voor <span class="mono">${esc(nr)}</span> van <span class="mono">${esc(total)}</span> wordt aangemaakt in TeamLeader.</div>
          <div class="kv-invsend-notice-s">Boekhouding krijgt deze automatisch binnen. Undo bestaat niet.</div>
        </div>
      </div>

      <div class="kv-invsend-recap">
        <div class="kv-invsend-recap-row"><span>Factuurnummer</span><span class="mono">${esc(nr || '—')}</span></div>
        <div class="kv-invsend-recap-row"><span>Oorspronkelijk bedrag</span><span class="mono">${esc(total)}</span></div>
        <div class="kv-invsend-recap-row"><span>Reden</span><span>${esc(desc || '—')}</span></div>
        ${hasPartialPayment() ? `<div class="kv-invsend-recap-row"><span>⚠ Deelbetaling</span><span class="mono">${esc(fmtEur(paidAmount()))} (blijft als vooruitbetaling)</span></div>` : ''}
      </div>
    </div>`;
}

function renderStep2Foot() {
  const canSubmit = !state.saving && !state.unknownStatus;
  return `
    <div class="kv-edit-foot kv-invsend-foot-danger">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invcredit-back ${state.saving ? 'disabled' : ''}>← Terug</button>
      <button type="button" class="ds-btn ds-btn-danger" data-kv-invcredit-submit
              ${canSubmit ? '' : 'disabled'} aria-busy="${state.saving ? 'true' : 'false'}">
        ${state.saving ? '<span class="kv-inv-spinner"></span> Aanmaken…' : 'Creditnota aanmaken'}
      </button>
    </div>`;
}

// ── Wrappers ───────────────────────────────────────────────────────────────

function renderBody() { return state.step === 2 ? renderStep2() : renderStep1(); }
function renderFoot() { return state.step === 2 ? renderStep2Foot() : renderStep1Foot(); }

// ── Validatie ──────────────────────────────────────────────────────────────

function validateStep1() {
  const errors = {};
  const key = state.form.reason_key;
  const txt = String(state.form.reason_text || '').trim();
  if (!key) errors.reason = 'Kies een reden';
  else if (key === 'anders' && txt.length < 10) errors.reason = 'Bij "Anders": geef een toelichting van minimaal 10 tekens';
  return errors;
}

// ── Submit ─────────────────────────────────────────────────────────────────

async function doSubmit() {
  if (state.saving || state.unknownStatus) return;   // in-flight lock

  state.saving = true;
  state.globalError = null;
  rerender();

  const body = { invoice_id: state.invoiceId };
  const desc = fullDescription();
  if (desc) body.description = desc;

  try {
    await K().authedJson('/api/finance-invoice-credit', { method: 'POST', body: JSON.stringify(body) });
    K().toast('Creditnota aangemaakt in TeamLeader');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || '';
    if (/timeout|network|502|503|504|Failed to fetch/i.test(msg)) {
      state.unknownStatus = true;
      state.globalError = null;
    } else {
      state.globalError = msg || 'Crediteren mislukt';
    }
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-invcredit-close], [data-kv-invcredit-cancel]').forEach((b) => {
    b.addEventListener('click', () => { if (!state.saving) D().closeModal(); });
  });

  if (state.step === 1) {
    box.querySelectorAll('[data-kv-invcredit-input]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        state.form[e.target.name] = e.target.value;
        if (state.errors.reason) { delete state.errors.reason; }
        if (e.target.name === 'reason_key') rerenderBody();
      });
    });
    box.querySelector('#kv-invcredit-form')?.addEventListener('submit', (e) => { e.preventDefault(); goNext(); });
    box.querySelector('[data-kv-invcredit-next]')?.addEventListener('click', goNext);
  } else {
    box.querySelector('[data-kv-invcredit-back]')?.addEventListener('click', () => {
      if (state.saving) return;
      state.step = 1; state.unknownStatus = false;
      rerender();
    });
    box.querySelector('[data-kv-invcredit-submit]')?.addEventListener('click', doSubmit);
  }
}

function goNext() {
  state.errors = validateStep1();
  if (Object.keys(state.errors).length) { rerender(); return; }
  state.step = 2;
  rerender();
}

// ── Micro-render ───────────────────────────────────────────────────────────

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderBody() {
  const el = document.querySelector('#dfoModalBody');
  const ft = document.querySelector('#dfoModalFoot');
  if (el) el.innerHTML = renderBody();
  if (ft) ft.innerHTML = renderFoot();
  wire();
}
function rerenderFoot() {
  const ft = document.querySelector('#dfoModalFoot');
  if (ft) ft.innerHTML = renderFoot();
  ft?.querySelector('[data-kv-invcredit-submit]')?.addEventListener('click', doSubmit);
  ft?.querySelector('[data-kv-invcredit-back]')?.addEventListener('click', () => {
    if (state.saving) return;
    state.step = 1; state.unknownStatus = false;
    rerender();
  });
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openInvoiceCreditModal({ invoice, onSuccess })
 */
export function openInvoiceCreditModal({ invoice, onSuccess } = {}) {
  if (!invoice?.id) { K().toast('Geen factuur om te crediteren'); return; }
  const st = invoice.display_status || invoice.status;
  if (st === 'concept' || st === 'draft') { K().toast('Conceptfacturen kunnen niet worden gecrediteerd.'); return; }
  if (st === 'credited') { K().toast('Deze factuur is al volledig gecrediteerd.'); return; }
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar.'); return; }
  initState(invoice, { onSuccess });
  rerender();
}
