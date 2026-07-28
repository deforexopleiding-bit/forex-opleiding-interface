// api/finance-expenses-list.js
// GET → losse transactie-lijst voor detail-view per tegenpartij (of algemeen
// overzicht met filters). Bron: camt_transactions (source in camt+paypal).
// Permission: finance.expenses.view.
//
// Query-params (alle optioneel):
//   counterparty   exacte naam-match (na trim) — voor detail-view
//   from           YYYY-MM-DD
//   to             YYYY-MM-DD
//   source         'all' | 'camt' | 'paypal'
//   category       category_id UUID (filter op transacties met die categorie)
//   uncategorized  '1' → alleen tx zonder categorisatie
//   limit          default 100, clamp [1..500]
//   offset         default 0
//
// Response:
//   { items: [{ id, booking_date, amount_cents, currency, description,
//               counterparty_name, source, transaction_code, entry_reference,
//               category: {id, slug, label, color} | null,
//               category_source: 'rule' | 'manual' | null,
//               rule_id: uuid | null }],
//     total, has_more }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { excludePaypalFundingLegs } from './_lib/expenses-grouping.js';

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
  const counterparty = q.counterparty ? String(q.counterparty).trim() : null;
  const from = ISO_DATE_RE.test(String(q.from || '')) ? String(q.from) : null;
  const to   = ISO_DATE_RE.test(String(q.to   || '')) ? String(q.to)   : null;
  const source = ['all','camt','paypal'].includes(String(q.source || 'all')) ? String(q.source || 'all') : 'all';
  const categoryFilter = q.category ? String(q.category) : null;
  const onlyUncategorized = String(q.uncategorized || '') === '1';
  const limit  = Math.max(1, Math.min(500, Number(q.limit)  || 100));
  const offset = Math.max(0, Number(q.offset) || 0);

  try {
    // Base query op camt_transactions.
    let qy = supabaseAdmin
      .from('camt_transactions')
      .select('id, booking_date, amount_cents, currency, description, counterparty_name, source, transaction_code, entry_reference, end_to_end_id', { count: 'exact' })
      .order('booking_date', { ascending: false })
      .range(offset, offset + limit - 1);
    if (counterparty)     qy = qy.eq('counterparty_name', counterparty);
    if (from)             qy = qy.gte('booking_date', from);
    if (to)               qy = qy.lte('booking_date', to);
    if (source !== 'all') qy = qy.eq('source', source);
    const { data, error, count } = await qy;
    if (error) throw new Error('camt_transactions: ' + error.message);
    const txs = data || [];

    // Fetch categorisaties voor deze batch.
    let cats = [];
    if (txs.length) {
      const ids = txs.map(t => t.id);
      const { data: catData, error: catErr } = await supabaseAdmin
        .from('transaction_categorizations')
        .select('camt_transaction_id, category_id, source, rule_id')
        .in('camt_transaction_id', ids);
      if (catErr) console.warn('[expenses-list] cat fetch:', catErr.message);
      cats = catData || [];
    }
    const catByTxId = new Map(cats.map(c => [c.camt_transaction_id, c]));

    // Metadata voor labels.
    const catIds = Array.from(new Set(cats.map(c => c.category_id)));
    let catMetaById = new Map();
    if (catIds.length) {
      const { data: metaData } = await supabaseAdmin
        .from('expense_categories')
        .select('id, slug, label, color')
        .in('id', catIds);
      catMetaById = new Map((metaData || []).map(c => [c.id, c]));
    }

    // Post-filter voor uncategorized / category (in-app want camt_transactions
    // heeft geen categorisation-FK; we joinen in JS).
    const enrichedTxs = txs.map(t => {
      const cat = catByTxId.get(t.id);
      return {
        ...t,
        category:        cat ? (catMetaById.get(cat.category_id) || null) : null,
        category_source: cat ? cat.source : null,
        rule_id:         cat ? cat.rule_id : null,
      };
    });

    // ── PayPal-financieringslegs uitsluiten (GEEN netting) ──
    // Detail-popup toont dus de echte -Af-pasbetalingen (Twilio: -€38,31,
    // -€35,14, -€43,05 apart) zonder de +Overige-financierings-regels die
    // ernaast op de rekening staan. Vasthoudings-tegenboekingen worden aan
    // beide zijden verwijderd. Zie excludePaypalFundingLegs voor het exacte
    // signaal (ref-join via end_to_end_id → entry_reference).
    //
    // Wanneer counterparty gefilterd is (detail-view) werkt de ref-join binnen
    // die counterparty's tx-set. Voor de algemene lijst (zonder counterparty)
    // werkt de ref-join alleen als parent + child in dezelfde page-batch zitten;
    // dat is bijna altijd het geval want beide dragen dezelfde booking_date en
    // sorteren aan elkaar. Edge-case (leg buiten batch): leg blijft zichtbaar
    // maar staat expliciet als "PayPal – Overige (Bij)" naast een tegenpartij,
    // dus verwarring is beperkt.
    const filteredTxs = excludePaypalFundingLegs(enrichedTxs);

    const items = filteredTxs.filter(t => {
      if (onlyUncategorized && t.category) return false;
      if (categoryFilter && (!t.category || t.category.id !== categoryFilter)) return false;
      return true;
    });

    return res.status(200).json({
      items,
      total: count || items.length,
      has_more: (offset + items.length) < (count || 0),
      limit, offset,
    });
  } catch (e) {
    console.error('[finance-expenses-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
