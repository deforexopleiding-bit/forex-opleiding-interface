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
// Body voor MANUAL_ESCALATION (Finance Inbox escalatie, F3):
//   {
//     id: uuid (required),
//     execution_result: {
//       outcome:        'resolved' | 'handed_over' | 'ongoing' (required),
//       handed_over_to?: string  (optioneel, max 200 chars — naam/email van overdracht;
//                                 zinvol bij outcome=handed_over),
//       manual_notes:    string  (min 10 chars, required)
//     }
//   }
//   Semantiek: MANUAL_ESCALATION rows starten in status=PENDING (escalation IS de
//   task; geen approval-stap). De uitkomst bepaalt of de taak afgesloten wordt:
//     - resolved     : escalation is opgelost -> status PENDING -> EXECUTED.
//     - handed_over  : doorgegeven aan extern persoon (advocaat/incasso) -> EXECUTED.
//     - ongoing      : voortgang loggen, taak BLIJFT in PENDING. execution_result
//                      krijgt een progress_log[]-entry appended. Eindigen-flow moet
//                      later alsnog via resolved of handed_over.
//
// State-machine:
//   - TL_*  + MANUAL_VERIFY_PAYMENT : alleen vanuit APPROVED -> EXECUTED.
//   - MANUAL_ESCALATION             : alleen vanuit PENDING. Bij outcome=ongoing
//                                     blijft status=PENDING; bij resolved /
//                                     handed_over wordt PENDING -> EXECUTED.
//   Andere statussen -> 409 met huidige status.
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

