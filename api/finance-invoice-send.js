// api/finance-invoice-send.js
// POST → factuur (her)verzenden via TL invoices.send. Permission: finance.invoice.send.
// TL-first + validate-first: faalt TL → 422 + volledige tl_response, GEEN DB-mutatie.
//
// Body: { invoice_id, recipients?: [{type:'contact'|'company', id}], subject?, language?, content? }
// Default-ontvanger: de klant-koppeling van de factuur (tl_company_id of tl_contact_id).
//
// Apiary-shape (te verifiëren met testplan):
//   { id, recipients:[{type:'contact'|'company', id}], subject?, content?, language? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.send'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.send)' });

  const { invoice_id, recipients, subject, language, content } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, customer_id, tl_invoice_id, invoice_number, status, customer:customers(tl_contact_id, tl_company_id, is_company)')
      .eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });

    // Default-ontvanger uit de klant-koppeling.
    let recList = Array.isArray(recipients) && recipients.length ? recipients : null;
    if (!recList) {
      const c = inv.customer || {};
      if (c.is_company && c.tl_company_id) recList = [{ type: 'company', id: c.tl_company_id }];
      else if (c.tl_contact_id) recList = [{ type: 'contact', id: c.tl_contact_id }];
      else return res.status(400).json({ error: 'Geen TL-ontvanger gekoppeld aan deze klant' });
    }

    const body = { id: inv.tl_invoice_id, recipients: recList };
    if (subject) body.subject = String(subject);
    if (content) body.content = String(content);
    body.language = String(language || 'nl');
    console.log('[finance-invoice-send] payload', JSON.stringify(body));

    let pr, prText = '';
    try { pr = await tlFetch('/invoices.send', { method: 'POST', body: JSON.stringify(body) }); prText = await pr.text().catch(() => ''); }
    catch (netErr) { console.error('[finance-invoice-send] netwerk', netErr.message); return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message }); }
    if (!pr.ok) {
      console.error('[finance-invoice-send] GEWEIGERD | HTTP', pr.status, '| payload=', JSON.stringify(body), '| response=', prText);
      return res.status(422).json({ error: `Teamleader weigerde verzending (HTTP ${pr.status}).`, tl_status: pr.status, tl_response: prText });
    }
    console.log('[finance-invoice-send] OK | HTTP', pr.status);

    // Audit (geen DB-mutatie op factuurstatus — TL beheert 'sent').
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.send', entity_type: 'invoice', entity_id: inv.id,
        after_json: { recipients: recList, subject: subject || null, language: language || 'nl' },
        reason_text: `Factuur ${inv.invoice_number} verzonden via Teamleader`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-send] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id });
  } catch (e) {
    console.error('[finance-invoice-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
