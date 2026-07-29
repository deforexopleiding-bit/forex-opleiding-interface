// api/_lib/dunning-step-failure-handler.js
// Pure helpers voor het faal-pad in advanceActiveRuns. Geen DB, geen HTTP —
// deterministisch unit-testbaar.
//
// Doel: bij een gefaalde step-executor-return de juiste update-payload +
// log-events bouwen zodat de engine:
//   - een gefaalde send opnieuw probeert (max 3x, delay 24u), OF
//   - na 3 fails de run markeert als needs_attention (mens moet ingrijpen)
//   - GEEN pointer-advance doet (blijft op de gefaalde step voor retry)
//
// De caller (dunning-engine.js) is verantwoordelijk voor de DB-writes +
// het schrijven van de log-events. Deze helper geeft alleen de payload
// terug — testbaar in isolatie.

export const MAX_RETRIES         = 3;
export const RETRY_DELAY_HOURS   = 24;

/**
 * Bouw een failure-reason-string uit de executor-response. Vast formaat
 * "<log_event>[:<meta_code>]" — leesbaar in UI-tooltip + audit-log.
 */
export function buildFailureReason(stepResult) {
  const evt = String(stepResult?.log_event || 'unknown');
  const meta = stepResult?.log_payload?.meta_code;
  if (meta) return `${evt}:${meta}`;
  return evt;
}

/**
 * Bepaal wat de engine moet doen bij een gefaalde step. Pure functie.
 *
 * @param {object} args
 * @param {number} args.currentCount   step_failure_count VÓÓR deze fail (0 als eerste fail)
 * @param {object} args.stepResult     executor-return (moet status:'failed' hebben)
 * @param {string} args.nowIso         ISO-timestamp "nu" (caller injecteert Date.now())
 * @param {number} [args.maxRetries]   override (default MAX_RETRIES)
 * @param {number} [args.retryDelayHours] override (default RETRY_DELAY_HOURS)
 *
 * @returns {{
 *   action:      'retry' | 'escalate',
 *   update:      object,        // fields voor UPDATE dunning_workflow_runs (zonder id)
 *   log_event:   string,        // 'step_failed_retry' | 'step_failed_final'
 *   log_payload: object,        // context voor dunning_log insert
 *   break_loop:  true,          // binnenlus moet stoppen; volgende cron pakt op
 * }}
 */
export function evaluateStepFailure({ currentCount, stepResult, nowIso, maxRetries = MAX_RETRIES, retryDelayHours = RETRY_DELAY_HOURS }) {
  const newCount = (Number(currentCount) || 0) + 1;
  const reason = buildFailureReason(stepResult);

  if (newCount >= maxRetries) {
    // Escalate: markeer needs_attention, cron slaat run over. current_step_id
    // blijft ongewijzigd; wanneer een mens ingrijpt (bv. template fixt) en
    // handmatig de vlag reset, wordt de retry-teller ook op 0 gezet zodat
    // niet direct het volgende faal-pad wordt bereikt.
    return {
      action:     'escalate',
      update: {
        step_failure_count:  newCount,
        needs_attention:     true,
        last_failure_at:     nowIso,
        last_failure_reason: reason,
        updated_at:          nowIso,
      },
      log_event:   'step_failed_final',
      log_payload: {
        attempt:              newCount,
        max_retries:          maxRetries,
        executor_log_event:   String(stepResult?.log_event || ''),
        executor_log_payload: stepResult?.log_payload || {},
        reason,
      },
      break_loop: true,
    };
  }

  // Retry: schuif next_action_at met N uur, laat current_step_id ongewijzigd.
  const nextTryMs = Date.parse(nowIso) + retryDelayHours * 3600 * 1000;
  const nextTryIso = new Date(nextTryMs).toISOString();

  return {
    action: 'retry',
    update: {
      step_failure_count:  newCount,
      last_failure_at:     nowIso,
      last_failure_reason: reason,
      next_action_at:      nextTryIso,
      updated_at:          nowIso,
    },
    log_event:   'step_failed_retry',
    log_payload: {
      attempt:              newCount,
      max_retries:          maxRetries,
      next_try_at:          nextTryIso,
      executor_log_event:   String(stepResult?.log_event || ''),
      executor_log_payload: stepResult?.log_payload || {},
      reason,
    },
    break_loop: true,
  };
}

/**
 * Bepaal of een succesvolle send de needs_attention-flag moet clearen.
 * Alleen relevant als de run VOOR deze send al op needs_attention stond
 * (bv. mens greep in door template te fixen; volgende cron slaagde alsnog).
 *
 * @returns {{
 *   should_clear:      boolean,
 *   update_patch:      object,   // patch om te mergen in de bestaande update
 *   log_event?:        string,   // 'needs_attention_resolved' als should_clear
 *   log_payload?:      object,   // eerdere faalreden + attempts voor audit
 * }}
 */
export function evaluateSuccessAfterFailure({ run }) {
  const wasAttention = !!run?.needs_attention;
  const hadFailures  = (Number(run?.step_failure_count) || 0) > 0;
  if (!wasAttention && !hadFailures) {
    return { should_clear: false, update_patch: {} };
  }
  const patch = {
    step_failure_count: 0,
  };
  if (wasAttention) {
    patch.needs_attention = false;
    // last_failure_at/reason bewust NIET wissen — die blijven staan als
    // historisch spoor. Bij de volgende geslaagde run zijn ze wel "oud",
    // maar de audit-log heeft de resolved-event dus context is bewaard.
  }
  return {
    should_clear: true,
    update_patch: patch,
    log_event:    'needs_attention_resolved',
    log_payload:  {
      previous_reason:   run?.last_failure_reason || null,
      previous_failures: Number(run?.step_failure_count) || 0,
      previously_flagged: wasAttention,
      resolved_at:       new Date().toISOString(),
    },
  };
}
