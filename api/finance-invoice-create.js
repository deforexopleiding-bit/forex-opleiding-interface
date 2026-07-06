// api/finance-invoice-create.js
// POST → handmatig factuur aanmaken: draft → (optioneel) book → (optioneel) send.
// Permission: finance.invoice.create. TL-first + validate-first.
// DFO werkt met VRIJE regels (geen product_id) → tax_rate_id via percentage uit env
// (TEAMLEADER_TAX_RATE_ID_21/9/6/0 + per-department overrides), zelfde helper als de
// offerte-push (_lib/teamleader-quotation.js taxRateIdFor).
//
// Kern-logica is verhuisd naar api/_lib/invoice-create-core.js (createTlInvoice)
// zodat sales-subscription-create.js dezelfde flow kan hergebruiken voor de
// €100 reserveringsfee (bouwstap 2 offerte-beveiliging). Deze handler blijft
// de HTTP-wrapper met auth + audit-log.
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
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createTlInvoice } from './_lib/invoice-create-core.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.create'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.create)' });

  const { customer_id, department_id, lines, purchase_order_number, payment_term_id, language, action, send, book_date } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id vereist' });
  if (!department_id) return res.status(400).json({ error: 'department_id vereist' });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'Minimaal 1 regel vereist' });
  if (!['draft', 'book', 'book_and_send'].includes(action)) return res.status(400).json({ error: 'action moet draft/book/book_and_send zijn' });

  try {
    const { data: cust } = await supabaseAdmin.from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone, tl_contact_id, tl_company_id, address_street, address_number, address_postal, address_city')
      .eq('id', customer_id).maybeSingle();
    if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });

    let result;
    try {
      result = await createTlInvoice({
        customer:     cust,
        departmentId: department_id,
        lines,
        action,
        opts: { purchase_order_number, payment_term_id, language, book_date, send },
      });
    } catch (e) {
      // Structured errors uit de helper → nette HTTP-response.
      if (e.stage === 'validate')       return res.status(400).json({ error: e.message });
      if (e.stage === 'customer_link')  return res.status(422).json({ error: e.message });
      if (e.stage === 'draft_network')  return res.status(502).json({ error: e.message });
      if (e.stage === 'draft')          return res.status(422).json({ error: e.message, tl_status: e.tl_status, tl_response: e.tl_response, stage: 'draft' });
      if (e.stage === 'draft_no_id')    return res.status(502).json({ error: e.message, tl_response: e.tl_response });
      throw e;
    }

    // Audit (fail-soft) — dezelfde shape als voorheen.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'invoice.create',
        entity_type: 'invoice',
        entity_id:   result.invoice_id || null,
        after_json:  { tl_invoice_id: result.tl_invoice_id, action, booked: result.booked, sent: result.sent, bookErr: result.bookErr, sendErr: result.sendErr, customer_id, department_id, local_id: result.invoice_id, sync_err: result.sync_err },
        reason_text: `Nieuwe factuur aangemaakt in Teamleader (${action}, booked=${result.booked}, sent=${result.sent})`,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-create] audit', e.message); }

    return res.status(200).json({
      success:        true,
      tl_invoice_id:  result.tl_invoice_id,
      invoice_id:     result.invoice_id,
      invoice_number: result.invoice_number,
      local_status:   result.local_status,
      booked:         result.booked,
      sent:           result.sent,
      bookErr:        result.bookErr,
      sendErr:        result.sendErr,
      sync_err:       result.sync_err,
    });
  } catch (e) {
    console.error('[finance-invoice-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