// MANUAL_ESCALATION (F3) outcome-enum.
// - resolved / handed_over: PENDING -> EXECUTED (taak afgesloten).
// - ongoing               : PENDING blijft PENDING, alleen progress_log appended.
const MANUAL_ESCALATION_OUTCOMES = new Set([
  'resolved',
  'handed_over',
  'ongoing',
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

    // State-machine guard: MANUAL_ESCALATION start in PENDING (geen approve-stap),
    // andere action_types vereisen APPROVED.
    const isEscalation = row.action_type === 'MANUAL_ESCALATION';
    const requiredStatus = isEscalation ? 'PENDING' : 'APPROVED';
    if (row.status !== requiredStatus) {
      return res.status(409).json({
        error: `Action is niet in ${requiredStatus} state (huidige status: ${row.status})`,
      });
    }

    // ---- Action-type-specifieke validatie + sanitize ----
    // Sanitized execution_result voor opslag.
    const cleanExecutionResult = {
      manual_notes: manualNotes,
    };

    // Escalation-specifieke vlag die de UPDATE-fase straks gebruikt om tussen
    // 'ongoing' (PENDING blijft) en terminal-outcomes (-> EXECUTED) te kiezen.
    let escalationOutcome = null;        // 'resolved' | 'handed_over' | 'ongoing'

    if (row.action_type === 'MANUAL_ESCALATION') {
      // F3 — Escalation outcome bepaalt of de taak afgesloten of doorlopend is.
      const outcome = typeof er.outcome === 'string' ? er.outcome.trim() : '';
      if (!MANUAL_ESCALATION_OUTCOMES.has(outcome)) {
        return res.status(400).json({
          error: 'execution_result.outcome vereist (resolved | handed_over | ongoing)',
        });
      }
      escalationOutcome = outcome;
      cleanExecutionResult.outcome = outcome;

      if (er.handed_over_to != null) {
        const handedOverTo = String(er.handed_over_to).trim();
        if (handedOverTo.length > 200) {
          return res.status(400).json({
            error: 'execution_result.handed_over_to mag max 200 karakters bevatten',
          });
        }
        if (handedOverTo.length > 0) {
          cleanExecutionResult.handed_over_to = handedOverTo;
        }
      }
    } else if (row.action_type === 'MANUAL_VERIFY_PAYMENT') {
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

    // Determine effective status + executed-timestamps voor de UPDATE.
    // - MANUAL_ESCALATION + ongoing : status BLIJFT PENDING, geen executed_at/by;
    //                                  outcome wordt geappend aan progress_log[].
    // - MANUAL_ESCALATION + terminal: PENDING -> EXECUTED met executed_at/by.
    // - andere action_types         : APPROVED -> EXECUTED met executed_at/by.
    const isOngoingEscalation = isEscalation && escalationOutcome === 'ongoing';

    // Voor 'ongoing': bouw progress_log entry en append aan bestaande array
    // zonder de outcome-property in mergedResult te zetten (anders raken we
    // de progress-historie kwijt bij volgende ongoing-update).
    let mergedResult;
    if (isOngoingEscalation) {
      const existingLog = Array.isArray(existingResult.progress_log) ? existingResult.progress_log : [];
      const progressEntry = {
        at:               nowIso,
        outcome:          'ongoing',
        manual_notes:     manualNotes,
        logged_by_user_id: userId,
      };
      // handed_over_to op een ongoing-event is ongebruikelijk maar wel toegestaan
      // (bv. admin noteert tussentijdse overdracht voor sparring) -> meenemen.
      if (cleanExecutionResult.handed_over_to) {
        progressEntry.handed_over_to = cleanExecutionResult.handed_over_to;
      }
      mergedResult = {
        ...existingResult,
        progress_log:       [...existingLog, progressEntry],
        last_progress_at:   nowIso,
        last_outcome:       'ongoing',
        marked_manually_at: nowIso,
      };
    } else {
      mergedResult = {
        ...existingResult,
        ...cleanExecutionResult,
        executed_by_user_id: userId,
        marked_manually_at: nowIso,
      };
    }

    // ---- UPDATE pending_actions ----
    // Concurrency-guard op de huidige source-status (APPROVED of PENDING).
    const updatePayload = isOngoingEscalation
      ? {
          // Ongoing-escalation: status onveranderd (PENDING), alleen result + updated_at.
          execution_result: mergedResult,
          updated_at:       nowIso,
        }
      : {
          // Normaal terminal-pad: -> EXECUTED met executed_at/by.
          status:              'EXECUTED',
          executed_at:         nowIso,
          executed_by_user_id: userId,
          execution_result:    mergedResult,
          updated_at:          nowIso,
        };

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('pending_actions')
      .update(updatePayload)
      .eq('id', id)
      .eq('status', requiredStatus)   // optimistic concurrency op source-status
      .select('id, status, executed_at, executed_by_user_id, execution_result, arrangement_id, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // ---- Cascade naar payment_arrangements (fail-soft) ----
    // Escalations hebben arrangement_id=NULL en raken dus geen arrangement; skip.
    // Ongoing-escalations zijn ook geen state-transitie -> niets te cascaderen.
    let arrangementStatusUpdated = false;
    let arrangementIdForResponse = updated.arrangement_id || row.arrangement_id || null;

    if (arrangementIdForResponse && !isOngoingEscalation) {
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

    // Effectieve nieuwe status na UPDATE: ongoing-escalation blijft PENDING,
    // alle andere paden eindigen op EXECUTED.
    const newStatus = isOngoingEscalation ? 'PENDING' : 'EXECUTED';
    const auditAction = isOngoingEscalation
      ? 'pending_action.escalation_progress_logged'
      : 'pending_action.manually_executed';

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      auditAction,
        entity_type: 'pending_action',
        entity_id:   id,
        after_json:  {
          pending_action_id: id,
          status:            newStatus,
          action_type:       row.action_type,
          customer_id:       row.customer_id,
          arrangement_id:    arrangementIdForResponse,
          execution_result:  mergedResult,
          arrangement_status_updated: arrangementStatusUpdated,
          escalation_outcome: escalationOutcome,   // null voor niet-escalation
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[pending-actions-mark-executed audit]', e.message); }

    return res.status(200).json({
      id:                          updated.id,
      status:                      newStatus,
      arrangement_status_updated:  arrangementStatusUpdated,
      arrangement_id:              arrangementIdForResponse,
      escalation_outcome:          escalationOutcome,   // null voor niet-escalation
    });
  } catch (e) {
    console.error('[pending-actions-mark-executed]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
