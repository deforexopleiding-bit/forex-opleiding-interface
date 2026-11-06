// modules/klanten-v2/views/modals/invoice-cash.js
//
// CASHBETALING REGISTREREN (6 nov 2026, Maxim). Contante (deel)betaling op
// een open factuur. De factuur blijft staan en wordt NIET gecrediteerd.
//
// Endpoint: POST /api/finance-invoice-register-cash
//   { invoice_id, amount, paid_at, ontvangen_door, notitie, bevestig_dubbel? }
// Server: gewone betaalflow (Teamleader + payments + factuurmotor) met
// betaalmethode cash; daarna een ontvangstbewijs (PDF, zelf downloaden —
// er wordt NIETS verstuurd).

const K = () => window.KV;
const D = () => window.DFO;
const esc = (v) => K().esc(v);
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEur = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : EUR.format(Number(n)));

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function openAmount(inv) {
  if (inv && typeof inv.amount_open === 'number') return Math.max(0, Number(inv.amount_open));
  return Math.max(0, (Number(inv?.amount_total) || 0) - (Number(inv?.amount_paid) || 0) - (Number(inv?.credited_amount) || 0));
}

let state = null;

function renderHead() {
  const nr = state.invoice?.invoice_number || '#' + String(state.invoice?.id || '').slice(0, 8);
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Cashbetaling registreren</div>
        <div class="kv-edit-head-name kv-inv-head-title"><span class="mono">${esc(nr)}</span></div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-cash-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function veld(naam, label, input, hint) {
  const e = state.errors[naam];
  return `<div class="kv-edit-field ${e ? 'kv-edit-field-error' : ''}">
    <label for="kv-cash-${naam}">${label} <span class="kv-edit-req">*</span></label>
    ${input}
    ${e ? `<div class="kv-edit-field-msg">${esc(e)}</div>` : ''}
    ${hint ? `<div class="kv-edit-hint kv-invpay-hint-inline">${hint}</div>` : ''}
  </div>`;
}

function renderBody() {
  if (state.klaar) return renderKlaar();
  const f = state.form;
  return `
    <form id="kv-cash-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
      ${state.dubbel ? `<div class="kv-edit-banner">${esc(state.dubbel)} <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-cash-dubbel>Ja, registreer toch</button></div>` : ''}
      <div class="kv-invpay-notice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <div>
          <div class="kv-invpay-notice-t"><strong>Contant ontvangen — de factuur blijft staan.</strong></div>
          <div class="kv-invpay-notice-s">
            Er wordt niets gecrediteerd. De betaling gaat via de gewone betaalflow naar Teamleader (betaalmethode cash);
            de commissie volgt op wat betaald is. Er gaat geen mail of bericht uit: het ontvangstbewijs download je zelf.
          </div>
        </div>
      </div>
      <div class="kv-invpay-open">
        <div class="kv-invpay-open-l">Openstaand op deze factuur:</div>
        <div class="kv-invpay-open-v mono">${esc(fmtEur(state.open))}</div>
      </div>
      <div class="kv-edit-grid">
        ${veld('amount', 'Bedrag (EUR)', `<input id="kv-cash-amount" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(f.amount)}" data-kv-cash-input class="kv-invpay-inp-num" />`, 'Deelbetaling mag: pas het bedrag aan.')}
        ${veld('paid_at', 'Datum ontvangst', `<input id="kv-cash-paid_at" name="paid_at" type="date" max="${todayIso()}" value="${esc(f.paid_at)}" data-kv-cash-input />`)}
        ${veld('ontvangen_door', 'Ontvangen door', `<input id="kv-cash-ontvangen_door" name="ontvangen_door" type="text" maxlength="120" value="${esc(f.ontvangen_door)}" data-kv-cash-input />`, 'Wie het geld in handen kreeg.')}
      </div>
      ${veld('notitie', 'Notitie (intern)', `<textarea id="kv-cash-notitie" name="notitie" rows="3" maxlength="1000" data-kv-cash-input placeholder="Waar en waarom contant betaald, bv. 'betaald na de masterclass in Antwerpen'">${esc(f.notitie)}</textarea>`, 'Verplicht. Komt niet op het ontvangstbewijs.')}
    </form>`;
}

function renderKlaar() {
  const r = state.klaar;
  const tl = r.teamleader || {};
  return `
    <div class="kv-edit-form">
      <div class="kv-invpay-open"><div class="kv-invpay-open-l">Geregistreerd</div><div class="kv-invpay-open-v mono">${esc(fmtEur(state.verstuurd))}</div></div>
      <div style="font-size:13px;line-height:1.6">
        <div>Teamleader: betaling geregistreerd${tl.betaalmethode === 'meegestuurd' ? ` met betaalmethode <b>${esc(tl.methode_naam || 'cash')}</b>` : ''}.</div>
        <div>Factuurstand nu: <b>${esc(r.status)}</b>, betaald ${esc(fmtEur(r.amount_paid))}.</div>
        ${r.bewijs ? `<div>Ontvangstbewijs: <b class="mono">${esc(r.bewijs.bewijsnummer)}</b></div>` : ''}
      </div>
      ${(r.waarschuwingen || []).map((w) => `<div class="kv-edit-banner" style="margin-top:10px">${esc(w)}</div>`).join('')}
    </div>`;
}

function renderFoot() {
  if (state.klaar) {
    return `<div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-cash-close>Sluiten</button>
      ${state.klaar.bewijs ? `<button type="button" class="ds-btn ds-btn-primary" data-kv-cash-pdf>Ontvangstbewijs (PDF)</button>` : ''}
    </div>`;
  }
  return `<div class="kv-edit-foot">
    <button type="button" class="ds-btn ds-btn-ghost" data-kv-cash-close ${state.saving ? 'disabled' : ''}>Annuleren</button>
    <button type="button" class="ds-btn ds-btn-primary" data-kv-cash-submit ${state.saving ? 'disabled' : ''}>${state.saving ? 'Registreren…' : 'Cashbetaling registreren'}</button>
  </div>`;
}

function clientValidate() {
  const e = {};
  const f = state.form;
  const amt = Number(f.amount);
  if (!Number.isFinite(amt) || amt <= 0) e.amount = 'Bedrag moet groter zijn dan 0';
  else if (amt > state.open + 0.005) e.amount = `Niet meer dan het openstaande bedrag (${fmtEur(state.open)})`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.paid_at || ''))) e.paid_at = 'Kies een datum';
  else if (f.paid_at > todayIso()) e.paid_at = 'De datum ligt in de toekomst';
  if (!String(f.ontvangen_door || '').trim()) e.ontvangen_door = 'Vul in wie het geld ontving';
  if (String(f.notitie || '').trim().length < 5) e.notitie = 'Een notitie is verplicht (minstens 5 tekens)';
  return e;
}

async function doSave(bevestigDubbel = false) {
  state.errors = clientValidate();
  state.globalError = null;
  if (Object.keys(state.errors).length) return rerender();
  state.saving = true; state.dubbel = null;
  rerender();
  try {
    const r = await K().authedJson('/api/finance-invoice-register-cash', {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: state.invoice.id,
        amount: Number(state.form.amount),
        paid_at: state.form.paid_at,
        ontvangen_door: state.form.ontvangen_door.trim(),
        notitie: state.form.notitie.trim(),
        bevestig_dubbel: bevestigDubbel,
      }),
    });
    state.saving = false;
    state.verstuurd = Number(state.form.amount);
    state.klaar = r;
    K().toast('Cashbetaling geregistreerd' + ((r.waarschuwingen || []).length ? ' — let op de melding' : ''));
    if (typeof state.onSuccess === 'function') state.onSuccess(r);
    rerender();
  } catch (e) {
    state.saving = false;
    if (e?.body?.code === 'MOGELIJK_DUBBEL') state.dubbel = e.message;
    else if (e?.body?.fouten) { state.errors = e.body.fouten; state.globalError = e.message; }
    else state.globalError = e?.message || 'Registreren mislukt';
    rerender();
  }
}

export async function downloadOntvangstbewijs(id, nummer) {
  try {
    const resp = await K().authedFetch('/api/finance-cash-ontvangstbewijs?id=' + encodeURIComponent(id));
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { msg = (await resp.json()).error || msg; } catch (_) { /* geen json */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ontvangstbewijs-${nummer || id}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    K().toast('Ontvangstbewijs downloaden mislukt: ' + (e?.message || e));
  }
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-cash-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-cash-submit]')?.addEventListener('click', () => doSave(false));
  box.querySelector('[data-kv-cash-dubbel]')?.addEventListener('click', () => doSave(true));
  box.querySelector('[data-kv-cash-pdf]')?.addEventListener('click', () => downloadOntvangstbewijs(state.klaar.bewijs.id, state.klaar.bewijs.bewijsnummer));
  box.querySelector('#kv-cash-form')?.addEventListener('submit', (e) => { e.preventDefault(); doSave(false); });
  box.querySelectorAll('[data-kv-cash-input]').forEach((inp) => inp.addEventListener('input', (e) => {
    state.form[e.target.name] = e.target.value;
  }));
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

/**
 * openInvoiceCashModal({ invoice, onSuccess })
 *   invoice — open factuur (niet concept, niet gecrediteerd, open > 0).
 */
export async function openInvoiceCashModal({ invoice, onSuccess } = {}) {
  if (!invoice?.id) return K().toast('Geen factuur');
  const st = String(invoice.display_status || invoice.status || '').toLowerCase();
  if (st === 'credited' || st === 'concept' || st === 'draft') return K().toast('Een concept of gecrediteerde factuur krijgt geen betaling.');
  const open = openAmount(invoice);
  if (open <= 0.005) return K().toast('Deze factuur staat niet meer open.');
  let naam = '';
  try { const p = window.AuthShared ? await window.AuthShared.getProfile() : null; naam = p?.full_name || p?.email || ''; } catch (_) { /* leeg laten */ }
  state = {
    invoice, open, onSuccess, errors: {}, globalError: null, saving: false, dubbel: null, klaar: null, verstuurd: 0,
    form: { amount: open.toFixed(2), paid_at: todayIso(), ontvangen_door: naam, notitie: '' },
  };
  rerender();
}
