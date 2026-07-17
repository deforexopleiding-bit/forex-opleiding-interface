// api/_lib/dunning-arrangement-hooks.js
//
// Fase 2b — Hooks tussen payment_arrangements en dunning_workflow_runs.
// Zorgt dat een actieve betaalafspraak de lopende aanmaan-workflow pauzeert
// en dat de runs netjes worden afgesloten/hervat bij afronding of annulering.
//
// Joost fase 2 (juli 2026): TWEEDE pauze-reden toegevoegd — een actief gesprek.
// Een run kan tegelijk gepauzeerd zijn door een arrangement EN een gesprek;
// beide worden onafhankelijk opgeheven en de run gaat pas terug naar active
// als BEIDE redenen weg zijn (paused_by_arrangement_id IS NULL EN
// paused_by_conversation_id IS NULL). De helpers in dit bestand implementeren
// dat "dual-reason" model met een 2-UPDATE-pattern: eerst runs waar de andere
// reden ALSNOG staat (alleen deze reden resetten, status blijft paused), dan
// runs waar de andere reden ook NULL is (status naar active + next_action_at
// op nu). Zo drukken arrangement-flows nooit een gespreks-pauze weg, en
// omgekeerd.
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
 * Pauzeer alle dunning_workflow_runs van een klant vanwege een nieuw ACTIEF
 * arrangement, en zet de arrangement-reden — ook als de run al gepauzeerd
 * was door een gesprek (Joost fase 2, #766).
 *
 * Dual-reason pattern (2-UPDATE, spiegel van pauseRunsForConversation):
 *   1) Runs `status='active'`           → status='paused' + reden zetten.
 *   2) Runs `status='paused'` waarvan   → alleen reden zetten,
 *      paused_by_arrangement_id NULL       status blijft paused. Zo blijft
 *      is (dus alleen door gesprek        het gesprek de andere pauze-
 *      gepauzeerd)                        reden en unpauseRunsForConversation
 *                                         weet dat de arrangement-reden ook
 *                                         actief is → resumed niet naar
 *                                         active zolang de afspraak loopt.
 * `completed` / `cancelled` runs worden NOOIT aangeraakt.
 *
 * De 2e UPDATE filtert `paused_by_arrangement_id IS NULL` zodat een
 * bestaande andere arrangement-koppeling nooit overschreven wordt (defensief;
 * per klant hoort er hooguit één ACTIEF arrangement te zijn).
 *
 * Idempotent: dubbel-pauzeren geen kwaad.
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
    const nowIso = new Date().toISOString();
    // 1) Actieve runs → paused met arrangement-reden.
    const { data: paused, error: pErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                   'paused',
        paused_by_arrangement_id: arrangementId,
        updated_at:               nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'active')
      .select('id');
    if (pErr) throw pErr;
    // 2) Runs al paused door alleen een gesprek → alleen arrangement-reden
    //    erbij, status blijft paused. Zonder deze stap zou een run die eerst
    //    door een inbound message gepauzeerd is, straks bij unpauseRunsFor
    //    Conversation als "geen andere reden" naar active gaan — en de klant
    //    krijgt aanmaningen ondanks een actieve betaalafspraak.
    const { data: linked, error: lErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        paused_by_arrangement_id: arrangementId,
        updated_at:               nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'paused')
      .is('paused_by_arrangement_id', null)
      .select('id');
    if (lErr) throw lErr;
    const count = (Array.isArray(paused) ? paused.length : 0)
                + (Array.isArray(linked) ? linked.length : 0);
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
      .select('id, customer_id');
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if (count > 0) {
      console.log(`[arrangement-hook] afgesloten ${count} runs (arrangement ${arrangementId} nagekomen)`);
      // #798 — reset Joost-tellers voor élke unieke klant wiens run
      // is afgesloten. Fail-safe: eventuele fout blokkeert de completion niet.
      const uniqueCustomers = Array.from(new Set(data.map((r) => r.customer_id).filter(Boolean)));
      for (const cid of uniqueCustomers) {
        try { await resetJoostCountersForCustomer(cid); }
        catch (e) { console.warn('[arrangement-hook] joost-counter-reset fail-soft:', cid, e?.message || e); }
      }
    }
    return { ok: true, completed_count: count };
  } catch (e) {
    console.warn('[arrangement-hook completeRunsFromArrangement] fail-soft:', e?.message || e);
    return { ok: false, completed_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Hervat de runs die door dit arrangement gepauzeerd zijn — GEANNULEERD-pad.
 * De afspraak is van tafel; de aanmaan-flow moet weer draaien. Dual-reason:
 * paused_by_arrangement_id gaat NULL. Alleen runs waar OOK paused_by_
 * conversation_id NULL is gaan status=active; runs met een actieve gespreks-
 * pauze blijven paused (de gespreks-cron resumet ze zelf zodra dat mag).
 *
 * @param {string} arrangementId
 * @returns {Promise<{ ok:boolean, resumed_count:number, still_paused_count:number, error?:string }>}
 */
export async function unpauseRunsFromArrangement(arrangementId) {
  if (!arrangementId) return { ok: false, resumed_count: 0, still_paused_count: 0, error: 'arrangementId vereist' };
  try {
    const nowIso = new Date().toISOString();
    // 1) Runs zonder gespreks-pauze → status=active + next_action_at=nu.
    const { data: activated, error: actErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                   'active',
        paused_by_arrangement_id: null,
        next_action_at:           nowIso,
        updated_at:               nowIso,
      })
      .eq('paused_by_arrangement_id', arrangementId)
      .eq('status', 'paused')
      .is('paused_by_conversation_id', null)
      .select('id');
    if (actErr) throw actErr;
    // 2) Runs mét actieve gespreks-pauze → alleen arrangement-reden weg,
    //    status blijft paused (gespreks-cron beslist wanneer hervatten).
    const { data: stillPaused, error: spErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        paused_by_arrangement_id: null,
        updated_at:               nowIso,
      })
      .eq('paused_by_arrangement_id', arrangementId)
      .eq('status', 'paused')
      .not('paused_by_conversation_id', 'is', null)
      .select('id');
    if (spErr) throw spErr;
    const resumedCount     = Array.isArray(activated)   ? activated.length   : 0;
    const stillPausedCount = Array.isArray(stillPaused) ? stillPaused.length : 0;
    if (resumedCount > 0 || stillPausedCount > 0) {
      console.log(`[arrangement-hook] arrangement ${arrangementId} geannuleerd: hervat ${resumedCount} runs, ${stillPausedCount} blijven paused (gespreks-pauze).`);
    }
    return { ok: true, resumed_count: resumedCount, still_paused_count: stillPausedCount };
  } catch (e) {
    console.warn('[arrangement-hook unpauseRunsFromArrangement] fail-soft:', e?.message || e);
    return { ok: false, resumed_count: 0, still_paused_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Hervat ALLE paused runs van een klant, ongeacht welk arrangement ze
 * pauzeerde. Gebruikt door de resume_dunning step-executor (Deel 3):
 * de workflow met arrangement_breached trigger commandeert "hervat".
 * Reset paused_by_arrangement_id.
 *
 * Dual-reason (Joost fase 2): runs met een actieve gespreks-pauze
 * (paused_by_conversation_id != NULL) worden GERESPECTEERD. Alleen de
 * arrangement-reden wordt weggehaald; de gespreks-cron beslist wanneer
 * die runs terug naar active gaan.
 *
 * @param {string} customerId
 * @returns {Promise<{ ok:boolean, resumed_count:number, still_paused_count:number, error?:string }>}
 */
export async function resumeAllPausedRunsForCustomer(customerId) {
  if (!customerId) return { ok: false, resumed_count: 0, still_paused_count: 0, error: 'customerId vereist' };
  try {
    const nowIso = new Date().toISOString();
    // 1) Runs zonder gespreks-pauze → status=active.
    const { data: activated, error: actErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                   'active',
        paused_by_arrangement_id: null,
        next_action_at:           nowIso,
        updated_at:               nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'paused')
      .is('paused_by_conversation_id', null)
      .select('id');
    if (actErr) throw actErr;
    // 2) Runs mét gespreks-pauze → alleen arrangement-reden weg.
    const { data: stillPaused, error: spErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        paused_by_arrangement_id: null,
        updated_at:               nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'paused')
      .not('paused_by_conversation_id', 'is', null)
      .select('id');
    if (spErr) throw spErr;
    const resumedCount     = Array.isArray(activated)   ? activated.length   : 0;
    const stillPausedCount = Array.isArray(stillPaused) ? stillPaused.length : 0;
    return { ok: true, resumed_count: resumedCount, still_paused_count: stillPausedCount };
  } catch (e) {
    console.warn('[arrangement-hook resumeAllPausedRunsForCustomer] fail-soft:', e?.message || e);
    return { ok: false, resumed_count: 0, still_paused_count: 0, error: e?.message || String(e) };
  }
}

// =============================================================================
// Joost fase 2: gespreks-pauze hooks (2e pauze-reden naast arrangement)
// =============================================================================

/**
 * Pauzeer alle actieve dunning_workflow_runs van een klant vanwege een
 * inbound bericht op deze conversation. Idempotent: als runs al door een
 * arrangement paused zijn, wordt paused_by_conversation_id erbij gezet
 * zonder status te wijzigen (blijft paused). Actieve runs gaan naar paused.
 *
 * Reset ook `paused_conversation_reminder_count` en `_last_reminder_at`:
 * elke nieuwe inbound zet de reminder-teller op 0 (nieuwe stilte begint).
 *
 * @param {string} conversationId
 * @param {string} customerId
 * @returns {Promise<{ ok:boolean, paused_count:number, error?:string }>}
 */
export async function pauseRunsForConversation(conversationId, customerId) {
  if (!conversationId || !customerId) {
    return { ok: false, paused_count: 0, error: 'conversationId + customerId vereist' };
  }
  try {
    const nowIso = new Date().toISOString();
    // Actieve runs → paused met gespreks-pauze.
    const { data: paused, error: pErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                                 'paused',
        paused_by_conversation_id:              conversationId,
        paused_conversation_reminder_count:     0,
        paused_conversation_last_reminder_at:   null,
        updated_at:                             nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'active')
      .select('id');
    if (pErr) throw pErr;
    // Reeds-paused runs (bv. door arrangement) → alleen gespreks-reden erbij
    // + teller reset. Status blijft paused. Idempotent.
    const { data: linked, error: lErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        paused_by_conversation_id:              conversationId,
        paused_conversation_reminder_count:     0,
        paused_conversation_last_reminder_at:   null,
        updated_at:                             nowIso,
      })
      .eq('customer_id', customerId)
      .eq('status', 'paused')
      .is('paused_by_conversation_id', null)
      .select('id');
    if (lErr) throw lErr;
    const count = (Array.isArray(paused) ? paused.length : 0)
                + (Array.isArray(linked) ? linked.length : 0);
    if (count > 0) {
      console.log(`[conv-hook] gespreks-pauze: ${count} runs voor klant ${customerId} (conv ${conversationId})`);
    }
    return { ok: true, paused_count: count };
  } catch (e) {
    console.warn('[conv-hook pauseRunsForConversation] fail-soft:', e?.message || e);
    return { ok: false, paused_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Hervat de runs die door deze conversation gepauzeerd zijn — na de resume-
 * termijn uit de reminder-cron. Dual-reason: alleen runs waar OOK
 * paused_by_arrangement_id NULL is gaan status=active; runs met een
 * arrangement blijven paused (arrangement-cascade beslist).
 *
 * @param {string} conversationId
 * @returns {Promise<{ ok:boolean, resumed_count:number, still_paused_count:number, error?:string }>}
 */
export async function unpauseRunsForConversation(conversationId) {
  if (!conversationId) return { ok: false, resumed_count: 0, still_paused_count: 0, error: 'conversationId vereist' };
  try {
    const nowIso = new Date().toISOString();
    // 1) Runs zonder arrangement-pauze → status=active + next_action_at=nu.
    const { data: activated, error: actErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        status:                                 'active',
        paused_by_conversation_id:              null,
        paused_conversation_reminder_count:     0,
        paused_conversation_last_reminder_at:   null,
        next_action_at:                         nowIso,
        updated_at:                             nowIso,
      })
      .eq('paused_by_conversation_id', conversationId)
      .eq('status', 'paused')
      .is('paused_by_arrangement_id', null)
      .select('id');
    if (actErr) throw actErr;
    // 2) Runs mét arrangement-pauze → alleen gespreks-reden weg.
    const { data: stillPaused, error: spErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        paused_by_conversation_id:              null,
        paused_conversation_reminder_count:     0,
        paused_conversation_last_reminder_at:   null,
        updated_at:                             nowIso,
      })
      .eq('paused_by_conversation_id', conversationId)
      .eq('status', 'paused')
      .not('paused_by_arrangement_id', 'is', null)
      .select('id');
    if (spErr) throw spErr;
    const resumedCount     = Array.isArray(activated)   ? activated.length   : 0;
    const stillPausedCount = Array.isArray(stillPaused) ? stillPaused.length : 0;
    if (resumedCount > 0 || stillPausedCount > 0) {
      console.log(`[conv-hook] gespreks-pauze opgeheven voor conv ${conversationId}: hervat ${resumedCount}, ${stillPausedCount} blijven paused (arrangement).`);
    }
    return { ok: true, resumed_count: resumedCount, still_paused_count: stillPausedCount };
  } catch (e) {
    console.warn('[conv-hook unpauseRunsForConversation] fail-soft:', e?.message || e);
    return { ok: false, resumed_count: 0, still_paused_count: 0, error: e?.message || String(e) };
  }
}

/**
 * Reset Joost's per-conversation counters voor deze klant. Bedoeld om aan te
 * roepen bij dunning-run-start (nieuwe run = nieuwe incident-cap-budget van
 * 10 berichten) en bij dunning-run-completion (paid / arrangement_nagekomen /
 * manual_cancel / no_more_steps).
 *
 * SCOPE: ALLEEN finance-conversations. joost_conversation_state is een
 * gedeelde tabel — Simone (events) leest en schrijft dezelfde velden voor
 * conversations die aan het events-WABA-nummer hangen. Zonder module-scope
 * zou een dunning-run-completion Simone's cap wegpoetsen.
 *
 * FAIL-SAFE (bewust anders dan andere hooks hier):
 *   Bij een module-lookup fout resetten we NIETS en loggen we een warning.
 *   We vallen NOOIT terug op "reset dan maar alle conversations van deze
 *   klant" — dat zou Simone's teller kunnen wegpoetsen. Semantiek: een
 *   gemiste reset betekent hooguit dat Joost eerder stilvalt, wat vervelend
 *   is maar niet gevaarlijk. Een over-brede reset kan Simone kapotmaken.
 *
 * Reset-velden (autonomy_paused_until / _reason WORDEN NIET GERAAKT — dat
 * is een expliciete beslissing die niet als bijproduct van een run-flip
 * mag verdwijnen):
 *   - messages_sent_today      → 0
 *   - messages_sent_today_date → NULL (eerstvolgende send seedt 'em)
 *   - messages_sent_total      → 0 (de kern van #798)
 *   - last_message_sent_at     → NULL (cooldown-teller weg)
 *   - no_reply_streak_count    → 0
 *   - updated_at               → now()
 *
 * @param {string} customerId  uuid — klant wiens finance-conversations
 *                             gereset moeten worden.
 * @returns {Promise<{ ok:boolean, conversations_reset:number, error?:string }>}
 */
export async function resetJoostCountersForCustomer(customerId) {
  if (!customerId) return { ok: false, conversations_reset: 0, error: 'customerId vereist' };
  try {
    // Stap 1 — bepaal welke phone_number_ids finance-lijnen zijn. Bij een
    // lookup-fout (of 0 finance-lijnen actief) → NIETS resetten. Simone-veilig.
    const { data: financeCfg, error: cfgErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'finance')
      .eq('is_active', true);
    if (cfgErr) {
      console.warn('[joost-counter-reset] whatsapp_module_config lookup fail — NIETS resetten (Simone-safe):', cfgErr.message);
      return { ok: false, conversations_reset: 0, error: cfgErr.message };
    }
    const financePnIds = (Array.isArray(financeCfg) ? financeCfg : [])
      .map((r) => r?.phone_number_id)
      .filter(Boolean);
    if (financePnIds.length === 0) {
      console.warn('[joost-counter-reset] geen actieve finance-lijnen in whatsapp_module_config — NIETS resetten (Simone-safe) customer', customerId);
      return { ok: false, conversations_reset: 0, error: 'no_active_finance_lines' };
    }

    // Stap 2 — vind de finance-conversations van deze klant. Bewust NIET
    // ook conversations met NULL phone_number_id meepakken: die zouden in
    // theorie via een adopt-bug bij events-inbound kunnen zijn ontstaan.
    // Bij twijfel niet resetten.
    const { data: convs, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id')
      .eq('customer_id', customerId)
      .in('phone_number_id', financePnIds);
    if (convErr) {
      console.warn('[joost-counter-reset] whatsapp_conversations lookup fail — NIETS resetten:', convErr.message);
      return { ok: false, conversations_reset: 0, error: convErr.message };
    }
    const convIds = (Array.isArray(convs) ? convs : []).map((r) => r?.id).filter(Boolean);
    if (convIds.length === 0) {
      // Geen finance-conv voor deze klant — niet ongewoon, gewoon skip.
      return { ok: true, conversations_reset: 0 };
    }

    // Stap 3 — reset de counters. Als er nog geen state-rij is voor een
    // conversation, is er ook niets te resetten (defaults zijn 0 / NULL).
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .update({
        messages_sent_today:      0,
        messages_sent_today_date: null,
        messages_sent_total:      0,
        last_message_sent_at:     null,
        no_reply_streak_count:    0,
        updated_at:               nowIso,
      })
      .in('conversation_id', convIds)
      .select('conversation_id');
    if (updErr) {
      console.warn('[joost-counter-reset] joost_conversation_state update fail:', updErr.message);
      return { ok: false, conversations_reset: 0, error: updErr.message };
    }
    const count = Array.isArray(updated) ? updated.length : 0;
    if (count > 0) {
      console.log(`[joost-counter-reset] reset ${count} finance-conv(s) voor klant ${customerId}`);
    }
    return { ok: true, conversations_reset: count };
  } catch (e) {
    console.warn('[joost-counter-reset] fail-soft:', e?.message || e);
    return { ok: false, conversations_reset: 0, error: e?.message || String(e) };
  }
}
