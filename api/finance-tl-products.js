// api/finance-tl-products.js
// GET ?q=&limit=&debug=1 → TL product-catalogus voor de Nieuwe-factuur modal.
// Primair: products.list. Fallback: distinct product_ids uit recente facturen (invoices.info)
// → products.info per id. Geeft `source` mee zodat we weten welk pad gebruikt is.
// Permission: finance.invoice.create. Read-only, geen DB-opslag.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { requirePermission } from './_lib/requirePermission.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  await sleep(150);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) { await sleep(2000 * Math.pow(2, attempt)); return tlCall(path, body, attempt + 1); }
  return r;
}

function normalize(p) {
  if (!p || !p.id) return null;
  return {
    id: p.id,
    name: p.name || p.description || '(zonder naam)',
    code: p.code || null,
    tax_rate_id: p.tax?.id || p.tax_rate?.id || null,
    unit_price: p.selling_price?.amount != null ? Number(p.selling_price.amount)
              : p.price?.amount != null ? Number(p.price.amount)
              : p.unit_price?.amount != null ? Number(p.unit_price.amount) : null,
    description: p.description || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.create'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.create)' });

  const q = req.query?.q ? String(req.query.q).trim() : null;
  const limit = Math.min(Math.max(Number(req.query?.limit) || 200, 1), 500);
  const debug = req.query?.debug === '1' || req.query?.debug === 'true';
  const debugInfo = {};

  try {
    // ── PAD 1: products.list (zonder filter → volledige bibliotheek).
    const body = { page: { size: Math.min(limit, 200), number: 1 } };
    if (q) body.filter = { term: q };
    const r = await tlCall('/products.list', body);
    const text = await r.text().catch(() => '');
    // Headers naar object (TL stuurt soms X-Api-Version, RateLimit, etc).
    const respHeaders = {};
    try { r.headers.forEach((v, k) => { respHeaders[k] = v; }); } catch {}
    if (!r.ok) {
      console.error('[finance-tl-products] products.list HTTP', r.status, '| headers=', JSON.stringify(respHeaders), '| body=', text.slice(0, 1000));
      debugInfo.products_list = { http: r.status, headers: respHeaders, raw: text, request_body: body };
    } else {
      let parsed = null; try { parsed = JSON.parse(text); } catch {}
      const data = parsed?.data || [];
      const meta = parsed?.meta || null;
      console.log('[finance-tl-products] products.list HTTP 200 | count=', data.length, '| meta=', JSON.stringify(meta), '| headers=', JSON.stringify(respHeaders));
      // Bij debug óf bij lege respons: stuur de volledige raw body + meta + headers + request mee.
      debugInfo.products_list = {
        http: r.status, count: data.length, meta, headers: respHeaders,
        request_body: body,
        raw_full: text,                                                    // VOLLEDIG, niet afgekapt
        sample: data[0] ? { id: data[0].id, name: data[0].name, keys: Object.keys(data[0]) } : null,
      };
      if (data.length) {
        const items = data.map(normalize).filter(Boolean);
        return res.status(200).json({ items, source: 'products.list', ...(debug ? { debug: debugInfo } : {}) });
      }
    }

    // ── PAD 2 (fallback): collect distinct product_ids uit recente facturen.
    console.log('[finance-tl-products] products.list LEEG → fallback via invoices');
    const { data: recent } = await supabaseAdmin.from('invoices')
      .select('tl_invoice_id').not('tl_invoice_id', 'is', null)
      .order('issue_date', { ascending: false }).limit(30);
    const tlInvoiceIds = (recent || []).map(x => x.tl_invoice_id).filter(Boolean);
    debugInfo.fallback_invoices_scanned = tlInvoiceIds.length;

    const seenProdIds = new Set();
    for (const tlInvId of tlInvoiceIds) {
      try {
        const ir = await tlCall('/invoices.info', { id: tlInvId });
        if (!ir.ok) continue;
        const info = (await ir.json()).data || {};
        for (const g of (info.grouped_lines || [])) for (const li of (g.line_items || [])) {
          const pid = li.product?.id || li.product_id;
          if (pid) seenProdIds.add(pid);
        }
        if (seenProdIds.size >= limit) break;
      } catch (e) { /* skip */ }
    }
    const prodIds = [...seenProdIds];
    debugInfo.fallback_distinct_product_ids = prodIds.length;

    const items = [];
    for (const pid of prodIds.slice(0, limit)) {
      try {
        const pr = await tlCall('/products.info', { id: pid });
        if (pr.ok) { const p = (await pr.json()).data; const n = normalize(p); if (n) items.push(n); }
      } catch (e) {}
    }

    // Optioneel: filter op zoekterm (lokaal).
    const filtered = q ? items.filter(it => (it.name || '').toLowerCase().includes(q.toLowerCase()) || (it.code || '').toLowerCase().includes(q.toLowerCase())) : items;

    return res.status(200).json({ items: filtered, source: 'invoices-fallback', ...(debug ? { debug: debugInfo } : (filtered.length === 0 ? { debug: debugInfo } : {})) });
  } catch (e) {
    console.error('[finance-tl-products]', e.message);
    return res.status(500).json({ error: e.message, debug: debugInfo });
  }
}
