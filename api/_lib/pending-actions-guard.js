// api/_lib/pending-actions-guard.js
//
// Shared guard-laag voor cron-dunning-conversation-reminders en de
// dunning-engine. Bepaalt of een klant een openstaande handmatige actie
// heeft die de bot moet doen zwijgen.
//
// DB CHECK-constraint op pending_actions.status:
//   PENDING, APPROVED, REJECTED, EXECUTED, FAILED, ROLLED_BACK
// (CANCELLED bestaat NIET in dit schema — eerdere versies hadden 'em
// abusievelijk in de blocking-set staan; dat blokkeerde in de praktijk
// niks, maar was misleidend.)
//
// Statussen die BLOKKEREN — mens is met de zaak bezig, bot moet niks doen:
//   - pending      : wacht op approve/reject
//   - approved     : goedgekeurd, wacht op executor (D2)
//   - executed     : uitgevoerd (bot-actie zou dubbelop zijn)
//   - failed       : executor viel om, mens moet ingrijpen
// Statussen die DOORLATEN (afgesloten toestand — geen open actie):
//   - rejected     : expliciet afgekeurd
//   - rolled_back  : uitvoering teruggedraaid; zaak is afgesloten en
//                    dunning mag gewoon doorlopen
//
// Extracted uit cron-dunning-conversation-reminders.js (#887) zodat de
// dunning-engine dezelfde regels hanteert. Één plek, één set constanten,
// twee callers.

import { supabaseAdmin as defaultSupabaseAdmin } from '../supabase.js';

export const BLOCKING_ACTION_STATUSES = new Set([
  'pending', 'approved', 'executed', 'failed',
]);

// Type+status-combinaties die EXPLICIET DOORLATEN, ook al zit hun status
// in BLOCKING_ACTION_STATUSES. Semantiek: "de actie is gedaan, er is geen
// wachtstand meer — de bot mag door."
//
// MANUAL_FOLLOWUP:executed — Belactie is afgerond (belletje gepleegd +
// uitkomst gelogd in dunning_call_log). De taak zelf is EXECUTED zodat
// de UI 'm netjes toont bij "Afgehandeld", maar er is geen operationele
// reden meer om de dunning-flow te blokkeren: de mens heeft het gesprek
// gedaan en de engine mag de volgende template versturen. Andere
// action_types op EXECUTED blijven WEL blokkeren (verify_payment,
// arrangement-uitvoer, escalation — die vragen andere follow-up).
export const NON_BLOCKING_COMBOS = new Set([
  'MANUAL_FOLLOWUP:executed',
]);

/**
 * True als een enkele actie de bot moet doen zwijgen. Pure functie zodat
 * de per-actie logica getestbaar blijft. Case-insensitive op status,
 * fail-safe op null/undefined, onbekende statussen laten door (liever
 * gemist blok dan over-blokkade).
 *
 * Regels:
 *  1) Als (action_type + ':' + status_lower) in NON_BLOCKING_COMBOS zit
 *     → NIET blokkerend (whitelist wint).
 *  2) Anders: blokkerend iff status_lower in BLOCKING_ACTION_STATUSES.
 */
export function isBlockingAction(action) {
  const status = String(action?.status || '').toLowerCase();
  if (!BLOCKING_ACTION_STATUSES.has(status)) return false;
  const type = String(action?.action_type || '');
  if (type && NON_BLOCKING_COMBOS.has(type + ':' + status)) return false;
  return true;
}

/**
 * True als er >=1 pending_action bestaat met een blokkerende (type,status).
 * Fail-safe op null/undefined-input.
 */
export function hasOpenBlockingAction(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  return actions.some(isBlockingAction);
}

/**
 * Batch-query pending_actions per customer. Returnt Map(customer_id ->
 * [{status, action_type}]) van alleen de acties met een BLOKKERENDE status
 * (rejected/cancelled worden hier al uit gefilterd).
 *
 * `action_type` gaat mee zodat callers een informatieve log-regel kunnen
 * schrijven (welk type actie blokkeerde de bot).
 *
 * Case-insensitief tegenover de DB: `pending_actions.status` staat in
 * PRODUCTIE in UPPERCASE (PENDING/APPROVED/EXECUTED/FAILED/REJECTED/
 * CANCELLED). Eerdere versies gebruikten `.not('status','in','(rejected,
 * cancelled)')` op PostgREST-niveau — die is case-sensitive en matchte
 * DB-uppercase NIET, waardoor rejected/cancelled-rijen door de filter
 * kwamen. `hasOpenBlockingAction` ving dat wel op, maar de log-`count`
 * werd verkeerd. Nu doen we NIETS meer op DB-niveau qua status-filter
 * en filteren in JS via de canonieke lowercase blocking-set — één
 * consistente normalisatie voor alle callers en scenarios.
 *
 * Fail-soft: bij DB-fout returnt lege map + warning; caller loopt door
 * zonder guard i.p.v. om te vallen.
 *
 * Dependency-injectable supabaseAdmin (default: shared client) zodat unit-
 * tests een fake-db kunnen meegeven.
 */
export async function loadOpenActionsByCustomer(customerIds, db = defaultSupabaseAdmin) {
  const byCustomer = new Map();
  const ids = (Array.isArray(customerIds) ? customerIds : []).filter(Boolean);
  if (ids.length === 0) return byCustomer;
  try {
    const { data, error } = await db
      .from('pending_actions')
      .select('customer_id, status, action_type')
      .in('customer_id', ids);
    if (error) {
      console.warn('[pending-actions-guard] batch lookup fail:', error.message);
      return byCustomer;
    }
    for (const row of data || []) {
      const cid = row.customer_id;
      if (!cid) continue;
      // Case-insensitieve filter via isBlockingAction — hanteert zowel
      // BLOCKING_ACTION_STATUSES als de NON_BLOCKING_COMBOS-whitelist
      // (MANUAL_FOLLOWUP:executed laat door). Rejected/cancelled +
      // MANUAL_FOLLOWUP-executed komen zo niet meer in de map.
      if (!isBlockingAction(row)) continue;
      const arr = byCustomer.get(cid) || [];
      arr.push({ status: row.status, action_type: row.action_type });
      byCustomer.set(cid, arr);
    }
  } catch (e) {
    console.warn('[pending-actions-guard] batch lookup exception:', e?.message);
  }
  return byCustomer;
}
