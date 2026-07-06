// api/_lib/invoice-create-core.js
// Herbruikbare kern voor TL-factuur aanmaken: draft → (optioneel) book →
// (optioneel) send → post-sync in eigen DB. Callers:
//   - api/finance-invoice-create.js (handmatige-factuur endpoint)
//   - api/sales-subscription-create.js (€100 reserveringsfee bij abbo-invoer)
//
// Bewust GEEN auth/permission-check hier — caller is verantwoordelijk. Ook
// GEEN audit-log — caller schrijft z'n eigen audit met de juiste action.
//
// Input:
//   customer      — customers-row (min: id, is_company, tl_contact_id, ...)
//   departmentId  — TL-department UUID (verplicht)
//   lines[]       — [{ description, quantity, unit_price_excl, vat_percentage,
//                      product_id? }] — vat_percentage moet 0/6/9/21 zijn.
//   action        — 'draft' | 'book' | 'book_and_send'
//   opts.saleType — 'domestic' | 'intracommunautair' | 'buitenEU' (default 'domestic')
//   opts.language — 'nl' | 'en' | ... (default 'nl')
//   opts.purchase_order_number, opts.payment_term_id, opts.book_date, opts.send
//
// Return:
//   {
//     ok:              true|false,
//     tl_invoice_id:   string|null,
//     invoice_id:      string|null,   // lokale invoices.id na upsert
//     invoice_number:  string|null,
//     local_status:    string|null,
//     booked:          boolean,
//     sent:            boolean,
//     bookErr, sendErr, sync_err
//   }
//
// Bij draft-fout: throwt Error('TL_DRAFT_FAILED') met .stage='draft' +
// .tl_status + .tl_response. Book/send-fouten zijn non-fatal (return ok:true
// met bookErr/sendErr); caller kiest of dat blokkerend is.

