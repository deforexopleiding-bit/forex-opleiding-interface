# No-show-signalen naar het LMS — één bron voor signalen

**17 september 2026.** De opvolging van studenten gebeurt voortaan volledig in
het LMS: `hlms_signaal`, zichtbaar op het
[hoofdmentorbord](https://lms.deforexopleiding.nl/hoofdmentor/). Daar bestaat
`twee_noshows_op_rij` al en komt `eerste_sessie_no_show` erbij.

Twee systemen die over dezelfde student iets zeggen is erger dan één: een
no-show die in het CRM op `open` staat en in het LMS is afgehandeld laat
niemand meer zien wat er écht nog moet gebeuren. Dus gaat de CRM-kant uit —
niet allebei half aan.

## Wat er verandert

| | |
|---|---|
| **Aanmaken** | `api/cron/noshow-detect.js` maakt geen `student_signals` meer aan. Twee sloten: de entry is uit `vercel.json`, en de handler stopt meteen (200 + `uitgezet: true`) ook bij een handmatige aanroep. |
| **Bestaande signalen** | Worden **afgesloten, niet verwijderd** — één keer, met de hand, door Cowork. Zie de SQL hieronder. |
| **De schermen** | Aandachtspunten, de No-shows-tab van de mentor en het automatiseringen-diagnosescherm verwijzen nu naar het hoofdmentorbord, in plaats van een lege lijst te tonen die lijkt te zeggen dat er niets is. |
| **Ongemoeid** | De auto-afsluiting van onboardings via de eerste **afgeronde** LMS-sessie (`api/cron/onboarding-eerste-sessie-afronden.js`). Andere cron, eigen watermerk, leest `student_signals` niet. |
| **Ongemoeid** | De andere signaaltypes: `eerste_call`, `reageert_niet`, `niet_bereikbaar`, `geen_reactie_bellen`, `anders`. Die komen van mentoren en gaan over iets anders dan een gemiste sessie. |

## Wie maakte ze aan, wie las ze — gemeten

**Aanmaken:** precies één plek, `api/cron/noshow-detect.js` (dagelijks 06:00).
Het mentor-meldpunt `api/student-signals-create.js` staat deze twee types niet
toe en is dus niet aangeraakt.

**Lezen:**

* `modules/students-overview.html` — tab **Aandachtspunten** (`AUTO_SIGNAL_TYPES`);
* `modules/mentor-students.html` — tab **No shows** (eigen studenten, `type='no_show'`);
* `modules/klanten-v2/views/automatiseringen-v2.js` — het diagnosescherm, via
  `api/flow-drilldown-overview.js` (tellers per status);
* meldingen/badges: `student.noshow_review` en `student.eerste_call_no_show`,
  die door dezelfde cron werden aangemaakt en dus vanzelf stoppen.

## De eenmalige datawijziging — klaargezet, niet gedraaid

[`docs/sql-migrations/2026-09-17-noshow-signalen-naar-lms.sql`](sql-migrations/2026-09-17-noshow-signalen-naar-lms.sql)

Vier stappen, los te draaien in de Supabase SQL-editor:

0. **kijken** — tel per type en status (verwacht: 39 × `no_show` + 3 ×
   `eerste_call_no_show` open, gemeten 16 september);
1. **vastleggen** — elke geraakte id met zijn oude status in
   `student_signals_lms_overdracht` (`ON CONFLICT DO NOTHING`);
2. **afsluiten** — `status='afgehandeld'`,
   `uitkomst='Vervangen door de LMS-opvolging (hoofdmentorbord)'`,
   `uitkomst_type='anders'`, `handled_at=now()`;
3. **controleren** — inclusief de tegenproef dat de andere types onaangeroerd zijn.

Eigenschappen die ertoe doen:

* **Niets wordt verwijderd.** Geen `DELETE`, geen `DROP`, geen `TRUNCATE` — er
  staat een toets op.
* **Terug te draaien.** Stap 1 is het spoor; de rollback staat onderaan het
  bestand en zet de oude status exact terug.
* **Idempotent.** Twee keer draaien verandert niets extra.
* **Ook `opnieuw_opvolgen` gaat mee.** Alleen `open` afsluiten zou precies de
  restlijst laten staan die we kwijt willen. Beide zijn signalen die nog op
  iemand wachten.

## Terugzetten

Haal het `UITGEZET`-blok uit de handler en zet de entry terug in
`vercel.json`. Het watermerk (`app_settings.noshow_detect_since`) is bewust
niet gewist en niet verzet, dus de cron hervat waar hij gebleven was. De
leeslogica eronder is ongewijzigd.

De contracttests in `tests/notify-hoofdmentor-adressering.test.js` en
`tests/dfo-lms-sessies.test.js` bewaken sinds vandaag een uitgeschakeld pad.
Ze zijn met opzet blijven staan: ze beschrijven hoe het werkte, en dat is
precies wat je wilt lezen als je het ooit terugzet.
