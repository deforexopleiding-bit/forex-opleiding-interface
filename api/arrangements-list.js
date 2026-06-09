// api/arrangements-list.js
// GET -> paginated payment_arrangements lijst voor de Wanbetalers-tab.
// Permission: finance.arrangements.view.
//
// Query-params:
//   customer_id (uuid optional)  -> filter op klant
//   status      (text optional)  -> exact-match op arrangement-status
//                                   (VOORGESTELD | ACTIEF | NAGEKOMEN |
//                                    VERBROKEN | GEANNULEERD)
//   type        (text optional)  -> exact-match op type
//                                   (UITSTEL | SPLITSING | ABONNEMENT_PAUZE |
//                                    ABONNEMENT_STOP | KWIJTSCHELDING)
//   limit       (int, default 50, clamp 1..200)
//   offset      (int, default 0)
//
// Response: { items: [...], total, limit, offset }
//
// Sortering: created_at DESC (de tabel heeft geen aparte proposed_at-kolom;
// created_at is set bij INSERT en functioneert als voorgesteld-op-tijdstip).
//
// Lowercase / legacy waarden worden via een alias-map vertaald naar de
// uppercase canonieke keys, zodat oude UI / bookmarked URLs blijven werken.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const VALID_STATUS = ['VOORGESTELD', 'ACTIEF', 'NAGEKOMEN', 'VERBROKEN', 'GEANNULEERD'];
const VALID_TYPE   = ['UITSTEL', 'SPLITSING', 'ABONNEMENT_PAUZE', 'ABONNEMENT_STOP', 'KWIJTSCHELDING'];

// Backward-compat aliases (lowercase -> uppercase canonical).
const STATUS_ALIAS = {
  voorgesteld:  'VOORGESTELD',
  actief:       'ACTIEF',
  voltooid:     'NAGEKOMEN',
  afgewezen:    'VERBROKEN',
  geannuleerd:  'GEANNULEERD',
  // 'goedgekeurd' wordt niet meer als arrangement-status gebruikt — map terug
  // naar VOORGESTELD (approval-flow zit op pending_actions).
  goedgekeurd:  'VOORGESTELD',
};
const TYPE_ALIAS = {
  uitstel:        'UITSTEL',
  gespreid:       'SPLITSING',
  pauze:          'ABONNEMENT_PAUZE',
  overig:         'ABONNEMENT_STOP',
  kwijtschelding: 'KWIJTSCHELDING',
};

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
  const statusIn   = q.status      ? String(q.status)      : null;
  const typeIn     = q.type        ? String(q.type)        : null;
  const limit      = clampInt(q.limit,  50, 1, 200);
  const offset     = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  // Normaliseer: STATUS_ALIAS mapt legacy lowercase -> uppercase canoniek.
  let statusFilter = null;
  if (statusIn) {
    const lc = statusIn.toLowerCase();
    if (STATUS_ALIAS[lc])                statusFilter = STATUS_ALIAS[lc];
    else if (VALID_STATUS.includes(statusIn)) statusFilter = statusIn;
    else {
      return res.status(400).json({ error: `Ongeldige status; verwacht ${VALID_STATUS.join('|')}` });
    }
  }
  let typeFilter = null;
  if (typeIn) {
    const lc = typeIn.toLowerCase();
    if (TYPE_ALIAS[lc])                typeFilter = TYPE_ALIAS[lc];
    else if (VALID_TYPE.includes(typeIn)) typeFilter = typeIn;
    else {
      return res.status(400).json({ error: `Ongeldige type; verwacht ${VALID_TYPE.join('|')}` });
    }
  }

  try {
    // NB: approval-state (approved_by / approved_at / rejected_at / rejection_reason)
    // hoort op pending_actions, NIET op payment_arrangements. De arrangement-tabel
    // bevat alleen de lifecycle-status (VOORGESTELD / ACTIEF / etc) en
    // cancellation_reason (handmatige cancel-reden). UI kan approval-details
    // opvragen via pending-actions-list / -detail.
    let query = supabaseAdmin
      .from('payment_arrangements')
      .select(`
        id, customer_id, invoice_ids, type, status, details,
        proposed_by, notes, cancellation_reason, created_at, updated_at,
        customers:customer_id ( id, is_company, company_name, first_name, last_name, email )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (customerId)   query = query.eq('customer_id', customerId);
    if (statusFilter) query = query.eq('status',      statusFilter);
    if (typeFilter)   query = query.eq('type',        typeFilter);

    const { data: rows, error, count } = await query;
    if (error) throw new Error('list: ' + error.message);

    const items = (rows || []).map(row => {
      const cust = row.customers || null;
      return {
        id:                  row.id,
        customer_id:         row.customer_id,
        customer: cust ? {
          id:    cust.id,
          name:  customerDisplayName(cust, '(onbekend)'),
          email: cust.email || null,
        } : null,
        invoice_ids:         Array.isArray(row.invoice_ids) ? row.invoice_ids : [],
        type:                row.type,
        status:              row.status,
        details:             row.details || {},
        proposed_by:         row.proposed_by,
        notes:               row.notes,
        cancellation_reason: row.cancellation_reason || null,
        created_at:          row.created_at,
        updated_at:          row.updated_at,
      };
    });

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({ items, total, limit, offset });
  } catch (e) {
    console.error('[arrangements-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
