// api/finance-customers.js
// GET -> klantenoverzicht met finance-context (open bedrag + arrangement-count
// + dunning-status) voor Finance > Klanten thin view.
//
// Permission: finance.dunning.view (zelfde gate als overige finance-views;
// dit is een read-only afgeleide van invoices + payment_arrangements +
// dunning_workflow_runs en bevat geen PII die niet al via /api/customers
// beschikbaar is voor admins).
//
// Query-params:
//   status              ('active' | 'archived' | 'all', default 'active')
//   open_amount_gt_zero ('true' | 'false', default 'false')
//   arrangement_status  ('all' | 'VOORGESTELD' | 'ACTIEF' | 'NAGEKOMEN' |
//                        'VERBROKEN' | 'GEANNULEERD', default 'all')
//   search              (string, ILIKE op naam/email)
//   sort_by             ('name' | 'open_amount' | 'arrangements_count' |
//                        'created_at', default 'open_amount')
//   sort_dir            ('asc' | 'desc', default 'desc')
//   page                (1-based, default 1)
//   page_size           (default 25, clamp [1..100])
//
// Response:
//   { items: [{
//       id, name, email, phone, is_company, status, created_at,
//       open_amount_cents,
//       open_invoice_count,
//       arrangements_count,             // alle arrangements (lifetime)
//       active_arrangement_status,      // null | VOORGESTELD | ACTIEF | NAGEKOMEN | VERBROKEN | GEANNULEERD
//       has_active_dunning,             // bool
//       dunning_status,                 // 'idle' | 'active' | 'completed_30d'
//     }, ...],
//     total, page, page_size, total_pages }
//
// Strategie:
//   1. Eerst customer-IDs verzamelen (via base-filter + paginatie).
//   2. Vervolgens per pagina open invoices + arrangements + dunning_runs
//      ophalen voor de zichtbare IDs (3 batch-queries i.p.v. N+1).
//   3. Server-side filteren op open_amount_gt_zero / arrangement_status
//      vereist een pre-pass over alle ids als die filters actief zijn —
//      dat doen we incrementeel in een tweede fetch-ronde.

import { supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const VALID_ARR_STATUS = ['VOORGESTELD', 'ACTIEF', 'NAGEKOMEN', 'VERBROKEN', 'GEANNULEERD'];
const SORT_WHITELIST = new Set(['name', 'open_amount', 'arrangements_count', 'created_at']);

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
function openAmount(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}
function toCents(eur) { return Math.round((Number(eur) || 0) * 100); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const q = req.query || {};
  const statusFilter      = String(q.status || 'active').toLowerCase();
  const openAmountGt      = String(q.open_amount_gt_zero || 'false').toLowerCase() === 'true';
  const arrStatusRaw      = String(q.arrangement_status || 'all').toUpperCase();
  const arrStatusFilter   = arrStatusRaw === 'ALL' ? null
                            : (VALID_ARR_STATUS.includes(arrStatusRaw) ? arrStatusRaw : null);
  const search            = String(q.search || '').trim();
  let   sortBy            = String(q.sort_by || 'open_amount');
  if (!SORT_WHITELIST.has(sortBy)) sortBy = 'open_amount';
  const sortDir           = String(q.sort_dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const page              = Math.max(1, clampInt(q.page, 1, 1, 1_000_000));
  const pageSize          = clampInt(q.page_size, 25, 1, 100);

  try {
    // ── Stap 1: aggregaten platform-breed verzamelen (open invoices,
    //   arrangements, dunning runs) en per customer-id mappen.
    //   Dit kost 3 queries, ongeacht hoeveel klanten er zijn.
    // ──
    const [openAggMap, arrAggMap, dunningAggMap] = await Promise.all([
      aggregateOpenInvoices(),
      aggregateArrangements(),
      aggregateDunningRuns(),
    ]);

    // ── Stap 2: customer-base-query opzetten (status + search filters
    //   server-side). Sortering en paginatie doen we ALLEEN server-side
    //   bij sort_by='name' of 'created_at'; voor open_amount /
    //   arrangements_count moet we in-memory sorteren omdat de waarden
    //   niet als kolom op customers staan.
    // ──
    let baseQuery = supabaseAdmin.from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, archived_at, anonymized_at, created_at', { count: 'exact' });

    if (statusFilter === 'active') {
      baseQuery = baseQuery.is('archived_at', null).is('anonymized_at', null);
    } else if (statusFilter === 'archived') {
      baseQuery = baseQuery.not('archived_at', 'is', null);
    } // 'all' → geen extra filter

    if (search) {
      const pat = '%' + search.replace(/[,()]/g, ' ') + '%';
      baseQuery = baseQuery.or(
        `first_name.ilike.${pat},last_name.ilike.${pat},company_name.ilike.${pat},email.ilike.${pat}`
      );
    }

    // Open-amount / arrangement-status filters dwingen ons om
    // **alle gefilterde customers** te laden, vervolgens te filteren op
    // de aggregate-maps, en daarna in-memory te paginate-en. Dit is
    // acceptabel tot ~10k customers; daarboven verdient dit een
    // materialized view (toekomstig: docs/finance-c46-customer-aggregates.md).
    const needsPostFilter = openAmountGt || arrStatusFilter !== null
                          || sortBy === 'open_amount' || sortBy === 'arrangements_count';

    if (!needsPostFilter) {
      // Pure server-side path: sort op kolom + range-paginatie.
      const sortCol = sortBy === 'name'
        ? 'last_name'
        : sortBy === 'created_at'
          ? 'created_at'
          : 'created_at';
      const from = (page - 1) * pageSize;
      const to   = from + pageSize - 1;
      baseQuery = baseQuery.order(sortCol, { ascending: sortDir === 'asc' }).range(from, to);

      const { data: customers, count, error } = await baseQuery;
      if (error) throw new Error('customers query: ' + error.message);

      const items = (customers || []).map(c => buildItem(c, openAggMap, arrAggMap, dunningAggMap));
      return res.status(200).json({
        items,
        total: count || 0,
        page,
        page_size: pageSize,
        total_pages: Math.ceil((count || 0) / pageSize),
      });
    }

    // In-memory pad: haal alle gefilterde customers op (zonder pagination
    // op DB-niveau), filter + sort + paginate in JS.
    // NB: Supabase default limit is 1000; we vragen expliciet meer.
    const { data: customers, error } = await baseQuery.range(0, 9999);
    if (error) throw new Error('customers query: ' + error.message);

    let items = (customers || []).map(c => buildItem(c, openAggMap, arrAggMap, dunningAggMap));

    // Post-filter
    if (openAmountGt)         items = items.filter(it => (it.open_amount_cents || 0) > 0);
    if (arrStatusFilter)      items = items.filter(it => it.active_arrangement_status === arrStatusFilter);

    // Sort in-memory
    items.sort((a, b) => {
      let av, bv;
      if (sortBy === 'name')                   { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
      else if (sortBy === 'created_at')        { av = a.created_at || ''; bv = b.created_at || ''; }
      else if (sortBy === 'arrangements_count'){ av = a.arrangements_count || 0; bv = b.arrangements_count || 0; }
      else /* open_amount */                   { av = a.open_amount_cents || 0; bv = b.open_amount_cents || 0; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    const total = items.length;
    const from  = (page - 1) * pageSize;
    const to    = from + pageSize;
    const paged = items.slice(from, to);

    return res.status(200).json({
      items: paged,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  } catch (e) {
    console.error('[finance-customers]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ─────────────────────────────────────────────────────────────────────

async function aggregateOpenInvoices() {
  // Map: customer_id -> { open_amount_eur, open_invoice_count }
  const m = new Map();
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('customer_id, amount_total, amount_paid, credited_amount, status')
    .in('status', OPEN_STATUSES);
  if (error) throw new Error('open invoices: ' + error.message);
  for (const inv of data || []) {
    if (!inv.customer_id) continue;
    const open = openAmount(inv);
    if (open <= 0) continue;
    const agg = m.get(inv.customer_id) || { open_amount_eur: 0, open_invoice_count: 0 };
    agg.open_amount_eur    += open;
    agg.open_invoice_count += 1;
    m.set(inv.customer_id, agg);
  }
  return m;
}

async function aggregateArrangements() {
  // Map: customer_id -> { count, active_status }
  // active_status = status van het meest-recent created arrangement (de
  // wizard maakt maar 1 actieve regel tegelijk per klant, dus laatste
  // created is leidend voor "huidige situatie").
  const m = new Map();
  const { data, error } = await supabaseAdmin
    .from('payment_arrangements')
    .select('customer_id, status, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error('arrangements: ' + error.message);
  for (const arr of data || []) {
    if (!arr.customer_id) continue;
    const agg = m.get(arr.customer_id) || { count: 0, active_status: null };
    agg.count += 1;
    // Eerste rij is jongste (order DESC) → bewaar als active_status.
    if (agg.active_status === null) agg.active_status = arr.status;
    m.set(arr.customer_id, agg);
  }
  return m;
}

async function aggregateDunningRuns() {
  // Map: customer_id -> { has_active }
  const m = new Map();
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('customer_id, status')
    .eq('status', 'active');
  if (error) throw new Error('dunning runs: ' + error.message);
  for (const r of data || []) {
    if (!r.customer_id) continue;
    m.set(r.customer_id, { has_active: true });
  }
  return m;
}

function buildItem(c, openAggMap, arrAggMap, dunningAggMap) {
  const open    = openAggMap.get(c.id)    || { open_amount_eur: 0, open_invoice_count: 0 };
  const arr     = arrAggMap.get(c.id)     || { count: 0, active_status: null };
  const dunning = dunningAggMap.get(c.id) || { has_active: false };
  let status = 'active';
  if (c.anonymized_at) status = 'anonymized';
  else if (c.archived_at) status = 'archived';
  return {
    id:                          c.id,
    name:                        customerDisplayName(c, '(zonder naam)'),
    email:                       c.email || null,
    phone:                       c.phone || null,
    is_company:                  !!c.is_company,
    status,
    created_at:                  c.created_at,
    open_amount_cents:           toCents(open.open_amount_eur),
    open_invoice_count:          open.open_invoice_count,
    arrangements_count:          arr.count,
    active_arrangement_status:   arr.active_status,
    has_active_dunning:          !!dunning.has_active,
    dunning_status:              dunning.has_active ? 'active' : 'idle',
  };
}
