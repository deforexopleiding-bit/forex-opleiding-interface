// api/finance-invoice-send.js
// POST → factuur (her)verzenden via TL invoices.send met een TL mail-template.
// Permission: finance.invoice.send. TL-first + validate-first.
//
// PIVOT: geen zelf-gegenereerde NL standaardtekst meer. TL's template wint; UI kiest 'm.
//
// Body (onze): {
//   invoice_id, mail_template_id,
//   recipient_email?, subject_override?, content_override?
// }
//
// TL invoices.send payload (minimal):
//   { id, mail_template_id }
// Overrides ALLEEN als de UI ze expliciet meegeeft:
//   recipient_email → recipients: { to: [{ email_address }] }
//   subject_override → subject
//   content_override → content
//
// Bij elke TL-fout: 422 met tl_request_payload + tl_response in de respons (geen Vercel-logs).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.send'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.send)' });

  const { invoice_id, mail_template_id, recipient_email, subject_override, content_override } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });
  if (!mail_template_id || !String(mail_template_id).trim()) return res.status(400).json({ error: 'mail_template_id vereist (kies een TL mail-template)' });

  try {
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, customer_id, tl_invoice_id, invoice_number, status').eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });

    // Minimal payload — TL's template doet de rest.
    const payload = {
      id: inv.tl_invoice_id,
      mail_template_id: String(mail_template_id).trim(),
    };
    // Optionele overrides — alleen toevoegen als de UI ze expliciet stuurde.
    const recEmail = (typeof recipient_email === 'string' && recipient_email.trim()) ? recipient_email.trim() : null;
    if (recEmail) payload.recipients = { to: [{ email_address: recEmail }] };
    if (typeof subject_override === 'string' && subject_override.trim()) payload.subject = subject_override.trim();
    if (typeof content_override === 'string' && content_override.trim()) payload.content = content_override.trim();

    // Sanity: id + mail_template_id moeten non-empty zijn (zou hier nooit lege strings hebben).
    for (const k of ['id', 'mail_template_id']) {
      if (!payload[k] || !String(payload[k]).trim()) return res.status(500).json({ error: `Interne fout: payload.${k} leeg`, tl_request_payload: payload });
    }

    console.log('[finance-invoice-send] payload', JSON.stringify(payload));

    let pr, prText = '', usedEndpoint = '/invoices.send';
    const tryEndpoint = async (path) => {
      console.log('[finance-invoice-send]', path);
      const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(payload) });
      const t = await r.text().catch(() => '');
      return { r, t };
    };
    try {
      ({ r: pr, t: prText } = await tryEndpoint('/invoices.send'));
      if (pr.status === 404) {
        console.warn('[finance-invoice-send] /invoices.send 404 → retry /invoices.sendEmail');
        usedEndpoint = '/invoices.sendEmail';
        ({ r: pr, t: prText } = await tryEndpoint('/invoices.sendEmail'));
      }
    } catch (netErr) {
      console.error('[finance-invoice-send] netwerk', netErr.message);
      return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message });
    }
    if (!pr.ok) {
      console.error('[finance-invoice-send] GEWEIGERD |', usedEndpoint, '| HTTP', pr.status, '| payload=', JSON.stringify(payload), '| response=', prText);
      return res.status(422).json({
        error: `Teamleader weigerde verzending (HTTP ${pr.status}).`,
        tl_status: pr.status, tl_endpoint: usedEndpoint,
        tl_request_payload: payload,
        tl_request_keys: Object.keys(payload),
        tl_response: prText,
      });
    }
    console.log('[finance-invoice-send] OK |', usedEndpoint, '| HTTP', pr.status);

    // Post-write sync-back: status kan na 'send' wijzigen (bv. draft → outstanding).
    let syncErr = null;
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { syncErr = e.message; console.error('[finance-invoice-send] post-sync', e.message); }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.send', entity_type: 'invoice', entity_id: inv.id,
        after_json: { mail_template_id: payload.mail_template_id, recipient_override: recEmail, tl_endpoint: usedEndpoint },
        reason_text: `Factuur ${inv.invoice_number} verzonden via Teamleader (template ${payload.mail_template_id})`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-send] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, tl_endpoint: usedEndpoint, sync_err: syncErr });
  } catch (e) {
    console.error('[finance-invoice-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
