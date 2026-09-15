// api/_lib/events-test-begintoestand.js
//
// DE TESTDEELNEMER MOET BEGINNEN WAAR DE TRIGGER BEGINT.
//
// ── WAT ER MISGING ──────────────────────────────────────────────────────
// Gemeten op 15 september, run 5e9f8deb… op 'Geen gehoor - laatste kans':
//
//   stap 0  send_email                 gedaan  16:28
//   stap 1  send_whatsapp              gedaan  16:28 (echte wamid)
//   stap 2  wait                       versneld naar 15s
//   stap 3  condition                  NIET WAAR — flow stopt hier
//           "check: geen_reactie_sinds_belstatus · NIET GEMETEN ·
//            geen bruikbaar nulpunt (call_status_at ontbreekt of is onleesbaar)"
//   stap 4  update_attendee_status     niet meer gedraaid
//   stap 5  send_internal_notification niet meer gedraaid
//
// Dat de flow stopte was JUIST — niet gemeten is niet waar, en er vervalt
// nooit een plek op een controle die niet kon draaien. Maar de oorzaak zat in
// de TESTMOTOR: api/events-automation-test.js maakte de synthetische deelnemer
// met `status='aangemeld'` en zonder `call_status` én zonder `call_status_at`.
//
// Die toestand kan in productie niet bestaan. Beide schrijfpaden naar
// `call_status` stempelen het tijdstip mee:
//   · api/opvolging-aanmelding-actie.js  zetBelstatusGeenGehoor()
//       { call_status: 'geen_gehoor', call_status_at: nuIso, called: true }
//   · api/events-attendee-update.js      case 'call_status'
//       patch.call_status + patch.call_status_at
//
// De testdeelnemer voldeed dus niet aan de startvoorwaarde van de
// automatisatie die hij moest testen, en stap 4 en 5 bleven ongetest.
//
// ── WAT DIT BESTAND DOET ────────────────────────────────────────────────
// Eén pure functie die per trigger_type zegt in welke toestand de
// testdeelnemer geboren moet worden. Geen imports, geen databank — de
// endpoint plakt de patch op zijn INSERT.
//
// NU ALLEEN `on_call_status`. De andere trigger-types houden exact het
// huidige gedrag (een lege patch), zodat deze wijziging niets verandert aan
// de testruns die vandaag al goed gaan. De switch staat er wél, zodat de
// volgende trigger die een begintoestand nodig heeft er los bij kan:
//   · on_assessment_completed zou een assessment_response_id nodig hebben —
//     dat is een FK naar een echte antwoord-rij, dus die vraagt meer dan een
//     patch en is met opzet niet meegenomen.
//   · on_signup en time_before_event hebben niets nodig: `registered_at` zet
//     de endpoint al.
//
// ── EN NOOIT STIL SLAGEN ────────────────────────────────────────────────
// Kan de begintoestand niet opgebouwd worden, dan komt er een `fout` terug en
// hoort de caller te WEIGEREN. Een run starten die drie stappen later
// stukloopt op een voorwaarde is precies de verwarring die dit bestand
// opheft: dan lijkt de automatisatie kapot terwijl de tester het was.

/**
 * In welke toestand moet de testdeelnemer geboren worden voor deze trigger?
 *
 * @param {object}  auto    de event_automations-rij (trigger_type + trigger_config)
 * @param {string}  nowIso  het moment van aanmaken, ISO-8601
 * @returns {{
 *   patch: object,      // velden om mee te geven aan de INSERT (kan leeg zijn)
 *   tekst: ?string,     // één regel voor het scherm, of null als er niets gezet is
 *   fout : ?string,     // gezet = de caller MOET weigeren
 * }}
 */
export function beginToestandVoorTrigger(auto, nowIso) {
  const type = auto && typeof auto.trigger_type === 'string' ? auto.trigger_type : '';
  const cfg  = (auto && auto.trigger_config && typeof auto.trigger_config === 'object')
    ? auto.trigger_config : {};

  if (type === 'on_call_status') {
    // De trigger leest trigger_config.call_status en start zodra
    // event_attendees.call_status daarop staat. Zonder die waarde is er geen
    // begintoestand te bepalen — en dan is er ook geen automatisatie die ooit
    // iemand pakt, want de kandidaat-query returnt dan [] (zie
    // loadCandidatesForAutomation). Weigeren, niet gokken.
    const wanted = typeof cfg.call_status === 'string' ? cfg.call_status.trim() : '';
    if (!wanted) {
      return {
        patch: {},
        tekst: null,
        fout : 'Deze automatisatie heeft trigger_type \'on_call_status\' maar geen '
             + 'trigger_config.call_status. Er is dus geen begintoestand te bepalen, en een '
             + 'testrun zou drie stappen later stuklopen op de voorwaarde in plaats van iets '
             + 'te meten. Zet eerst een belstatus op de trigger.',
      };
    }
    return {
      // call_status_at is het NULPUNT waar de hele flow op rekent: de conditie
      // 'geen_reactie_sinds_belstatus' meet vanaf dit moment, en
      // {{attendee.geen_gehoor_deadline}} rekent er 48 uur vanaf. Zonder dit
      // veld is er niets te meten — dat was de bug.
      //
      // `called` gaat met opzet NIET mee: de trigger leest het niet, en een rij
      // met een belstatus én called=false bestaat in productie ook (dat is wat
      // een handmatige wijziging in de eventmodule oplevert).
      patch: { call_status: wanted, call_status_at: nowIso },
      tekst: 'testdeelnemer gezet op belstatus ' + wanted + ' · nulpunt = nu',
      fout : null,
    };
  }

  // Elk ander trigger-type: precies het gedrag van vóór deze wijziging.
  return { patch: {}, tekst: null, fout: null };
}
