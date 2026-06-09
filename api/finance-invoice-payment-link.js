// api/finance-invoice-payment-link.js
// POST { invoice_id } [?force=true] → resolve TL betaal/share-URL met lazy cache.
//
// Permission: finance.invoice.view (read-side fetch; cache-update is intern).
//
// Strategie (op basis van TL-recon, juni 2026):
//   1) Cache-hit: invoices.payment_url IS NOT NULL EN payment_url_fetched_at
//      jonger dan CACHE_TTL_DAYS → direct returnen (geen TL-call, geen audit).
//      Cache-bypass mogelijk via ?force=true.
//   2) Fresh fetch via TL /invoices.info (defensieve field-probe op
//      payment_url / public_url / web_url / online_payment.url — apiary
//      documenteert deze velden vandaag NIET, maar de probe blijft staan
//      voor het geval TL het toevoegt).
//   3) Fallback: TL /invoices.download (format=pdf) → tijdelijke signed
//      PDF-URL (~10 min geldig). Dit is de de-facto primary route. PDF-URL
//      wordt NIET in DB gepersisteerd vanwege korte TTL.
//
// Edge-cases die early-returnen met 422 (geen TL-call):
//   - tl_invoice_id IS NULL          → lokale-only invoice, geen TL-koppeling.
//   - status IN concept/draft         → geen invoice_number, geen betaal-link.
//   - status IN paid/credited         → geen openstaand bedrag, geen betaal-link.
//   - amount_total <= 0               → credit note of nul-factuur.
//
// TL rate-limit (100 req/min) is geen risico op send-moment (1-call event).
// Bij 429 doen we 1 exponential-backoff retry, daarna 502.
//
// Response 200:
//   { payment_url, fetched_at, from_cache, tl_invoice_id, source?, expires? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';

const DEFAULT_CACHE_TTL_DAYS = 7;
const SKIP_STATUSES = new Set(['concept', 'draft', 'paid', 'credited', 'writeoff']);

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

function getCacheTtlMs() {
  const raw = process.env.FINANCE_PAYMENT_LINK_CACHE_TTL_DAYS;
  const days = parseInt(raw, 10);
  const eff = Number.isFinite(days) && days > 0 ? days : DEFAULT_CACHE_TTL_DAYS;
  return eff * 24 * 60 * 60 * 1000;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeInvoicesInfo(tlInvoiceId) {
  // Field-probe (TL apiary documenteert deze velden vandaag niet — defensief).
  // Returns { url, source } of { url: null }.
  let attempt = 0;
  for (;;) {
    let r;
    try {
      r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId }) });
    } catch (e) {
      console.error('[finance-invoice-payment-link] invoices.info exception:', e.message);
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
    console.error('[finance-invoice-payment-link] invoices.info HTTP', r.status, txt.slice(0, 200));
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
      console.error('[finance-invoice-payment-link] invoices.download exception:', e.message);
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
    console.error('[finance-invoice-payment-link] invoices.download HTTP', r.status, txt.slice(0, 200));
    return { url: null, expires: null, http: r.status, error: txt.slice(0, 200) };
  }
}

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
    // Lookup invoice (service-role: cache-update mag onafhankelijk van RLS).
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, tl_invoice_id, status, payment_url, payment_url_fetched_at, customer_id, amount_total, amount_paid, invoice_number')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) {
      console.error('[finance-invoice-payment-link] invoice lookup:', invErr.message);
      return res.status(500).json({ error: 'Invoice lookup faalde' });
    }
    if (!inv) return res.status(404).json({ error: 'Invoice niet gevonden' });

    // Edge-case guards (geen TL-call).
    if (!inv.tl_invoice_id) {
      return res.status(422).json({ error: 'Invoice heeft geen TL-koppeling (lokale-only invoice)' });
    }
    const status = String(inv.status || '').toLowerCase();
    if (SKIP_STATUSES.has(status)) {
      if (status === 'concept' || status === 'draft') {
        return res.status(422).json({ error: 'Draft invoices hebben geen payment-link' });
      }
      if (status === 'credited') {
        return res.status(422).json({ error: 'Credit notes hebben geen payment-link' });
      }
      if (status === 'paid' || status === 'writeoff') {
        return res.status(422).json({ error: `Invoice met status '${status}' heeft geen openstaande payment-link` });
      }
    }
    const total = Number(inv.amount_total || 0);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(422).json({ error: 'Credit notes of nul-facturen hebben geen payment-link' });
    }

    // Cache-check (tenzij force).
    const ttlMs = getCacheTtlMs();
    const fetchedAtMs = inv.payment_url_fetched_at ? new Date(inv.payment_url_fetched_at).getTime() : 0;
    const cacheFresh = !force
      && inv.payment_url
      && fetchedAtMs
      && (Date.now() - fetchedAtMs) < ttlMs;
    if (cacheFresh) {
      return res.status(200).json({
        payment_url: inv.payment_url,
        fetched_at: inv.payment_url_fetched_at,
        from_cache: true,
        tl_invoice_id: inv.tl_invoice_id,
      });
    }

    // Fresh fetch — Laag 1: invoices.info field-probe.
    const probe = await probeInvoicesInfo(inv.tl_invoice_id);
    let resolvedUrl = probe.url || null;
    let resolvedSource = probe.source || null;
    let resolvedExpires = null;
    let persisted = false;

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
          return res.status(502).json({ error: 'TL rate-limited (429) na retry', detail });
        }
        if (httpInfo && httpInfo >= 500) {
          return res.status(502).json({ error: `TL fetch failed (HTTP ${httpInfo})`, detail });
        }
        console.warn('[finance-invoice-payment-link] TL leverde geen payment-link voor', inv.invoice_number, 'http=', httpInfo);
        return res.status(502).json({ error: 'TL leverde geen payment-link', detail });
      }
    }

    // Persist alleen als bron NIET de kortlevende PDF-URL is.
    let newFetchedAt = new Date().toISOString();
    if (resolvedSource && resolvedSource !== 'tl_download_pdf') {
      const { error: updErr } = await supabaseAdmin
        .from('invoices')
        .update({ payment_url: resolvedUrl, payment_url_fetched_at: newFetchedAt })
        .eq('id', inv.id);
      if (updErr) {
        console.error('[finance-invoice-payment-link] cache update fail:', updErr.message);
      } else {
        persisted = true;
      }
    }

    // Audit-log (alleen bij fresh fetch). Fail-soft.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id,
        action: 'invoice.payment_link_fetched',
        entity_type: 'invoice',
        entity_id: inv.id,
        after_json: {
          invoice_id: inv.id,
          tl_invoice_id: inv.tl_invoice_id,
          payment_url: resolvedUrl,
          source: resolvedSource,
          forced: force,
          persisted,
        },
        reason_text: `Payment-link opgehaald voor ${inv.invoice_number} (source=${resolvedSource})`,
        ip_address: getClientIp(req),
      });
    } catch (e) {
      console.error('[finance-invoice-payment-link] audit:', e.message);
    }

    return res.status(200).json({
      payment_url: resolvedUrl,
      fetched_at: persisted ? newFetchedAt : null,
      from_cache: false,
      tl_invoice_id: inv.tl_invoice_id,
      source: resolvedSource,
      expires: resolvedExpires,
    });
  } catch (e) {
    console.error('[finance-invoice-payment-link]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
