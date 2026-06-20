// api/_lib/register-payment-internal.js
// Gedeelde logica voor "betaling registreren op een factuur" — gebruikt door
// het HTTP-endpoint /api/finance-invoice-register-payment EN door de
// autopilot-confirm in /api/finance-bank-camt-upload (geen HTTP-roundtrip).
//
// TL-FIRST: registreer in Teamleader; pas bij 2xx onze payments-rij + invoice-
// status. Bij TL-fout: gooi een gestructureerde error die de caller naar HTTP
// status mapt (422 voor 4xx, 502 voor netwerk, 500 voor andere).
//
// Bevat de complete cascade: TL registerPayment (met paid_at fallback) +
// invoices.info her-sync + payments insert + invoices update + audit_log.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';
import { releaseProportionalForPayment } from './mentor-ledger-engine.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tlCall(path, body, attempt = 0) {
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

// Zelfde status-mapping als finance-tl-invoice-sync.js + de bestaande
// register/remove-payment endpoints (zie fase 2A en 2B).
function mapStatus(inv, payable, due) {
  const s = String(inv.status || '').toLowerCase();
  if (s === 'draft') return 'concept';
  if (s.includes('credit')) return 'credited';
  if (inv.paid === true) return 'paid';
  if (due != null && payable != null) {
    if (due <= 0 && payable > 0) return 'paid';
    if (due > 0 && due < payable) return 'partially_paid';
    if (due >= payable) return 'open';
  }
  return 'open';
}

/**
 * Gestructureerde error die de caller naar het juiste HTTP-status mapt.
 * `kind` = 'validation' | 'tl_client' | 'tl_server' | 'tl_network' | 'db'
 */
export class RegisterPaymentError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

/**
 * Registreer een betaling op een factuur (TL + lokale DB + audit). Hergebruikt
 * de exacte body-shape die in productie bewezen werkt (zie fase 2B).
 *
 * @param {object} opts
 * @param {string} opts.invoiceId         — onze uuid in `invoices`
 * @param {number} opts.amount            — euro's > 0 (float)
 * @param {string} opts.paidAt            — 'YYYY-MM-DD'
 * @param {string} [opts.paymentMethodId] — vrije string; alleen lokaal
 * @param {string} [opts.source]          — 'manual' (default) | 'camt_match' | …
 * @param {string|null} opts.userId       — supabase auth-user-id voor audit; null bij service-context
 * @param {string|null} opts.ipAddress    — voor audit
 * @returns {Promise<{ invoice_id, amount_paid, status, payment_db_id }>}
 * @throws {RegisterPaymentError}
 */
