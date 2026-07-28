// api/finance-expenses-counterparties.js
// GET → transacties gegroepeerd per counterparty_name met totaal, aantal
// tx en huidige categorie. Bron: camt_transactions (source in camt+paypal).
// Permission: finance.expenses.view.
//
// Query-params (alle optioneel):
//   from                  ISO YYYY-MM-DD — booking_date >= from
//   to                    ISO YYYY-MM-DD — booking_date <= to
//   source                'all' | 'camt' | 'paypal'  (default 'all')
//   category              category_id UUID; filter tegenpartijen die exact
//                         die categorie hebben
//   uncategorized         '1' → alleen tegenpartijen zonder categorie
//   include_internal      '1' → toon '(intern PayPal)' + '(leeg)'-groep
//                         (default: verbergen — analyse-besluit 4:
//                         'Vastgehouden - algemeen' is ruis)
//   include_incoming      '1' → toon ook counterparties met netto positief
//                         (klant-inkomsten). Default UIT: dit is de
//                         UITGAVEN-analyse.
//   sort                  'total_desc' (grootste NEGATIEF eerst — meest
//                         uitgegeven) | 'total_abs_desc' (grootste
//                         absoluut) | 'count_desc' | 'name_asc'
//                         Default 'total_desc'.
//
// Response:
//   { counterparties: [
//       { name, total_cents, tx_count, first_date, last_date,
//         category: { id, slug, label, color } | null,
//         category_source: 'rule' | 'manual' | null }
//     ],
//     total_count, filters_applied }
//
// Groepering: exacte match op counterparty_name (parser trimt al in DB).
// Categorie: als >50% van tx dezelfde categorie hebben → dat is de
// counterparty-categorie. Bij ties → null (verschillende overrides). In
// praktijk staat elke tx van 1 counterparty op dezelfde categorie (via
// rule); manual overrides zijn edge-cases.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  groupByCounterparty,
  buildCounterpartyRows,
  sortCounterparties,
  aiSuggestionsByCounterparty,
  EMPTY_NAME,
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
  const categoryFilter = q.category ? String(q.category) : null;
  const onlyUncategorized = String(q.uncategorized || '') === '1';
  const includeInternal          = String(q.include_internal || '') === '1';
  const includeInternalTransfers = String(q.include_internal_transfers || '') === '1';
  const includeIncoming          = String(q.include_incoming || '') === '1';
  const sort = ['total_desc','total_abs_desc','count_desc','name_asc'].includes(String(q.sort || '')) ? String(q.sort) : 'total_desc';

  try {
    // Stap 1: fetch tx-rijen (id, counterparty_name, amount_cents, booking_date, source).
    // Chunked-fetch via .range() met max-safe cap (500 per call is genoeg voor
    // een jaar PayPal-import ~2k rijen; groter → verhogen).
    const CHUNK = 1000;
    const txs = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let qy = supabaseAdmin
        .from('camt_transactions')
        .select('id, counterparty_name, amount_cents, booking_date, source')
        .order('booking_date', { ascending: false })
        .range(offset, offset + CHUNK - 1);
      if (from)             qy = qy.gte('booking_date', from);
      if (to)               qy = qy.lte('booking_date', to);
      if (source !== 'all') qy = qy.eq('source', source);
      const { data, error } = await qy;
      if (error) throw new Error('camt_transactions fetch: ' + error.message);
      if (!data || data.length === 0) break;
      txs.push(...data);
      if (data.length < CHUNK) break;
      offset += CHUNK;
    }

    // Stap 2: fetch alle categorisaties voor deze tx-ids.
    let cats = [];
    if (txs.length) {
      const ids = txs.map(t => t.id);
      // Chunked IN-query zodat we niet in PostgREST URL-lengte-cap lopen.
      const catChunks = [];
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { data, error } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('camt_transaction_id, category_id, source, ai_confidence, ai_reason')
          .in('camt_transaction_id', slice);
        if (error) {
          console.warn('[expenses-counterparties] tx_cat chunk fout:', error.message);
          continue;
        }
        catChunks.push(...(data || []));
      }
      cats = catChunks;
    }
    // Split: bevestigde categorisaties (rule/manual) vs ai_suggest.
    // catByTxId gaat naar groupByCounterparty (consensus) — bevat GEEN ai_suggest.
    // aiSuggestByTxId gaat naar aiSuggestionsByCounterparty (weergave-alleen).
    const catByTxId       = new Map();
    const aiSuggestByTxId = new Map();
    for (const c of cats) {
      if (c.source === 'ai_suggest') aiSuggestByTxId.set(c.camt_transaction_id, c);
      else                            catByTxId.set(c.camt_transaction_id, c);
    }

    // Stap 3: fetch categorie-metadata (labels/colors + is_internal-flag).
    const { data: allCats, error: catMetaErr } = await supabaseAdmin
      .from('expense_categories')
      .select('id, slug, label, color, is_internal');
    if (catMetaErr) throw new Error('expense_categories fetch: ' + catMetaErr.message);
    const catMetaById = new Map((allCats || []).map(c => [c.id, c]));

    // Stap 4: groepeer per counterparty_name (pure helper).
    const groups = groupByCounterparty(txs, catByTxId);

    // Stap 5: build + filter response-rijen (pure helper).
    const rowsUnsorted = buildCounterpartyRows(groups, catMetaById, {
      includeInternal,
      includeInternalTransfers,
      includeIncoming,
      onlyUncategorized,
      categoryFilter,
    });

    // Stap 6: sort (pure helper).
    const rows = sortCounterparties(rowsUnsorted, sort);

    // Stap 7: hang AI-suggesties aan de output. Alleen counterparties die nog
    // niet bevestigd zijn (category=null in row) krijgen een ai_suggestion-veld.
    // Rijen die al een 'echte' categorie hebben tonen die; de suggestie is dan
    // irrelevant (er is al een keuze).
    const aiByName = aiSuggestionsByCounterparty(
      // Filter tx op zichtbare counterparties (efficiency).
      txs.filter(t => rows.some(r => r.name === String(t.counterparty_name || EMPTY_NAME).trim())),
      aiSuggestByTxId
    );
    for (const row of rows) {
      if (row.category) { row.ai_suggestion = null; continue; }
      const sug = aiByName.get(row.name);
      if (!sug) { row.ai_suggestion = null; continue; }
      const meta = catMetaById.get(sug.category_id);
      if (!meta) { row.ai_suggestion = null; continue; }
      row.ai_suggestion = {
        category:       meta,
        confidence:     sug.avg_confidence,
        reason:         sug.sample_reason,
        tx_count:       sug.tx_count,
      };
    }

    return res.status(200).json({
      counterparties: rows,
      total_count: rows.length,
      filters_applied: { from, to, source, category: categoryFilter, uncategorized: onlyUncategorized, include_internal: includeInternal, include_internal_transfers: includeInternalTransfers, include_incoming: includeIncoming, sort },
    });
  } catch (e) {
    console.error('[finance-expenses-counterparties]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
