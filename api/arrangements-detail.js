// api/arrangements-detail.js
// GET -> volledige payment_arrangement-detail incl. klant, facturen en pending_actions.
// Permission: finance.arrangements.view.
//
// Query: ?id=<uuid>  (verplicht)
//
// Response: {
//   arrangement: { ... },
//   customer:    { id, name, email, is_company, ... } | null,
//   invoices:    [ { id, invoice_number, status, amount_total, amount_paid, ... } ],
//   pending_actions: [ { id, action_type, status, payload, ... } ]
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

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

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    // NB: approval-state zit op pending_actions (zie hieronder), niet op
    // payment_arrangements. De arrangement-tabel bevat alleen de lifecycle-status.
    const { data: arr, error: arrErr } = await supabaseAdmin
      .from('payment_arrangements')
      .select(`
        id, customer_id, invoice_ids, type, status, details,
        proposed_by, notes, created_at, updated_at,
        customers:customer_id (
          id, is_company, company_name, first_name, last_name, email, phone
        )
      `)
      .eq('id', id)
      .maybeSingle();
    if (arrErr) throw new Error('arrangement: ' + arrErr.message);
    if (!arr)  return res.status(404).json({ error: 'Arrangement niet gevonden' });

    const cust = arr.customers || null;
    const customer = cust ? {
      id:           cust.id,
      name:         customerDisplayName(cust, '(onbekend)'),
      email:        cust.email || null,
      phone:        cust.phone || null,
      is_company:   !!cust.is_company,
      company_name: cust.company_name || null,
      first_name:   cust.first_name   || null,
      last_name:    cust.last_name    || null,
    } : null;

    // --- Facturen ophalen op basis van invoice_ids-array.
    const invoiceIds = Array.isArray(arr.invoice_ids) ? arr.invoice_ids.filter(x => x && UUID_RE.test(String(x))) : [];
    let invoices = [];
    if (invoiceIds.length > 0) {
      const { data: invRows, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, status, amount_total, amount_paid, credited_amount, issue_date, due_date, paid_date, tl_invoice_id, tl_department_id')
        .in('id', invoiceIds);
      if (invErr) throw new Error('invoices: ' + invErr.message);
      invoices = invRows || [];
    }

    // --- Pending actions ophalen (alle statussen — UI bepaalt zelf filtering).
    // NB: pending_actions-kolommen heten proposed_by_user_id / approved_by_user_id
    //     en rejection_reason (deployed DB).
    const { data: paRowsRaw, error: paErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, customer_id, arrangement_id, action_type, payload, status, proposed_by_user_id, approved_by_user_id, approved_at, executed_at, execution_result, rejection_reason, scheduled_for, expires_at, created_at, updated_at')
      .eq('arrangement_id', id)
      .order('created_at', { ascending: true });
    if (paErr) throw new Error('pending_actions: ' + paErr.message);
    // Alias terug naar proposed_by / approved_by / reject_reason voor UI-compat.
    const paRows = (paRowsRaw || []).map(r => ({
      ...r,
      proposed_by:   r.proposed_by_user_id,
      approved_by:   r.approved_by_user_id,
      reject_reason: r.rejection_reason,
    }));

    const arrangement = {
      id:            arr.id,
      customer_id:   arr.customer_id,
      invoice_ids:   invoiceIds,
      type:          arr.type,
      status:        arr.status,
      details:       arr.details || {},
      proposed_by:   arr.proposed_by,
      notes:         arr.notes,
      created_at:    arr.created_at,
      updated_at:    arr.updated_at,
    };

    return res.status(200).json({
      arrangement,
      customer,
      invoices,
      pending_actions: paRows || [],
    });
  } catch (e) {
    console.error('[arrangements-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