export async function registerPaymentInternal(opts) {
  const {
    invoiceId, amount, paidAt,
    paymentMethodId = null,
    source = 'manual',
    userId = null,
    ipAddress = null,
  } = opts;

  if (!invoiceId) throw new RegisterPaymentError('validation', 'invoiceId vereist');
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new RegisterPaymentError('validation', 'amount > 0 vereist');
  }
  const dateOnly = String(paidAt || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) || isNaN(new Date(dateOnly + 'T00:00:00Z').getTime())) {
    throw new RegisterPaymentError('validation', 'paid_at YYYY-MM-DD vereist');
  }

  // 1. Lees factuur.
  const { data: inv } = await supabaseAdmin.from('invoices')
    .select('id, customer_id, tl_invoice_id, amount_total, amount_paid, status')
    .eq('id', invoiceId).maybeSingle();
  if (!inv) throw new RegisterPaymentError('validation', 'Factuur niet gevonden');
  if (!inv.tl_invoice_id) throw new RegisterPaymentError('validation', 'Factuur heeft geen Teamleader-id');

  // 2. TL-FIRST: registerPayment met paid_at fallback (datetime → date-only).
  const buildBody = (paidVal) => ({
    id: inv.tl_invoice_id,
    payment: { amount: r2(amtNum), currency: 'EUR' },
    paid_at: paidVal,
  });
  const tryRegister = async (paidVal) => {
    const body = buildBody(paidVal);
    console.log('[register-payment-internal] registerPayment payload', JSON.stringify(body));
    const r = await tlCall('/invoices.registerPayment', body);
    const text = await r.text().catch(() => '');
    return { r, text };
  };

  const paidDateTime = `${dateOnly}T00:00:00+00:00`;
  let pr, prText = '';
  try {
    ({ r: pr, text: prText } = await tryRegister(paidDateTime));
    if (!pr.ok && /paid_at must be valid/i.test(prText)) {
      const firstText = prText;
      console.warn('[register-payment-internal] paid_at datetime geweigerd → date-only retry');
      ({ r: pr, text: prText } = await tryRegister(dateOnly));
      if (!pr.ok) {
        throw new RegisterPaymentError('tl_client', `TL weigerde betaling (HTTP ${pr.status})`, {
          tl_status: pr.status,
          tl_response_datetime: firstText,
          tl_response_date_only: prText,
        });
      }
    }
  } catch (e) {
    if (e instanceof RegisterPaymentError) throw e;
    throw new RegisterPaymentError('tl_network', 'Kon Teamleader niet bereiken: ' + e.message);
  }
  if (!pr.ok) {
    const isClient = pr.status >= 400 && pr.status < 500;
    throw new RegisterPaymentError(isClient ? 'tl_client' : 'tl_server',
      `TL weigerde betaling (HTTP ${pr.status})`, { tl_status: pr.status, tl_response: prText });
  }

  // 3. Her-sync via invoices.info.
  let newPaid = Math.min(r2((Number(inv.amount_paid) || 0) + amtNum), Number(inv.amount_total) || Infinity);
  let newStatus = inv.status, paidDate = dateOnly;
  try {
    const ir = await tlCall('/invoices.info', { id: inv.tl_invoice_id });
    if (ir.ok) {
      const info = (await ir.json()).data || {};
      const t = info.total || {};
      const payable = amt(t.payable) ?? amt(t.tax_inclusive) ?? (Number(inv.amount_total) || null);
      const due = amt(t.due);
      if (payable != null && due != null) newPaid = Math.max(0, r2(payable - due));
      newStatus = mapStatus(info, payable, due);
      paidDate = isoDate(info.paid_at) || paidDate;
    } else {
      console.error('[register-payment-internal] invoices.info HTTP', ir.status);
    }
  } catch (e) {
    console.error('[register-payment-internal] invoices.info', e.message);
  }

  // 4. INSERT payments-rij. Returnt id voor caller (auto-confirm linkt 'm).
  const paymentInsert = {
    customer_id: inv.customer_id,
    invoice_id:  inv.id,
    amount:      r2(amtNum),
    payment_date: dateOnly,
    payment_method: paymentMethodId ? String(paymentMethodId) : null,
    source,
    matched_by: userId,
  };
  const { data: payRow, error: payErr } = await supabaseAdmin.from('payments').insert(paymentInsert).select('id').single();
  if (payErr) {
    console.error('[register-payment-internal] payments insert', payErr.message);
    // TL is gemuteerd, DB faalt — caller weet dit via DB-error.
    throw new RegisterPaymentError('db', 'TL OK maar payments insert faalde: ' + payErr.message);
  }

  // 5. UPDATE invoices.
  const { error: upErr } = await supabaseAdmin.from('invoices').update({
    amount_paid: newPaid,
    status:      newStatus,
    paid_date:   newStatus === 'paid' ? (paidDate || dateOnly) : null,
    updated_at:  new Date().toISOString(),
  }).eq('id', inv.id);
  if (upErr) {
    console.error('[register-payment-internal] invoice update', upErr.message);
    throw new RegisterPaymentError('db', 'TL+payment OK maar invoice update faalde: ' + upErr.message);
  }

  // 5b. F5.2 mentor-hook: bij ELKE betaling (partial of full) wordt het
  // evenredige deel van de openstaande bonus-obligaties vrijgegeven via
  // child-entries. Forward-only / no clawback. Non-blocking; engine is
  // idempotent op (parent_id, payment_id).
  // Bij fullyPaid spawnt 'ie ook een settle-child voor evt. afrondings-restjes
  // zodat de gehele obligatie volledig vrijgegeven is na de eindbetaling.
  if (inv.customer_id && payRow?.id) {
    try {
      await releaseProportionalForPayment({
        customerId      : inv.customer_id,
        sourceInvoiceId : inv.id,
        paymentId       : payRow.id,
        paymentAmount   : r2(amtNum),
        invoiceTotal    : Number(inv.amount_total) || 0,
        fullyPaid       : newStatus === 'paid',
      });
    } catch (e) {
      console.error('[register-payment-internal] mentor-hook releaseProportionalForPayment:', e.message);
    }
  }

  // 6. Audit (fail-soft).
  try {
    await supabaseAdmin.from('audit_log').insert({
      user_id:     userId,
      action:      'finance_invoice.register_payment',
      entity_type: 'invoice',
      entity_id:   inv.id,
      after_json:  { amount: r2(amtNum), paid_at: dateOnly, payment_method_id: paymentMethodId || null,
                     new_status: newStatus, new_amount_paid: newPaid, source },
      reason_text: `Betaling €${r2(amtNum)} geregistreerd op factuur ${inv.id} (status → ${newStatus}, source: ${source})`,
      ip_address:  ipAddress,
    });
  } catch (e) { console.error('[register-payment-internal] audit', e.message); }

  return {
    invoice_id:     inv.id,
    amount_paid:    newPaid,
    status:         newStatus,
    payment_db_id:  payRow.id,
  };
}
