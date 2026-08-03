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
 *   - reminder_1_hours (default 20)
 *   - reminder_2_hours (default 24)
 *   - resume_after_hours (default 24)
 *   - suppress_reminder_after_outbound_hours (default 24) — GAT 5 / Bug 1 fix:
 *     hoe lang na onze outbound de reminder-cirkel gepauzeerd blijft. Was
 *     voorheen effectief oneindig (elke outbound blokkeerde permanent).
 *     Zet op 0 om de guard uit te zetten (reminder gaat dan sowieso door zodra
 *     tijd-drempel r1h/r2h gehaald is).
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
  // GAT 5 / Bug 1: tijd-drempel voor "wij hebben net gereageerd"-guard. Zolang
  // onze laatste outbound jonger is dan deze drempel, geen bot-reminder eroverheen.
  // Ouder dan drempel + klant blijft stil → cirkel gaat wél door.
  // 0 = guard uit. Default 24u (mens heeft een dag om zelf reactie te krijgen;
  // daarna neemt de automatische cirkel het over).
  const suppressH = Number(noReplyCfg?.suppress_reminder_after_outbound_hours ?? 24);

  const HOUR = 60 * 60 * 1000;

  /**
   * Bug 1 / GAT 5 fix — was voorheen absolute suppress (lastOutbound > anchor
   * → return null, voor eeuwig). Nu: alleen suppress als onze outbound RECENT
   * is. Ouder dan drempel → laat de cirkel doorlopen zodat een klant die stil
   * blijft alsnog opgepakt wordt.
   *
   * anchorMs is de referentie (lastInboundMs voor r1-gate, lastReminderMs voor
   * r2-gate). We suppressen alleen als outbound BOTH recenter-dan-anchor is
   * (wij hebben iets gezegd na de klant/reminder) EN jonger dan `suppressH`.
   */
  function ourOutboundRecentlyOverrides(anchorMs) {
    if (!lastOutboundMs) return false;
    if (lastOutboundMs <= anchorMs) return false;         // outbound vóór anchor telt niet
    if (suppressH <= 0) return false;                     // guard uit
    const ageMs = nowMs - lastOutboundMs;
    return ageMs < suppressH * HOUR;
  }

  if (count === 0) {
    if (!lastInboundMs) return null;
    if (ourOutboundRecentlyOverrides(lastInboundMs)) return null;
    if (nowMs - lastInboundMs >= r1h * HOUR) return 'r1';
    return null;
  }
  if (count === 1) {
    if (!lastReminderAt) return null;
    // Bestaande reply-respect: klant heeft NA r1 gereageerd → geen r2.
    if (lastInboundMs && lastInboundMs > lastReminderAt) return null;
    if (ourOutboundRecentlyOverrides(lastReminderAt)) return null;
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
