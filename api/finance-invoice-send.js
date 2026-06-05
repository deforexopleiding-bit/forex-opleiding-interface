// api/finance-invoice-send.js
// POST → factuur (her)verzenden via TL invoices.send. Permission: finance.invoice.send.
// TL-first + validate-first: faalt TL → 422 + volledige tl_response, GEEN DB-mutatie.
//
// Body (onze): { invoice_id, to?, subject?, content?, language? }
//
// TL invoices.send shape (bevestigd via TL 400 "to must be present" / "content must be present";
// zelfde patroon als de werkende quotations.send in teamleader-send-quotation.js):
//   { id, recipients: { to: [{ email_address }] }, subject, content, language }
//
// Default-ontvanger: customers.email → fallback invoices.info → invoicee.email.
// Default-tekst: nette NL begeleidende mail met klantnaam + factuurnummer.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';
import { customerDisplayName } from './_lib/customer-name.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.send'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.send)' });

  const { invoice_id, to, subject, language, content } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, customer_id, tl_invoice_id, invoice_number, status, customer:customers(is_company, company_name, first_name, last_name, email)')
      .eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });

    // 1. Ontvanger-email: expliciet meegegeven > klant > fallback invoices.info → invoicee.email.
    let recipientEmail = (typeof to === 'string' && to.trim()) ? to.trim() : (inv.customer?.email || null);
    if (!recipientEmail) {
      try {
        const ir = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: inv.tl_invoice_id }) });
        if (ir.ok) {
          const data = (await ir.json()).data || {};
          recipientEmail = data.invoicee?.email
            || data.invoicee?.emails?.[0]?.email
            || data.invoicee?.contact?.email
            || data.invoicee?.company?.email
            || null;
        }
      } catch (e) { console.warn('[finance-invoice-send] invoicee-email fallback', e.message); }
    }
    if (!recipientEmail) return res.status(400).json({ error: 'Geen ontvanger-e-mail beschikbaar (klant heeft geen e-mail; vul "to" expliciet in).' });

    // 2. Default-tekst (vaste fallback, zelfde patroon als quotations.send).
    const custName = customerDisplayName(inv.customer || {}, '');
    const aanhef = custName ? `Beste ${custName}` : 'Beste';
    const defaultSubject = `Factuur ${inv.invoice_number} van De Forex Opleiding`;
    const defaultContent = `${aanhef},\n\nHierbij doen wij u factuur ${inv.invoice_number} toekomen. U vindt deze in de bijlage.\n\nMet vriendelijke groet,\nDe Forex Opleiding`;

    // 3. TL invoices.send body (bewezen shape, alligned met quotations.send).
    const body = {
      id: inv.tl_invoice_id,
      recipients: { to: [{ email_address: recipientEmail }] },
      subject: subject && String(subject).trim() ? String(subject) : defaultSubject,
      content: content && String(content).trim() ? String(content) : defaultContent,
      language: String(language || 'nl'),
    };
    console.log('[finance-invoice-send] payload', JSON.stringify(body));

    let pr, prText = '';
    try { pr = await tlFetch('/invoices.send', { method: 'POST', body: JSON.stringify(body) }); prText = await pr.text().catch(() => ''); }
    catch (netErr) { console.error('[finance-invoice-send] netwerk', netErr.message); return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message }); }
    if (!pr.ok) {
      console.error('[finance-invoice-send] GEWEIGERD | HTTP', pr.status, '| payload=', JSON.stringify(body), '| response=', prText);
      return res.status(422).json({ error: `Teamleader weigerde verzending (HTTP ${pr.status}).`, tl_status: pr.status, tl_response: prText });
    }
    console.log('[finance-invoice-send] OK | HTTP', pr.status);

    // Post-write sync-back: status kan na 'send' wijzigen (bv. draft → outstanding bij eerste send).
    let syncErr = null;
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { syncErr = e.message; console.error('[finance-invoice-send] post-sync', e.message); }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.send', entity_type: 'invoice', entity_id: inv.id,
        after_json: { to: recipientEmail, subject: body.subject, language: body.language },
        reason_text: `Factuur ${inv.invoice_number} verzonden via Teamleader naar ${recipientEmail}`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-send] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, to: recipientEmail, sync_err: syncErr });
  } catch (e) {
    console.error('[finance-invoice-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
