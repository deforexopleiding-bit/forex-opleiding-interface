// modules/klanten-v2/views/modals/invoice-payment.js
//
// Factuur-betaling-modal (PR-D3, derde van de 6 factuur-modals).
//
// KRITIEK: Dit is een HANDMATIGE boeking — GEEN Mollie-charge.
// De modal registreert dat de klant al betaald heeft (bank, kas,
// PayPal, wat dan ook) en synchroniseert dat naar TeamLeader.
// Er wordt niets bij de klant afgeschreven, geen betaal-verzoek
// gestuurd, geen mail. De UI benadrukt dit expliciet in een banner.
//
// Endpoint: POST /api/finance-invoice-register-payment
// Body: { invoice_id, amount, paid_at (YYYY-MM-DD), payment_method_id? }
// Server maakt payment-rij met source='manual' + syncbackt naar TL.
//
// UNDO-PAD (niet in deze modal, maar in de dossier-audit):
// POST /api/finance-invoice-remove-payment kan een individuele
// registratie ongedaan maken. Zie PR-oplevering voor context.
//
// Externe side-effects:
// - TeamLeader /invoicePayments.add wordt gecalled → onomkeerbaar
//   in TL-audit-log (undo genereert een reverse-entry, geen delete).
// - Geen mail, geen betaal-verzoek, geen Mollie.
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function computeOpenAmount(inv) {
  const total = Number(inv?.amount_total) || 0;
  const paid  = Number(inv?.amount_paid) || Number(inv?.paid_amount) || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(invoice, opts) {
  const openAmt = computeOpenAmount(invoice);
  state = {
    invoiceId: invoice?.id || null,
    invoice,
    openAmount: openAmt,
    form: {
      amount:  openAmt.toFixed(2),   // default = openstaand bedrag
      paid_at: todayIso(),           // default = vandaag
    },
    errors: {},
    globalError: null,
    saving: false,
    onSuccess: opts?.onSuccess || null,
  };
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderHead() {
  const nr = state.invoice?.invoice_number || (state.invoiceId ? '#' + String(state.invoiceId).slice(0, 8) : '—');
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Betaling boeken</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          <span class="mono">${esc(nr)}</span>
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-invpay-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderBody() {
  const eAmt  = state.errors.amount;
  const eDate = state.errors.paid_at;
  return `
    <form id="kv-invpay-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-invpay-notice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <div>
          <div class="kv-invpay-notice-t"><strong>Handmatige boeking — géén Mollie-charge.</strong></div>
          <div class="kv-invpay-notice-s">
            Registreer dat de klant al betaald heeft (bank, kas, PayPal, …).
            Er wordt niks bij de klant afgeschreven en er gaat geen mail uit.
            Deze boeking wordt gesynchroniseerd met TeamLeader.
          </div>
        </div>
      </div>

      <div class="kv-invpay-open">
        <div class="kv-invpay-open-l">Openstaand op deze factuur:</div>
        <div class="kv-invpay-open-v mono">${esc(fmtEur(state.openAmount))}</div>
      </div>

      <div class="kv-edit-grid">
        <div class="kv-edit-field ${eAmt ? 'kv-edit-field-error' : ''}">
          <label for="kv-invpay-amt">Bedrag (EUR) <span class="kv-edit-req">*</span></label>
          <input id="kv-invpay-amt" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal"
                 value="${esc(state.form.amount)}" data-kv-invpay-input class="kv-invpay-inp-num" />
          ${eAmt ? `<div class="kv-edit-field-msg">${esc(eAmt)}</div>` : ''}
          <div class="kv-edit-hint kv-invpay-hint-inline">
            Voorgesteld = openstaand bedrag; pas aan voor deelbetalingen.
          </div>
        </div>
        <div class="kv-edit-field ${eDate ? 'kv-edit-field-error' : ''}">
          <label for="kv-invpay-date">Betaal-datum <span class="kv-edit-req">*</span></label>
          <input id="kv-invpay-date" name="paid_at" type="date"
                 value="${esc(state.form.paid_at)}" data-kv-invpay-input />
          ${eDate ? `<div class="kv-edit-field-msg">${esc(eDate)}</div>` : ''}
          <div class="kv-edit-hint kv-invpay-hint-inline">
            De datum waarop het geld daadwerkelijk binnenkwam (niet vandaag als het eerder was).
          </div>
        </div>
      </div>
    </form>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invpay-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-invpay-submit ${state.saving ? 'disabled' : ''}>
        ${state.saving ? 'Boeken…' : 'Boeking registreren'}
      </button>
    </div>`;
}

// ── Validatie ──────────────────────────────────────────────────────────────

function clientValidate() {
  const errors = {};
  const amt = Number(state.form.amount);
  if (!Number.isFinite(amt) || amt <= 0) errors.amount = 'Bedrag moet > 0 zijn';
  else if (amt > state.openAmount + 0.005) errors.amount = `Bedrag mag niet groter zijn dan het openstaande bedrag (${fmtEur(state.openAmount)})`;

  const d = String(state.form.paid_at || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.paid_at = 'Formaat moet YYYY-MM-DD zijn';
  else {
    const day = new Date(d + 'T00:00:00');
    if (Number.isNaN(day.getTime())) errors.paid_at = 'Ongeldige datum';
    else if (day > new Date()) errors.paid_at = 'Betaal-datum mag niet in de toekomst liggen';
  }
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

  state.saving = true;
  rerender();

  try {
    await K().authedJson('/api/finance-invoice-register-payment', {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: state.invoiceId,
        amount:     Number(state.form.amount),
        paid_at:    state.form.paid_at,
      }),
    });
    K().toast('Betaling geboekt en gesynchroniseerd met TeamLeader');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || 'Boeking mislukt';
    state.globalError = msg;
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

// BROK SALES-2 (v=2, 2026-08-19): idempotente bindOnce (zie invoice-create.js).
function bindOnce(node, evt, handler) {
  if (!node) return;
  const k = '__kvBound_' + evt;
  if (node[k]) return;
  node[k] = true;
  node.addEventListener(evt, handler);
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-invpay-close], [data-kv-invpay-cancel]').forEach((b) => {
    bindOnce(b, 'click', () => D().closeModal());
  });
  bindOnce(box.querySelector('[data-kv-invpay-submit]'), 'click', doSave);
  bindOnce(box.querySelector('#kv-invpay-form'), 'submit', (e) => { e.preventDefault(); doSave(); });

  box.querySelectorAll('[data-kv-invpay-input]').forEach((inp) => {
    bindOnce(inp, 'input', (e) => {
      state.form[e.target.name] = e.target.value;
      if (state.errors[e.target.name]) { delete state.errors[e.target.name]; rerenderBody(); }
    });
  });
}

// ── Micro-render ───────────────────────────────────────────────────────────

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderBody() {
  const el = document.querySelector('#dfoModalBody');
  if (el) el.innerHTML = renderBody();
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openInvoicePaymentModal({ invoice, onSuccess })
 *   invoice   — factuur-object met open bedrag > 0. Concept/gecrediteerde
 *               facturen worden bij de caller al gefilterd (canPay in
 *               invoice-detail-modal).
 *   onSuccess — callback() na geslaagde boeking; caller herlaadt list.
 */
export function openInvoicePaymentModal({ invoice, onSuccess } = {}) {
  if (!invoice?.id) {
    K().toast('Geen factuur om te boeken');
    return;
  }
  const open = computeOpenAmount(invoice);
  if (open <= 0) {
    K().toast('Deze factuur staat niet meer open — geen boeking nodig.');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(invoice, { onSuccess });
  rerender();
}
