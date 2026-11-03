// api/_lib/teamleader-invoice-pdf.js
//
// Haalt de factuur-PDF van een Teamleader-factuur op als Buffer, voor gebruik
// als e-mailbijlage (o.a. de dunning/wanbetaler-brieven). Hergebruikt de
// logica uit api/finance-invoice-pdf.js: TL /invoices.download geeft een
// kortlevende signed URL (data.data.location) terug; die downloaden we en
// leveren we als Buffer.
//
// FAIL-SOFT: geen tl_invoice_id, een concept-factuur, een 404 (NOT_IN_TL),
// een TL-storing of een download-fout → return null. De caller mag hier NOOIT
// op breken; de brief gaat dan zonder die ene bijlage de deur uit.

import fetch from 'node-fetch';
import { tlFetch } from './teamleader-token.js';

/**
 * fetchInvoicePdfBuffer(tlInvoiceId)
 *   → Promise<Buffer | null>
 *
 * @param {string|null} tlInvoiceId  Teamleader-factuur-id (invoices.tl_invoice_id).
 * @returns {Promise<Buffer|null>}   PDF-bytes, of null bij ontbreken/fout (fail-soft).
 */
export async function fetchInvoicePdfBuffer(tlInvoiceId) {
  const id = tlInvoiceId ? String(tlInvoiceId).trim() : '';
  if (!id) return null;

  try {
    // 1) Signed download-URL opvragen bij Teamleader.
    const r = await tlFetch('/invoices.download', {
      method: 'POST',
      body: JSON.stringify({ id, format: 'pdf' }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[teamleader-invoice-pdf] invoices.download HTTP', r.status, txt.slice(0, 160));
      return null;
    }
    const data = await r.json().catch(() => null);
    const url = data?.data?.location || data?.location || null;
    if (!url) {
      console.warn('[teamleader-invoice-pdf] geen location in TL-response voor', id);
      return null;
    }

    // 2) De (kortlevende) signed URL downloaden → Buffer.
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) {
      console.warn('[teamleader-invoice-pdf] PDF-download HTTP', pdfRes.status, 'voor', id);
      return null;
    }
    const arrayBuffer = await pdfRes.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    return buf.length ? buf : null;
  } catch (e) {
    console.warn('[teamleader-invoice-pdf] exception (fail-soft):', e?.message || e);
    return null;
  }
}
