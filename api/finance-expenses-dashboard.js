// api/finance-expenses-dashboard.js
// GET → drie aggregaties tegelijk voor het uitgaven-dashboard:
//   - by_category: totalen per categorie (identiek aan breakdown-endpoint)
//   - by_month:    chronologische maand-totalen (voor trend-grafiek)
//   - by_group:    { operational, partners, taxes } (voor 3-way split)
// Permission: finance.expenses.view. Read-only.
//
// KERN: gebruikt EXACT dezelfde tx-set en filter-logica als
// finance-expenses-breakdown zodat de grafiek-totalen exact matchen met
// de bestaande breakdown-tabel. Anders krijg je twee cijfers die niet
// kloppen en dat ondermijnt vertrouwen.
//
// Query-params (identiek aan breakdown):
//   from, to                       YYYY-MM-DD
//   source                         'all' | 'camt' | 'paypal'
//   include_internal               '1' → toon '(intern PayPal)'/'(leeg)'
//   include_internal_transfers     '1' → toon is_internal categorie tx
//   include_incoming               '1' → toon inkomsten
//
// Response:
//   { by_category: { categories: [...], uncategorized: {...} },
//     by_month:    [{ month, total_cents, tx_count }],
//     by_group:    { operational_cents, partners_cents, taxes_cents, ...counts },
//     total_expenses_cents,
//     period: { from, to } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { filterTransactionsForBreakdown } from './_lib/expenses-grouping.js';
import {
  aggregateByMonth,
  aggregateByGroup,
  aggregateByCategory,
} from './_lib/expenses-dashboard.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
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
    const source = ['all','camt','paypal'].includes(String(q.source || 'all'))
      ? String(q.source || 'all')
      : 'all';
    const includeInternal          = String(q.include_internal || '') === '1';
    const includeInternalTransfers = String(q.include_internal_transfers || '') === '1';
    const includeIncoming          = String(q.include_incoming || '') === '1';

    // Stap 1: fetch tx (chunked). Zelfde query-shape als breakdown.
    const CHUNK = 1000;
    const txs = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let qy = supabaseAdmin
        .from('camt_transactions')
        .select('id, booking_date, amount_cents, counterparty_name, source')
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

    // Stap 2: categorisaties (rule/manual only — ai_suggest telt niet).
    const cats = [];
    if (txs.length) {
      const ids = txs.map(t => t.id);
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { data } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('camt_transaction_id, category_id, source')
          .in('camt_transaction_id', slice)
          .in('source', ['rule', 'manual']);
        cats.push(...(data || []));
      }
    }
    const catByTxId = new Map(cats.map(c => [c.camt_transaction_id, { category_id: c.category_id }]));

    // Stap 3: category-metadata (voor is_internal + slug + label + color).
    const { data: allCats } = await supabaseAdmin
      .from('expense_categories')
      .select('id, slug, label, color, is_internal')
      .eq('is_active', true)
      .order('label');
    const catMetaById = new Map((allCats || []).map(c => [c.id, c]));

    // Stap 4: filter — IDENTIEK aan breakdown-endpoint. Interne overboekingen
    // uit (via is_internal), incoming uit, PayPal-CSV interne rijen uit.
    const filteredTxs = filterTransactionsForBreakdown(
      txs, catByTxId, catMetaById,
      { includeInternal, includeInternalTransfers, includeIncoming }
    );

    // Stap 5: drie aggregaties op dezelfde tx-set — totalen matchen exact.
    const byCategory = aggregateByCategory(filteredTxs, catByTxId, catMetaById);
    const byMonth    = aggregateByMonth(filteredTxs);
    const byGroup    = aggregateByGroup(filteredTxs, catByTxId, catMetaById);

    const totalExpenses = filteredTxs.reduce((s, t) => s + (Number(t.amount_cents) || 0), 0);

    return res.status(200).json({
      by_category:          byCategory,
      by_month:             byMonth,
      by_group:             byGroup,
      total_expenses_cents: totalExpenses,
      period:               { from, to },
      filters_applied:      { source, include_internal: includeInternal, include_internal_transfers: includeInternalTransfers, include_incoming: includeIncoming },
    });
  } catch (e) {
    console.error('[finance-expenses-dashboard]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
