// api/finance-debug-invoice-raw.js
// ⚠️ TIJDELIJK / DEBUG — VERWIJDEREN VÓÓR MERGE.
// GET ?invoice_number=2026/781  OF  ?tl_invoice_id=<uuid>  [&api_version=2023-10-01]
// super_admin only. Read-only: resolve tl_invoice_id → invoices.info (baseline ZONDER
// X-Api-Version + upgraded MET X-Api-Version) + invoices.list, en dump total + late_fees.
//
// Achtergrond: tlFetch stuurt geen X-Api-Version → onze integratie zit op de gepinde
// (oudere) versie. `late_fees` is toegevoegd in versie 2023-10-01 (nieuwste TL-versie).
// Door X-Api-Version: 2023-10-01 mee te sturen zou het incassokosten-veld moeten verschijnen.

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';

const DEFAULT_VERSION = '2023-10-01';

// invoices.info met optionele X-Api-Version; geeft status + gebruikte versie + data/error terug.
async function callInfo(tlId, version) {
  const headers = version ? { 'X-Api-Version': version } : {};
  const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlId }), headers });
  const text = await r.text().catch(() => '');
  let data = null; try { data = JSON.parse(text).data; } catch {}
  return { ok: r.ok, status: r.status, version_header_resp: r.headers.get('x-api-version') || null, data, error: r.ok ? null : text.slice(0, 400) };
}

