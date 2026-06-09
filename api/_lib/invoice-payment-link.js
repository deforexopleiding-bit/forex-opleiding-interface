// api/_lib/invoice-payment-link.js
//
// Core fetch+cache logica voor TL invoice payment-link resolution.
// Wordt gebruikt door:
//   - api/finance-invoice-payment-link.js (HTTP endpoint, thin wrapper met auth)
//   - api/inbox-send-template.js (send-time lazy resolve voor factuur.betaal_link
//     wanneer template-mapping de key gebruikt)
//   - api/_lib/dunning-step-executors.js (C4.5 toekomstige integratie — zie TODO)
//
// Strategie (op basis van TL apiary-recon juni 2026):
//   1) Edge-case guards (geen TL-call):
//      - tl_invoice_id IS NULL          → throw NO_TL_LINK
//      - status IN concept/draft        → throw DRAFT_INVOICE
//      - status IN paid/credited        → throw STATUS_NO_LINK
//      - status writeoff                → throw STATUS_NO_LINK
//      - amount_total <= 0              → throw CREDIT_OR_ZERO
//   2) Cache-hit: payment_url IS NOT NULL EN payment_url_fetched_at jonger dan
//      CACHE_TTL → return cached (cache-bypass via opts.force).
//   3) Fresh fetch via TL /invoices.info (defensieve field-probe op
//      payment_url / public_url / web_url / online_payment.url — apiary
//      documenteert deze velden vandaag NIET, maar de probe blijft staan voor
//      het geval TL het toevoegt). Persist bij hit.
//   4) Fallback: TL /invoices.download (format=pdf) → tijdelijke signed PDF-URL
//      (~10 min geldig). Wordt NIET in DB gepersisteerd vanwege korte TTL.
//      Dit is de de-facto primary route vandaag.
//   5) Alles faalt → throw TL_NULL.
//
// Errors hebben een `.code` property zodat callers ze kunnen mappen op HTTP-
// statussen (endpoint) of fail-soft kunnen loggen (inbox-send-template).
//
// Error-codes:
//   - INVALID_INPUT     → ontbrekende invoice_id of niet-uuid
//   - INVOICE_NOT_FOUND → invoice-row niet gevonden
//   - NO_TL_LINK        → invoice heeft geen tl_invoice_id (lokale-only)
//   - DRAFT_INVOICE     → status concept/draft, geen invoice_number
//   - STATUS_NO_LINK    → status paid/credited/writeoff
//   - CREDIT_OR_ZERO    → amount_total <= 0
//   - TL_RATE_LIMITED   → TL 429 na retry
//   - TL_SERVER_ERROR   → TL 5xx
//   - TL_NULL           → TL leverde geen url (info-probe miss + download miss)
//   - LOOKUP_FAILED     → Supabase lookup faalde
//
// Geen permission-checks; callers moeten zelf authn/authz doen.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

const DEFAULT_CACHE_TTL_DAYS = 7;
const SKIP_STATUSES_DRAFT = new Set(['concept', 'draft']);
const SKIP_STATUSES_DONE = new Set(['paid', 'credited', 'writeoff']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvoicePaymentLinkError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'InvoicePaymentLinkError';
    this.code = code;
    this.detail = detail;
  }
}

