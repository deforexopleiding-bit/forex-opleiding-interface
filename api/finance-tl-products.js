// api/finance-tl-products.js
// GET ?q=&limit= → TL products.list (sellable items voor handmatige factuur).
// Permission: finance.invoice.create. Read-only passthrough; geen DB-opslag.

import { createUserClient } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.create'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.create)' });

  const q = req.query?.q ? String(req.query.q).trim() : null;
  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);

  try {
    const body = { page: { size: limit, number: 1 } };
    if (q) body.filter = { term: q };
    const r = await tlFetch('/products.list', { method: 'POST', body: JSON.stringify(body) });
    const text = await r.text().catch(() => '');
    if (!r.ok) { console.error('[finance-tl-products] products.list HTTP', r.status, text.slice(0, 200)); return res.status(502).json({ error: `TL products.list HTTP ${r.status}`, tl_response: text }); }
    const data = JSON.parse(text).data || [];
    // Genormaliseerd: id + naam + (optioneel) tax_rate_id + standaardprijs.
    const items = data.map(p => ({
      id: p.id, name: p.name || '(zonder naam)', code: p.code || null,
      tax_rate_id: p.tax?.id || p.tax_rate?.id || null,
      unit_price: p.selling_price?.amount != null ? Number(p.selling_price.amount) : (p.price?.amount != null ? Number(p.price.amount) : null),
      description: p.description || null,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    console.error('[finance-tl-products]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
