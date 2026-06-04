// api/finance-invoice-pdf.js
// GET ?tl_invoice_id=<uuid> → tijdelijke TL-download-URL voor de factuur-PDF.
// Permission: finance.invoice.view. Read-only (geen TL-mutatie).
//
// Embedden van een PDF via <iframe src> kan geen Bearer-header meesturen; daarom
// geeft dit endpoint de (kortlevende) signed TL-URL terug als JSON, en opent de
// frontend die in een nieuw tabblad. Lukt het niet → frontend valt terug op de
// "Open in Teamleader"-knop.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch } from './_lib/teamleader-token.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });
  }

  const tlInvoiceId = req.query?.tl_invoice_id || null;
  if (!tlInvoiceId) return res.status(400).json({ error: 'tl_invoice_id vereist' });

  try {
    const r = await tlFetch('/invoices.download', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId, format: 'pdf' }) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[finance-invoice-pdf] invoices.download HTTP', r.status, txt.slice(0, 200));
      return res.status(502).json({ error: `TL invoices.download HTTP ${r.status}` });
    }
    const data = await r.json();
    // TL geeft doorgaans { data: { location, expires } }.
    const url = data?.data?.location || data?.location || null;
    if (!url) return res.status(502).json({ error: 'Geen download-URL in TL-response' });
    return res.status(200).json({ url, expires: data?.data?.expires || null });
  } catch (e) {
    console.error('[finance-invoice-pdf]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
