// api/_lib/dunning-arrangement-hooks.js
//
// Fase 2b — Hooks tussen payment_arrangements en dunning_workflow_runs.
// Zorgt dat een actieve betaalafspraak de lopende aanmaan-workflow pauzeert
// en dat de runs netjes worden afgesloten/hervat bij afronding of annulering.
//
// Aangeroepen vanuit:
//   arrangements-propose.js         → pauseRunsForArrangement (TOEZEGGING = direct ACTIEF)
//   pending-actions-mark-executed.js → pauseRunsForArrangement (na cascade → ACTIEF)
//   cron-arrangements-breach-check   → completeRunsFromArrangement (NAGEKOMEN)
//   arrangements-cancel.js          → unpauseRunsFromArrangement (GEANNULEERD)
//
// Design-keuze: de resume-flow bij VERBROKEN gaat NIET automatisch via deze
// helper. Bij VERBROKEN blijven de runs paused; het is aan de workflow met
// step_type='resume_dunning' (Deel 3) om ze weer op active te zetten. Zo blijft
// Jeffrey de regie houden over "wat gebeurt er als een klant z'n afspraak breekt".
//
// ALLE helpers zijn FAIL-SOFT: lukt de hook niet, dan wordt een warn gelogd en
// gaat de caller door. Het vastleggen van de afspraak of de status-flip mag
// NOOIT klappen op een side-effect.
//
// Dry-run: deze helpers muteren ONZE eigen dunning_workflow_runs-status —
// pure administratie zonder externe zij-effecten (net als de breach-check
// status-flips in #757). Ze respecteren dry-run dus NIET; als dry-run aan
// staat gebeurt de flip toch. Dat is bewust: de UI-state moet consistent
// blijven met de arrangement-status, ongeacht sandbox-mode.

import { supabaseAdmin } from '../supabase.js';

/**
 * Pauzeer alle actieve dunning_workflow_runs van een klant vanwege een
 * nieuwe ACTIEF arrangement. Idempotent (dubbel-pauzeren geen kwaad).
 *
 * @param {string} arrangementId
 * @param {string} customerId
 * @returns {Promise<{ ok:boolean, paused_count:number, error?:string }>}
 */
export async function pauseRunsForArrangement(arrangementId, customerId) {
  if (!arrangementId || !customerId) {
    return { ok: false, paused_count: 0, error: 'arrangementId + customerId vereist' };
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                   'paused',
        paused_by_arrangement_id: arrangementId,
        updated_at:               new Date().toISOString(),
      })
      .eq('customer_id', customerId)
      .eq('status', 'active')
      .select('id');
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if (count > 0) {
      console.log(`[arrangement-hook] gepauzeerd ${count} runs voor klant ${customerId} (arrangement ${arrangementId})`);
    }
    return { ok: true, paused_count: count };
  } catch (e) {
    console.warn('[arrangement-hook pauseRunsForArrangement] fail-soft:', e?.message || e);
    return { ok: false, paused_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Sluit alle runs af die door dit arrangement gepauzeerd zijn — NAGEKOMEN-pad.
 * Facturen zijn betaald; de aanmaan-flow is niet meer nodig. Runs krijgen
 * status='completed' met completion_reason='arrangement_nagekomen'.
 *
 * @param {string} arrangementId
 * @returns {Promise<{ ok:boolean, completed_count:number, error?:string }>}
 */
export async function completeRunsFromArrangement(arrangementId) {
  if (!arrangementId) return { ok: false, completed_count: 0, error: 'arrangementId vereist' };
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:            'completed',
        completed_at:      nowIso,
        completion_reason: 'arrangement_nagekomen',
        updated_at:        nowIso,
      })
      .eq('paused_by_arrangement_id', arrangementId)
      .eq('status', 'paused')
      .select('id');
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if (count > 0) {
      console.log(`[arrangement-hook] afgesloten ${count} runs (arrangement ${arrangementId} nagekomen)`);
    }
    return { ok: true, completed_count: count };
  } catch (e) {
    console.warn('[arrangement-hook completeRunsFromArrangement] fail-soft:', e?.message || e);
    return { ok: false, completed_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Hervat de runs die door dit arrangement gepauzeerd zijn — GEANNULEERD-pad.
 * De afspraak is van tafel; de aanmaan-flow moet weer draaien. Runs gaan
 * paused → active. paused_by_arrangement_id wordt gereset.
 *
 * @param {string} arrangementId
 * @returns {Promise<{ ok:boolean, resumed_count:number, error?:string }>}
 */
export async function unpauseRunsFromArrangement(arrangementId) {
  if (!arrangementId) return { ok: false, resumed_count: 0, error: 'arrangementId vereist' };
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                   'active',
        paused_by_arrangement_id: null,
        // Bij hervatten meteen picken: next_action_at op nu zetten zodat de
        // eerstvolgende engine-tick 'em oppakt.
        next_action_at:           nowIso,
        updated_at:               nowIso,
      })
      .eq('paused_by_arrangement_id', arrangementId)
      .eq('status', 'paused')
      .select('id');
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if (count > 0) {
      console.log(`[arrangement-hook] hervat ${count} runs (arrangement ${arrangementId} geannuleerd)`);
    }
    return { ok: true, resumed_count: count };
  } catch (e) {
    console.warn('[arrangement-hook unpauseRunsFromArrangement] fail-soft:', e?.message || e);
    return { ok: false, resumed_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Hervat ALLE paused runs van een klant, ongeacht welk arrangement ze
 * pauzeerde. Gebruikt door de resume_dunning step-executor (Deel 3):
 * de workflow met arrangement_breached trigger commandeert "hervat".
 * Reset paused_by_arrangement_id.
 *
 * @param {string} customerId
 * @returns {Promise<{ ok:boolean, resumed_count:number, error?:string }>}
 */
export async function resumeAllPausedRunsForCustomer(customerId) {
  if (!customerId) return { ok: false, resumed_count: 0, error: 'customerId vereist' };
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                   'active',
        paused_by_arrangement_id: null,
        next_action_at:           nowIso,
        updated_at:               nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'paused')
      .select('id');
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    return { ok: true, resumed_count: count };
  } catch (e) {
    console.warn('[arrangement-hook resumeAllPausedRunsForCustomer] fail-soft:', e?.message || e);
    return { ok: false, resumed_count: 0, error: e?.message || String(e) };
  }
}
