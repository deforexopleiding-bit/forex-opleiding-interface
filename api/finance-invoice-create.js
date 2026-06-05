// api/finance-invoice-create.js
// POST → handmatig factuur aanmaken: draft → (optioneel) book → (optioneel) send.
// Permission: finance.invoice.create. TL-first + validate-first.
// DFO werkt met VRIJE regels (geen product_id) → tax_rate_id via percentage uit env
// (TEAMLEADER_TAX_RATE_ID_21/9/6/0 + per-department overrides), zelfde helper als de
// offerte-push (_lib/teamleader-quotation.js taxRateIdFor).
//
// Body: {
//   customer_id (onze uuid),
//   department_id (TL),
//   lines: [{ description, quantity, unit_price_excl, vat_percentage,
//             product_id? }],                    // product_id optioneel (toekomst)
//   purchase_order_number?, payment_term_id?, language?,
//   action: 'draft' | 'book' | 'book_and_send',
//   send?: { recipients?, subject?, content? }
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getOrCreateTlCustomer } from './_lib/teamleader-contact.js';
import { taxRateIdFor } from './_lib/teamleader-quotation.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.create'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.create)' });

  const { customer_id, department_id, lines, purchase_order_number, payment_term_id, language, action, send } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id vereist' });
  if (!department_id) return res.status(400).json({ error: 'department_id vereist' });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'Minimaal 1 regel vereist' });
  if (!['draft', 'book', 'book_and_send'].includes(action)) return res.status(400).json({ error: 'action moet draft/book/book_and_send zijn' });

  try {
    const { data: cust } = await supabaseAdmin.from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone, tl_contact_id, tl_company_id, address_street, address_number, address_postal, address_city')
      .eq('id', customer_id).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });

    // 1. TL customer-referentie (idempotent — maakt aan als nog niet gekoppeld).
    let customerRef;
    try { customerRef = await getOrCreateTlCustomer(cust); }
    catch (e) { return res.status(422).json({ error: 'Kon klant niet aan Teamleader koppelen: ' + e.message }); }

    // 2. Draft — vrije regels: tax_rate_id wordt afgeleid van vat_percentage via de
    //    bestaande env-mapping (hergebruikt taxRateIdFor uit _lib/teamleader-quotation.js).
    //    Voor handmatige facturen gaan we uit van domestic (verlegd/buiten-EU = later).
    let lineItems;
    try {
      lineItems = lines.map((l, idx) => {
        const desc = String(l.description || '').trim();
        const qty = Number(l.quantity) || 1;
        const unit = Number(l.unit_price_excl);
        const vat = Number(l.vat_percentage);
        if (!desc) throw new Error(`Regel ${idx + 1}: omschrijving ontbreekt`);
        if (!Number.isFinite(unit) || unit < 0) throw new Error(`Regel ${idx + 1}: ongeldige eenheidsprijs`);
        if (![0, 6, 9, 21].includes(vat)) throw new Error(`Regel ${idx + 1}: ongeldig BTW-percentage (${vat})`);
        const li = {
          description: desc,
          quantity: qty,
          unit_price: { amount: r2(unit), currency: 'EUR', tax: 'excluding' },
          tax_rate_id: taxRateIdFor(vat, department_id, 'domestic'),
        };
        if (l.product_id) li.product_id = String(l.product_id);
        return li;
      });
    } catch (valErr) { return res.status(400).json({ error: valErr.message }); }
    const draftBody = {
      invoicee: { customer: customerRef },
      department_id: String(department_id),
      grouped_lines: [{ line_items: lineItems }],
    };
    if (purchase_order_number) draftBody.purchase_order_number = String(purchase_order_number);
    if (payment_term_id) draftBody.payment_term_id = String(payment_term_id);
    if (language) draftBody.language = String(language);
    console.log('[finance-invoice-create] draft payload', JSON.stringify(draftBody));

    let dr, dText = '';
    try { dr = await tlFetch('/invoices.draft', { method: 'POST', body: JSON.stringify(draftBody) }); dText = await dr.text().catch(() => ''); }
    catch (netErr) { console.error('[finance-invoice-create] draft netwerk', netErr.message); return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message }); }
    if (!dr.ok) {
      console.error('[finance-invoice-create] draft GEWEIGERD | HTTP', dr.status, '| payload=', JSON.stringify(draftBody), '| response=', dText);
      return res.status(422).json({ error: `Teamleader weigerde de concept-factuur (HTTP ${dr.status}).`, tl_status: dr.status, tl_response: dText, stage: 'draft' });
    }
    let tlInvoiceId = null; try { tlInvoiceId = JSON.parse(dText)?.data?.id || null; } catch {}
    if (!tlInvoiceId) return res.status(502).json({ error: 'TL gaf geen invoice id terug', tl_response: dText });
    console.log('[finance-invoice-create] draft OK', tlInvoiceId);

    let booked = false, sent = false, bookErr = null, sendErr = null;

    // 3. Optioneel boeken.
    if (action === 'book' || action === 'book_and_send') {
      try {
        const br = await tlFetch('/invoices.book', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId }) });
        const bText = await br.text().catch(() => '');
        if (!br.ok) { bookErr = { http: br.status, response: bText }; console.error('[finance-invoice-create] book GEWEIGERD', br.status, bText.slice(0, 300)); }
        else { booked = true; console.log('[finance-invoice-create] book OK'); }
      } catch (e) { bookErr = { error: e.message }; }
    }

    // 4. Optioneel versturen (alleen na boeken).
    if (booked && action === 'book_and_send') {
      try {
        const recList = (send && Array.isArray(send.recipients) && send.recipients.length) ? send.recipients
          : (customerRef.type === 'company' ? [{ type: 'company', id: customerRef.id }] : [{ type: 'contact', id: customerRef.id }]);
        const sb = { id: tlInvoiceId, recipients: recList, language: send?.language || language || 'nl' };
        if (send?.subject) sb.subject = String(send.subject);
        if (send?.content) sb.content = String(send.content);
        const sr = await tlFetch('/invoices.send', { method: 'POST', body: JSON.stringify(sb) });
        const sText = await sr.text().catch(() => '');
        if (!sr.ok) { sendErr = { http: sr.status, response: sText }; console.error('[finance-invoice-create] send GEWEIGERD', sr.status, sText.slice(0, 300)); }
        else { sent = true; console.log('[finance-invoice-create] send OK'); }
      } catch (e) { sendErr = { error: e.message }; }
    }

    // Audit (factuur landt in onze DB via de volgende factuur-sync; geen lokale insert hier).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.create', entity_type: 'invoice', entity_id: null,
        after_json: { tl_invoice_id: tlInvoiceId, action, booked, sent, bookErr, sendErr, customer_id, department_id },
        reason_text: `Nieuwe factuur aangemaakt in Teamleader (${action}, booked=${booked}, sent=${sent})`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-create] audit', e.message); }

    return res.status(200).json({ success: true, tl_invoice_id: tlInvoiceId, booked, sent, bookErr, sendErr });
  } catch (e) {
    console.error('[finance-invoice-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
