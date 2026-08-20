// modules/klanten-v2/views/modals/invoice-detail.js
//
// Factuur-detail-modal (PR-D1, eerste van de 6 factuur-modals).
// PURE READ. Zero mutations, zero externe side-effects. Bundelt de
// factuur-info + line-items + creditnota's + PDF-link + TL-betaal-link
// in één overzichtsscherm. Biedt actie-knoppen naar de sub-modals
// (Update PR-D2 / Betaling PR-D3 / Verzenden PR-D4 / Crediteren PR-D5)
// — die openen elk hun eigen modal in latere PR's.
//
// Data-bronnen (allen GET, allen bestaand):
//   /api/finance-invoices?customer_id=X&invoice_id=Y — basis (optioneel;
//     de list.js geeft ons het invoice-object al mee, dus meestal niet
//     nodig behalve na een sub-modal-write om te verversen)
//   /api/finance-invoice-lines?invoice_id=Y            — line-items
//   /api/finance-invoice-creditnotes?invoice_id=Y      — eerdere cn's
//   /api/finance-invoice-payment-link?invoice_id=Y     — TL betaal-link
//   /api/finance-invoice-pdf?invoice_id=Y              — PDF-URL (signed,
//     expiring — niet cachen)
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }
function fmtDate(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } }

// Zelfde mapping als in tabs/facturen.js — houdt consistente labels.
const STATUS = {
  open:                { label: 'Open',            cls: 'ds-pill-accent'  },
  overdue:             { label: 'Verlopen',        cls: 'ds-pill-danger'  },
  paid:                { label: 'Betaald',         cls: 'ds-pill-ok'      },
  partially_paid:      { label: 'Deels betaald',   cls: 'ds-pill-warn'    },
  credited:            { label: 'Gecrediteerd',    cls: 'ds-pill-neutral' },
  partially_credited:  { label: 'Deels gecrediteerd', cls: 'ds-pill-neutral' },
  concept:             { label: 'Concept',         cls: 'ds-pill-neutral' },
  draft:               { label: 'Concept',         cls: 'ds-pill-neutral' },
};
function statusPill(st) {
  const m = STATUS[st] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${esc(m.label)}</span>`;
}
function isConcept(st) { return st === 'concept' || st === 'draft'; }
function isCredited(st) { return st === 'credited' || st === 'partially_credited'; }

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(invoice, opts) {
  state = {
    invoiceId:    invoice?.id || null,
    invoice,                      // start-object uit list.js
    lines:        [],
    linesLoading: true,
    linesError:   null,
    creditNotes:  [],
    cnLoading:    true,
    cnError:      null,
    paymentLink:  invoice?.payment_url || null,
    plLoading:    false,
    plError:      null,
    // BROK FINANCE-INVOICE-PDF: als de bron-row al aangeeft dat er geen TL-
    // koppeling is (en geen invoice_number waar we op zouden kunnen self-healen)
    // pre-primen we de knop op unavailable — voorkomt een lookup-round-trip die
    // toch met NOT_IN_TL terugkomt.
    pdfUnavailable: !!invoice && !invoice.tl_invoice_id
                    && (!invoice.invoice_number || String(invoice.invoice_number).startsWith('CONCEPT-')),
    onEdit:       opts?.onEdit    || null,
    onPay:        opts?.onPay     || null,
    onSend:       opts?.onSend    || null,
    onCredit:     opts?.onCredit  || null,
    onSuccess:    opts?.onSuccess || null,
  };
}

// ── Data-loaders (parallel, fail-tolerant) ─────────────────────────────────

async function loadLines() {
  try {
    const j = await K().authedJson(`/api/finance-invoice-lines?invoice_id=${encodeURIComponent(state.invoiceId)}`);
    state.lines = Array.isArray(j?.lines) ? j.lines : [];
  } catch (e) { state.linesError = e?.message || 'Line-items niet geladen'; }
  finally    { state.linesLoading = false; }
}
async function loadCreditNotes() {
  try {
    const j = await K().authedJson(`/api/finance-invoice-creditnotes?invoice_id=${encodeURIComponent(state.invoiceId)}`);
    state.creditNotes = Array.isArray(j?.credit_notes) ? j.credit_notes : [];
  } catch (e) { state.cnError = e?.message || 'Creditnota\'s niet geladen'; }
  finally    { state.cnLoading = false; }
}
async function loadAll() {
  await Promise.allSettled([loadLines(), loadCreditNotes()]);
  rerender();
}

// ── Actions (side-effect-vrij aan de modal-kant; sub-modals doen het echte werk) ──

async function openPdf() {
  // BROK FINANCE-INVOICE-PDF (2026-08-19): endpoint accepteert nu invoice_id
  // met self-heal via TL invoices.list op invoice_number. Bij 404 NOT_IN_TL
  // (echt geen TL-koppeling) tonen we een nette toast + markeren de knop als
  // niet-beschikbaar zodat volgende klikken niet weer een lookup triggeren.
  if (state.pdfUnavailable) {
    K().toast('Geen TeamLeader-factuur — PDF niet beschikbaar.');
    return;
  }
  try {
    const j = await K().authedJson(`/api/finance-invoice-pdf?invoice_id=${encodeURIComponent(state.invoiceId)}`);
    if (j?.url) window.open(j.url, '_blank', 'noopener');
    else throw new Error('Geen PDF-URL beschikbaar');
  } catch (e) {
    // K().authedJson throwt op non-2xx. Endpoint retourneert bij NOT_IN_TL een
    // 404 met code='NOT_IN_TL' en een leesbare error-text — die text bevat
    // "PDF niet beschikbaar" waar we op matchen zodat we de knop lokaal
    // kunnen uitschakelen. Fallback: rauwe error-tekst tonen.
    const msg = String(e?.message || '');
    if (/PDF niet beschikbaar|NOT_IN_TL/i.test(msg)) {
      state.pdfUnavailable = true;
      rerender();
      K().toast('Geen TeamLeader-factuur — PDF niet beschikbaar.');
    } else {
      K().toast(`PDF ophalen mislukt: ${msg || 'onbekend'}`);
    }
  }
}
async function copyPaymentLink() {
  try {
    if (!state.paymentLink) {
      state.plLoading = true; rerender();
      const j = await K().authedJson(`/api/finance-invoice-payment-link?invoice_id=${encodeURIComponent(state.invoiceId)}`);
      state.paymentLink = j?.payment_url || j?.url || null;
      state.plLoading = false;
    }
    if (!state.paymentLink) throw new Error('Geen betaal-link beschikbaar');
    await navigator.clipboard.writeText(state.paymentLink);
    K().toast('Betaal-link gekopieerd naar klembord');
  } catch (e) {
    state.plError = e?.message || 'Onbekende fout';
    state.plLoading = false;
    K().toast(`Kopiëren mislukt: ${state.plError}`);
    rerender();
  }
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderHead() {
  const nr = state.invoice?.invoice_number || (state.invoiceId ? '#' + String(state.invoiceId).slice(0, 8) : '—');
  const st = state.invoice?.display_status || state.invoice?.status;
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Factuur</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          <span class="mono">${esc(nr)}</span>
          ${statusPill(st)}
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-inv-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderMetaGrid(inv) {
  const total   = Number(inv?.amount_total) || 0;
  const paid    = Number(inv?.amount_paid)  || 0;
  const cred    = Number(inv?.credited_amount) || 0;
  // BROK D2/D3 (2026-08-19): gebruik de door de API berekende amount_open
  // als bron van waarheid (finance-invoices.js:155 = max(0, total - paid)).
  // Voorheen: eigen client-side (total - paid - cred) → verschilde met de
  // lijst + betaal-modal (die WEL amount_open van de API gebruikte). Gaf
  // "Open € 0,00" bij een factuur met credited_amount > 0 en een 1-cent-
  // drift bij r2-rounding-mismatches. Fallback voor legacy-responses die
  // amount_open missen: houd de oude berekening aan.
  const open = (inv && typeof inv.amount_open === 'number')
    ? Number(inv.amount_open)
    : Math.max(0, total - paid - cred);
  return `
    <div class="kv-inv-meta-grid">
      <div class="kv-inv-meta-cell">
        <div class="kv-inv-meta-l">Totaal (incl. BTW)</div>
        <div class="kv-inv-meta-v mono">${esc(fmtEur(total))}</div>
      </div>
      <div class="kv-inv-meta-cell">
        <div class="kv-inv-meta-l">Betaald</div>
        <div class="kv-inv-meta-v mono">${esc(fmtEur(paid))}</div>
      </div>
      <div class="kv-inv-meta-cell ${open > 0 ? 'is-emphasis' : ''}">
        <div class="kv-inv-meta-l">Openstaand</div>
        <div class="kv-inv-meta-v mono">${esc(fmtEur(open))}</div>
      </div>
      ${cred > 0 ? `
        <div class="kv-inv-meta-cell">
          <div class="kv-inv-meta-l">Gecrediteerd</div>
          <div class="kv-inv-meta-v mono">${esc(fmtEur(cred))}</div>
        </div>` : ''}
    </div>
    <div class="kv-inv-dates">
      <span><strong>Factuurdatum:</strong> ${esc(fmtDate(inv?.invoice_date))}</span>
      <span><strong>Vervaldatum:</strong> ${esc(fmtDate(inv?.due_date))}</span>
      ${inv?.tl_invoice_id ? `<span><strong>TL-id:</strong> <code>${esc(String(inv.tl_invoice_id).slice(0, 12))}</code></span>` : ''}
    </div>`;
}

function renderLinesBlock() {
  if (state.linesLoading) return `<div class="kv-inv-loading">Line-items laden…</div>`;
  if (state.linesError)  return `<div class="kv-inv-warn">Line-items niet geladen: ${esc(state.linesError)}</div>`;
  if (!state.lines.length) return `<div class="kv-prof-empty">Geen line-items (TL heeft geen tl_invoice_id-koppeling).</div>`;
  // BROK FINANCE-INVOICE-DETAIL: 2 extra kolommen (BTW €, Regel incl.) —
  // client-side berekend uit regel-data. Geen endpoint-wijziging.
  return `
    <table class="kv-abo-lines">
      <thead><tr>
        <th>Omschrijving</th>
        <th class="r">Aantal</th>
        <th class="r">Prijs excl.</th>
        <th class="r">BTW %</th>
        <th class="r">BTW €</th>
        <th class="r">Regel excl.</th>
        <th class="r">Regel incl.</th>
      </tr></thead>
      <tbody>${state.lines.map(l => {
        const rate    = Number(l.tax_rate);
        const subExcl = Number(l.line_total_excl);
        const hasRate = Number.isFinite(rate);
        const hasExcl = Number.isFinite(subExcl);
        const btwAmt  = (hasRate && hasExcl) ? (subExcl * rate / 100) : null;
        const incl    = (hasExcl && btwAmt != null) ? (subExcl + btwAmt) : null;
        return `
        <tr>
          <td>${esc(l.description || '—')}</td>
          <td class="r mono">${esc(String(l.quantity != null ? l.quantity : 1))}</td>
          <td class="r mono">${esc(fmtEur(l.unit_price_excl))}</td>
          <td class="r mono">${esc(hasRate ? rate + '%' : '—')}</td>
          <td class="r mono">${esc(fmtEur(btwAmt))}</td>
          <td class="r mono">${esc(fmtEur(l.line_total_excl))}</td>
          <td class="r mono"><b>${esc(fmtEur(incl))}</b></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
}

function renderCreditNotesBlock() {
  if (state.cnLoading) return `<div class="kv-inv-loading">Creditnota's laden…</div>`;
  if (state.cnError)   return `<div class="kv-inv-warn">Creditnota's niet geladen: ${esc(state.cnError)}</div>`;
  if (!state.creditNotes.length) return '';
  return `
    <div class="kv-edit-section-h">Creditnota's (${state.creditNotes.length})</div>
    <ul class="kv-inv-cn-list">
      ${state.creditNotes.map(c => `
        <li class="kv-inv-cn-row">
          <span class="mono">${esc(c.number || '—')}</span>
          <span class="ds-cell-sub">${esc(fmtDate(c.date))}</span>
          ${statusPill(c.status)}
          <span class="mono kv-inv-cn-amt">${esc(fmtEur(c.amount_total))}</span>
        </li>`).join('')}
    </ul>`;
}

function renderBody() {
  return `
    <div class="kv-inv-body">
      ${renderMetaGrid(state.invoice)}

      <div class="kv-edit-section-h">Line-items</div>
      ${renderLinesBlock()}

      ${renderCreditNotesBlock()}

      <div class="kv-inv-extlinks">
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-inv-pdf
          ${state.pdfUnavailable ? 'disabled title="Geen TeamLeader-factuur — PDF niet beschikbaar" style="opacity:.55;cursor:not-allowed"' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg>
          ${state.pdfUnavailable ? 'PDF (niet beschikbaar)' : 'PDF (opent extern)'}
        </button>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-inv-paylink ${state.plLoading ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          ${state.plLoading ? 'Ophalen…' : 'Betaal-link kopiëren'}
        </button>
        ${state.invoice?.tl_invoice_id ? `
          <a class="ds-btn ds-btn-ghost ds-btn-sm" href="https://focus.teamleader.eu/invoices/${esc(encodeURIComponent(state.invoice.tl_invoice_id))}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open in TeamLeader
          </a>` : ''}
      </div>
    </div>`;
}

function renderFoot() {
  const st = state.invoice?.display_status || state.invoice?.status;
  const canEdit    = isConcept(st);
  const canPay     = !isConcept(st) && st !== 'credited';
  const canSend    = st !== 'credited';
  const canCredit  = !isConcept(st) && !isCredited(st);

  return `
    <div class="kv-edit-foot kv-inv-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-inv-close>Sluiten</button>
      <div class="kv-inv-foot-actions">
        <button type="button" class="ds-btn ds-btn-ghost" data-kv-inv-act="edit" ${canEdit ? '' : 'disabled'} title="${canEdit ? 'Concept-factuur bewerken' : 'Alleen voor concepten'}">
          Bewerken
        </button>
        <button type="button" class="ds-btn ds-btn-primary" data-kv-inv-act="pay" ${canPay ? '' : 'disabled'} title="${canPay ? 'Handmatige betaling boeken' : 'Niet beschikbaar voor concepten/gecrediteerd'}">
          Betaling boeken
        </button>
        <button type="button" class="ds-btn ds-btn-ghost" data-kv-inv-act="send" ${canSend ? '' : 'disabled'} title="Volgt in PR-D4">
          Verzenden
        </button>
        <button type="button" class="ds-btn ds-btn-ghost" data-kv-inv-act="credit" ${canCredit ? '' : 'disabled'} title="Volgt in PR-D5">
          Crediteren
        </button>
      </div>
    </div>`;
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-inv-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-inv-pdf]')?.addEventListener('click', openPdf);
  box.querySelector('[data-kv-inv-paylink]')?.addEventListener('click', copyPaymentLink);
  box.querySelectorAll('[data-kv-inv-act]').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-kv-inv-act');
      const cb = {
        edit:   state.onEdit,
        pay:    state.onPay,
        send:   state.onSend,
        credit: state.onCredit,
      }[action];
      if (typeof cb === 'function') cb(state.invoice);
      else K().toast(`${action} — volgt in een volgende PR-D.`);
    });
  });
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openInvoiceDetailModal({ invoice, onEdit, onPay, onSend, onCredit, onSuccess })
 *   invoice   — factuur-object uit list.js (bevat id, invoice_number,
 *               amounts, status, dates). Vereist id.
 *   onEdit    — callback(invoice) voor "Bewerken"-knop (PR-D2).
 *   onPay     — callback(invoice) voor "Betaling boeken"-knop (PR-D3).
 *   onSend    — callback(invoice) voor "Verzenden"-knop (PR-D4).
 *   onCredit  — callback(invoice) voor "Crediteren"-knop (PR-D5).
 *   onSuccess — n.v.t. voor deze modal (geen writes), maar behouden
 *               voor API-consistentie met andere modals.
 */
export function openInvoiceDetailModal({ invoice, ...opts } = {}) {
  if (!invoice?.id) {
    K().toast('Geen factuur om te tonen');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(invoice, opts);
  rerender();
  loadAll();
}
