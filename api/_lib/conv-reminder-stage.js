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
//   'geen_gesprek' → er is helemaal geen klant-bericht in deze conversatie;
//          er valt dus niets op te volgen. Zie "GEEN INBOUND" in de kop.
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
//   2. Anders loopt de klok vanaf ons laatste INHOUDELIJKE antwoord in die
//      conversatie.
//
// ── WAT TELT ALS "ONS ANTWOORD" ──────────────────────────────────────────
//
// Niet elke outbound. Bewijs uit productie (Samuel Yago, conversatie
// ca2af2a4-4ebc-42e5-a04d-1aafb0b55054): hij zegde op 07-09 om 10:07 zijn
// overeenkomst op, niemand antwoordde, en tóch gingen er op 08, 09 en 10
// september herinneringen uit. Oorzaak: de klok mat tegen `max(laatste
// outbound, laatste reminder)`, en de herinnering van de cron IS een outbound.
// Eén herinnering die er doorheen glipte zette de bal terug bij de klant, en
// vanaf dat moment was de guard voorgoed uitgeschakeld voor dat gesprek.
//
// De regel is daarom niet "wie drukte op verzenden" maar "wat voor bericht was
// het". Een TEMPLATE legt de bal nooit terug bij de klant: templates zijn
// aanmaningen, bulkrondes en herinneringen — eenrichtingsverkeer. Een VRIJ
// TEKSTBERICHT wel, of dat nu een medewerker is of Joost die inhoudelijk
// antwoordt. Diezelfde conversatie laat zien waarom dat klopt: op 05-09 om
// 08:42 gaf Joost autonoom een echt antwoord op zijn vraag, zonder template en
// zonder gebruiker-id. Dat wás een antwoord, en dat mag de klok starten.
//
// Uitzondering binnen de vrije tekst: de r1-variant van deze cron zelf (die
// gaat als vrije tekst uit zolang het 24-uursvenster open is). De caller
// filtert die eruit op `dunning_log.message_id` van de eigen
// `conversation_reminder_sent`-regels — anders zou de cron via de achterdeur
// alsnog zijn eigen bal terugleggen.
//
// ── DE VERZENDTIJD MAG NIET WANDELEN ─────────────────────────────────────
//
// r2 en rz hingen aan een rollende 24-uursklok vanaf het exacte tijdstip van
// de vorige herinnering. De cron tikt elk kwartier, dus de eerstvolgende tik
// die aan die 24 uur voldeed lag altijd íets later, en dat stapelde dag na
// dag op. In productie liep dat de nacht in: negen herinneringen die van
// 17:31 UTC naar 22:15 UTC wandelden (Michiel Van Brenk), en reeksen die
// eindigden op 01:15 en 02:15 UTC — drie en vier uur 's nachts bij de klant.
//
// Daarom vergelijkt `drempelGehaald()` bij voorkeur op hele KALENDERDAGEN in
// Europe/Amsterdam, aangeleverd door de caller. Het anker zit dan op de dag en
// niet op het uur; de eerste tik binnen het verzendvenster van de volgende dag
// is de eerste die telt.
//
// ── GEEN INBOUND = GEEN GESPREK ──────────────────────────────────────────
//
// Een conversatie zonder enig klant-bericht is geen gesprek. Er valt dan niets
// op te volgen, en de hele no-reply-cyclus is niet van toepassing. Dat wordt
// expliciet geblokkeerd ('geen_gesprek') in plaats van stilzwijgend door te
// laten. Zie de opmerking bij die tak voor de drie productie-gevallen.
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
 * @param {string|null} [args.convLastAnswerAt] ISO-datum van ons laatste
 *   INHOUDELIJKE antwoord in deze conversatie — een vrij tekstbericht dat geen
 *   herinnering van deze cron is. Zie de kop van dit bestand. Dit is de klok
 *   voor r1 én de maatstaf voor "ligt de bal bij ons". Is deze null (nooit
 *   inhoudelijk geantwoord, of de lookup faalde), dan gaat er geen herinnering
 *   uit: zonder eigen antwoord is "ik heb nog geen reactie gekregen" onwaar.
 * @param {object} args.noReplyCfg       joost_config.autonomy_config.no_reply
 *   - reminder_1_hours (default 20)
 *   - reminder_2_hours (default 24)
 *   - resume_after_hours (default 24)
 *
 *   OBSOLEET: `suppress_reminder_after_outbound_hours` wordt niet meer gelezen.
 *   Die guard onderdrukte een reminder zolang onze outbound jong was; nu de
 *   klok zelf vanaf ons laatste bericht loopt is dat per constructie al
 *   afgedekt. De key mag in de config blijven staan en stuurt niets aan.
 * @param {number|null} [args.kalenderdagenSindsOnsBericht] aantal hele
 *   kalenderdagen (Europe/Amsterdam) tussen ons laatste bericht in deze draad
 *   (herinnering óf antwoord, welke van de twee het laatst was) en vandaag.
 *   Wordt gebruikt voor r2 en rz in plaats van een rollende 24-uursklok — zie
 *   "DE VERZENDTIJD MAG NIET WANDELEN" in de kop. Null → val terug op de
 *   uren-vergelijking (oud gedrag; alleen nog voor losse unit-tests).
 * @param {number} args.nowMs            Date.now() (injecteerbaar voor tests).
 * @returns {'r1'|'r2'|'rz'|'rz_blocked'|'geen_gesprek'|null}
 */