function getCacheTtlMs() {
  const raw = process.env.FINANCE_PAYMENT_LINK_CACHE_TTL_DAYS;
  const days = parseInt(raw, 10);
  const eff = Number.isFinite(days) && days > 0 ? days : DEFAULT_CACHE_TTL_DAYS;
  return eff * 24 * 60 * 60 * 1000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickFirstNonEmpty(obj, paths) {
  if (!obj || typeof obj !== 'object') return null;
  for (const p of paths) {
    const segs = p.split('.');
    let cur = obj;
    for (const s of segs) {
      if (cur == null) { cur = null; break; }
      cur = cur[s];
    }
    if (cur != null && String(cur).trim()) return String(cur).trim();
  }
  return null;
}

async function probeInvoicesInfo(tlInvoiceId) {
  // Field-probe (TL apiary documenteert deze velden vandaag niet — defensief).
  let attempt = 0;
  for (;;) {
    let r;
    try {
      r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId }) });
    } catch (e) {
      console.error('[invoice-payment-link] invoices.info exception:', e.message);
      return { url: null, source: null, http: null, error: e.message };
    }
    if (r.ok) {
      const json = await r.json().catch(() => null);
      const data = json && json.data ? json.data : null;
      if (!data) return { url: null, source: null, http: r.status };
      const url = pickFirstNonEmpty(data, ['payment_url', 'public_url', 'web_url', 'online_payment.url']);
      if (!url) return { url: null, source: null, http: r.status };
      let chosen = 'tl_web_url';
      if (data.payment_url && String(data.payment_url).trim() === url) chosen = 'tl_payment_url';
      else if (data.public_url && String(data.public_url).trim() === url) chosen = 'tl_public_url';
      else if (data.web_url && String(data.web_url).trim() === url) chosen = 'tl_web_url';
      else if (data.online_payment && data.online_payment.url && String(data.online_payment.url).trim() === url) chosen = 'tl_online_payment';
      return { url, source: chosen, http: r.status };
    }
    if (r.status === 429 && attempt === 0) {
      attempt += 1;
      await sleep(2000);
      continue;
    }
    const txt = await r.text().catch(() => '');
    console.error('[invoice-payment-link] invoices.info HTTP', r.status, txt.slice(0, 200));
    return { url: null, source: null, http: r.status, error: txt.slice(0, 200) };
  }
}

async function probeInvoicesDownloadPdf(tlInvoiceId) {
  let attempt = 0;
  for (;;) {
    let r;
    try {
      r = await tlFetch('/invoices.download', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId, format: 'pdf' }) });
    } catch (e) {
      console.error('[invoice-payment-link] invoices.download exception:', e.message);
      return { url: null, expires: null, http: null, error: e.message };
    }
    if (r.ok) {
      const json = await r.json().catch(() => null);
      const url = json?.data?.location || json?.location || null;
      const expires = json?.data?.expires || null;
      return { url, expires, http: r.status };
    }
    if (r.status === 429 && attempt === 0) {
      attempt += 1;
      await sleep(2000);
      continue;
    }
    const txt = await r.text().catch(() => '');
    console.error('[invoice-payment-link] invoices.download HTTP', r.status, txt.slice(0, 200));
    return { url: null, expires: null, http: r.status, error: txt.slice(0, 200) };
  }
}

/**
 * Resolve een TL betaal/share URL voor een interne invoice met lazy cache.
 *
 * @param {string} invoiceId - uuid van invoices.id.
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - bypass cache.
 * @param {string|null} [opts.userId=null] - informational voor toekomstige audit (caller schrijft zelf audit).
 * @returns {Promise<{ payment_url: string, fetched_at: string|null, from_cache: boolean, tl_invoice_id: string, source: string, expires: string|null, persisted: boolean }>}
 * @throws {InvoicePaymentLinkError} met .code voor mapping naar HTTP statussen of fail-soft logging.
 */
