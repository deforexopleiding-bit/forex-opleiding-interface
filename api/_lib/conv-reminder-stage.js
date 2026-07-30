// api/_lib/conv-reminder-stage.js
//
// Pure helper voor de no-reply reminder-cron. Extract uit
// cron-dunning-conversation-reminders.js zodat unit-tests draaien zonder
// supabase-init (de cron-file laadt supabase op module-load, wat env-vars
// vereist die in test-omgeving niet gezet zijn).
//
// determineStage bepaalt welke actie de reminder-cron moet doen voor 1 run:
//   'r1' → reminder 1 sturen (nooit gestuurd + klant is stil >= reminder_1_hours
//          én wij hebben niet recenter geantwoord)
//   'r2' → reminder 2 sturen (r1 al gestuurd + stil-sinds-r1 >= reminder_2_hours
//          én geen inbound én geen outbound na r1)
//   'rz' → resume run (r2 al gestuurd + stil >= resume_after_hours)
//   null → niets doen (nog te vroeg, al voltooid, of wij hebben al gereageerd)

/**
 * @param {object} args
 * @param {object} args.run              dunning_workflow_runs row met
 *   paused_conversation_reminder_count + paused_conversation_last_reminder_at.
 * @param {string|null} args.convLastInboundAt   ISO-datum laatste klant-bericht.
 * @param {string|null} [args.convLastOutboundAt] ISO-datum laatste outbound
 *   van ons (WA-messages.direction='out'). Fix B no-reply-bug: check dat wij
 *   niet al recenter hebben geantwoord dan de klant. Als null: fallback op
 *   oud gedrag (alleen inbound-timing) — fix A dekt dan af.
 * @param {object} args.noReplyCfg       joost_config.autonomy_config.no_reply
 * @param {number} args.nowMs            Date.now() (injecteerbaar voor tests).
 * @returns {'r1'|'r2'|'rz'|null}
 */
export function determineStage({ run, convLastInboundAt, convLastOutboundAt = null, noReplyCfg, nowMs }) {
  const count = Number(run?.paused_conversation_reminder_count || 0);
  const lastReminderAt = run?.paused_conversation_last_reminder_at
    ? new Date(run.paused_conversation_last_reminder_at).getTime()
    : null;
  const lastInboundMs = convLastInboundAt
    ? new Date(convLastInboundAt).getTime()
    : null;
  const lastOutboundMs = convLastOutboundAt
    ? new Date(convLastOutboundAt).getTime()
    : null;

  const r1h = Number(noReplyCfg?.reminder_1_hours ?? 20);
  const r2h = Number(noReplyCfg?.reminder_2_hours ?? 24);
  const rzh = Number(noReplyCfg?.resume_after_hours ?? 24);

  const HOUR = 60 * 60 * 1000;

  if (count === 0) {
    if (!lastInboundMs) return null;
    // FIX B no-reply-bug: wij hebben al gereageerd → geen r1-reminder.
    if (lastOutboundMs && lastOutboundMs > lastInboundMs) return null;
    if (nowMs - lastInboundMs >= r1h * HOUR) return 'r1';
    return null;
  }
  if (count === 1) {
    if (!lastReminderAt) return null;
    // Bestaande reply-respect: klant heeft NA r1 gereageerd → geen r2.
    if (lastInboundMs && lastInboundMs > lastReminderAt) return null;
    // Symmetrisch (FIX B): wij hebben handmatig geantwoord na r1 → geen r2.
    if (lastOutboundMs && lastOutboundMs > lastReminderAt) return null;
    if (nowMs - lastReminderAt >= r2h * HOUR) return 'r2';
    return null;
  }
  if (count >= 2) {
    if (!lastReminderAt) return null;
    if (nowMs - lastReminderAt >= rzh * HOUR) return 'rz';
    return null;
  }
  return null;
}