// Haal de factuur-PDF server-side op (zelfde flow als finance-invoice-pdf.js) en
// extraheer de tekst — stabiel via onze OAuth-token (geen browser/CORS/30s-expiry).
async function fetchPdfText(tlId) {
  const dr = await tlFetch('/invoices.download', { method: 'POST', body: JSON.stringify({ id: tlId, format: 'pdf' }) });
  const dtext = await dr.text().catch(() => '');
  if (!dr.ok) return { ok: false, error: `invoices.download HTTP ${dr.status}: ${dtext.slice(0, 200)}` };
  let url = null; try { const j = JSON.parse(dtext); url = j?.data?.location || j?.location || null; } catch {}
  if (!url) return { ok: false, error: 'geen download-URL in TL-response', raw: dtext.slice(0, 200) };

  let buf;
  try {
    const fr = await fetch(url);
    if (!fr.ok) return { ok: false, error: `PDF-fetch HTTP ${fr.status}` };
    buf = Buffer.from(await fr.arrayBuffer());
  } catch (e) { return { ok: false, error: 'PDF-fetch fout: ' + e.message }; }

  let text = '';
  try {
    const mod = await import('pdf-parse/lib/pdf-parse.js'); // lib-pad omzeilt index.js debug-code
    const pdfParse = mod.default || mod;
    const parsed = await pdfParse(buf);
    text = parsed.text || '';
  } catch (e) { return { ok: false, error: 'pdf-parse fout: ' + e.message, bytes: buf.length }; }

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // NL-bedragformaat: punt = duizendtal, komma = decimaal (bv 1.234,56).
  const amtRe = /(\d{1,3}(?:[.  ]\d{3})*,\d{2})/;
  const nlToNumber = (s) => s ? Number(String(s).replace(/[.  ]/g, '').replace(',', '.')) : null;
  const firstAmountAfter = (idx) => (idx >= 0 ? (text.slice(idx).match(amtRe)?.[1] || null) : null);

  // 1. Incassokosten-sectie: ~300 tekens ervoor + erna + eerste bedrag erna.
  const ciIdx = text.search(/incassokosten/i);
  const incasso_section = ciIdx >= 0 ? text.slice(Math.max(0, ciIdx - 300), ciIdx + 300).replace(/\s+/g, ' ').trim() : null;
  const incasso_amount_raw = firstAmountAfter(ciIdx);

  // 2. Alle 'Totaal'-voorkomens met snippet + bedrag; eindtotaal = match met 'betalen', anders laatste.
  const totaalMatches = [];
  const reTot = /totaal/gi; let mm;
  while ((mm = reTot.exec(text)) && totaalMatches.length < 15) {
    const at = mm.index;
    totaalMatches.push({ snippet: text.slice(at, at + 140).replace(/\s+/g, ' ').trim(), amount_raw: firstAmountAfter(at) });
  }
  const payableMatch = totaalMatches.find(t => /betalen/i.test(t.snippet) && t.amount_raw) || [...totaalMatches].reverse().find(t => t.amount_raw) || null;
  const total_payable_raw = payableMatch?.amount_raw || null;

  return {
    ok: true, bytes: buf.length, chars: text.length,
    has_incasso: /incasso/i.test(text),
    has_incassokosten: /incassokosten/i.test(text),
    has_440: /\b440\b/.test(text) || /440[.,]00/.test(text),
    has_40_00: /\b40[.,]00\b/.test(text),
    // Gerichte totalen-parse (ter verificatie naast de ruwe sectie).
    incasso_section,
    incasso_amount_raw, incasso_amount: nlToNumber(incasso_amount_raw),     // verwacht 40
    total_payable_raw, total_payable: nlToNumber(total_payable_raw),        // verwacht 440
    totaal_matches: totaalMatches,
    currency: /€|EUR/.test(text) ? 'EUR' : null,
    format_note: 'NL-formaat: punt=duizendtal, komma=decimaal (1.234,56). Euroteken doorgaans vóór het bedrag.',
    tail_lines: lines.slice(-15),
    head_snippet: text.slice(0, 2000),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  let tlId = req.query?.tl_invoice_id || null;
  const invNr = req.query?.invoice_number || null;
  const apiVersion = req.query?.api_version || DEFAULT_VERSION;
  if (!tlId && !invNr) return res.status(400).json({ error: 'invoice_number of tl_invoice_id vereist' });

  const sumOf = (d) => d ? { invoice_number: d.invoice_number, status: d.status, total: d.total, late_fees: d.late_fees, paid: d.paid, paid_at: d.paid_at } : null;

  try {
    let dbRow = null;
    if (!tlId && invNr) {
      const pattern = '%' + String(invNr).trim().replace(/[^0-9a-zA-Z]+/g, '%') + '%';
      const { data } = await supabaseAdmin.from('invoices')
        .select('id, tl_invoice_id, invoice_number, amount_total, amount_paid, status').ilike('invoice_number', pattern).limit(5);
      dbRow = (data || [])[0] || null;
      if (!dbRow) return res.status(404).json({ error: 'Geen factuur in onze DB', invoice_number: invNr, ilike_pattern: pattern });
      tlId = dbRow.tl_invoice_id;
    }
    if (!tlId) return res.status(400).json({ error: 'Geen tl_invoice_id' });

    // 1. Baseline (geen X-Api-Version → onze gepinde versie).
    const baseline = await callInfo(tlId, null);
    // 2. Upgraded (expliciete recente versie).
    const upgraded = await callInfo(tlId, apiVersion);

    // 3. invoices.list (1 factuur) met dezelfde recente versie — late_fees per-item?
    let listItem = null, listErr = null, listVersionResp = null;
    try {
      const lr = await tlFetch('/invoices.list', { method: 'POST', body: JSON.stringify({ filter: { ids: [tlId] }, page: { size: 1, number: 1 } }), headers: { 'X-Api-Version': apiVersion } });
      listVersionResp = lr.headers.get('x-api-version') || null;
      const ltext = await lr.text().catch(() => '');
      if (lr.ok) { const arr = (JSON.parse(ltext).data) || []; listItem = arr[0] || null; }
      else listErr = `HTTP ${lr.status}: ${ltext.slice(0, 300)}`;
    } catch (e) { listErr = e.message; }

    // 4. PDF-document server-side ophalen + tekst extraheren (staat de €40 op de factuur zelf?).
    const pdf = await fetchPdfText(tlId).catch(e => ({ ok: false, error: e.message }));

    return res.status(200).json({
      tl_invoice_id: tlId,
      db_row: dbRow,
      pdf,
      requested_api_version: apiVersion,
      current_pinned_version: baseline.version_header_resp,   // versie die TL ZONDER header gebruikte
      baseline: { ok: baseline.ok, status: baseline.status, version_used: baseline.version_header_resp, summary: sumOf(baseline.data), error: baseline.error },
      upgraded: { ok: upgraded.ok, status: upgraded.status, version_used: upgraded.version_header_resp, summary: sumOf(upgraded.data), error: upgraded.error },
      list_with_version: { version_used: listVersionResp, summary: sumOf(listItem), late_fees: listItem ? listItem.late_fees : null, error: listErr },
      raw_upgraded: upgraded.data,   // VOLLEDIGE raw invoices.info op de upgraded versie
    });
  } catch (e) {
    console.error('[finance-debug-invoice-raw]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
