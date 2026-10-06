# Intake-pot — de CRM-kant (opdracht 5 oktober 2026)

De intake-pot zelf leeft in het LMS (`hlms_intake`, zie `docs/intake-pot.md` in
dfo-lms-prototype). Het CRM doet drie dingen:

1. **Vullen** — `api/_lib/onboarding-intake-spiegel.js`, aangeroepen vanuit
   `spiegelOnboarding()`. Schrijft alleen de CRM-kolommen (naam, telefoon,
   traject, start, aangemeld, `crm_stand`, `student_id`, en sinds 6 oktober
   `mentor_id` en de bedenktijd). De telefoon komt uit de afleiding hieronder.
   Nieuwe rijen alleen voor onboardings vanaf `INTAKE_POT_VANAF`
   (default 2026-10-06 00:00 Brussel); oudere zet de hoofdmentor er in het LMS
   met de hand in, en die worden daarna wél bijgewerkt. Faalzacht.
2. **Tonen** — `api/_lib/intake-gesprek-stand.js` via de sidecar
   `/api/onboarding-intake-status` (`gesprekken`, `gesprekken_status`):
   kolom **Intakegesprek** in het onboardingoverzicht, regel **Intakegesprek**
   in het detailscherm (met uitkomst en actieplan na afronden). Niet gelezen =
   "onbekend", nooit "niet in de pot".
3. **Verlonen** — `coaching-earnings.js` telt GOEDGEKEURDE intakes
   (`afgerond_door` = mentor, `goedgekeurd_op` in het venster; sinds 6 oktober,
   daarvoor `afgerond_op`) als
   `breakdown.intake` à €8,75 (¼ × €35). Op de uitbetaling een eigen regel
   `coaching_intake`, label "Intakes: n × 0,25". Een intake is geen
   `hlms_sessie`: hij verbruikt geen sessie van het pakket en sluit de
   onboarding niet. Zolang `hlms_intake` niet bestaat: 0, met
   `_meta.lms_intake = 'tabel-ontbreekt'`.

"Intake" betekent in de bestaande CRM-code de START-STATUS
(`mentor_intake_status`). Het gesprek uit de pot heet op het scherm daarom
**Intakegesprek**.

## Sinds 6 oktober 2026

**Twee stappen.** De mentor zet in het LMS "Intake klaar" (`afgerond_op`), de
hoofdmentor keurt goed (`goedgekeurd_op`). Het CRM toont in de kolom
Intakegesprek dan "Ter goedkeuring" of "Goedgekeurd"
(`intake-gesprek-stand.js`, stand `ter_goedkeuring`), en verloont alleen
goedgekeurde intakes. Bestaat de kolom `goedgekeurd_op` nog niet, dan valt het
CRM terug op de oude telling (`isGoedkeuringKolomOntbreekt`).

**Wizard voltooid ≠ afgerond.** `onboardings.status = 'afgerond'` betekent dat
de wizard doorlopen is. Afgesloten is een onboarding pas met
`auto_afgerond_op`/`auto_afgerond_sessie_id` (de eerste echte sessie). De regel
staat op één plek: `api/_lib/onboarding-einde.js` (`onboardingAfgesloten`,
`lmsStandVoor`, `afgeslotenOp`). Het LMS krijgt `wizard_voltooid` als lopende
stand.

## Het telefoonnummer (6 oktober 2026)

Eén afleiding: `api/_lib/onboarding-telefoon.js`. De voorrang, meest
betrouwbare eerst:

1. `customers.phone` (klantkaart)
2. `whatsapp_conversations.phone_number` van die klant (het laatst actieve)
3. `leads.telefoon_e164`/`telefoon` (op e-mail)
4. `follow_up_appointments.lead_phone` (op e-mail, de laatste)
5. een wizardveld met telefoon/gsm/whatsapp in de naam

De eerste bron met een eenduidig E.164-nummer (`normaliseerNlBe`, +31/+32) wint.
Is er geen, dan het eerste ruwe nummer met `zeker: false`: zichtbaar, maar
zonder WhatsApp-link. Elke bron is faalzacht. De afleiding leest alleen; ze
schrijft niets in het CRM.

Waar het heen gaat (dfo-lms):
- `hlms_crm_onboarding.telefoon` en `hlms_intake.telefoon`: via de spiegel;
- `hlms_student.telefoon`: ALLEEN als het leeg is. De voorwaarde
  `.or('telefoon.is.null,telefoon.eq.')` zit in de update zelf.

**Alle studenten**: `api/_lib/student-telefoon-aanvullen.js`. Je start hem met de
knop "Telefoonnummers aanvullen voor alle studenten" in de Onboarding-hub
(`/api/student-telefoon-aanvullen-run`, `students.all.view`, met droogloop); hij
draait ook elke ochtend als cron (`/api/cron/student-telefoon-aanvullen`, 07:35,
na de hersync). De student wordt zo aan een klant gekoppeld: onboarding
(`dfo_lms_student_id`) → `bubble_user_id` → e-mail, dat laatste alleen bij
precies één klant. Zonder klant zoekt hij nog op het eigen e-mailadres van de
student.

Gemeten op 6 oktober na de eerste run: actieve studenten zonder nummer van 259
naar 30 (van 304). De werklijst van die 30, met reden, staat in
`docs/opvolging-oktober-2026.md` §9e in dfo-lms-prototype.

## Onboarding opkuisen (6 oktober 2026, tweede opdracht van Maxim)

**14-dagenregel.** `hoortVanzelfInPot()` zet een nieuwe onboarding alleen nog
vanzelf in de pot als de start meer dan `INTAKE_POT_MIN_DAGEN` dagen
(standaard 14) na het closen (`created_at`) ligt.
- Bij een snellere start gaat hij meteen naar "Klaar voor onboarding".
- Zonder startdatum komt hij wél in de pot.
- 0 betekent: altijd in de pot.
- Een bestaande rij blijft staan.

**Intake overgeslagen.** De mentor plant meteen de eerste sessie; een trigger
in het LMS (`hlms_intake_overslaan.sql`) sluit de open intake.
- Het CRM toont de stand `overgeslagen` in de kolom Intakegesprek
  (`intake-gesprek-stand.js`).
- Een overgeslagen intake wordt niet verloond.

**Handmatig afronden.** `api/_lib/onboarding-handmatig.js`
(`handmatig_afgerond_op/_door/_reden`, migratie
`2026-10-06-onboarding-handmatig-afgerond.sql`) is de tweede bron in
`onboarding-einde.js`, naast de afsluiting door een sessie.
- Je start het vanuit het LMS (machine-actie `handmatig_afronden`) of vanuit
  het CRM-detailscherm (`api/onboarding-handmatig-afronden.js`).
- Het overzicht geeft per open onboarding het bewijs mee voor "Waarschijnlijk
  al gestart" (`onboarding-al-gestart.js`).

**Naar incasso-opvolging.** `api/_lib/onboarding-incasso.js` (schrijft) en
`onboarding-incasso-stand.js` (leest; dat bestand gebruikt de spiegel).
Migratie: `2026-10-06-onboarding-incasso.sql`.
- Een onboarding in incasso verdwijnt uit de LMS-spiegel en uit de pot
  (`vervallen`). In het CRM staat hij in de tab Incasso.
- Er wordt NIET geannuleerd: status, facturen, toegang en aanmaningen blijven
  zoals ze zijn.
- "Terug activeren" loopt via `zetStartdatumOnboarding`. Daarna wordt
  `incasso_terug_op` gezet; `incasso_op` blijft staan als geschiedenis.
