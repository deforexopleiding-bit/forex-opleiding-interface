// api/finance-debug-invoice-raw.js
// ⚠️ TIJDELIJK / DEBUG — VERWIJDEREN VÓÓR MERGE.
// GET ?invoice_number=2026/781  OF  ?tl_invoice_id=<uuid>  (super_admin only).
// Read-only: resolve de tl_invoice_id (DB-lookup op factuurnummer) → invoices.info →
// dump de VOLLEDIGE raw JSON + een samenvatting (total + late_fees). GEEN DB-mutatie.
// Doel: de exacte late_fees/totalen-structuur op een echte factuur bevestigen.

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  let tlId = req.query?.tl_invoice_id || null;
  const invNr = req.query?.invoice_number || null;
  if (!tlId && !invNr) return res.status(400).json({ error: 'invoice_number of tl_invoice_id vereist' });

  try {
    let dbRow = null;
    if (!tlId && invNr) {
      // Tolerante match: "2026/781" → ilike "%2026%781%" (factuurnr staat als "2026 / 781").
      const pattern = '%' + String(invNr).trim().replace(/[^0-9a-zA-Z]+/g, '%') + '%';
      const { data } = await supabaseAdmin.from('invoices')
        .select('id, tl_invoice_id, invoice_number, amount_total, amount_paid, vat_amount, status, tl_department_id')
        .ilike('invoice_number', pattern).limit(5);
      const rows = data || [];
      dbRow = rows[0] || null;
      if (!dbRow) return res.status(404).json({ error: 'Geen factuur in onze DB', invoice_number: invNr, ilike_pattern: pattern });
      tlId = dbRow.tl_invoice_id;
      if (!tlId) return res.status(400).json({ error: 'Gevonden factuur heeft geen tl_invoice_id', db_row: dbRow });
    }

    const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlId }) });
    const text = await r.text().catch(() => '');
    if (!r.ok) return res.status(502).json({ error: `TL invoices.info HTTP ${r.status}`, tl_response: text, db_row: dbRow });

    let info = null;
    try { info = JSON.parse(text).data; } catch (e) { return res.status(502).json({ error: 'TL-respons niet parsebaar', raw_text: text.slice(0, 2000) }); }

    return res.status(200).json({
      tl_invoice_id: tlId,
      db_row: dbRow,
      summary: info ? {
        invoice_number: info.invoice_number,
        status: info.status,
        total: info.total,            // {tax_exclusive, tax_inclusive, payable, due, ...}
        late_fees: info.late_fees,    // verwacht: rente + incassokosten
        paid: info.paid,
        paid_at: info.paid_at,
      } : null,
      raw: info,                      // VOLLEDIGE raw invoices.info-data
    });
  } catch (e) {
    console.error('[finance-debug-invoice-raw]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