import { tlFetch } from './teamleader-token.js';
import { getOrCreateTlCustomer } from './teamleader-contact.js';
import { taxRateIdFor } from './teamleader-quotation.js';
import { upsertInvoiceFromTl } from './invoice-upsert.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export async function createTlInvoice({ customer, departmentId, lines, action, opts = {} }) {
  if (!customer?.id) throw new Error('customer met id vereist');
  if (!departmentId) throw new Error('departmentId vereist');
  if (!Array.isArray(lines) || !lines.length) throw new Error('minimaal 1 regel vereist');
  if (!['draft', 'book', 'book_and_send'].includes(action)) throw new Error('action ongeldig');

  const saleType = opts.saleType || 'domestic';
  const language = opts.language || 'nl';

  // 1. TL customer-referentie (idempotent).
  let customerRef;
  try { customerRef = await getOrCreateTlCustomer(customer); }
  catch (e) {
    const err = new Error('Kon klant niet aan Teamleader koppelen: ' + e.message);
    err.stage = 'customer_link';
    throw err;
  }

  // 2. Line items → TL-shape (met vat-validatie + tax_rate-lookup).
  const lineItems = lines.map((l, idx) => {
    const desc = String(l.description || '').trim();
    const qty  = Number(l.quantity) || 1;
    const unit = Number(l.unit_price_excl);
    const vat  = Number(l.vat_percentage);
    if (!desc) throw Object.assign(new Error(`Regel ${idx + 1}: omschrijving ontbreekt`), { stage: 'validate' });
    if (!Number.isFinite(unit) || unit < 0) throw Object.assign(new Error(`Regel ${idx + 1}: ongeldige eenheidsprijs`), { stage: 'validate' });
    if (![0, 6, 9, 21].includes(vat)) throw Object.assign(new Error(`Regel ${idx + 1}: ongeldig BTW-percentage (${vat})`), { stage: 'validate' });
    const li = {
      description: desc,
      quantity:    qty,
      unit_price:  { amount: r2(unit), currency: 'EUR', tax: 'excluding' },
      tax_rate_id: taxRateIdFor(vat, departmentId, saleType),
    };
    if (l.product_id) li.product_id = String(l.product_id);
    return li;
  });

  // 3. Draft.
  const draftBody = {
    invoicee:      { customer: customerRef },
    department_id: String(departmentId),
    grouped_lines: [{ line_items: lineItems }],
  };
  if (opts.purchase_order_number) draftBody.purchase_order_number = String(opts.purchase_order_number);
  if (opts.payment_term_id)       draftBody.payment_term_id       = String(opts.payment_term_id);
  if (language)                   draftBody.language              = String(language);

  let dr, dText = '';
  try { dr = await tlFetch('/invoices.draft', { method: 'POST', body: JSON.stringify(draftBody) }); dText = await dr.text().catch(() => ''); }
  catch (netErr) {
    const err = new Error('Kon Teamleader niet bereiken: ' + netErr.message);
    err.stage = 'draft_network';
    throw err;
  }
  if (!dr.ok) {
    console.error('[invoice-core] draft GEWEIGERD | HTTP', dr.status, '| payload=', JSON.stringify(draftBody), '| response=', dText);
    const err = new Error(`Teamleader weigerde de concept-factuur (HTTP ${dr.status}).`);
    err.stage       = 'draft';
    err.tl_status   = dr.status;
    err.tl_response = dText;
    throw err;
  }
  let tlInvoiceId = null;
  try { tlInvoiceId = JSON.parse(dText)?.data?.id || null; } catch {}
  if (!tlInvoiceId) {
    const err = new Error('TL gaf geen invoice id terug');
    err.stage       = 'draft_no_id';
    err.tl_response = dText;
    throw err;
  }

  let booked = false, sent = false, bookErr = null, sendErr = null;

  // 4. Boeken.
  if (action === 'book' || action === 'book_and_send') {
    const onDate = (typeof opts.book_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.book_date))
      ? opts.book_date
      : new Date().toISOString().slice(0, 10);
    try {
      const br    = await tlFetch('/invoices.book', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId, on: onDate }) });
      const bText = await br.text().catch(() => '');
      if (!br.ok) { bookErr = { http: br.status, response: bText }; console.error('[invoice-core] book GEWEIGERD', br.status, bText.slice(0, 300)); }
      else booked = true;
    } catch (e) { bookErr = { error: e.message }; }
  }

  // 5. Versturen (alleen na succesvol boeken).
  // TL invoices.send verwacht:
  //   - `to`        : array van { type: 'contact'|'company', id } (NIET 'recipients').
  //   - `content`   : GENEST object { subject, body }. Losse top-level
  //                   subject/content werden genegeerd → HTTP 400
  //                   "subject must be present" + "body must be present".
  //   - `language`  : optioneel.
  //
  // subject + body zijn verplicht binnen content. Callers kunnen via
  // opts.send.subject / opts.send.content (of opts.send.body) eigen tekst
  // meesturen; anders generieke DFO-defaults zodat de fee-factuur (en
  // andere book_and_send zonder eigen tekst) TL passeert.
  if (booked && action === 'book_and_send') {
    try {
      const send    = opts.send || {};
      const toList  = (Array.isArray(send.recipients) && send.recipients.length) ? send.recipients
        : (customerRef.type === 'company' ? [{ type: 'company', id: customerRef.id }] : [{ type: 'contact', id: customerRef.id }]);
      const subject = send.subject
        ? String(send.subject)
        : 'Factuur - De Forex Opleiding';
      const body = (send.body || send.content)
        ? String(send.body || send.content)
        : 'Beste,\n\nIn bijlage vindt u de factuur.\n\nMet vriendelijke groet,\nDe Forex Opleiding B.V.';
      const sb = {
        id:       tlInvoiceId,
        to:       toList,
        content:  { subject, body },
        language: send.language || language,
      };
      const sr    = await tlFetch('/invoices.send', { method: 'POST', body: JSON.stringify(sb) });
      const sText = await sr.text().catch(() => '');
      if (!sr.ok) { sendErr = { http: sr.status, response: sText }; console.error('[invoice-core] send GEWEIGERD', sr.status, sText.slice(0, 300)); }
      else sent = true;
    } catch (e) { sendErr = { error: e.message }; }
  }

  // 6. Post-write sync-back.
  let local = null, sync_err = null;
  try { local = await upsertInvoiceFromTl(tlInvoiceId, { is_manual: true, pushed_to_tl: true, fallback_department: departmentId }); }
  catch (e) { sync_err = e.message; console.error('[invoice-core] post-sync', e.message); }

  return {
    ok:             true,
    tl_invoice_id:  tlInvoiceId,
    invoice_id:     local?.id || null,
    invoice_number: local?.invoice_number || null,
    local_status:   local?.status || null,
    booked, sent, bookErr, sendErr, sync_err,
  };
}
