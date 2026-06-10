// api/tasks-list.js
// GET -> paginated lijst van pending_actions (alle taken: arrangement-acties +
// MANUAL_VERIFY_PAYMENT) voor de Finance-taken module.
//
// Permission: finance.tasks.view OF finance.arrangements.view (fallback).
//
// Query-params:
//   status        (CSV optional)   -> case-insensitive, gefilterd op
//                                     PENDING|APPROVED|REJECTED|EXECUTED|FAILED|CANCELLED.
//                                     Default (bij ontbreken): "PENDING,APPROVED" = open taken.
//   action_type   (CSV optional)   -> exact-match (bv. MANUAL_VERIFY_PAYMENT,TL_INVOICE_SPLIT)
//   category      (text optional)  -> 'arrangement' (action_type ILIKE 'TL\_%') |
//                                     'verify_payment' (action_type = 'MANUAL_VERIFY_PAYMENT') |
//                                     'escalation' (action_type = 'MANUAL_ESCALATION')
//   customer_id   (uuid optional)
//   invoice_id    (uuid optional)  -> first-class FK-kolom uit F1-migratie
//   search        (text optional)  -> ILIKE op klant-naamvelden (first_name / last_name / company_name)
//   limit         (int, default 50, clamp 1..200)
//   offset        (int, default 0)
//
// Response:
//   {
//     items: [
//       {
//         id, customer_id, arrangement_id, invoice_id, action_type, status, payload,
//         proposed_by, approved_by, approved_at, executed_at, execution_result,
//         reject_reason, scheduled_for, expires_at, created_at, updated_at,
//         customer:    { id, name, email } | null,
//         arrangement: { id, type, arrangement_status } | null,
//         invoice:     { id, invoice_number, amount_total, invoice_status } | null,
//         linked_joost_suggestion: {
//           id, suggested_reply, detected_intent, confidence, conversation_id
//         } | null
//       }, ...
//     ],
//     total,
//     counts: {
//       byStatus:   { PENDING, APPROVED, EXECUTED, REJECTED, FAILED, CANCELLED },
//       byCategory: { arrangement, verify_payment, escalation }
//     },
//     limit, offset
//   }
//
// Sortering: created_at DESC (created_at is het voorgesteld-op-tijdstip, consistent
// met pending-actions-list / arrangements-list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED'];
const VALID_CATEGORY = ['arrangement', 'verify_payment', 'escalation'];

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function parseCsv(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Permission: finance.tasks.view OF finance.arrangements.view (fallback voor
  // bestaande approvers die nog geen tasks-key hebben gekregen).
  const hasTasksView = await requirePermission(req, 'finance.tasks.view');
  const hasArrView   = hasTasksView ? true : await requirePermission(req, 'finance.arrangements.view');
  if (!hasTasksView && !hasArrView) {
    return res.status(403).json({ error: 'Geen rechten (finance.tasks.view of finance.arrangements.view)' });
  }

  // ---- Query-params ----
  const q = req.query || {};

  // Status CSV (default: PENDING + APPROVED = open taken)
  let statusList = parseCsv(q.status).map((s) => s.toUpperCase());
  if (statusList.length === 0) statusList = ['PENDING', 'APPROVED'];
  const invalidStatus = statusList.filter((s) => !VALID_STATUS.includes(s));
  if (invalidStatus.length > 0) {
    return res.status(400).json({
      error: `Ongeldige status: ${invalidStatus.join(',')}; verwacht ${VALID_STATUS.join('|')} (case-insensitive)`,
    });
  }

  // action_type CSV
  const actionTypes = parseCsv(q.action_type);

  // category filter
  const category = q.category ? String(q.category).toLowerCase() : null;
  if (category && !VALID_CATEGORY.includes(category)) {
    return res.status(400).json({ error: `Ongeldige category; verwacht ${VALID_CATEGORY.join('|')}` });
  }

  // customer / invoice id
  const customerId = q.customer_id ? String(q.customer_id) : null;
  const invoiceId  = q.invoice_id  ? String(q.invoice_id)  : null;
  if (customerId && !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id moet een uuid zijn' });
  }
  if (invoiceId && !UUID_RE.test(invoiceId)) {
    return res.status(400).json({ error: 'invoice_id moet een uuid zijn' });
  }

  // search-term (ILIKE op klant-naamvelden via embed-filter)
  const search = q.search ? String(q.search).trim() : null;

  const limit  = clampInt(q.limit, 50, 1, 200);
  const offset = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  // ---- Helper: bouw basis-filter op een query-builder (zonder embeds, voor count-queries) ----
  const applyBaseFilters = (qb) => {
    if (statusList.length === 1) qb = qb.eq('status', statusList[0]);
    else if (statusList.length > 1) qb = qb.in('status', statusList);
    if (actionTypes.length === 1) qb = qb.eq('action_type', actionTypes[0]);
    else if (actionTypes.length > 1) qb = qb.in('action_type', actionTypes);
    if (category === 'arrangement') {
      // alle TL_-prefix acties zijn arrangement-acties (D2-executor target)
      qb = qb.ilike('action_type', 'TL\\_%');
    } else if (category === 'verify_payment') {
      qb = qb.eq('action_type', 'MANUAL_VERIFY_PAYMENT');
    } else if (category === 'escalation') {
      qb = qb.eq('action_type', 'MANUAL_ESCALATION');
    }
    if (customerId) qb = qb.eq('customer_id', customerId);
    if (invoiceId)  qb = qb.eq('invoice_id', invoiceId);
    return qb;
  };

  try {
    // ---- Hoofdquery: items met embedded customer + arrangement + invoice ----
    // DB-kolommen: proposed_by_user_id / approved_by_user_id / rejection_reason.
    // Aliased in response naar proposed_by / approved_by / reject_reason (UI-compat
    // met pending-actions-list endpoint).
    let query = supabaseAdmin
      .from('pending_actions')
      .select(`
        id, customer_id, arrangement_id, invoice_id, action_type, payload, status,
        proposed_by_user_id, approved_by_user_id, approved_at, executed_at, execution_result,
        rejection_reason, scheduled_for, expires_at, created_at, updated_at,
        customers:customer_id ( id, is_company, company_name, first_name, last_name, email ),
        payment_arrangements:arrangement_id ( id, type, status ),
        invoices:invoice_id ( id, invoice_number, amount_total, status ),
        joost_suggestions!linked_task_id ( id, suggested_reply, detected_intent, confidence, conversation_id )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    query = applyBaseFilters(query);

    // search: ILIKE OR over de drie klant-naamvelden via embed-filter syntax.
    // PostgREST ondersteunt .or() met embedded-table notation 'customers.col'.
    if (search) {
      const safe = search.replace(/[%,]/g, '');
      if (safe.length > 0) {
        const pattern = `*${safe}*`;
        query = query.or(
          [
            `first_name.ilike.${pattern}`,
            `last_name.ilike.${pattern}`,
            `company_name.ilike.${pattern}`,
          ].join(','),
          { foreignTable: 'customers' },
        );
      }
    }

    const { data: rows, error, count } = await query;
    if (error) throw new Error('list: ' + error.message);

    const items = (rows || []).map((row) => {
      const cust = row.customers || null;
      const arr  = row.payment_arrangements || null;
      const inv  = row.invoices || null;
      // PostgREST reverse-embed retourneert array; pak eerste (er is max 1 row
      // omdat linked_task_id niet uniek per pending_action is, maar in praktijk
      // is dat een 1:1-relatie via de joost-create-task flow).
      const suggArr = Array.isArray(row.joost_suggestions) ? row.joost_suggestions : [];
      const sugg = suggArr.length > 0 ? suggArr[0] : null;
      return {
        id:               row.id,
        customer_id:      row.customer_id,
        arrangement_id:   row.arrangement_id,
        invoice_id:       row.invoice_id,
        action_type:      row.action_type,
        payload:          row.payload || {},
        status:           row.status,
        proposed_by:      row.proposed_by_user_id,
        approved_by:      row.approved_by_user_id,
        approved_at:      row.approved_at,
        executed_at:      row.executed_at,
        execution_result: row.execution_result,
        reject_reason:    row.rejection_reason,
        scheduled_for:    row.scheduled_for,
        expires_at:       row.expires_at,
        created_at:       row.created_at,
        updated_at:       row.updated_at,
        customer: cust ? {
          id:    cust.id,
          name:  customerDisplayName(cust, '(onbekend)'),
          email: cust.email || null,
        } : null,
        arrangement: arr ? {
          id:                 arr.id,
          type:               arr.type,
          arrangement_status: arr.status,
        } : null,
        invoice: inv ? {
          id:             inv.id,
          invoice_number: inv.invoice_number,
          amount_total:   inv.amount_total,
          invoice_status: inv.status,
        } : null,
        linked_joost_suggestion: sugg ? {
          id:              sugg.id,
          suggested_reply: sugg.suggested_reply || null,
          detected_intent: sugg.detected_intent || null,
          confidence:      (sugg.confidence != null) ? Number(sugg.confidence) : null,
          conversation_id: sugg.conversation_id || null,
        } : null,
      };
    });

    // ---- Counts per status (PENDING/APPROVED/EXECUTED/REJECTED/FAILED/CANCELLED) ----
    // Status-filter NIET toegepast op de count-queries (we tellen alle statussen),
    // overige filters wel zodat de KPI consistent is met de huidige view-context.
    const byStatus = { PENDING: 0, APPROVED: 0, REJECTED: 0, EXECUTED: 0, FAILED: 0, CANCELLED: 0 };
    try {
      await Promise.all(VALID_STATUS.map(async (s) => {
        let cq = supabaseAdmin
          .from('pending_actions')
          .select('id', { count: 'exact', head: true })
          .eq('status', s);
        // herbouw filters zonder status, maar met actionType/category/customer/invoice
        if (actionTypes.length === 1) cq = cq.eq('action_type', actionTypes[0]);
        else if (actionTypes.length > 1) cq = cq.in('action_type', actionTypes);
        if (category === 'arrangement')      cq = cq.ilike('action_type', 'TL\\_%');
        else if (category === 'verify_payment') cq = cq.eq('action_type', 'MANUAL_VERIFY_PAYMENT');
        else if (category === 'escalation')     cq = cq.eq('action_type', 'MANUAL_ESCALATION');
        if (customerId) cq = cq.eq('customer_id', customerId);
        if (invoiceId)  cq = cq.eq('invoice_id', invoiceId);
        const { count: c, error: ce } = await cq;
        if (ce) { console.error('[tasks-list count', s, ']', ce.message); return; }
        byStatus[s] = typeof c === 'number' ? c : 0;
      }));
    } catch (e) {
      console.error('[tasks-list byStatus]', e.message);
    }

    // ---- Counts per category (arrangement / verify_payment / escalation) ----
    // Negeert de category-param zelf zodat tab-badges in de UI altijd het totaal
    // van alle categorieën weergeven, gefilterd op overige criteria.
    const byCategory = { arrangement: 0, verify_payment: 0, escalation: 0 };
    try {
      // arrangement (TL_-prefix)
      let arrQ = supabaseAdmin
        .from('pending_actions')
        .select('id', { count: 'exact', head: true })
        .ilike('action_type', 'TL\\_%');
      if (statusList.length === 1) arrQ = arrQ.eq('status', statusList[0]);
      else if (statusList.length > 1) arrQ = arrQ.in('status', statusList);
      if (customerId) arrQ = arrQ.eq('customer_id', customerId);
      if (invoiceId)  arrQ = arrQ.eq('invoice_id', invoiceId);
      const { count: arrCount, error: arrErr } = await arrQ;
      if (arrErr) console.error('[tasks-list byCategory.arrangement]', arrErr.message);
      else byCategory.arrangement = typeof arrCount === 'number' ? arrCount : 0;

      // verify_payment
      let verQ = supabaseAdmin
        .from('pending_actions')
        .select('id', { count: 'exact', head: true })
        .eq('action_type', 'MANUAL_VERIFY_PAYMENT');
      if (statusList.length === 1) verQ = verQ.eq('status', statusList[0]);
      else if (statusList.length > 1) verQ = verQ.in('status', statusList);
      if (customerId) verQ = verQ.eq('customer_id', customerId);
      if (invoiceId)  verQ = verQ.eq('invoice_id', invoiceId);
      const { count: verCount, error: verErr } = await verQ;
      if (verErr) console.error('[tasks-list byCategory.verify_payment]', verErr.message);
      else byCategory.verify_payment = typeof verCount === 'number' ? verCount : 0;

      // escalation
      let escQ = supabaseAdmin
        .from('pending_actions')
        .select('id', { count: 'exact', head: true })
        .eq('action_type', 'MANUAL_ESCALATION');
      if (statusList.length === 1) escQ = escQ.eq('status', statusList[0]);
      else if (statusList.length > 1) escQ = escQ.in('status', statusList);
      if (customerId) escQ = escQ.eq('customer_id', customerId);
      if (invoiceId)  escQ = escQ.eq('invoice_id', invoiceId);
      const { count: escCount, error: escErr } = await escQ;
      if (escErr) console.error('[tasks-list byCategory.escalation]', escErr.message);
      else byCategory.escalation = typeof escCount === 'number' ? escCount : 0;
    } catch (e) {
      console.error('[tasks-list byCategory]', e.message);
    }

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({
      items,
      total,
      counts: { byStatus, byCategory },
      limit,
      offset,
    });
  } catch (e) {
    console.error('[tasks-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
