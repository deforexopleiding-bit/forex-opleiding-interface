// api/finance-invoice-lines.js
// GET ?invoice_id=<uuid> OF ?tl_invoice_id=<uuid> → genormaliseerde factuurregels + totalen
// uit TL invoices.info (lazy, geen DB-opslag). Permission: finance.invoice.view. Read-only.
//
// Output:
//   { lines: [{ description, quantity, unit_price_excl, tax_rate, line_total_excl }],
//     totals: { excl, tax, incl, due }, currency }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch } from './_lib/teamleader-token.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}
// Reverse env-map: TL tax_rate_id → integer BTW% (zelfde envs als taxRateIdFor:
// TEAMLEADER_TAX_RATE_ID_<n>[_DEPT] + INTRA/OUTSIDE_EU → 0). Eén keer per request opbouwen.
function buildReverseTaxMap() {
  const map = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    const m = k.match(/^TEAMLEADER_TAX_RATE_ID_(\d+)(?:_[A-Z]+)?$/);
    if (m) { map[v] = Number(m[1]); continue; }
    if (/^TEAMLEADER_TAX_RATE_ID_(INTRA|OUTSIDE_EU)/.test(k)) map[v] = 0;
  }
  return map;
}
// BTW-tarief als fractie (0.21). TL line_item: li.tax.rate, li.tax_rate, of bij draft
// vaak alleen tax_rate_id zonder rate → fallback via env reverse-map.
function rateOf(li, taxMap) {
  if (li.tax && typeof li.tax.rate === 'number') return li.tax.rate;
  if (typeof li.tax_rate === 'number') return li.tax_rate;
  const id = li.tax_rate_id || (li.tax?.type === 'taxRate' ? li.tax?.id : null);
  if (id && taxMap[id] != null) return taxMap[id] / 100;  // env-map is percentage → fractie
  return null;
}
// Stukprijs EXCL btw, defensief over unit_price-shapes (object {amount,tax} of plat getal).
function unitExcl(li, taxMap) {
  const up = li.unit_price;
  let unit = null, incl = false;
  if (up && typeof up === 'object') { unit = Number(up.amount); incl = up.tax === 'including'; }
  else if (up != null && up !== '') unit = Number(up);
  if (!Number.isFinite(unit)) unit = Number(amt(li.total?.tax_exclusive) ?? amt(li.total) ?? 0);
  if (!Number.isFinite(unit)) unit = 0;
  const rt = rateOf(li, taxMap);
  if (incl && rt > 0) unit = unit / (1 + rt);
  return unit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });

  let tlId = req.query?.tl_invoice_id || null;
  const invoiceId = req.query?.invoice_id || null;
  if (!tlId && !invoiceId) return res.status(400).json({ error: 'invoice_id of tl_invoice_id vereist' });

  try {
    if (!tlId && invoiceId) {
      const { data: row } = await supabaseAdmin.from('invoices').select('tl_invoice_id').eq('id', invoiceId).maybeSingle();
      tlId = row?.tl_invoice_id || null;
    }
    if (!tlId) return res.status(200).json({ lines: [], totals: null, reason: 'geen tl_invoice_id' });

    const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlId }) });
    const text = await r.text().catch(() => '');
    if (!r.ok) { console.error('[finance-invoice-lines] invoices.info HTTP', r.status, text.slice(0, 200)); return res.status(502).json({ error: `TL invoices.info HTTP ${r.status}` }); }
    let inv = null; try { inv = JSON.parse(text).data; } catch { return res.status(502).json({ error: 'TL-respons niet parsebaar' }); }

    const taxMap = buildReverseTaxMap();
    const lines = [];
    for (const g of (inv.grouped_lines || [])) {
      for (const li of (g.line_items || [])) {
        const qty = Number(li.quantity) || 0;
        const ue = r2(unitExcl(li, taxMap));
        const rt = rateOf(li, taxMap);
        lines.push({
          description: li.description || '—',
          quantity: qty,
          unit_price_excl: ue,
          tax_rate: rt != null ? Math.round(rt * 100) : null,
          line_total_excl: r2(ue * qty),
        });
      }
    }

    const t = inv.total || {};
    const excl = amt(t.tax_exclusive);
    const incl = amt(t.tax_inclusive) ?? amt(t.payable);
    const due = amt(t.due);
    // BTW per tarief (TL: total.taxes of total.tax = lijst per tarief).
    const taxList = Array.isArray(t.taxes) ? t.taxes : (Array.isArray(t.tax) ? t.tax : []);
    const tax_rates = taxList.map(x => ({
      rate: (typeof x.rate === 'number') ? Math.round(x.rate * 100) : null,
      amount: r2(amt(x.tax) ?? amt(x.total) ?? amt(x.amount) ?? 0),
    })).filter(x => x.amount != null);
    const totals = {
      excl: excl != null ? r2(excl) : null,
      tax: (incl != null && excl != null) ? r2(incl - excl) : null,
      tax_rates,                                  // [] → UI valt terug op één Btw-regel
      incl: incl != null ? r2(incl) : null,
      due: due != null ? r2(due) : null,
    };

    return res.status(200).json({ lines, totals, currency: 'EUR' });
  } catch (e) {
    console.error('[finance-invoice-lines]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
