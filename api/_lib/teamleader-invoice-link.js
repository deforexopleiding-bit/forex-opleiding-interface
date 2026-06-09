// api/_lib/teamleader-invoice-link.js
//
// Resolver voor TL-betaal/public-share URL voor een factuur (Route A uit
// finance-4-recon.md): real-time fetch met lazy cache in
// public.invoices.payment_url + payment_url_fetched_at.
//
// Stappenplan per resolve:
//   1) Lees `invoices`-rij (id, tl_invoice_id, payment_url, payment_url_fetched_at).
//   2) Cache-hit: payment_url != NULL EN fetched_at < CACHE_TTL_MS oud → return cached.
//   3) Cache-miss/stale: POST /invoices.info met tl_invoice_id, probe in volgorde:
//        data.payment_url → data.public_url → data.web_url → data.online_payment.url
//      Eerste gevuld veld wint. Persist in invoices.payment_url + fetched_at = now().
//   4) Geen URL in TL response: fallback /invoices.download (PDF) → tijdelijke
//      signed URL. Wordt NIET in DB gepersisteerd (TTL ~10 min, te kort).
//   5) Alles faalt: return null.
//
// Bij TL 429/5xx: return cached URL als die er is (zelfs als ouder dan TTL),
// anders null + log de error.
//
// Bevat geen permission-checks; de caller moet zijn eigen requirePermission
// runnen vóór deze helper aan te roepen.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24u

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

/**
 * Resolve een betaal/public URL voor een interne invoice-rij.
 *
 * @param {object} invoice - Verwacht minimaal { id, tl_invoice_id, payment_url?, payment_url_fetched_at? }.
 * @returns {Promise<{ url: string|null, source: 'cached'|'tl_payment_url'|'tl_public_url'|'tl_web_url'|'tl_online_payment'|'tl_download_pdf'|null, expires: string|null, cached: boolean }>}
 */
export async function getInvoicePaymentLink(invoice) {
  if (!invoice || !invoice.id) {
    return { url: null, source: null, expires: null, cached: false };
  }

  const tlId = invoice.tl_invoice_id || null;
  const cachedUrl = invoice.payment_url || null;
  const fetchedAt = invoice.payment_url_fetched_at ? new Date(invoice.payment_url_fetched_at).getTime() : 0;
  const isFresh = cachedUrl && fetchedAt && (Date.now() - fetchedAt) < CACHE_TTL_MS;

  if (isFresh) {
    return { url: cachedUrl, source: 'cached', expires: null, cached: true };
  }

  // Geen tl_invoice_id → kan TL niet bevragen.
  if (!tlId) {
    return { url: cachedUrl || null, source: cachedUrl ? 'cached' : null, expires: null, cached: !!cachedUrl };
  }

  // 1) invoices.info: probe op meest waarschijnlijke veldnamen.
  try {
    const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlId }) });
    if (r.ok) {
      const json = await r.json().catch(() => null);
      const data = json && json.data ? json.data : null;
      if (data) {
        const url = pickFirstNonEmpty(data, [
          'payment_url',
          'public_url',
          'web_url',
          'online_payment.url',
        ]);
        if (url) {
          // Persist cache (fail-soft — als update faalt, retourneren we de URL nog steeds).
          const sourceMap = {
            payment_url: 'tl_payment_url',
            public_url: 'tl_public_url',
            web_url: 'tl_web_url',
            online_payment: 'tl_online_payment',
          };
          // Bepaal welk veld is gepakt zodat we 'source' correct kunnen labelen.
          let chosenSource = 'tl_web_url';
          if (data.payment_url && String(data.payment_url).trim() === url) chosenSource = 'tl_payment_url';
          else if (data.public_url && String(data.public_url).trim() === url) chosenSource = 'tl_public_url';
          else if (data.web_url && String(data.web_url).trim() === url) chosenSource = 'tl_web_url';
          else if (data.online_payment && data.online_payment.url && String(data.online_payment.url).trim() === url) chosenSource = 'tl_online_payment';

          try {
            const { error: updErr } = await supabaseAdmin
              .from('invoices')
              .update({ payment_url: url, payment_url_fetched_at: new Date().toISOString() })
              .eq('id', invoice.id);
            if (updErr) console.error('[teamleader-invoice-link] cache update fail:', updErr.message);
          } catch (e) {
            console.error('[teamleader-invoice-link] cache update exception:', e.message);
          }
          return { url, source: chosenSource, expires: null, cached: false };
        }
      }
    } else if (r.status === 429 || r.status >= 500) {
      // Throttle/server-error: fallback op cached (zelfs stale).
      const txt = await r.text().catch(() => '');
      console.error('[teamleader-invoice-link] invoices.info HTTP', r.status, txt.slice(0, 200));
      if (cachedUrl) return { url: cachedUrl, source: 'cached', expires: null, cached: true };
    } else {
      const txt = await r.text().catch(() => '');
      console.error('[teamleader-invoice-link] invoices.info HTTP', r.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.error('[teamleader-invoice-link] invoices.info exception:', e.message);
    if (cachedUrl) return { url: cachedUrl, source: 'cached', expires: null, cached: true };
  }

  // 2) Fallback: invoices.download (signed PDF URL, ~10 min geldig — NIET cachen).
  try {
    const dr = await tlFetch('/invoices.download', { method: 'POST', body: JSON.stringify({ id: tlId, format: 'pdf' }) });
    if (dr.ok) {
      const dj = await dr.json().catch(() => null);
      const url = dj?.data?.location || dj?.location || null;
      if (url) {
        return {
          url,
          source: 'tl_download_pdf',
          expires: dj?.data?.expires || null,
          cached: false,
        };
      }
    } else {
      const txt = await dr.text().catch(() => '');
      console.error('[teamleader-invoice-link] invoices.download HTTP', dr.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.error('[teamleader-invoice-link] invoices.download exception:', e.message);
  }

  // 3) Niets gevonden → return cached (stale) of null.
  if (cachedUrl) return { url: cachedUrl, source: 'cached', expires: null, cached: true };
  return { url: null, source: null, expires: null, cached: false };
}
