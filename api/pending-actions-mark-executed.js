// api/pending-actions-mark-executed.js
// POST -> markeer een pending_action handmatig als 'EXECUTED'. Permission:
// finance.arrangements.approve.
//
// Body voor TL-acties (TL_INVOICE_*, TL_SUBSCRIPTION_*):
//   {
//     id: uuid (required),
//     execution_result: {
//       tl_credit_note_ids?: string[],
//       tl_subscription_id?: string,
//       tl_invoice_ids?:     string[],
//       manual_notes:        string (min 10 chars, required)
//     }
//   }
//
// Body voor MANUAL_VERIFY_PAYMENT (klant-claimt-betaald uit Inbox, F1):
//   {
//     id: uuid (required),
//     execution_result: {
//       outcome:                 'confirmed_paid' | 'not_found_in_bank' | 'klant_misvatting' (required),
//       matched_transaction_id?: uuid    (alleen bij outcome=confirmed_paid; optioneel),
//       manual_notes:            string  (min 10 chars, required)
//     }
//   }
//   Semantiek: Jeffrey heeft in CAMT/bank-export gekeken; outcome legt de
//   uitkomst vast. confirmed_paid markeert taak als afgerond (geld gevonden);
//   not_found_in_bank en klant_misvatting blijven ook EXECUTED (taak is
//   afgehandeld, alleen met negatieve uitkomst). Voor "kan niet verifieren /
//   nog niet duidelijk" gebruik mark-not-executed (-> FAILED).
//
// State-machine: alleen vanuit status='APPROVED' kan handmatig op EXECUTED gezet
// worden; anders 409 met huidige status. APPROVED is de uitkomst van de
// approval-flow; EXECUTED is de uitkomst van handmatige verwerking door admin
// (D1.6 — D2 vervangt dit later door auto-executor cron).
//
// Cascade naar payment_arrangements:
//   Na succesvolle EXECUTED-update: tel pending_actions per arrangement_id.
//   - Alle status NIET (PENDING, APPROVED)  => arrangement is af.
//     * Alle EXECUTED zonder FAILED/REJECTED              -> arrangement.status = ACTIEF.
//     * Met FAILED/REJECTED maar minstens 1 EXECUTED      -> arrangement.status = ACTIEF (gedeeltelijk).
//     * Alleen FAILED/REJECTED zonder EXECUTED            -> arrangement blijft VOORGESTELD (admin moet zelf annuleren).
//   - Nog PENDING of APPROVED open -> arrangement.status blijft VOORGESTELD.
//
// Cascade-update wordt alleen toegepast als arrangement.status='VOORGESTELD'
// (optimistic concurrency); andere statussen (ACTIEF/NAGEKOMEN/VERBROKEN/
// GEANNULEERD) blijven onaangeroerd.
//
// NB: schema-kolomnamen in deployed DB (pending_actions):
//   - status                UPPERCASE enum (PENDING/APPROVED/EXECUTED/FAILED/REJECTED/CANCELLED)
//   - executed_at           timestamptz
//   - executed_by_user_id   uuid REFERENCES profiles(id)
//   - execution_result      jsonb

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MANUAL_VERIFY_PAYMENT (F1) outcome-enum.
const MANUAL_VERIFY_OUTCOMES = new Set([
  'confirmed_paid',
  'not_found_in_bank',
  'klant_misvatting',
]);

