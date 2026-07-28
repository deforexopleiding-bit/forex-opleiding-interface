// api/finance-expenses-breakdown.js
// GET → som per categorie over een periode + totalen.
// Permission: finance.expenses.view.
//
// Query-params:
//   from, to        YYYY-MM-DD (periode)
//   source          'all' | 'camt' | 'paypal'
//   include_internal '1' → tel '(intern PayPal)'/'(leeg)' mee (default UIT)
//   include_incoming '1' → tel netto-positieve counterparties mee (default UIT)
//
// Response:
//   { categories: [{ id, slug, label, color, total_cents, tx_count, pct }],
//     uncategorized: { total_cents, tx_count, pct },
//     total_expenses_cents,
//     total_all_cents,
//     period: { from, to }
//   }
//
// Note: pct is o.b.v. |total_cents| / |total_expenses_cents| (absolute).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  filterTransactionsForBreakdown,
  computeBreakdown,
} from './_lib/expenses-grouping.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.expenses.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.expenses.view)' });
  }

  const q = req.query || {};
  const from = ISO_DATE_RE.test(String(q.from || '')) ? String(q.from) : null;
  const to   = ISO_DATE_RE.test(String(q.to   || '')) ? String(q.to)   : null;
  const source = ['all','camt','paypal'].includes(String(q.source || 'all')) ? String(q.source || 'all') : 'all';
  const includeInternal          = String(q.include_internal || '') === '1';
  const includeInternalTransfers = String(q.include_internal_transfers || '') === '1';
  const includeIncoming          = String(q.include_incoming || '') === '1';

  try {
    // Fetch alle relevante tx (chunked). Alleen non-Memo want die zijn al
    // niet in DB (parser filtert).
    const CHUNK = 1000;
    const txs = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let qy = supabaseAdmin
        .from('camt_transactions')
        .select('id, amount_cents, counterparty_name, source')
        .range(offset, offset + CHUNK - 1);
      if (from)             qy = qy.gte('booking_date', from);
      if (to)               qy = qy.lte('booking_date', to);
      if (source !== 'all') qy = qy.eq('source', source);
      const { data, error } = await qy;
      if (error) throw new Error('camt_transactions: ' + error.message);
      if (!data || data.length === 0) break;
      txs.push(...data);
      if (data.length < CHUNK) break;
      offset += CHUNK;
    }

    // Fetch categorisaties (VÓÓR filter, want interne-overboeking-filter heeft
    // categorie-info nodig om tx te herkennen). ai_suggest EXPLICIET UITSLUITEN:
    // die zijn voorstellen, tellen niet mee in totaal/breakdown.
    const cats = [];
    if (txs.length) {
      const ids = txs.map(t => t.id);
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { data } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('camt_transaction_id, category_id, source')
          .in('camt_transaction_id', slice)
          .in('source', ['rule', 'manual']);   // ← geen ai_suggest
        cats.push(...(data || []));
      }
    }
    const catByTxId = new Map(cats.map(c => [c.camt_transaction_id, { category_id: c.category_id }]));

    // Alle categorieën met is_internal-flag (voor labels + interne-filter).
    const { data: allCats } = await supabaseAdmin
      .from('expense_categories')
      .select('id, slug, label, color, is_internal')
      .eq('is_active', true)
      .order('label');
    const catMetaById = new Map((allCats || []).map(c => [c.id, c]));

    // Filter: intern + interne overboekingen + counterparty-groep incoming
    // (helper filtert nu op groep-niveau ipv per-tx zodat PayPal +Bij mee-net).
    const filteredTxs = filterTransactionsForBreakdown(
      txs, catByTxId, catMetaById,
      { includeInternal, includeInternalTransfers, includeIncoming }
    );

    // Aggregeer (pure helper — filtert interne categorieën uit output-lijst).
    const bd = computeBreakdown(filteredTxs, catByTxId, allCats || []);

    return res.status(200).json({
      categories: bd.categories,
      uncategorized: bd.uncategorized,
      total_expenses_cents: bd.totalAll,
      total_all_cents:      bd.totalAll,
      period:               { from, to },
    });
  } catch (e) {
    console.error('[finance-expenses-breakdown]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
