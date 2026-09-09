// api/_lib/conv-reminder-stage.js
//
// Pure helper voor de no-reply reminder-cron. Extract uit
// cron-dunning-conversation-reminders.js zodat unit-tests draaien zonder
// supabase-init (de cron-file laadt supabase op module-load, wat env-vars
// vereist die in test-omgeving niet gezet zijn).
//
// determineStage bepaalt welke actie de reminder-cron moet doen voor 1 run:
//   'r1' → reminder 1 sturen (nooit gestuurd + ONS laatste bericht is
//          >= reminder_1_hours oud én de klant heeft daarna niets gestuurd)
//   'r2' → reminder 2 sturen (r1 al gestuurd + ons laatste bericht is
//          >= reminder_2_hours oud én de klant heeft daarna niets gestuurd)
//   'rz' → resume run (r2 al gestuurd + stil >= resume_after_hours)
//   'rz_blocked' → hervatten geweigerd: de bal ligt bij ons (aparte waarde
//          i.p.v. null zodat de cron het als eigen reden kan loggen)
//   null → niets doen (nog te vroeg, of al voltooid)
//
// ── DE KLOK LOOPT VANAF ONS LAATSTE UITGAANDE BERICHT ────────────────────
//
// Dit was fout en het is bij een klant zichtbaar geworden. Conversatie
// c7e20f96-f02a-46b7-ac1e-a862a99ec1b5: de klant stuurde op 06-09 om
// 08:59:38Z twee berichten, waaronder de vraag "Waarom krijg ik deze app?".
// Niemand antwoordde. Precies 20 uur later (07-09 05:00:26Z) ging reminder 1
// uit met "Ik heb je eerder een bericht gestuurd, maar nog geen reactie van
// jou gekregen" — feitelijk onwaar, want zíj had wél gereageerd en wij niet.
//
// Oorzaak: de r1-drempel werd gemeten vanaf `last_inbound_at` (het laatste
// bericht van de KLANT). Wie stil is bepaalt echter wie er als laatste iets
// gezegd heeft, niet wanneer de klant voor het laatst iets zei.
//
// Twee regels, in deze volgorde:
//   1. Is het LAATSTE bericht in de draad van de klant en onbeantwoord, dan
//      gaat er GEEN no-reply-herinnering uit. De bal ligt bij ons; zo'n
//      gesprek hoort op een werklijst, niet in een automaat.
//   2. Anders loopt de klok vanaf ons laatste uitgaande bericht in die
//      conversatie (dat kan de aanmaning zijn, een reminder, of het antwoord
//      van een medewerker).
//
// ── DE REGEL GELDT OOK VOOR HET HERVATTEN ('rz') ─────────────────────────
//
// De eerste versie van deze fix liet 'rz' met opzet ongemoeid, met als
// redenering: bij een onbeantwoord gesprek komt de teller nooit op 2, want
// dan is r1 al niet vertrokken. Dat klopt alleen als de klant de héle tijd
// stil blijft. Het gat:
//
//   klant stil -> r1 gaat uit -> klant nog steeds stil -> r2 gaat uit
//   -> DAARNA stuurt de klant een bericht dat niemand beantwoordt.
//
// Nu is de teller 2, de bal ligt bij ons, en de count>=2-tak keek daar niet
// naar. Vierentwintig uur na r2 vuurde 'rz', unpauseRunsForConversation zette
// de run weer aan, en de aanmaanladder liep verder bovenop een onbeantwoord
// bericht van die klant. Dat is exact het gedrag dat deze fix moet stoppen,
// alleen een laag dieper: niet de herinnering zelf maar het hervatten.
//
// Daarom geldt dezelfde regel voor 'rz'. Ligt het laatste bericht bij de klant
// en is het onbeantwoord, dan blijft de run gepauzeerd tot een mens antwoordt.
// Dat is geen uitstel maar een stop: er is geen timer die het alsnog laat
// gebeuren — pas een uitgaand bericht van ons haalt de blokkade weg.

/**
 * @param {object} args
 * @param {object} args.run              dunning_workflow_runs row met
 *   paused_conversation_reminder_count + paused_conversation_last_reminder_at.
 * @param {string|null} args.convLastInboundAt   ISO-datum laatste klant-bericht.
 * @param {string|null} [args.convLastOutboundAt] ISO-datum laatste outbound
 *   van ons (whatsapp_messages.direction='out'). Dit is nu de KLOK voor r1/r2,
 *   niet langer alleen een guard. Is deze null (nooit iets gestuurd, of de
 *   lookup faalde), dan gaat er geen herinnering uit: zonder eigen bericht is
 *   "ik heb nog geen reactie gekregen" per definitie onwaar.
 * @param {object} args.noReplyCfg       joost_config.autonomy_config.no_reply
 *   - reminder_1_hours (default 20)
 *   - reminder_2_hours (default 24)
 *   - resume_after_hours (default 24)
 *
 *   OBSOLEET: `suppress_reminder_after_outbound_hours` wordt niet meer gelezen.
 *   Die guard onderdrukte een reminder zolang onze outbound jong was; nu de
 *   klok zelf vanaf ons laatste bericht loopt is dat per constructie al
 *   afgedekt. De key mag in de config blijven staan en stuurt niets aan.
 * @param {number} args.nowMs            Date.now() (injecteerbaar voor tests).
 * @returns {'r1'|'r2'|'rz'|'rz_blocked'|null}
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

  // ONS laatste bericht in de draad. Normaal is dat gewoon de laatste
  // outbound; `paused_conversation_last_reminder_at` doet mee als vangnet voor
  // het geval de WA-message nog niet gepersisteerd is (of bij een dry-run,
  // waar de teller wél opgehoogd wordt maar er geen bericht wegging).
  const onsLaatsteMs = Math.max(lastOutboundMs || 0, lastReminderAt || 0) || null;

  /**
   * Ligt de bal bij ons? Waar: het laatste bericht in de draad komt van de
   * klant en is onbeantwoord. Dan gaat er geen enkele herinnering uit — een
   * automaat die "ik heb nog geen reactie gekregen" stuurt op een onbeantwoorde
   * klantvraag is aantoonbaar onwaar tegen de klant.
   */
  function balLigtBijOns() {
    if (!lastInboundMs) return false;
    if (!onsLaatsteMs) return true;                 // wij hebben nooit iets gestuurd
    return lastInboundMs > onsLaatsteMs;
  }

  if (count === 0) {
    if (balLigtBijOns()) return null;
    if (!onsLaatsteMs) return null;                 // niets van ons = geen klok
    if (nowMs - onsLaatsteMs >= r1h * HOUR) return 'r1';
    return null;
  }
  if (count === 1) {
    if (!lastReminderAt) return null;
    if (balLigtBijOns()) return null;               // dekt ook de oude reply-respect
    if (!onsLaatsteMs) return null;
    if (nowMs - onsLaatsteMs >= r2h * HOUR) return 'r2';
    return null;
  }
  if (count >= 2) {
    if (!lastReminderAt) return null;
    // Hervatten is geen herinnering, maar het zet de aanmaanladder wél weer
    // in beweging. Ligt de bal bij ons, dan gebeurt dat niet: de run blijft
    // gepauzeerd tot een mens antwoordt. Aparte returnwaarde zodat de cron
    // dit als eigen reden logt in plaats van het te laten verdwijnen in
    // NOT_DUE_YET — dit is een blokkade, geen "nog even wachten".
    if (balLigtBijOns()) return 'rz_blocked';
    if (nowMs - lastReminderAt >= rzh * HOUR) return 'rz';
    return null;
  }
  return null;
}
