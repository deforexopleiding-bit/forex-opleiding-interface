// api/finance-bank-transactions.js
// GET → gepagineerde lijst bank-transacties uit onze DB voor de Bank-tab.
// Permission: finance.bank.view.
//
// Query-params (alle optioneel):
//   from        ISO YYYY-MM-DD — transaction_date >= from
//   to          ISO YYYY-MM-DD — transaction_date <= to
//   direction   'in' | 'out' | 'all'  (default 'all')
//   min         minimum bedrag in cents (signed; voor 'in' filter is min positief)
//   max         maximum bedrag in cents
//   q           ILIKE-zoek op description / counterparty_name / counterparty_iban /
//               invoice_number (case-insensitive, multi-woord AND zoals klanten-search)
//   limit       default 100, clamp [1..500]
//   offset      default 0
//
// Response:
//   { items: [...], total, page_size, offset, has_more, kpis: { sum_in_cents, sum_out_cents, count_in, count_out } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.bank.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.view)' });
  }

  const q = req.query || {};
  const from = ISO_DATE_RE.test(String(q.from || '')) ? String(q.from) : null;
  const to   = ISO_DATE_RE.test(String(q.to   || '')) ? String(q.to)   : null;
  const direction = ['in', 'out', 'all'].includes(String(q.direction)) ? String(q.direction) : 'all';
  const min = Number.isFinite(Number(q.min)) ? Number(q.min) : null;
  const max = Number.isFinite(Number(q.max)) ? Number(q.max) : null;
  const search = String(q.q || '').trim();
  const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
  const offset = Math.max(0, Number(q.offset) || 0);

  try {
    let query = supabaseAdmin
      .from('bank_transactions')
      .select('id, eb_mutation_id, ledger_id, mutation_type, transaction_date, amount_cents, currency, description, counterparty_name, counterparty_iban, invoice_number, created_at', { count: 'exact' });

    if (from) query = query.gte('transaction_date', from);
    if (to)   query = query.lte('transaction_date', to);
    if (direction === 'in')  query = query.gt('amount_cents', 0);
    if (direction === 'out') query = query.lt('amount_cents', 0);
    if (min != null) query = query.gte('amount_cents', min);
    if (max != null) query = query.lte('amount_cents', max);

    // Multi-woord search analoog aan customers.js fix (PR #91): split op
    // whitespace, chain .or() per woord. Elke .or() doet OR over 4 kolommen.
    if (search) {
      const words = search.split(/\s+/).filter(Boolean);
      for (const w of words) {
        const esc = w.replace(/[,()]/g, ' ');
        const pat = `%${esc}%`;
        query = query.or(
          `description.ilike.${pat},counterparty_name.ilike.${pat},counterparty_iban.ilike.${pat},invoice_number.ilike.${pat}`
        );
      }
    }

    query = query
      .order('transaction_date', { ascending: false })
      .order('eb_mutation_id', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: items, error, count } = await query;
    if (error) throw new Error(error.message);

    // KPI's: aparte aggregate-call over dezelfde filter-set (geen pagination).
    // Geen Supabase server-side sum aggregate buiten count=exact, dus we tellen
    // alleen incl/out-counts en het sum-bedrag van de huidige page voor snelheid.
    const kpis = {
      sum_in_cents: 0, sum_out_cents: 0,
      count_in: 0, count_out: 0,
    };
    for (const r of (items || [])) {
      const a = Number(r.amount_cents) || 0;
      if (a > 0) { kpis.sum_in_cents += a;  kpis.count_in++;  }
      if (a < 0) { kpis.sum_out_cents += a; kpis.count_out++; }
    }

    return res.status(200).json({
      items: items || [],
      total: count || 0,
      page_size: limit,
      offset,
      has_more: (offset + (items?.length || 0)) < (count || 0),
      kpis,
    });
  } catch (e) {
    console.error('[finance-bank-transactions]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
