// api/finance-bank-camt-transactions.js
// GET → gepagineerde lijst CAMT-transacties + KPI's voor de nieuwe Bank-tab.
// Permission: finance.bank.transactions_view.
//
// Query-params:
//   from        YYYY-MM-DD — booking_date >= from
//   to          YYYY-MM-DD — booking_date <= to
//   direction   'in' | 'out' | 'all'
//                 IN  = amount_cents > 0 (credit)
//                 OUT = amount_cents < 0 (debit)
//                 Hier is sign-based filteren wèl betrouwbaar: CAMT levert
//                 direction expliciet via CdtDbtInd zonder ambigu type-enum.
//   min/max     cents-range op amount_cents
//   q           multi-woord search op description/counterparty_name/iban/end_to_end_id
//   limit       default 100, clamp [1..500]
//   offset      default 0
//
// Response: { items, total, page_size, offset, has_more, kpis }

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
  if (!(await requirePermission(req, 'finance.bank.transactions_view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.transactions_view)' });
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
    // Stap 1 — vraag de camt_transactions zelf op (zonder embed). PostgREST
    // nested-resource filters in combinatie met de default left join hebben
    // inconsistent gedrag laten zien voor deze tabel (linked_invoice bleef
    // null voor records die wel een confirmed match hebben). 2-staps fetch
    // + client-side join in dezelfde handler is robuuster en geeft exact
    // dezelfde response shape.
    let query = supabaseAdmin
      .from('camt_transactions')
      .select(`
        id, statement_id, account_iban, booking_date, value_date, amount_cents,
        currency, description, counterparty_name, counterparty_iban,
        end_to_end_id, transaction_code, entry_reference, created_at
      `, { count: 'exact' });

    if (from) query = query.gte('booking_date', from);
    if (to)   query = query.lte('booking_date', to);
    if (direction === 'in')  query = query.gt('amount_cents', 0);
    if (direction === 'out') query = query.lt('amount_cents', 0);
    if (min != null) query = query.gte('amount_cents', min);
    if (max != null) query = query.lte('amount_cents', max);

    // Multi-woord search (zelfde patroon als customers/finance-bank-transactions).
    if (search) {
      const words = search.split(/\s+/).filter(Boolean);
      for (const w of words) {
        const esc = w.replace(/[,()]/g, ' ');
        const pat = `%${esc}%`;
        query = query.or(
          `description.ilike.${pat},counterparty_name.ilike.${pat},counterparty_iban.ilike.${pat},end_to_end_id.ilike.${pat}`
        );
      }
    }

    query = query
      .order('booking_date', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: rawItems, error, count } = await query;
    if (error) throw new Error(error.message);

    // Stap 2 — voor de tx-ids op deze pagina: één aparte query naar
    // payment_match_candidates met confirm-variants + embedded invoice. Plat
    // naar Map<camt_tx_id, linked_invoice> en stitch in de items hieronder.
    const txIds = (rawItems || []).map(r => r.id).filter(Boolean);
    const linkedMap = new Map();
    if (txIds.length) {
      const { data: matches, error: mErr } = await supabaseAdmin
        .from('payment_match_candidates')
        .select('camt_transaction_id, status, invoices!inner ( id, invoice_number )')
        .in('camt_transaction_id', txIds)
        .in('status', ['confirmed', 'auto_confirmed', 'manual_confirmed']);
      if (mErr) {
        // Niet kritiek voor de lijst zelf — log + ga door met linked=null.
        console.error('[camt-tx] match-join fout:', mErr.message);
      } else {
        for (const m of (matches || [])) {
          if (!m.invoices || !m.camt_transaction_id) continue;
          if (linkedMap.has(m.camt_transaction_id)) continue; // eerste hit per tx
          linkedMap.set(m.camt_transaction_id, {
            id:             m.invoices.id,
            invoice_number: m.invoices.invoice_number,
            match_status:   m.status,
          });
        }
      }
    }

    const items = (rawItems || []).map(r => ({
      ...r,
      linked_invoice: linkedMap.get(r.id) || null,
    }));

    // KPI's over current page (snel, geen extra aggregate-query).
    const kpis = { sum_in_cents: 0, sum_out_cents: 0, count_in: 0, count_out: 0 };
    for (const r of items) {
      const a = Number(r.amount_cents) || 0;
      if (a > 0) { kpis.sum_in_cents += a;  kpis.count_in++;  }
      if (a < 0) { kpis.sum_out_cents += a; kpis.count_out++; }
    }

    return res.status(200).json({
      items,
      total: count || 0,
      page_size: limit,
      offset,
      has_more: (offset + items.length) < (count || 0),
      kpis,
    });
  } catch (e) {
    console.error('[finance-bank-camt-transactions]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
