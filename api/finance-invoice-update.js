// api/finance-invoice-update.js
// POST → conceptfactuur aanpassen via TL invoices.update. Permission: finance.invoice.update.
// TL-first + validate-first. ALLEEN voor draft/concept; geboekte facturen → crediteren+opnieuw.
//
// Body: { invoice_id,
//         invoicee?: { customer:{type,id} },
//         grouped_lines?: [{ line_items:[{ description, quantity, unit_price:{amount,currency,tax}, tax_rate_id?, product_id? }] }],
//         purchase_order_number?, payment_term_id?, language? }
// Velden die niet meegegeven worden, blijven onaangeroerd.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';
import { taxRateIdFor } from './_lib/teamleader-quotation.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.update'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.update)' });

  const { invoice_id, ...patch } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    // tl_department_id nodig voor taxRateIdFor — laad mee met de invoice.
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, tl_invoice_id, tl_department_id, invoice_number, status').eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });
    if (inv.status !== 'concept') return res.status(409).json({ error: 'Alleen conceptfacturen kunnen worden aangepast — crediteer en maak opnieuw.' });

    const body = { id: inv.tl_invoice_id };
    if (patch.invoicee && patch.invoicee.customer && patch.invoicee.customer.id) body.invoicee = { customer: { type: patch.invoicee.customer.type || 'contact', id: patch.invoicee.customer.id } };

    // Twee shapes voor regels: `lines` (shorthand, mapper bouwt grouped_lines + tax_rate_id —
    // zelfde mapping als create) of `grouped_lines` (rauw, voor backwards-compat).
    if (Array.isArray(patch.lines) && patch.lines.length) {
      try {
        const lineItems = patch.lines.map((l, idx) => {
          const desc = String(l.description || '').trim();
          const qty = Number(l.quantity) || 1;
          const unit = Number(l.unit_price_excl);
          const vat = Number(l.vat_percentage);
          if (!desc) throw new Error(`Regel ${idx + 1}: omschrijving ontbreekt`);
          if (!Number.isFinite(unit) || unit < 0) throw new Error(`Regel ${idx + 1}: ongeldige eenheidsprijs`);
          if (![0, 6, 9, 21].includes(vat)) throw new Error(`Regel ${idx + 1}: ongeldig BTW-percentage (${vat})`);
          return {
            description: desc,
            quantity: qty,
            unit_price: { amount: r2(unit), currency: 'EUR', tax: 'excluding' },
            tax_rate_id: taxRateIdFor(vat, inv.tl_department_id, 'domestic'),
          };
        });
        body.grouped_lines = [{ line_items: lineItems }];
      } catch (valErr) { return res.status(400).json({ error: valErr.message }); }
    } else if (Array.isArray(patch.grouped_lines) && patch.grouped_lines.length) {
      body.grouped_lines = patch.grouped_lines;
    }

    if (patch.purchase_order_number != null) body.purchase_order_number = String(patch.purchase_order_number);
    if (patch.payment_term_id) body.payment_term_id = String(patch.payment_term_id);
    if (patch.language) body.language = String(patch.language);
    console.log('[finance-invoice-update] payload', JSON.stringify(body));

    let pr, prText = '';
    try { pr = await tlFetch('/invoices.update', { method: 'POST', body: JSON.stringify(body) }); prText = await pr.text().catch(() => ''); }
    catch (netErr) { console.error('[finance-invoice-update] netwerk', netErr.message); return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message }); }
    if (!pr.ok) {
      console.error('[finance-invoice-update] GEWEIGERD | HTTP', pr.status, '| payload=', JSON.stringify(body), '| response=', prText);
      return res.status(422).json({ error: `Teamleader weigerde de wijziging (HTTP ${pr.status}).`, tl_status: pr.status, tl_response: prText });
    }
    console.log('[finance-invoice-update] OK | HTTP', pr.status);

    // Post-write sync-back via gedeelde upsertInvoiceFromTl (bedragen/btw/regels kunnen gewijzigd zijn).
    let syncErr = null;
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { syncErr = e.message; console.error('[finance-invoice-update] post-sync', e.message); }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.update', entity_type: 'invoice', entity_id: inv.id,
        after_json: { patch: body }, reason_text: `Concept ${inv.invoice_number} aangepast`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-update] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, sync_err: syncErr });
  } catch (e) {
    console.error('[finance-invoice-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