export async function ensureInvoicePaymentLink(invoiceId, opts = {}) {
  const { force = false /*, userId = null */ } = opts || {};

  if (!invoiceId || typeof invoiceId !== 'string' || !UUID_RE.test(invoiceId)) {
    throw new InvoicePaymentLinkError('INVALID_INPUT', 'invoice_id (uuid) vereist');
  }

  // Invoice lookup (service-role: cache-update mag onafhankelijk van RLS).
  let inv;
  try {
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('id, tl_invoice_id, status, payment_url, payment_url_fetched_at, amount_total, amount_paid, invoice_number')
      .eq('id', invoiceId)
      .maybeSingle();
    if (error) {
      console.error('[invoice-payment-link] invoice lookup:', error.message);
      throw new InvoicePaymentLinkError('LOOKUP_FAILED', 'Invoice lookup faalde', error.message);
    }
    inv = data;
  } catch (e) {
    if (e instanceof InvoicePaymentLinkError) throw e;
    throw new InvoicePaymentLinkError('LOOKUP_FAILED', 'Invoice lookup exception', e.message);
  }
  if (!inv) {
    throw new InvoicePaymentLinkError('INVOICE_NOT_FOUND', 'Invoice niet gevonden');
  }

  // Edge-case guards (geen TL-call).
  if (!inv.tl_invoice_id) {
    throw new InvoicePaymentLinkError('NO_TL_LINK', 'Invoice heeft geen TL-koppeling (lokale-only invoice)');
  }
  const status = String(inv.status || '').toLowerCase();
  if (SKIP_STATUSES_DRAFT.has(status)) {
    throw new InvoicePaymentLinkError('DRAFT_INVOICE', 'Draft invoices hebben geen payment-link');
  }
  if (SKIP_STATUSES_DONE.has(status)) {
    throw new InvoicePaymentLinkError('STATUS_NO_LINK', `Invoice met status '${status}' heeft geen openstaande payment-link`);
  }
  const total = Number(inv.amount_total || 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new InvoicePaymentLinkError('CREDIT_OR_ZERO', 'Credit notes of nul-facturen hebben geen payment-link');
  }

  // Cache-check (tenzij force).
  const ttlMs = getCacheTtlMs();
  const fetchedAtMs = inv.payment_url_fetched_at ? new Date(inv.payment_url_fetched_at).getTime() : 0;
  const cacheFresh = !force
    && inv.payment_url
    && fetchedAtMs
    && (Date.now() - fetchedAtMs) < ttlMs;
  if (cacheFresh) {
    return {
      payment_url: inv.payment_url,
      fetched_at: inv.payment_url_fetched_at,
      from_cache: true,
      tl_invoice_id: inv.tl_invoice_id,
      source: 'cached',
      expires: null,
      persisted: false,
    };
  }

  // Fresh fetch — Laag 1: invoices.info field-probe.
  const probe = await probeInvoicesInfo(inv.tl_invoice_id);
  let resolvedUrl = probe.url || null;
  let resolvedSource = probe.source || null;
  let resolvedExpires = null;

  if (!resolvedUrl) {
    // Laag 2: invoices.download (signed PDF). NIET persisten (10 min TTL).
    const dl = await probeInvoicesDownloadPdf(inv.tl_invoice_id);
    if (dl.url) {
      resolvedUrl = dl.url;
      resolvedSource = 'tl_download_pdf';
      resolvedExpires = dl.expires || null;
    } else {
      const detail = probe.error || dl.error || null;
      const httpInfo = probe.http || dl.http || null;
      if (httpInfo === 429) {
        throw new InvoicePaymentLinkError('TL_RATE_LIMITED', 'TL rate-limited (429) na retry', detail);
      }
      if (httpInfo && httpInfo >= 500) {
        throw new InvoicePaymentLinkError('TL_SERVER_ERROR', `TL fetch failed (HTTP ${httpInfo})`, detail);
      }
      throw new InvoicePaymentLinkError('TL_NULL', 'TL leverde geen payment-link', detail);
    }
  }

  // Persist alleen als bron NIET de kortlevende PDF-URL is.
  let persisted = false;
  const newFetchedAt = new Date().toISOString();
  if (resolvedSource && resolvedSource !== 'tl_download_pdf') {
    try {
      const { error: updErr } = await supabaseAdmin
        .from('invoices')
        .update({ payment_url: resolvedUrl, payment_url_fetched_at: newFetchedAt })
        .eq('id', inv.id);
      if (updErr) {
        console.error('[invoice-payment-link] cache update fail:', updErr.message);
      } else {
        persisted = true;
      }
    } catch (e) {
      console.error('[invoice-payment-link] cache update exception:', e.message);
    }
  }

  return {
    payment_url: resolvedUrl,
    fetched_at: persisted ? newFetchedAt : null,
    from_cache: false,
    tl_invoice_id: inv.tl_invoice_id,
    source: resolvedSource,
    expires: resolvedExpires,
    persisted,
  };
}
