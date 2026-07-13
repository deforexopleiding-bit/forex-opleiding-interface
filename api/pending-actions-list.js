// api/pending-actions-list.js
// GET -> paginated pending_actions lijst voor de Wanbetalers Approvals-tab + nav-badge.
// Permission: finance.arrangements.view (lezen mag ruimer dan approve).
//
// Query-params:
//   status        (text optional)  -> exact-match op pending_actions.status
//                                     (PENDING | APPROVED | REJECTED | EXECUTED | FAILED | CANCELLED)
//                                     case-insensitive input; genormaliseerd naar UPPERCASE voor DB-filter.
//   action_type   (text optional)  -> exact-match (bv. arrangement.uitstel)
//   source        (text optional)  -> exact-match op payload->>'source' (bv. manual | auto)
//   customer_id   (uuid optional)
//   limit         (int, default 50, clamp 1..200)
//   offset        (int, default 0)
//
// Response: {
//   items: [
//     {
//       id, customer_id, arrangement_id, action_type, status, payload,
//       proposed_by, approved_by, approved_at, executed_at, execution_result,
//       reject_reason (alias voor DB-kolom rejection_reason), scheduled_for, expires_at, created_at, updated_at,
//       customer:     { id, name, email } | null,
//       arrangement:  { id, type, status } | null
//     }, ...
//   ],
//   counts: { PENDING, APPROVED, REJECTED, EXECUTED, FAILED },
//   total, limit, offset
// }
//
// Sortering: created_at DESC (kolom 'proposed_at' bestaat niet; created_at is
// het voorgesteld-op-tijdstip, consistent met arrangements-list.js).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// Status-enum is UPPERCASE in deployed DB (spec-conform). We accepteren
// beide casings als query-param en normaliseren naar UPPERCASE voor de
// SQL-filter, zodat oude callers / bookmarks met lowercase ook blijven werken.
const VALID_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'finance.arrangements.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.view)' });
  }

  const q          = req.query || {};
  // status-param: accepteer zowel lowercase als UPPERCASE en normaliseer
  // altijd naar UPPERCASE — DB CHECK eist UPPERCASE.
  const statusRaw  = q.status      ? String(q.status).toUpperCase() : null;
  const actionType = q.action_type ? String(q.action_type)          : null;
  const source     = q.source      ? String(q.source)               : null;
  const customerId = q.customer_id ? String(q.customer_id)          : null;
  const limit      = clampInt(q.limit,  50, 1, 200);
  const offset     = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  if (statusRaw && !VALID_STATUS.includes(statusRaw)) {
    return res.status(400).json({ error: `Ongeldige status; verwacht ${VALID_STATUS.join('|')} (case-insensitive)` });
  }
  if (customerId && !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id moet een uuid zijn' });
  }

  try {
    // ---- Hoofdquery: items met embedded customer + arrangement ----
    // NB: DB-kolommen heten proposed_by_user_id / approved_by_user_id.
    // We mappen ze in de response naar de kortere aliassen proposed_by /
    // approved_by die de UI verwacht (back-compat met arrangement-laag).
    let query = supabaseAdmin
      .from('pending_actions')
      .select(`
        id, customer_id, arrangement_id, action_type, payload, status,
        proposed_by_user_id, approved_by_user_id, approved_at, executed_at, execution_result,
        rejection_reason, scheduled_for, expires_at, created_at, updated_at,
        customers:customer_id ( id, is_company, company_name, first_name, last_name, email, is_test ),
        payment_arrangements:arrangement_id ( id, type, status )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusRaw)  query = query.eq('status',      statusRaw);
    if (actionType) query = query.eq('action_type', actionType);
    if (customerId) query = query.eq('customer_id', customerId);
    // payload.source is jsonb-veld; PostgREST ondersteunt ->> operator in filter-keys.
    if (source)     query = query.eq('payload->>source', source);

    const { data: rows, error, count } = await query;
    if (error) throw new Error('list: ' + error.message);

    const items = (rows || []).map(row => {
      const cust = row.customers || null;
      const arr  = row.payment_arrangements || null;
      return {
        id:               row.id,
        customer_id:      row.customer_id,
        arrangement_id:   row.arrangement_id,
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
          id:      cust.id,
          name:    customerDisplayName(cust, '(onbekend)'),
          email:   cust.email || null,
          is_test: cust.is_test === true,
        } : null,
        arrangement: arr ? {
          id:               arr.id,
          type:             arr.type,
          arrangement_status: arr.status,
        } : null,
      };
    });

    // ---- Counts per status (voor nav-badge + UI-pills). Best-effort: faalt nooit hard. ----
    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0, EXECUTED: 0, FAILED: 0 };
    try {
      // Eén aggregate-query per status: PostgREST head:true + count:'exact' is goedkoop.
      // Filter customer_id ook hier om de KPI consistent met de huidige view te houden.
      const statusKeys = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED'];
      await Promise.all(statusKeys.map(async (s) => {
        let cq = supabaseAdmin
          .from('pending_actions')
          .select('id', { count: 'exact', head: true })
          .eq('status', s);
        if (customerId) cq = cq.eq('customer_id', customerId);
        if (actionType) cq = cq.eq('action_type', actionType);
        if (source)     cq = cq.eq('payload->>source', source);
        const { count: c, error: ce } = await cq;
        if (ce) { console.error('[pending-actions-list counts', s, ']', ce.message); return; }
        counts[s] = typeof c === 'number' ? c : 0;
      }));
    } catch (e) {
      console.error('[pending-actions-list counts]', e.message);
    }

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({ items, counts, total, limit, offset });
  } catch (e) {
    console.error('[pending-actions-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
