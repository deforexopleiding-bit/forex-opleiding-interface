// api/tasks-create-verify-payment.js
// POST -> nieuwe MANUAL_VERIFY_PAYMENT pending_action aanmaken op basis van een
// klant-claim ("klant zegt al betaald te hebben") vanuit de WhatsApp-inbox.
//
// Permission: finance.tasks.create OF finance.arrangements.propose (fallback).
//
// Body (JSON):
//   {
//     invoice_id:        uuid    (verplicht),
//     customer_id:       uuid    (verplicht — moet overeenkomen met invoice.customer_id),
//     claimed_amount:    number  (verplicht, > 0),
//     claim_text:        string  (verplicht, min 10 chars — letterlijke klant-quote
//                                 of toelichting van de behandelaar),
//     klant_message_id:  string  (optioneel — reference naar inbox-bericht voor audit)
//   }
//
// Verschillen met arrangements-propose:
//   - arrangement_id = NULL (geen koppeling naar payment_arrangement; klant-claim
//     is een standalone verificatie-taak, geen onderdeel van een betalingsregeling).
//   - invoice_id wordt op de first-class FK-kolom (F1-migratie) opgeslagen, niet
//     alleen in payload.jsonb — dat maakt 'alle open verify-taken voor factuur X'
//     queries direct indexeerbaar.
//   - action_type = 'MANUAL_VERIFY_PAYMENT' (geen TL_-prefix; deze actie wordt NIET
//     door de D2 TeamLeader-executor opgepakt, alleen handmatig afgehandeld via
//     mark-executed / mark-not-executed).
//
// Validatie:
//   - invoice bestaat + behoort tot customer_id (anders 400/404)
//   - claimed_amount > 0
//   - claim_text >= 10 karakters
//
// Response 201: { item: { ...pending_action } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s)   { return typeof s === 'string' && UUID_RE.test(s); }
function isPosNum(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Permission: finance.tasks.create OF finance.arrangements.propose (fallback voor
  // proposers die nog geen tasks-key hebben gekregen).
  const hasTasksCreate = await requirePermission(req, 'finance.tasks.create');
  const hasArrPropose  = hasTasksCreate ? true : await requirePermission(req, 'finance.arrangements.propose');
  if (!hasTasksCreate && !hasArrPropose) {
    return res.status(403).json({ error: 'Geen rechten (finance.tasks.create of finance.arrangements.propose)' });
  }

  // ---- Body parsen ----
  const body = req.body || {};
  const invoiceId      = body.invoice_id ? String(body.invoice_id) : null;
  const customerId     = body.customer_id ? String(body.customer_id) : null;
  const claimedAmount  = body.claimed_amount != null ? Number(body.claimed_amount) : null;
  const claimText      = typeof body.claim_text === 'string' ? body.claim_text.trim() : '';
  const klantMessageId = body.klant_message_id != null ? String(body.klant_message_id) : null;

  // ---- Validatie ----
  if (!isUuid(invoiceId))  return res.status(400).json({ error: 'invoice_id (uuid) vereist' });
  if (!isUuid(customerId)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!isPosNum(claimedAmount)) {
    return res.status(400).json({ error: 'claimed_amount moet een getal > 0 zijn' });
  }
  if (!claimText || claimText.length < 10) {
    return res.status(400).json({ error: 'claim_text vereist (min 10 karakters)' });
  }

  try {
    // ---- Verifieer invoice bestaat + behoort tot customer ----
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, status')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) throw new Error('invoice-lookup: ' + invErr.message);
    if (!inv)   return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (inv.customer_id !== customerId) {
      return res.status(400).json({
        error: `Factuur ${inv.invoice_number || inv.id} hoort niet bij de opgegeven klant`,
      });
    }

    // ---- INSERT pending_action ----
    // arrangement_id = NULL (standalone verify-taak, niet aan arrangement gekoppeld).
    // proposed_by_user_id defensief: user.id is altijd gezet als auth.getUser slaagde,
    // maar guarded met optional chaining om nooit een undefined naar de DB te sturen.
    const claimedAt = new Date().toISOString();
    const payload = {
      claimed_amount:   claimedAmount,
      claim_text:       claimText,
      klant_message_id: klantMessageId,
      claimed_at:       claimedAt,
      source:           'manual',
      rationale:        'klant claimt al betaald te hebben - handmatige verificatie nodig',
    };

    const insertRow = {
      customer_id:         customerId,
      arrangement_id:      null,
      invoice_id:          invoiceId,
      action_type:         'MANUAL_VERIFY_PAYMENT',
      status:              'PENDING',
      proposed_by_user_id: user?.id || null,
      payload,
    };

    const { data: paRow, error: paErr } = await supabaseAdmin
      .from('pending_actions')
      .insert(insertRow)
      .select(`
        id, customer_id, arrangement_id, invoice_id, action_type, status, payload,
        proposed_by_user_id, approved_by_user_id, approved_at, executed_at,
        execution_result, rejection_reason, scheduled_for, expires_at,
        created_at, updated_at
      `)
      .single();
    if (paErr) throw new Error('pending-action-insert: ' + paErr.message);

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user?.id || null,
        action:      'task.verify_payment.proposed',
        entity_type: 'pending_action',
        entity_id:   paRow.id,
        after_json:  {
          pending_action_id: paRow.id,
          invoice_id:        invoiceId,
          customer_id:       customerId,
          claimed_amount:    claimedAmount,
          klant_message_id:  klantMessageId,
        },
        reason_text: claimText,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[tasks-create-verify-payment audit]', e.message);
    }

    // ---- Response: response-shape consistent met tasks-list (aliased kolommen) ----
    const item = {
      id:               paRow.id,
      customer_id:      paRow.customer_id,
      arrangement_id:   paRow.arrangement_id,
      invoice_id:       paRow.invoice_id,
      action_type:      paRow.action_type,
      status:           paRow.status,
      payload:          paRow.payload || {},
      proposed_by:      paRow.proposed_by_user_id,
      approved_by:      paRow.approved_by_user_id,
      approved_at:      paRow.approved_at,
      executed_at:      paRow.executed_at,
      execution_result: paRow.execution_result,
      reject_reason:    paRow.rejection_reason,
      scheduled_for:    paRow.scheduled_for,
      expires_at:       paRow.expires_at,
      created_at:       paRow.created_at,
      updated_at:       paRow.updated_at,
    };

    return res.status(201).json({ item });
  } catch (e) {
    console.error('[tasks-create-verify-payment]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
