// api/finance-payment-matches.js
// GET → lijst payment_match_candidates met JOIN op camt_transactions + invoices.
// Permission: finance.bank.transactions_view.
//
// Query-params:
//   status     CSV — suggested,confirmed,rejected,auto_confirmed (default: suggested,auto_confirmed)
//   min_score  int — clamp 0..100 (default 0)
//   from       YYYY-MM-DD — booking_date >= from
//   to         YYYY-MM-DD — booking_date <= to
//   limit      default 100, clamp [1..500]
//   offset     default 0

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = ['suggested', 'confirmed', 'rejected', 'auto_confirmed'];

// Welke invoice-statussen zijn ZINVOL om nog te matchen?
// Verbergen we 'paid' (al voldaan), 'credited' (factuur ongedaan) en 'writeoff'
// (afgeschreven) — een match-candidate op zulke facturen is altijd een
// historisch artefact. 'cancelled' bestaat niet voor invoices in onze CHECK
// constraint (migratie 2026-05-30): concept/open/partially_paid/paid/overdue/
// credited/writeoff. Dus blijven over voor weergave:
const INVOICE_STATUSES_FOR_MATCH = ['concept', 'open', 'partially_paid', 'overdue'];

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
  const statusRaw = String(q.status || 'suggested,auto_confirmed').split(',').map(s => s.trim()).filter(Boolean);
  const statuses = statusRaw.filter(s => VALID_STATUSES.includes(s));
  const minScore = Math.max(0, Math.min(100, Number(q.min_score) || 0));
  const from = ISO_DATE_RE.test(String(q.from || '')) ? String(q.from) : null;
  const to   = ISO_DATE_RE.test(String(q.to   || '')) ? String(q.to)   : null;
  const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
  const offset = Math.max(0, Number(q.offset) || 0);

  try {
    // Embedded select voor camt_transactions + invoices + customer-naam join.
    // `invoices!inner` zodat het status-filter op de embed ook de parent-row
    // verbergt (anders krijg je candidate + invoices: null door PostgREST).
    let query = supabaseAdmin
      .from('payment_match_candidates')
      .select(`
        id, camt_transaction_id, invoice_id, match_score, match_reasons,
        status, confirmed_by_user_id, confirmed_at, registered_payment_id,
        rejected_reason, created_at,
        camt_transactions ( booking_date, amount_cents, description,
                            counterparty_name, counterparty_iban, end_to_end_id ),
        invoices!inner ( invoice_number, amount_total, amount_paid, status,
                         issue_date, due_date,
                         customers ( first_name, last_name, company_name ) )
      `, { count: 'exact' });

    if (statuses.length) query = query.in('status', statuses);
    if (minScore > 0)    query = query.gte('match_score', minScore);
    // Filter on joined column needs an explicit `camt_transactions.booking_date`.
    if (from) query = query.gte('camt_transactions.booking_date', from);
    if (to)   query = query.lte('camt_transactions.booking_date', to);
    // Verberg candidates voor facturen die al voldaan / gecrediteerd /
    // afgeschreven zijn — historische artefacten waar geen actie meer op nodig
    // is. !inner zorgt dat de parent rij ook gedropt wordt.
    query = query.in('invoices.status', INVOICE_STATUSES_FOR_MATCH);

    query = query
      .order('match_score', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: items, error, count } = await query;
    if (error) throw new Error(error.message);

    // Plat de joined data + bouw customer_display_name.
    const out = (items || []).map(row => {
      const c = row.camt_transactions || {};
      const inv = row.invoices || {};
      const cust = inv.customers || {};
      const displayName = (cust.company_name && cust.company_name.trim())
        || [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim()
        || '—';
      return {
        id: row.id,
        camt_transaction_id: row.camt_transaction_id,
        invoice_id: row.invoice_id,
        match_score: row.match_score,
        match_reasons: row.match_reasons || [],
        status: row.status,
        confirmed_at: row.confirmed_at,
        rejected_reason: row.rejected_reason,
        registered_payment_id: row.registered_payment_id,
        created_at: row.created_at,
        camt: {
          booking_date: c.booking_date,
          amount_cents: c.amount_cents,
          description:  c.description,
          counterparty_name: c.counterparty_name,
          counterparty_iban: c.counterparty_iban,
          end_to_end_id:     c.end_to_end_id,
        },
        invoice: {
          invoice_number: inv.invoice_number,
          amount_total:   inv.amount_total,
          amount_paid:    inv.amount_paid,
          status:         inv.status,
          issue_date:     inv.issue_date,
          due_date:       inv.due_date,
          customer_name:  displayName,
        },
      };
    });

    return res.status(200).json({
      items: out,
      total: count || 0,
      page_size: limit,
      offset,
      has_more: (offset + out.length) < (count || 0),
    });
  } catch (e) {
    console.error('[finance-payment-matches]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
