// modules/klanten-v2/views/modals/invoice-remove-payment.js
//
// Factuur-betaling-terugdraaien modal (finance-mutaties ronde). Complement
// van invoice-payment.js: dit endpoint draait ALLE geregistreerde betalingen
// van een factuur terug in TeamLeader (TL invoices.removePayments) en
// updatet de status lokaal.
//
// Endpoint: POST /api/finance-invoice-remove-payment
// Body: { invoice_id }  (of tl_invoice_id — beide werkt)
// Server: TL-FIRST → 422 bij TL-fout (geen DB-mutatie), 502 bij netwerkfout.
// Permission: finance.invoice.payment.remove (server-side).
//
// Anders dan invoice-payment werkt dit endpoint niet per payment-id — TL
// biedt geen "verwijder één specifieke payment"-primitive. Alle payments
// gaan tegelijk terug.
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;
function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

let state = null;

function renderHead() {
  const nr = state.invoice?.invoice_number || (state.invoice?.id ? '#' + String(state.invoice.id).slice(0, 8) : '—');
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow" style="color:var(--rose, #C22B3E)">Boekhouding · destructief</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          Betalingen terugdraaien · <span class="mono">${esc(nr)}</span>
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-invrp-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderBody() {
  const inv = state.invoice || {};
  const paid = Number(inv.paid || inv.amount_paid || 0);
  const tot  = Number(inv.amount_total || inv.total || 0);
  return `
    <form class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
      <div class="kv-invpay-notice" style="background:var(--rose-soft, #FDECEE); border-color:var(--rose-line, #F5C2C9)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/></svg>
        <div>
          <div class="kv-invpay-notice-t"><strong>Draait ALLE geregistreerde betalingen op deze factuur terug.</strong></div>
          <div class="kv-invpay-notice-s">
            TeamLeader markeert de factuur als onbetaald en verwijdert alle payment-koppelingen (+ PDF wordt opnieuw gegenereerd). Er is <strong>geen "één betaling verwijderen"</strong>-primitive; alles gaat in één keer terug. Je kunt daarna losse betalingen opnieuw boeken via Betaling registreren.
          </div>
        </div>
      </div>
      <div class="kv-invpay-open">
        <div class="kv-invpay-open-l">Geboekt tot nu toe:</div>
        <div class="kv-invpay-open-v mono">${esc(fmtEur(paid))} van ${esc(fmtEur(tot))}</div>
      </div>
    </form>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invrp-close ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-invrp-submit ${state.saving ? 'disabled' : ''} style="background:var(--rose, #C22B3E); border-color:var(--rose, #C22B3E)">
        ${state.saving ? 'Terugdraaien…' : 'Alle betalingen terugdraaien'}
      </button>
    </div>`;
}

async function doSave() {
  state.saving = true; state.globalError = null;
  rerender();
  try {
    await K().authedJson('/api/finance-invoice-remove-payment', {
      method: 'POST',
      body: JSON.stringify({ invoice_id: state.invoice.id }),
    });
    K().toast('Betalingen teruggedraaid en gesynchroniseerd met TeamLeader');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    state.globalError = e?.message || 'Terugdraaien mislukt';
    state.saving = false;
    rerender();
  }
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-invrp-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-invrp-submit]')?.addEventListener('click', doSave);
}
function rerender() { D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() }); wire(); }

export function openInvoiceRemovePaymentModal({ invoice, onSuccess } = {}) {
  if (!invoice?.id) { K().toast('Geen factuur geselecteerd'); return; }
  const paid = Number(invoice.paid || invoice.amount_paid || 0);
  if (paid <= 0) { K().toast('Deze factuur heeft geen geboekte betalingen om terug te draaien.'); return; }
  state = { invoice, saving: false, globalError: null, onSuccess: onSuccess || null };
  rerender();
}
