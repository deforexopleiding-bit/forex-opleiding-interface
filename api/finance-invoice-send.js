// api/finance-invoice-send.js
// POST → factuur (her)verzenden via TL invoices.send. Permission: finance.invoice.send.
// TL-first + validate-first: faalt TL → 422 + volledige tl_response, GEEN DB-mutatie.
//
// Body (onze): { invoice_id, to?, subject?, content?, language? }
//
// TL invoices.send shape (iteratief vastgesteld via TL 400-fouten):
//   { id, email, subject, body, content, language }
// Body en content krijgen dezelfde plain-tekst (TL accepteert eerste try; pas aan als TL
// onderscheid maakt — log toont 'm dan).
// Fallback endpoint /invoices.sendEmail bij 404 op /invoices.send.
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

    // 2. Default-tekst — defensief: nooit lege strings naar TL. Helpers garanderen
    //    minstens een vaste fallback-string als bv. invoice_number onverwacht null is.
    const nonEmpty = (v, fb) => { const s = (v == null ? '' : String(v)).trim(); return s || fb; };
    const custName = customerDisplayName(inv.customer || {}, '');
    const aanhef = custName ? `Beste ${custName}` : 'Beste';
    const invNr = nonEmpty(inv.invoice_number, inv.tl_invoice_id);
    const defaultSubject = nonEmpty(`Factuur ${invNr} van De Forex Opleiding`, 'Uw factuur van De Forex Opleiding');
    const defaultContent = nonEmpty(
      `${aanhef},\n\nHierbij doen wij u factuur ${invNr} toekomen. U vindt deze in de bijlage.\n\nMet vriendelijke groet,\nDe Forex Opleiding`,
      'Beste,\n\nHierbij doen wij u onze factuur toekomen. U vindt deze in de bijlage.\n\nMet vriendelijke groet,\nDe Forex Opleiding'
    );

    // 3. TL body — platte shape. Garandeer NON-EMPTY voor alle verplichte velden.
    const subjectFinal = nonEmpty(subject, defaultSubject);
    const bodyTextFinal = nonEmpty(content, defaultContent);
    const payload = {
      id: inv.tl_invoice_id,
      email: recipientEmail,
      subject: subjectFinal,
      body: bodyTextFinal,         // plain begeleidende tekst
      content: bodyTextFinal,      // TL wil óók 'content' (zelfde tekst — splits als TL HTML vereist)
      language: String(language || 'nl'),
    };
    // Sanity-check: weiger lokaal als ook maar één verplicht veld leeg is (zou niet kunnen).
    for (const k of ['id', 'email', 'subject', 'body', 'content', 'language']) {
      if (!payload[k] || !String(payload[k]).trim()) {
        return res.status(500).json({ error: `Interne fout: payload.${k} leeg`, tl_request_payload: payload });
      }
    }

    const tryEndpoint = async (path) => {
      console.log('[finance-invoice-send]', path, 'payload', JSON.stringify(payload));
      const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(payload) });
      const t = await r.text().catch(() => '');
      return { r, t };
    };

    let pr, prText = '', usedEndpoint = '/invoices.send';
    try {
      ({ r: pr, t: prText } = await tryEndpoint('/invoices.send'));
      // Fallback naar invoices.sendEmail bij 404 (endpoint-rename in TL-versie).
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
      // ECHO de exacte payload terug in de response zodat we in Chrome direct zien wat de
      // wire-format was — geen Vercel-logs hoeven spitten.
      return res.status(422).json({
        error: `Teamleader weigerde verzending (HTTP ${pr.status}).`,
        tl_status: pr.status, tl_endpoint: usedEndpoint,
        tl_request_payload: payload,
        tl_request_keys: Object.keys(payload),
        tl_response: prText,
      });
    }
    console.log('[finance-invoice-send] OK |', usedEndpoint, '| HTTP', pr.status);

    // Post-write sync-back: status kan na 'send' wijzigen (bv. draft → outstanding bij eerste send).
    let syncErr = null;
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { syncErr = e.message; console.error('[finance-invoice-send] post-sync', e.message); }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.send', entity_type: 'invoice', entity_id: inv.id,
        after_json: { email: recipientEmail, subject: payload.subject, language: payload.language, tl_endpoint: usedEndpoint },
        reason_text: `Factuur ${inv.invoice_number} verzonden via Teamleader naar ${recipientEmail}`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-send] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, to: recipientEmail, tl_endpoint: usedEndpoint, sync_err: syncErr });
  } catch (e) {
    console.error('[finance-invoice-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
