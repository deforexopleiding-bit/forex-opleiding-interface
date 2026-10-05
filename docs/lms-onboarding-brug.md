# De onboardingbrug: LMS → CRM (5 oktober 2026)

Een mentor rondt in het LMS een sessie af. Is dat de **eerste afgeronde
sessie** van die student, dan hoort zijn onboarding in het CRM dicht te gaan —
binnen enkele seconden, niet pas de volgende ochtend om 07:00.

## De route

`POST https://forex-opleiding-interface.vercel.app/api/lms-onboarding-sessie`
(zonder afsluitende streep — het CRM is geen Next-app).

| | |
| --- | --- |
| Header | `x-dfo-secret` |
| Geldige geheimen | `DFO_LMS_PUSH_SECRET` of `DFO_LMS_AGENDA_SECRET` (beide bestaan al aan beide kanten) |
| Body | `{ "actie": "sessie_afgerond", "student_id": "<hlms_student.id>", "sessie_id": "<optioneel>" }` |
| Antwoord | altijd `{ ok, code, message, data }` — programmeer op `code` |

| `code` | betekenis |
| --- | --- |
| `afgesloten` | de onboarding is nu afgesloten; de spiegel is bijgewerkt |
| `al_automatisch` | was al afgesloten (door deze route of de cron) |
| `al_afgerond` | stond al op afgerond (met de hand) |
| `niet_aanraken` | geannuleerd of gearchiveerd |
| `geen_onboarding` | geen onboarding bij deze student |
| `geen_afgeronde_sessie` | de databank kent nog geen afgeronde sessie van deze student |
| `machine_toegang_dicht` (403) / `niet_geconfigureerd` (503) | geheim fout / niet ingesteld |

## Wat de route niet gelooft

Het LMS zegt alleen over wie het gaat. Welke sessie de eerste afgeronde was,
leest de route zelf in `hlms_sessie`. De afsluiting zelf staat in
`api/_lib/onboarding-afsluiten-na-sessie.js` en is dezelfde als die van de
cron: dezelfde kolommen (`auto_afgerond_sessie_id`, `_op`, `_titel`,
`auto_afgerond_op`), dezelfde wacht in de update (`auto_afgerond_sessie_id is
null`), dezelfde melding aan de hoofdmentoren.

## De bodem blijft

`/api/cron/onboarding-eerste-sessie-afronden` draait elke ochtend om 07:00. Hij
vindt een onboarding sinds vandaag ook via `onboardings.dfo_lms_student_id`
wanneer de student geen Bubble-id heeft — die vielen eerder stil buiten de
afsluiting.

## "Call ingepland"

Die stand wordt niet geschreven maar live afgeleid uit `hlms_sessie`
(`/api/onboarding-intake-status`). Ook die lezer gebruikt sinds vandaag het
student-id als tweede brug, zodat een student zonder Bubble-id "call
ingepland" en "gestart" krijgt.

## Actie `startdatum` — start later op (5 oktober 2026)

`POST /api/lms-onboarding-sessie` met `{ actie: 'startdatum', student_id, start_datum, notitie? }`.
De hoofdmentor keurt in het LMS "start later op" goed; het LMS zet de student
on hold tot die dag en roept daarna deze actie aan, zodat de onboarding hier
dezelfde startdatum krijgt (en de spiegel naar het LMS meteen bijwerkt).

- Zelfde ondergrens als de knop in het CRM: minstens vandaag + 3 (NL-tijd).
  Te vroeg → 422 `startdatum_te_vroeg` met `data.min`.
- Codes: `gewijzigd` / `ongewijzigd` / `geen_onboarding` / `niet_aanraken`
  (gearchiveerd/geannuleerd) / `al_afgerond` / `startdatum_ongeldig` (400).
- Schrijft alleen `onboardings.start_date` + één interne tijdlijnregel.
  Er gaat niets naar de klant; geen melding naar de mentor (die zag de
  beslissing al in het LMS).

## Hoofdmentor > Onboarding in het LMS (5 oktober 2026)

**Lezen — live.** `GET /api/lms-onboarding-overzicht` (header `x-dfo-secret`)
geeft de rijen van het CRM-onboardingoverzicht (scope actief), met dezelfde
bouwer als het CRM-scherm (`api/_lib/onboarding-overzicht-rijen.js`) en
dezelfde startstatus-afleiding (`api/_lib/onboarding-intake-items.js`), plus
de actieve mentoren met hun LMS-id (`api/_lib/lms-mentor-brug.js`, op
e-mailadres, precies één match). Geen kopietabel: wat het CRM nu weet, ziet
het LMS bij het openen of verversen. Het betaaltoken wordt weggelaten.

**Schrijven — via dezelfde functies als de CRM-schermen.**
`POST /api/lms-onboarding-sessie` met `onboarding_id` en `door_email`:

| actie | velden | gedeelde functie |
|---|---|---|
| `mentor_toewijzen` | `mentor_lms_id` of `null` | `wijsMentorToe` |
| `startdatum` | `start_datum` (vandaag + 3) | `zetStartdatumOnboarding` |
| `startstatus` | `status` (nog_te_benaderen / geen_gehoor / wil_later / wil_niet) of `null`, `notitie?` | `zetStartstatus` |
| `notitie` | `tekst` | `schrijfOnboardingNotitie` |

Dezelfde controles, meldingen aan mentoren en spiegel naar het LMS als in het
CRM. `door_email` wordt een CRM-gebruiker als er precies één actief profiel bij
past; anders gebeurt de actie op naam van niemand en staat "via het LMS
(e-mail)" op de tijdlijn. **Annuleren en archiveren kunnen hier niet** — die
blijven in het CRM.

Ook nieuw: de automatische statuswijziging (automations) spiegelt nu naar het
LMS; dat was het enige schrijfpad op `status` zonder spiegel.
