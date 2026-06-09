// api/finance-invoice-payment-link.js
// POST { invoice_id } [?force=true] → resolve TL betaal/share-URL met lazy cache.
//
// Permission: finance.invoice.view (read-side fetch; cache-update is intern).
//
// Thin HTTP-wrapper rond api/_lib/invoice-payment-link.js:ensureInvoicePaymentLink.
// Core fetch/cache-logica + edge-case guards + TL-probes leven in de helper, zodat
// inbox-send-template (en straks de dunning-executor — C4.5) dezelfde resolver
// kunnen hergebruiken zonder HTTP-overhead.
//
// Error-code → HTTP-status mapping:
//   INVALID_INPUT     → 400
//   INVOICE_NOT_FOUND → 404
//   NO_TL_LINK        → 422 (lokale-only invoice)
//   DRAFT_INVOICE     → 422 (concept/draft)
//   STATUS_NO_LINK    → 422 (paid/credited/writeoff)
//   CREDIT_OR_ZERO    → 422 (nul-factuur / credit-note)
//   TL_RATE_LIMITED   → 502
//   TL_SERVER_ERROR   → 502
//   TL_NULL           → 502 (TL leverde geen url)
//   LOOKUP_FAILED     → 500
//
// Response 200:
//   { payment_url, fetched_at, from_cache, tl_invoice_id, source?, expires? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { ensureInvoicePaymentLink, InvoicePaymentLinkError } from './_lib/invoice-payment-link.js';

const ERROR_CODE_TO_HTTP = {
  INVALID_INPUT: 400,
  INVOICE_NOT_FOUND: 404,
  NO_TL_LINK: 422,
  DRAFT_INVOICE: 422,
  STATUS_NO_LINK: 422,
  CREDIT_OR_ZERO: 422,
  TL_RATE_LIMITED: 502,
  TL_SERVER_ERROR: 502,
  TL_NULL: 502,
  LOOKUP_FAILED: 500,
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });
  }

  // Input.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const invoiceId = body.invoice_id || null;
  if (!invoiceId || typeof invoiceId !== 'string') {
    return res.status(400).json({ error: 'invoice_id (uuid) vereist in body' });
  }
  const force = String(req.query?.force || '').toLowerCase() === 'true';

  try {
    let result;
    try {
      result = await ensureInvoicePaymentLink(invoiceId, { force, userId: user.id });
    } catch (e) {
      if (e instanceof InvoicePaymentLinkError) {
        const http = ERROR_CODE_TO_HTTP[e.code] || 500;
        const out = { error: e.message };
        if (e.detail) out.detail = e.detail;
        return res.status(http).json(out);
      }
      throw e;
    }

    // Audit-log (alleen bij fresh fetch — cached returnt zonder audit-event).
    // Fail-soft: audit-fail blokkeert response niet.
    if (!result.from_cache) {
      try {
        await supabaseAdmin.from('audit_log').insert({
          user_id: user.id,
          action: 'invoice.payment_link_fetched',
          entity_type: 'invoice',
          entity_id: invoiceId,
          after_json: {
            invoice_id: invoiceId,
            tl_invoice_id: result.tl_invoice_id,
            payment_url: result.payment_url,
            source: result.source,
            forced: force,
            persisted: result.persisted,
          },
          reason_text: `Payment-link opgehaald (source=${result.source})`,
          ip_address: getClientIp(req),
        });
      } catch (e) {
        console.error('[finance-invoice-payment-link] audit:', e.message);
      }
    }

    return res.status(200).json({
      payment_url: result.payment_url,
      fetched_at: result.fetched_at,
      from_cache: result.from_cache,
      tl_invoice_id: result.tl_invoice_id,
      source: result.source,
      expires: result.expires,
    });
  } catch (e) {
    console.error('[finance-invoice-payment-link]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
