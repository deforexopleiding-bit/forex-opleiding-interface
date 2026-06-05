// api/finance-invoice-late-fee.js
// GET ?invoice_id=<uuid> OF ?tl_invoice_id=<uuid> → incassokosten (Schadebeding/WIK) +
// "Totaal te betalen", lazy uit de factuur-PDF geparsed. Permission: finance.invoice.view.
//
// Alleen zinvol bij een TE-LATE factuur (open/partially_paid + due_date < vandaag). Anders
// of bij parse-fout → { fee_amount: null } (nooit foute data). Read-only, geen DB-mutatie.
// Bron is de PDF: TL's API-veld `late_fees` is in onze response NIET aanwezig (ook niet met
// X-Api-Version 2023-10-01), dus we parsen het document zelf.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { requirePermission } from './_lib/requirePermission.js';

// NL-bedragformaat: punt=duizendtal, komma=decimaal (1.234,56). amtRe negeert plakkend €.
const amtRe = /(\d{1,3}(?:[.  ]\d{3})*,\d{2})/;
const nlToNumber = (s) => (s ? Number(String(s).replace(/[.  ]/g, '').replace(',', '.')) : null);
const firstAmountAfter = (text, idx) => (idx >= 0 ? (text.slice(idx).match(amtRe)?.[1] || null) : null);

async function parsePdfFees(tlId) {
  const dr = await tlFetch('/invoices.download', { method: 'POST', body: JSON.stringify({ id: tlId, format: 'pdf' }) });
  if (!dr.ok) { console.error('[finance-late-fee] invoices.download HTTP', dr.status); return null; }
  let url = null; try { const j = JSON.parse(await dr.text()); url = j?.data?.location || j?.location || null; } catch {}
  if (!url) return null;
  let buf;
  try { const fr = await fetch(url); if (!fr.ok) return null; buf = Buffer.from(await fr.arrayBuffer()); } catch (e) { console.error('[finance-late-fee] pdf fetch', e.message); return null; }
  let text = '';
  try { const mod = await import('pdf-parse/lib/pdf-parse.js'); const pdfParse = mod.default || mod; text = (await pdfParse(buf)).text || ''; }
  catch (e) { console.error('[finance-late-fee] pdf-parse', e.message); return null; }

  // Incassokosten op het document = "Schadebeding" (WIK); fallback "Incassokosten".
  let fee_label = null, ci = text.search(/schadebeding/i);
  if (ci >= 0) fee_label = 'Schadebeding'; else { ci = text.search(/incassokosten/i); if (ci >= 0) fee_label = 'Incassokosten'; }
  const fee_amount = ci >= 0 ? nlToNumber(firstAmountAfter(text, ci)) : null;
  const tp = text.search(/totaal\s*te\s*betalen/i);
  const total_payable = tp >= 0 ? nlToNumber(firstAmountAfter(text, tp)) : null;
  return { fee_label, fee_amount, total_payable, currency: 'EUR' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });

  const invoiceId = req.query?.invoice_id || null;
  const tlq = req.query?.tl_invoice_id || null;
  if (!invoiceId && !tlq) return res.status(400).json({ error: 'invoice_id of tl_invoice_id vereist' });

  try {
    let q = supabaseAdmin.from('invoices').select('id, tl_invoice_id, status, due_date, amount_total, amount_paid');
    q = invoiceId ? q.eq('id', invoiceId) : q.eq('tl_invoice_id', tlq);
    const { data: inv } = await q.maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(200).json({ fee_amount: null });

    // Alleen voor te-late facturen (overdue = open/partially_paid + due_date < vandaag).
    const today = new Date().toISOString().slice(0, 10);
    const overdue = (inv.status === 'open' || inv.status === 'partially_paid') && inv.due_date && inv.due_date < today;
    if (!overdue) return res.status(200).json({ fee_amount: null, overdue: false });

    const parsed = await parsePdfFees(inv.tl_invoice_id);
    if (!parsed || !(Number(parsed.fee_amount) > 0)) return res.status(200).json({ fee_amount: null, overdue: true, source: 'pdf' });

    return res.status(200).json({
      fee_label: parsed.fee_label, fee_amount: parsed.fee_amount,
      total_payable: parsed.total_payable, currency: parsed.currency || 'EUR',
      source: 'pdf', overdue: true,
    });
  } catch (e) {
    console.error('[finance-invoice-late-fee]', e.message);
    return res.status(200).json({ fee_amount: null, error: e.message }); // nooit foute data / nooit UI blokkeren
  }
}
