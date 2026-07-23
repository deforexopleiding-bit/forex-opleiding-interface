// api/_lib/pending-actions-guard.js
//
// Shared guard-laag voor cron-dunning-conversation-reminders en de
// dunning-engine. Bepaalt of een klant een openstaande handmatige actie
// heeft die de bot moet doen zwijgen.
//
// Statussen die BLOKKEREN — mens is met de zaak bezig, bot moet niks doen:
//   - pending   : wacht op approve/reject
//   - approved  : goedgekeurd, wacht op executor (D2)
//   - executed  : uitgevoerd (bot-actie zou dubbelop zijn)
//   - failed    : executor viel om, mens moet ingrijpen
// Statussen die DOORLATEN (geen open actie):
//   - rejected  : expliciet afgekeurd
//   - cancelled : ingetrokken
//
// Extracted uit cron-dunning-conversation-reminders.js (#887) zodat de
// dunning-engine dezelfde regels hanteert. Één plek, één set constanten,
// twee callers.

import { supabaseAdmin as defaultSupabaseAdmin } from '../supabase.js';

export const BLOCKING_ACTION_STATUSES = new Set([
  'pending', 'approved', 'executed', 'failed',
]);

/**
 * True als er >=1 pending_action bestaat met een blokkerende status. Pure
 * functie zodat de guard direct getestbaar is. Case-insensitive op status,
 * fail-safe op null/undefined-input, en onbekende statussen laten door
 * (liever een gemist blok dan een over-blokkade).
 */
export function hasOpenBlockingAction(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  return actions.some(a => BLOCKING_ACTION_STATUSES.has(
    String(a?.status || '').toLowerCase()
  ));
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
      // Case-insensitieve filter via de canonieke lowercase set.
      // rejected/cancelled worden hier al eruit gehaald zodat de map
      // alleen blokkerende acties bevat.
      const s = String(row.status || '').toLowerCase();
      if (!BLOCKING_ACTION_STATUSES.has(s)) continue;
      const arr = byCustomer.get(cid) || [];
      arr.push({ status: row.status, action_type: row.action_type });
      byCustomer.set(cid, arr);
    }
  } catch (e) {
    console.warn('[pending-actions-guard] batch lookup exception:', e?.message);
  }
  return byCustomer;
}
