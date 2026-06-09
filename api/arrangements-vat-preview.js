// api/arrangements-vat-preview.js
//
// GET -> live BTW-mix + totals voor een set facturen (D1.5 wizard UITSTEL preview).
// Permission: finance.arrangements.propose (lezen mag wie ook mag voorstellen —
// dezelfde rol-set; voorkomt een extra permission-key te beheren voor 1
// helper-endpoint).
//
// Query-params:
//   invoice_ids (comma-separated uuids, verplicht, min 1)
//
// Response 200:
//   {
//     vat_distribution: [{ vat_rate, total_amount_excl_vat }, ...],
//     total_excl_vat:    number,
//     total_incl_vat:    number,
//     total_outstanding: number,        // TL `total.due` per factuur, gesommeerd
//     invoice_count:     number
//   }
//
// Errors:
//   400  invoice_ids ontbreekt / ongeldig uuid / leeg na filter
//   401  niet geauthenticeerd
//   403  geen finance.arrangements.propose
//   404  factuur niet gevonden
//   500  TL invoices.info fout (zie console)
//
// Hergebruikt _lib/invoice-vat-mix.js. Geen DB-mutaties, geen audit-log
// (puur lookup). Veilig om client-side te pollen bij UI-wijzigingen — maar
// elke call doet N TL-requests, dus debounce in de UI is verstandig.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildVatDistribution, getInvoiceOutstandingTotals } from './_lib/invoice-vat-mix.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseInvoiceIds(raw) {
  if (!raw) return [];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.arrangements.propose'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.propose)' });
  }

  const q = req.query || {};
  const rawIds = parseInvoiceIds(q.invoice_ids);
  if (rawIds.length === 0) {
    return res.status(400).json({ error: 'invoice_ids (comma-separated uuids) vereist, min 1' });
  }

  // Dedup + uuid-validatie. Behoud volgorde voor reproduceerbare TL-calls.
  const seen = new Set();
  const invoiceIds = [];
  for (const id of rawIds) {
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: `Ongeldig invoice_id (uuid vereist): ${id}` });
    }
    if (!seen.has(id)) {
      seen.add(id);
      invoiceIds.push(id);
    }
  }

  try {
    // Pre-check: facturen bestaan + horen bij dezelfde klant. Anders is een
    // consolidate-payload semantisch onzin (klanten mengen).
    const { data: rows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, status')
      .in('id', invoiceIds);
    if (invErr) throw new Error('invoice-lookup: ' + invErr.message);
    const found = rows || [];
    if (found.length !== invoiceIds.length) {
      const foundSet = new Set(found.map((r) => r.id));
      const missing = invoiceIds.filter((id) => !foundSet.has(id));
      return res.status(404).json({ error: 'Factuur niet gevonden', missing });
    }
    const firstCustomerId = found[0].customer_id;
    const mixed = found.find((r) => r.customer_id !== firstCustomerId);
    if (mixed) {
      return res.status(400).json({
        error: 'Alle facturen moeten van dezelfde klant zijn (preview voor consolidate-payload)',
      });
    }

    // Twee TL-passes (vat_distribution + outstanding-totals) — beide hergebruiken
    // /invoices.info per factuur. De helper-module doet 150ms throttle tussen
    // calls om TL rate-limit te respecteren. Voor N <= 10 ruim binnen 60s budget.
    const [vatDistribution, totals] = await Promise.all([
      buildVatDistribution(supabaseAdmin, invoiceIds),
      getInvoiceOutstandingTotals(supabaseAdmin, invoiceIds),
    ]);

    return res.status(200).json({
      vat_distribution:  vatDistribution,
      total_excl_vat:    totals.total_excl_vat,
      total_incl_vat:    totals.total_incl_vat,
      total_outstanding: totals.total_outstanding,
      invoice_count:     invoiceIds.length,
    });
  } catch (e) {
    console.error('[arrangements-vat-preview]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
