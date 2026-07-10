// api/_lib/tl-invoice-send.js
//
// Gedeelde TL invoices.send-kern: template-fetch + payload-build + cascade
// A/B shape. Extractie van finance-invoice-send.js voor hergebruik door het
// mentor-resend-endpoint (mentor-student-invoice-resend.js).
//
// Bewuste keuze: finance-invoice-send.js is (nog) NIET geport naar deze
// helper — die functie werkt goed en heeft veel diagnostiek-branches die we
// niet willen refactoren in dezelfde PR waar we mentors introduceren. Enige
// duplicatie op de send-shape is acceptabel; als finance-invoice-send later
// gehaald wordt naar deze helper is de TL-shape-single-source-of-truth
// automatisch bereikt. Zie CLAUDE.md over blast-radius.
//
// Deze helper:
//   - is TL-only: geen supabase-writes, geen audit. Caller doet dat.
//   - resolvet template subject/body/language (of gebruikt overrides).
//   - probeert shape A (content:{subject,body}) → bij 400/422 shape B
//     (customer_message:{subject,body}). Andere non-ok = hard fail.
//
// throws { code, message, details? } object met code ∈:
//   TEMPLATE_NOT_FOUND | TL_HARD_ERROR | TL_NETWORK | TL_BOTH_SHAPES_REJECTED

import { tlFetch } from './teamleader-token.js';

async function fetchTemplate(mailTemplateId) {
  const endpoint = '/mailTemplates.list';
  const filterUsed = { type: 'invoice' };
  const reqBody = { filter: filterUsed, page: { size: 200, number: 1 } };
  let r, text = '';
  try {
    r = await tlFetch(endpoint, { method: 'POST', body: JSON.stringify(reqBody) });
    text = await r.text().catch(() => '');
  } catch (netErr) {
    throw Object.assign(new Error('TL netwerk: ' + netErr.message), { code: 'TL_NETWORK' });
  }
  if (!r.ok) {
    throw Object.assign(new Error(`TL mailTemplates.list HTTP ${r.status}`), {
      code: 'TEMPLATE_NOT_FOUND',
      details: { http_status: r.status, tl_response_truncated: text.slice(0, 500) },
    });
  }
  let data = [];
  try { data = JSON.parse(text)?.data || []; } catch {}
  const tpl = data.find((t) => t.id === mailTemplateId) || null;
  if (!tpl) {
    throw Object.assign(new Error(`Mail-template ${mailTemplateId} niet gevonden in TL`), {
      code: 'TEMPLATE_NOT_FOUND',
      details: { count_returned: data.length, ids_seen_sample: data.slice(0, 5).map((t) => t.id) },
    });
  }
  return tpl;
}

/**
 * Verstuur een factuur via TL invoices.send.
 *
 * @param {object} opts
 * @param {object} opts.invoice - Row uit invoices met tl_invoice_id + customer.email (verplicht).
 * @param {string} opts.mailTemplateId - TL mail-template id.
 * @param {string} [opts.recipientEmail] - override; default = invoice.customer.email.
 * @param {string} [opts.subjectOverride] - override; default = template subject.
 * @param {string} [opts.contentOverride] - override; default = template body.
 * @returns {Promise<{ ok:true, shape:'A'|'B', http:number, tl_endpoint:string,
 *                     template_name:string|null, payload:object,
 *                     recipient_email:string }>}
 */
export async function sendInvoiceViaTl({
  invoice,
  mailTemplateId,
  recipientEmail = null,
  subjectOverride = null,
  contentOverride = null,
}) {
  if (!invoice || !invoice.tl_invoice_id) {
    throw Object.assign(new Error('Factuur heeft geen tl_invoice_id'), { code: 'INVOICE_NO_TL_ID' });
  }
  if (!mailTemplateId || !String(mailTemplateId).trim()) {
    throw Object.assign(new Error('mail_template_id vereist'), { code: 'MAIL_TEMPLATE_REQUIRED' });
  }

  const tpl = await fetchTemplate(String(mailTemplateId).trim());
  const tplSubject = (tpl.content?.subject || tpl.subject || '').trim();
  const tplBody    = (tpl.content?.body    || tpl.body    || tpl.content?.html || '').trim();
  const tplLang    = tpl.language || null;
  const tplName    = tpl.name || tpl.title || null;

  const recEmail = (typeof recipientEmail === 'string' && recipientEmail.trim())
    ? recipientEmail.trim()
    : String(invoice.customer?.email || '').trim();
  const subjectFinal = (typeof subjectOverride === 'string' && subjectOverride.trim())
    ? subjectOverride.trim()
    : tplSubject;
  const bodyFinal = (typeof contentOverride === 'string' && contentOverride.trim())
    ? contentOverride.trim()
    : tplBody;
  const langFinal = tplLang || 'nl';

  const sanity = { id: invoice.tl_invoice_id, email: recEmail, subject: subjectFinal, body: bodyFinal, language: langFinal, mail_template_id: mailTemplateId };
  for (const k of Object.keys(sanity)) {
    if (!sanity[k] || !String(sanity[k]).trim()) {
      throw Object.assign(new Error(`Veld '${k}' is leeg na template-resolve.`), { code: 'RESOLVE_EMPTY_FIELD', details: { field: k } });
    }
  }

  const endpoint = '/invoices.send';
  const buildShape = (which) => {
    const base = { id: invoice.tl_invoice_id, email: recEmail, language: langFinal, mail_template_id: String(mailTemplateId).trim() };
    const block = { subject: subjectFinal, body: bodyFinal };
    if (which === 'A') return { ...base, content: block };
    return { ...base, customer_message: block };
  };

  const attempts = [];
  const tryShape = async (which) => {
    const payload = buildShape(which);
    const r = await tlFetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    const t = await r.text().catch(() => '');
    return { which, payload, http: r.status, ok: r.ok, response: t };
  };

  let success = null;
  try {
    const a = await tryShape('A');
    attempts.push({ shape: 'A', http: a.http, tl_response_truncated: (a.response || '').slice(0, 500) });
    if (a.ok) success = a;
    else if (a.http === 400 || a.http === 422) {
      const b = await tryShape('B');
      attempts.push({ shape: 'B', http: b.http, tl_response_truncated: (b.response || '').slice(0, 500) });
      if (b.ok) success = b;
    } else {
      throw Object.assign(new Error(`TL onverwachte status (HTTP ${a.http}) op shape A`), {
        code: 'TL_HARD_ERROR',
        details: { tl_endpoint: endpoint, tl_status: a.http, tl_response_truncated: (a.response || '').slice(0, 500), template_name: tplName },
      });
    }
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new Error('TL netwerk: ' + e.message), { code: 'TL_NETWORK' });
  }

  if (!success) {
    throw Object.assign(new Error('Beide TL invoices.send-shapes geweigerd'), {
      code: 'TL_BOTH_SHAPES_REJECTED',
      details: { tl_endpoint: endpoint, template_name: tplName, attempts },
    });
  }

  return {
    ok: true,
    shape: success.which,
    http: success.http,
    tl_endpoint: endpoint,
    template_name: tplName,
    payload: success.payload,
    recipient_email: recEmail,
  };
}
