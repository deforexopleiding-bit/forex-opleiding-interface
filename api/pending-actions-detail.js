// api/pending-actions-detail.js
// GET -> volledige pending_action-detail incl. klant, arrangement, approver en rejecter.
// Permission: finance.arrangements.view.
//
// Query: ?id=<uuid>  (verplicht)
//
// Response: {
//   item:        { ...pending_action },
//   customer:    { id, name, email, phone, is_company, ... } | null,
//   arrangement: { id, type, status, details, ... } | null,
//   invoices:    [ { id, invoice_number, status, amount_total, ... } ],
//   approver:    { id, full_name, email } | null,
//   rejecter:    { id, full_name, email } | null
// }
//
// `invoices` bevat de invoices waar dit pending_action betrekking op heeft —
// bron is payload.credit_invoice_ids (UITSTEL consolidate) of payload.invoice_id
// (SPLITSING/KWIJTSCHELDING). Wordt door de detail-modal gebruikt om
// invoice_numbers te tonen i.p.v. ruwe uuids.
//
// NB: pending_actions heeft GEEN aparte 'rejected_by'-kolom; bij REJECTED valt
// approved_by terug op de uitvoerende user (consistent met agent_approval_queue-
// pattern), maar voor compat exposeren we hier 'rejecter' alleen wanneer status
// in {REJECTED, CANCELLED} is. 'approver' alleen wanneer status in
// {APPROVED, EXECUTED, FAILED}.

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
    // NB: DB-kolommen heten proposed_by_user_id / approved_by_user_id;
    // aliased in de response naar proposed_by / approved_by voor UI-compat.
    const { data: pa, error: paErr } = await supabaseAdmin
      .from('pending_actions')
      .select(`
        id, customer_id, arrangement_id, action_type, payload, status,
        proposed_by_user_id, approved_by_user_id, approved_at, executed_at, execution_result,
        rejection_reason, scheduled_for, expires_at, created_at, updated_at,
        customers:customer_id (
          id, is_company, company_name, first_name, last_name, email, phone
        ),
        payment_arrangements:arrangement_id (
          id, type, status, details, invoice_ids, notes, created_at, updated_at
        )
      `)
      .eq('id', id)
      .maybeSingle();
    if (paErr) throw new Error('pending_action: ' + paErr.message);
    if (!pa)   return res.status(404).json({ error: 'Pending action niet gevonden' });

    const cust = pa.customers || null;
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

    const arr = pa.payment_arrangements || null;
    const arrangement = arr ? {
      id:          arr.id,
      type:        arr.type,
      status:      arr.status,
      details:     arr.details || {},
      invoice_ids: Array.isArray(arr.invoice_ids) ? arr.invoice_ids : [],
      notes:       arr.notes,
      created_at:  arr.created_at,
      updated_at:  arr.updated_at,
    } : null;

    // ---- Approver / Rejecter lookup ----
    // approved_by_user_id-kolom wordt door /approve EN /reject ingevuld; status
    // bepaalt welke rol hij feitelijk vervult in de UI.
    let approver = null;
    let rejecter = null;
    if (pa.approved_by_user_id) {
      const { data: prof, error: profErr } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email')
        .eq('id', pa.approved_by_user_id)
        .maybeSingle();
      if (profErr) console.error('[pending-actions-detail profile]', profErr.message);
      else if (prof) {
        const profObj = { id: prof.id, full_name: prof.full_name || null, email: prof.email || null };
        if (['REJECTED', 'CANCELLED'].includes(pa.status)) rejecter = profObj;
        else approver = profObj;
      }
    }

    const item = {
      id:               pa.id,
      customer_id:      pa.customer_id,
      arrangement_id:   pa.arrangement_id,
      action_type:      pa.action_type,
      payload:          pa.payload || {},
      status:           pa.status,
      proposed_by:      pa.proposed_by_user_id,
      approved_by:      pa.approved_by_user_id,
      approved_at:      pa.approved_at,
      executed_at:      pa.executed_at,
      execution_result: pa.execution_result,
      reject_reason:    pa.rejection_reason,
      scheduled_for:    pa.scheduled_for,
      expires_at:       pa.expires_at,
      created_at:       pa.created_at,
      updated_at:       pa.updated_at,
    };

    // ---- Invoice-lookup voor leesbare invoice_numbers in de detail-modal ----
    // Bron-IDs: payload.credit_invoice_ids[] (UITSTEL), payload.invoice_id
    // (SPLITSING/KWIJTSCHELDING), of arrangement.invoice_ids als fallback.
    const payload  = pa.payload || {};
    const idsFromPayload = [];
    if (Array.isArray(payload.credit_invoice_ids)) {
      for (const x of payload.credit_invoice_ids) {
        if (typeof x === 'string' && UUID_RE.test(x)) idsFromPayload.push(x);
      }
    }
    if (typeof payload.invoice_id === 'string' && UUID_RE.test(payload.invoice_id)) {
      idsFromPayload.push(payload.invoice_id);
    }
    const arrangementInvoiceIds = (arrangement && Array.isArray(arrangement.invoice_ids))
      ? arrangement.invoice_ids.filter(x => typeof x === 'string' && UUID_RE.test(x))
      : [];
    const allIds = [...new Set([...idsFromPayload, ...arrangementInvoiceIds])];

    let invoices = [];
    if (allIds.length > 0) {
      const { data: invRows, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, status, amount_total, amount_paid, credited_amount, issue_date, due_date, paid_date, tl_invoice_id')
        .in('id', allIds);
      if (invErr) console.error('[pending-actions-detail invoices]', invErr.message);
      else invoices = invRows || [];
    }

    return res.status(200).json({ item, customer, arrangement, invoices, approver, rejecter });
  } catch (e) {
    console.error('[pending-actions-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
