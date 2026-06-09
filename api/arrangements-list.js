// api/arrangements-list.js
// GET -> paginated payment_arrangements lijst voor de Wanbetalers-tab.
// Permission: finance.arrangements.view.
//
// Query-params:
//   customer_id (uuid optional)  -> filter op klant
//   status      (text optional)  -> exact-match op arrangement-status
//                                   (voorgesteld | goedgekeurd | afgewezen |
//                                    actief | voltooid | geannuleerd)
//   type        (text optional)  -> exact-match op type
//                                   (uitstel | gespreid | pauze |
//                                    kwijtschelding | overig)
//   limit       (int, default 50, clamp 1..200)
//   offset      (int, default 0)
//
// Response: { items: [...], total, limit, offset }
//
// Sortering: created_at DESC (de tabel heeft geen aparte proposed_at-kolom;
// created_at is set bij INSERT en functioneert als voorgesteld-op-tijdstip).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const VALID_STATUS = ['voorgesteld', 'goedgekeurd', 'afgewezen', 'actief', 'voltooid', 'geannuleerd'];
const VALID_TYPE   = ['uitstel', 'gespreid', 'pauze', 'kwijtschelding', 'overig'];

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
  const customerId = q.customer_id ? String(q.customer_id) : null;
  const statusRaw  = q.status      ? String(q.status).toLowerCase() : null;
  const typeRaw    = q.type        ? String(q.type).toLowerCase()   : null;
  const limit      = clampInt(q.limit,  50, 1, 200);
  const offset     = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  if (statusRaw && !VALID_STATUS.includes(statusRaw)) {
    return res.status(400).json({ error: `Ongeldige status; verwacht ${VALID_STATUS.join('|')}` });
  }
  if (typeRaw && !VALID_TYPE.includes(typeRaw)) {
    return res.status(400).json({ error: `Ongeldige type; verwacht ${VALID_TYPE.join('|')}` });
  }

  try {
    let query = supabaseAdmin
      .from('payment_arrangements')
      .select(`
        id, customer_id, invoice_ids, type, status, details,
        proposed_by, approved_by, approved_at, rejected_at, reject_reason,
        notes, created_at, updated_at,
        customers:customer_id ( id, is_company, company_name, first_name, last_name, email )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (customerId) query = query.eq('customer_id', customerId);
    if (statusRaw)  query = query.eq('status',      statusRaw);
    if (typeRaw)    query = query.eq('type',        typeRaw);

    const { data: rows, error, count } = await query;
    if (error) throw new Error('list: ' + error.message);

    const items = (rows || []).map(row => {
      const cust = row.customers || null;
      return {
        id:            row.id,
        customer_id:   row.customer_id,
        customer: cust ? {
          id:    cust.id,
          name:  customerDisplayName(cust, '(onbekend)'),
          email: cust.email || null,
        } : null,
        invoice_ids:   Array.isArray(row.invoice_ids) ? row.invoice_ids : [],
        type:          row.type,
        status:        row.status,
        details:       row.details || {},
        proposed_by:   row.proposed_by,
        approved_by:   row.approved_by,
        approved_at:   row.approved_at,
        rejected_at:   row.rejected_at,
        reject_reason: row.reject_reason,
        notes:         row.notes,
        created_at:    row.created_at,
        updated_at:    row.updated_at,
      };
    });

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({ items, total, limit, offset });
  } catch (e) {
    console.error('[arrangements-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