function isStringArray(x) {
  return Array.isArray(x) && x.every(v => typeof v === 'string' && v.trim().length > 0);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.arrangements.approve'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.approve)' });
  }

  const body = req.body || {};
  const id   = body.id ? String(body.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  // ---- Basis-validate execution_result (action_type-agnostic) ----
  const er = body.execution_result && typeof body.execution_result === 'object'
    ? body.execution_result
    : null;
  if (!er) return res.status(400).json({ error: 'execution_result (object) vereist' });

  const manualNotes = typeof er.manual_notes === 'string' ? er.manual_notes.trim() : '';
  if (manualNotes.length < 10) {
    return res.status(400).json({ error: 'execution_result.manual_notes vereist (min 10 chars)' });
  }

  try {
    // ---- Lookup huidige row (nodig voor action_type-specifieke validatie) ----
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, status, action_type, customer_id, arrangement_id, execution_result')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!row)      return res.status(404).json({ error: 'Pending action niet gevonden' });

    if (row.status !== 'APPROVED') {
      return res.status(409).json({
        error: `Action is niet in APPROVED state (huidige status: ${row.status})`,
      });
    }

    // ---- Action-type-specifieke validatie + sanitize ----
    // Sanitized execution_result voor opslag.
    const cleanExecutionResult = {
      manual_notes: manualNotes,
    };

    if (row.action_type === 'MANUAL_VERIFY_PAYMENT') {
      // F1 — Klant-claimt-betaald (Inbox) wordt door admin handmatig in CAMT
      // gecheckt. Uitkomst-enum bepaalt of de claim klopt.
      const outcome = typeof er.outcome === 'string' ? er.outcome.trim() : '';
      if (!MANUAL_VERIFY_OUTCOMES.has(outcome)) {
        return res.status(400).json({
          error: 'execution_result.outcome vereist (confirmed_paid | not_found_in_bank | klant_misvatting)',
        });
      }
      cleanExecutionResult.outcome = outcome;

      if (er.matched_transaction_id != null) {
        const txId = String(er.matched_transaction_id).trim();
        if (txId.length > 0) {
          if (!UUID_RE.test(txId)) {
            return res.status(400).json({
              error: 'execution_result.matched_transaction_id moet een uuid zijn',
            });
          }
          cleanExecutionResult.matched_transaction_id = txId;
        }
      }
    } else {
      // Bestaande TL-shape voor arrangement-acties (UITSTEL / SPLITSING /
      // ABONNEMENT_* / KWIJTSCHELDING -> TL_INVOICE_* / TL_SUBSCRIPTION_*).
      const tlCreditNoteIds  = er.tl_credit_note_ids != null ? er.tl_credit_note_ids : null;
      const tlSubscriptionId = er.tl_subscription_id != null ? String(er.tl_subscription_id).trim() : '';
      const tlInvoiceIds     = er.tl_invoice_ids != null ? er.tl_invoice_ids : null;

      if (tlCreditNoteIds != null && !isStringArray(tlCreditNoteIds)) {
        return res.status(400).json({ error: 'execution_result.tl_credit_note_ids moet string[] zijn' });
      }
      if (tlInvoiceIds != null && !isStringArray(tlInvoiceIds)) {
        return res.status(400).json({ error: 'execution_result.tl_invoice_ids moet string[] zijn' });
      }

      if (tlCreditNoteIds && tlCreditNoteIds.length > 0) {
        cleanExecutionResult.tl_credit_note_ids = tlCreditNoteIds.map(s => String(s).trim());
      }
      if (tlSubscriptionId.length > 0) {
        cleanExecutionResult.tl_subscription_id = tlSubscriptionId;
      }
      if (tlInvoiceIds && tlInvoiceIds.length > 0) {
        cleanExecutionResult.tl_invoice_ids = tlInvoiceIds.map(s => String(s).trim());
      }
    }

    const nowIso = new Date().toISOString();
    // Defensief: user kan in edge-cases zonder id terugkomen (oude sessie,
    // service-account). NULL is geldig in executed_by_user_id (uuid nullable).
    const userId = user?.id || null;

    // Merge met bestaande execution_result (jsonb) — handmatige verwerking
    // overschrijft of vult eerdere result aan (bv. executor-attempts).
    const existingResult = (row.execution_result && typeof row.execution_result === 'object')
      ? row.execution_result
      : {};
    const mergedResult = {
      ...existingResult,
      ...cleanExecutionResult,
      executed_by_user_id: userId,
      marked_manually_at: nowIso,
    };

    // ---- UPDATE pending_actions -> EXECUTED ----
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('pending_actions')
      .update({
        status:              'EXECUTED',
        executed_at:         nowIso,
        executed_by_user_id: userId,
        execution_result:    mergedResult,
        updated_at:          nowIso,
      })
      .eq('id', id)
      .eq('status', 'APPROVED')   // optimistic concurrency
      .select('id, status, executed_at, executed_by_user_id, execution_result, arrangement_id, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // ---- Cascade naar payment_arrangements (fail-soft) ----
    let arrangementStatusUpdated = false;
    let arrangementIdForResponse = updated.arrangement_id || row.arrangement_id || null;

    if (arrangementIdForResponse) {
      try {
        // Tel alle pending_actions voor dit arrangement per status.
        const { data: siblings, error: sibErr } = await supabaseAdmin
          .from('pending_actions')
          .select('id, status')
          .eq('arrangement_id', arrangementIdForResponse);
        if (sibErr) throw new Error('siblings: ' + sibErr.message);

        const counts = { PENDING: 0, APPROVED: 0, EXECUTED: 0, FAILED: 0, REJECTED: 0, CANCELLED: 0 };
        for (const s of (siblings || [])) {
          if (counts[s.status] != null) counts[s.status]++;
        }

        const stillOpen = counts.PENDING + counts.APPROVED;
        const hasExecuted = counts.EXECUTED > 0;

        if (stillOpen === 0 && hasExecuted) {
          // Alle stappen afgesloten + minstens 1 EXECUTED -> arrangement ACTIEF.
          const { data: arrUpd, error: arrErr } = await supabaseAdmin
            .from('payment_arrangements')
            .update({
              status:     'ACTIEF',
              updated_at: nowIso,
            })
            .eq('id', arrangementIdForResponse)
            .eq('status', 'VOORGESTELD')   // alleen vanuit VOORGESTELD oppakken
            .select('id, status');
          if (arrErr) throw new Error('arrangement-cascade: ' + arrErr.message);
          arrangementStatusUpdated = !!(arrUpd && arrUpd.length > 0);
        }
        // stillOpen===0 && !hasExecuted: alleen FAILED/REJECTED/CANCELLED -> blijft VOORGESTELD.
        // stillOpen>0: nog werk te doen -> blijft VOORGESTELD.
      } catch (e) {
        console.error('[pending-actions-mark-executed cascade]', e.message);
      }
    }

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'pending_action.manually_executed',
        entity_type: 'pending_action',
        entity_id:   id,
        after_json:  {
          pending_action_id: id,
          status:            'EXECUTED',
          action_type:       row.action_type,
          customer_id:       row.customer_id,
          arrangement_id:    arrangementIdForResponse,
          execution_result:  mergedResult,
          arrangement_status_updated: arrangementStatusUpdated,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[pending-actions-mark-executed audit]', e.message); }

    return res.status(200).json({
      id:                          updated.id,
      status:                      'EXECUTED',
      arrangement_status_updated:  arrangementStatusUpdated,
      arrangement_id:              arrangementIdForResponse,
    });
  } catch (e) {
    console.error('[pending-actions-mark-executed]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
