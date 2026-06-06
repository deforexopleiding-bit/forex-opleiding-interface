// api/finance-invoice-send.js
// POST → factuur (her)verzenden via TL invoices.send met server-side template-resolve.
// Permission: finance.invoice.send.
//
// Flow:
// 1. mail_template_id verplicht. Server haalt template op (mailTemplates.info, fallback list).
// 2. template.content.{subject, body} + template.language → platte payload velden.
// 3. UI overrides (recipient_email / subject_override / content_override) prevaleren.
// 4. Platte TL-shape: { id, email, subject, content, language, mail_template_id }
//    (GEEN recipients-object, GEEN body — TL viel daar op met "must be present").
//
// Bij elke TL-fout: 422 + tl_request_payload + tl_request_keys + tl_response.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';

// Haal de TL mail-template op via dezelfde bekend-werkende call als finance-mail-templates.js:
// /mailTemplates.list { filter: { type: 'invoice' }, page: { size: 200 } } + lokaal filteren op id.
// .info en filter.ids zijn nooit empirisch bewezen → niet meer proberen.
async function fetchTemplate(id) {
  const endpoint = '/mailTemplates.list';
  const filterUsed = { type: 'invoice' };
  const reqBody = { filter: filterUsed, page: { size: 200, number: 1 } };
  let r, text = '';
  try {
    r = await tlFetch(endpoint, { method: 'POST', body: JSON.stringify(reqBody) });
    text = await r.text().catch(() => '');
  } catch (netErr) {
    console.error('[finance-invoice-send] fetchTemplate netwerk', netErr.message);
    return { tpl: null, source: endpoint, diag: { endpoint, filter_used: filterUsed, http_status: 0, count_returned: 0, ids_seen_sample: [], tl_response_truncated: 'NETWERK: ' + netErr.message } };
  }
  if (!r.ok) {
    return { tpl: null, source: endpoint, diag: { endpoint, filter_used: filterUsed, http_status: r.status, count_returned: 0, ids_seen_sample: [], tl_response_truncated: text.slice(0, 2000) } };
  }
  let data = [];
  try { data = JSON.parse(text)?.data || []; } catch {}
  const tpl = data.find(t => t.id === id) || null;
  if (tpl) return { tpl, source: 'list+local-filter' };
  return {
    tpl: null,
    source: endpoint,
    diag: {
      endpoint, filter_used: filterUsed, http_status: r.status,
      count_returned: data.length,
      ids_seen_sample: data.slice(0, 5).map(t => t.id),
      tl_response_truncated: text.slice(0, 500),
    },
  };
}

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
      .select('id, customer_id, tl_invoice_id, invoice_number, status, customer:customers(email)').eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });

    // 1. Template ophalen + resolven.
    const tplId = String(mail_template_id).trim();
    const { tpl, source, diag } = await fetchTemplate(tplId);
    if (!tpl) {
      console.error('[finance-invoice-send] template niet gevonden', tplId, JSON.stringify(diag));
      return res.status(400).json({
        error: 'Kon mail-template niet vinden in Teamleader',
        template_id: tplId,
        template_fetch_diag: diag,
      });
    }
    const tplSubject = (tpl.content?.subject || tpl.subject || '').trim();
    const tplBody    = (tpl.content?.body    || tpl.body    || tpl.content?.html || '').trim();
    const tplLang    = tpl.language || null;
    const tplName    = tpl.name || tpl.title || null;
    console.log('[finance-invoice-send] template resolved | source:', source, '| name:', tplName, '| lang:', tplLang, '| has_subject:', !!tplSubject, '| body_chars:', tplBody.length);

    // 2. Resolve velden (UI overrides prevaleren).
    const recEmail = (typeof recipient_email === 'string' && recipient_email.trim())
      ? recipient_email.trim()
      : (inv.customer?.email || '').trim();
    const subjectFinal = (typeof subject_override === 'string' && subject_override.trim())
      ? subject_override.trim()
      : tplSubject;
    const bodyFinal = (typeof content_override === 'string' && content_override.trim())
      ? content_override.trim()
      : tplBody;
    const langFinal = tplLang || 'nl';

    // 3. Sanity (op de waarden die in beide shapes terechtkomen).
    const sanityValues = { id: inv.tl_invoice_id, email: recEmail, subject: subjectFinal, body: bodyFinal, language: langFinal, mail_template_id: tplId };
    for (const k of Object.keys(sanityValues)) {
      if (!sanityValues[k] || !String(sanityValues[k]).trim()) {
        return res.status(400).json({
          error: `Veld '${k}' is leeg (zou niet kunnen na template-resolve).`,
          template_source: source, template_name: tplName,
        });
      }
    }

    // 4. Cascade A/B over nesting van subject+body. TL is consistent met content:{subject,body}
    //    in mailTemplates, dus A is sterkste kandidaat. B (customer_message) als fallback.
    const usedEndpoint = '/invoices.send';
    const buildShape = (which) => {
      const base = { id: inv.tl_invoice_id, email: recEmail, language: langFinal, mail_template_id: tplId };
      const block = { subject: subjectFinal, body: bodyFinal };
      if (which === 'A') return { ...base, content: block };
      if (which === 'B') return { ...base, customer_message: block };
      throw new Error('Unknown shape ' + which);
    };

    const tryShape = async (which) => {
      const payload = buildShape(which);
      console.log(`[finance-invoice-send] try shape ${which}`, JSON.stringify(payload));
      const r = await tlFetch(usedEndpoint, { method: 'POST', body: JSON.stringify(payload) });
      const t = await r.text().catch(() => '');
      return { which, payload, http: r.status, ok: r.ok, response: t };
    };

    const attempts = [];
    let success = null;
    try {
      // Shape A
      const a = await tryShape('A');
      attempts.push({ shape: 'A', tl_request_payload: a.payload, tl_request_keys: Object.keys(a.payload), tl_status: a.http, tl_response: a.response });
      if (a.ok) success = a;
      // Bij 400/422 cascade naar B; andere statussen = hard error
      else if (a.http === 400 || a.http === 422) {
        console.warn('[finance-invoice-send] shape A geweigerd (HTTP', a.http, ') → cascade naar shape B');
        const b = await tryShape('B');
        attempts.push({ shape: 'B', tl_request_payload: b.payload, tl_request_keys: Object.keys(b.payload), tl_status: b.http, tl_response: b.response });
        if (b.ok) success = b;
      } else {
        // Niet-validatie status (401/403/404/429/5xx): direct hard error met diagnostiek.
        console.error('[finance-invoice-send] hard error shape A | HTTP', a.http, '| response=', a.response);
        return res.status(422).json({
          error: `Teamleader gaf onverwachte status (HTTP ${a.http}) op shape A — geen cascade.`,
          tl_status: a.http, tl_endpoint: usedEndpoint,
          tl_request_payload: a.payload, tl_request_keys: Object.keys(a.payload),
          tl_response: a.response,
          template_source: source, template_name: tplName,
        });
      }
    } catch (netErr) {
      console.error('[finance-invoice-send] netwerk', netErr.message);
      return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message });
    }

    if (!success) {
      console.error('[finance-invoice-send] BEIDE shapes geweigerd | attempts=', JSON.stringify(attempts));
      return res.status(422).json({
        error: 'Beide nesting-shapes geweigerd door Teamleader',
        tl_endpoint: usedEndpoint,
        template_source: source, template_name: tplName,
        attempts,
      });
    }
    console.log('[finance-invoice-send] OK | shape', success.which, '| HTTP', success.http);
    const shapeUsed = success.which;
    const payload = success.payload;

    // Post-write sync-back: status kan na 'send' wijzigen (draft → outstanding).
    let syncErr = null;
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { syncErr = e.message; console.error('[finance-invoice-send] post-sync', e.message); }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.send', entity_type: 'invoice', entity_id: inv.id,
        after_json: { mail_template_id: tplId, template_name: tplName, recipient_override: (recipient_email && recipient_email !== inv.customer?.email) ? recEmail : null, tl_endpoint: usedEndpoint, shape_used: shapeUsed },
        reason_text: `Factuur ${inv.invoice_number} verzonden via Teamleader (template ${tplName || tplId}, shape ${shapeUsed})`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-send] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, tl_endpoint: usedEndpoint, template_name: tplName, shape_used: shapeUsed, tl_request_payload: payload, sync_err: syncErr });
  } catch (e) {
    console.error('[finance-invoice-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