export function determineStage({
  run, convLastInboundAt, convLastAnswerAt = null,
  kalenderdagenSindsOnsBericht = null, noReplyCfg, nowMs,
}) {
  const count = Number(run?.paused_conversation_reminder_count || 0);
  const lastReminderAt = run?.paused_conversation_last_reminder_at
    ? new Date(run.paused_conversation_last_reminder_at).getTime()
    : null;
  const lastInboundMs = convLastInboundAt
    ? new Date(convLastInboundAt).getTime()
    : null;
  // ONS LAATSTE ANTWOORD — niet zomaar onze laatste outbound. De caller heeft
  // de herinneringen van deze cron en alle template-sends er al uitgefilterd.
  const antwoordMs = convLastAnswerAt
    ? new Date(convLastAnswerAt).getTime()
    : null;

  const r1h = Number(noReplyCfg?.reminder_1_hours ?? 20);
  const r2h = Number(noReplyCfg?.reminder_2_hours ?? 24);
  const rzh = Number(noReplyCfg?.resume_after_hours ?? 24);

  const HOUR = 60 * 60 * 1000;

  /**
   * Is de drempel sinds de vorige herinnering gehaald?
   *
   * Bij voorkeur op hele kalenderdagen, niet op een rollende 24-uursklok. De
   * cron tikt elk kwartier en de klok stond verankerd op het exacte tijdstip
   * van de vorige herinnering, dus de eerstvolgende tik die aan "24 uur"
   * voldeed lag altijd íets later — en dat stapelde op. Gemeten in productie:
   * Michiel Van Brenk kreeg negen herinneringen die van 17:31 UTC naar 22:15
   * UTC wandelden, dus van halverwege de middag tot kwart over twaalf 's
   * nachts in Amsterdam. Marie Nyumah eindigde op 01:15 UTC, Ingrid Van Den
   * Eede op 02:15 UTC.
   *
   * Op kalenderdagen vergelijken haalt het anker van het uur af: de eerste tik
   * binnen het verzendvenster van de volgende dag is de eerste die telt, en
   * die ligt elke dag op hetzelfde punt.
   */
  // Anker voor r2 en rz: ONS laatste bericht in de draad — de vorige
  // herinnering, of ons antwoord als dat later kwam. Dat tweede is geen detail:
  // heeft een medewerker net persoonlijk gereageerd, dan mag er geen
  // automatische "ik heb nog geen reactie gekregen" achteraan komen.
  const onsLaatsteMs = Math.max(lastReminderAt || 0, antwoordMs || 0) || null;

  function drempelGehaald(urenDrempel) {
    if (!onsLaatsteMs) return false;
    if (Number.isFinite(kalenderdagenSindsOnsBericht)) {
      return kalenderdagenSindsOnsBericht * 24 >= urenDrempel;
    }
    return nowMs - onsLaatsteMs >= urenDrempel * HOUR;
  }

  /**
   * Ligt de bal bij ons? Waar: het laatste bericht in de draad komt van de
   * klant en er is daarna geen inhoudelijk antwoord meer gegeven. Dan gaat er
   * niets uit — een automaat die "ik heb nog geen reactie gekregen" stuurt op
   * een onbeantwoord klantbericht is aantoonbaar onwaar tegen de klant.
   *
   * Meet TEGEN HET ANTWOORD, niet tegen onze laatste outbound. Anders houdt de
   * cron zichzelf in de lucht: zijn eigen herinnering zou de bal terugleggen
   * bij de klant en de guard voorgoed uitschakelen.
   */
  function balLigtBijOns() {
    if (!antwoordMs) return true;                   // nooit inhoudelijk geantwoord
    return lastInboundMs > antwoordMs;
  }

  // GEEN INBOUND = GEEN GESPREK. Fail-closed, vóór alle andere takken.
  //
  // Zonder klant-bericht bestaat er niets om een no-reply-herinnering over te
  // sturen: "ik heb nog geen reactie van je ontvangen" slaat nergens op als de
  // klant nooit iets gestuurd heeft. Tot deze wijziging gaf `balLigtBijOns`
  // hier `false` terug — geen bewuste doorlaat, maar een gat: de guard greep
  // niet in en de teller besliste alsnog.
  //
  // Gemeten in productie (10 sep 2026): drie runs staan gespreksgepauzeerd
  // terwijl er nul WhatsApp-berichten bij de klant staan — Karim Alian (64
  // dagen te laat), Priscilla Mauricia (70) en Khalid Nassiri (44). Hun
  // aanmaanladder staat daardoor al twee maanden stil op een pauze die
  // nergens op slaat. Eigen returnwaarde zodat dat zichtbaar wordt in de
  // cron-log in plaats van stil te blijven.
  if (!lastInboundMs) return 'geen_gesprek';

  if (count === 0) {
    if (balLigtBijOns()) return null;
    if (!antwoordMs) return null;                   // geen antwoord = geen klok
    if (nowMs - antwoordMs >= r1h * HOUR) return 'r1';
    return null;
  }
  if (count === 1) {
    if (!lastReminderAt) return null;
    if (balLigtBijOns()) return null;               // dekt ook de oude reply-respect
    // De r2-klok loopt vanaf r1, niet vanaf ons antwoord: r2 is een opvolging
    // van de eerste herinnering. (Vanaf het antwoord meten zou r2 direct na r1
    // laten vertrekken, want dat antwoord is per definitie ouder.)
    if (drempelGehaald(r2h)) return 'r2';
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
    if (drempelGehaald(rzh)) return 'rz';
    return null;
  }
  return null;
}
