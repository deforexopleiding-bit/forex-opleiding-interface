# Opvolging mentoren fase 1 — de factuurstand naar het LMS (CRM-kant)

> **Status:** gebouwd. `hlms_crm_factuurstand` staat sinds 16 september op
> productie; de eerste schrijfronde gebeurt via de knop, na de droogloop.
> Alles blijft faalzacht bij een ontbrekende LMS-tabel.

Het LMS krijgt een opvolgsysteem voor mentoren en hoofdmentor. Eén van de
regels daar: **één vervallen factuur = de mentor moet het bespreken, twee of
meer = rood signaal** (en straks: dan kan de mentor niet inplannen of
afronden). Het CRM blijft de bron voor facturen (beslissing optie B, 5
september); het LMS krijgt een **spiegel**. Dit document beschrijft die
spiegel, en alleen die.

## Wat er gebouwd is

| Bestand | Wat het doet |
|---|---|
| `api/_lib/factuurstand-spiegel.js` | De definitie, de koppeling klant→student, en de **enige** schrijver van `hlms_crm_factuurstand`. |
| `api/_lib/factuurstand-sync.js` | De ronde: verzoenen (toevoegen / bijwerken / verwijderen) + de droogloop met alle metingen. |
| `api/cron/factuurstand-spiegel-sync.js` | Cron-ingang, `CRON_SECRET`, `?dry=1`. |
| `api/factuurstand-spiegel-sync-run.js` | De knop in het CRM, rechten `students.all.view`, `{ dry: true }`. |
| `modules/onboarding-hub.html` | Derde blok in de tab **LMS-koppeling**: Droogloop / Nu doorrekenen. |
| `tests/factuurstand-spiegel.test.js` | 31 toetsen: contracten + tegenproeven. |

Doeltabel (wordt aan **LMS-kant** aangemaakt; het CRM maakt hem niet en gaat
er faalzacht mee om zolang hij ontbreekt):

De tabel staat sinds 16 september op productie, met `CHECK`-beperkingen op
`bron_status`, op `vervallen_aantal <= open_aantal` en op niet-negatieve
aantallen. RLS: lezen alleen hoofdmentor/admin, schrijven alleen via de
service role — wat de spiegel gebruikt. Een toets pint vast dat de teller
nooit een rij oplevert die tegen die beperkingen aan loopt.

```sql
hlms_crm_factuurstand (
  student_id          uuid primary key references hlms_student(id),
  vervallen_aantal    int  not null,
  open_aantal         int  not null,
  oudste_vervaldatum  date null,
  openstaand_bedrag   numeric(12,2) null,
  bijgewerkt_op       timestamptz not null default now(),
  bron_status         text not null check (bron_status in ('gelezen','niet_gekoppeld','onbereikbaar')),
  bron_fout           text null
)
```

## 1. De definitie

* **`open_aantal`** — status in `open / partially_paid / overdue`, `is_test`
  is niet waar, en **restbedrag > 0** (`amount_total − amount_paid −
  credited_amount`).
* **`vervallen_aantal`** — daarvan: de facturen die volgens de
  wanbetalersmotor te laat zijn.
* **`oudste_vervaldatum`** — de oudste vervaldatum onder de **vervallen**
  facturen, niet onder alle openstaande. Een klant met één factuur die pas
  volgende maand vervalt hoort daar geen datum te krijgen; die zou in het LMS
  lezen als "loopt al zo lang".
* **`openstaand_bedrag`** — som van de restbedragen. Bij `niet_gekoppeld`
  staat er `null` en niet `0,00` — geen bedrag bekend is iets anders dan nul
  euro openstaand.
* **Concept telt nergens mee.** Een concept is nog geen vordering.

### Afwijking van de opdracht (bewust, en een no-op vandaag)

De opdracht schreef `open_aantal = status open`. De code gebruikt de
**gedeelde lijst** `OPEN_INVOICE_STATUSES` uit `api/_lib/dunning-pipeline.js`
(`open / partially_paid / overdue`). Op de productiemeting van 16 september
(paid 1.545 / open 343 / concept 77) staat er geen enkele rij op
`partially_paid` of `overdue`, dus vandaag is dat **hetzelfde getal**. Zodra
er ooit één factuur half betaald wordt, hoort die mee te tellen — en dat
hoort niet van een tweede lijstje af te hangen.

### De "te laat"-grens is die van Joost, niet een tweede

`isOverdue()` uit `api/_lib/dunning-overdue-guard.js` wordt **hergebruikt**,
inclusief de instelbare gratieperiode (`app_settings.dunning_grace_days`,
standaard 0). Er staat geen tweede vergelijking in de spiegel, en de toets
*"de spiegel telt precies vervallen wat de wanbetalersmotor vervallen noemt"*
legt de twee over negen vervaldatum/gratie-combinaties naast elkaar.

Gevolg van die keuze, expliciet: met de standaardwaarde 0 is een factuur
vervallen vanaf **de dag ná de vervaldatum**. De vervaldag zelf telt niet.
Zet iemand ooit `dunning_grace_days` op 3, dan schuift de mentoropvolging
mee — dat is precies de bedoeling van "dezelfde grens", maar het is goed dat
het hier staat: één instelling raakt vanaf nu twee systemen. De droogloop
toont de actuele waarde bij de peildatum.

Tijdzone: de guard rekent in **Europe/Amsterdam**, de opdracht noemde
Europe/Brussels. Dat is dezelfde klok (beide CET/CEST, identieke
overgangen), dus dit is letterlijk dezelfde grens en geen benadering. Eén
tijdzone-constante is meer waard dan een tweede die toevallig gelijk uitvalt.

### `is_historical` — gemeten en beslist

Gemeten in de broncode (16 september 2026):

* De kolom komt uit `docs/sql-migrations/2026-05-30-finance-fase-1-fundament.sql`:
  `is_historical boolean NOT NULL DEFAULT false`.
* Er zijn **twee** schrijvers — `api/_lib/invoice-upsert.js:127` en
  `api/finance-tl-invoice-sync.js:207` — en allebei zetten hem hard op
  `false`.
* **Niets in het CRM zet hem ooit op `true`**, en geen enkele lezer filtert
  erop. (De `is_historical` die je overal elders ziet hoort bij `events` —
  andere tabel, ander begrip.)

Betekenis: op `invoices` is het een **slapende vlag**, bedoeld voor facturen
van vóór het CRM die met de hand ingevoerd zouden worden.

**Beslissing: ze tellen mee** (er wordt niet op gefilterd). Twee redenen, in
volgorde van gewicht: (1) de wanbetalersmotor filtert er ook niet op, en de
opdracht is expliciet dat de grens exact die van Joost is — twee systemen die
over dezelfde factuur iets anders zeggen is erger dan één die iets meetelt
wat misschien oud is; (2) een openstaande, vervallen factuur ís een
vordering, ongeacht het tijdperk. De droogloop telt ze **apart**
(`is_historical_meegeteld`), zodat die beslissing herzien kan worden op grond
van een getal mocht iemand die vlag ooit gaan zetten.

## 2. De koppeling klant → LMS-student

Drie wegen, in volgorde van zekerheid. De **keuze** is een pure functie
(`kiesKlant`); de wegen leveren alleen kandidaten aan.

| Weg | Bron | Opmerking |
|---|---|---|
| a. `onboarding` | `onboardings.dfo_lms_student_id` | Zeker, maar alleen voor klanten die via het CRM geprovisioneerd zijn. |
| b. `bubble` | `hlms_student.bubble_user_id` ↔ `onboardings.bubble_user_id` | Aan CRM-kant hangt het Bubble-id van een student op de **onboarding**, niet op de klant. Er is geen `customers.bubble_user_id`. |
| c. `email` | `lower(customers.email)` ↔ `lower(hlms_student.email)` | Laatste terugval. |

**Twee kandidaten is geen keuze.** Levert een weg meer dan één verschillende
klant op, dan koppelen we **niet** en melden we het (`bron_status =
'niet_gekoppeld'`, reden `meerdere-klanten`). We vallen dan ook **niet** terug
op een lagere weg: dubbelzinnigheid op een zekerdere weg is een
gegevensprobleem dat een mens hoort te zien, geen reden om te raden. Een gok
zou betekenen dat een mentor iemand aanspreekt op de factuur van een ander.

**Geen klant gevonden** → `bron_status = 'niet_gekoppeld'`, aantallen 0.
Die 0 betekent **niets**; het LMS opent daar geen signaal op.

**CRM onleesbaar** → `bron_status = 'onbereikbaar'` en de vorige waarden
worden **niet** overschreven met nul: dan gaat alleen de bronstand + de
tijdstempel mee. Bestond er nog geen rij, dan komt er wel één (nullen +
`onbereikbaar`) — een rij die zegt "ik weet het niet" is meer waard dan geen
rij, want geen rij ziet er in het LMS identiek uit als een student die nog
nooit gespiegeld is.

**Wie krijgt een rij:** elke `hlms_student` die aan **drie** eisen voldoet —
`product_soort='mentorship'`, **`auth_id` gevuld**, en een traject dat nog
loopt (`eind_datum` leeg of ≥ vandaag). Dat is precies de verzameling die het
LMS leest (bevestigd 16 september); de spiegel hoort geen rijen te schrijven
die daar nooit gelezen worden. Zonder `auth_id` bestaat de student wel als
rij, maar kan er niemand inloggen — dat zijn de handmatige adminrijen en half
afgeronde uitnodigingen.

Er is aan LMS-kant géén `actief`-kolom op `hlms_student` (wel op
`hlms_personeel`), vandaar die afleiding. `isActieveMentorshipStudent()` en
`redenNietActief()` zijn één functie met twee ingangen, zodat de droogloop
niet iets anders kan melden dan de ronde doet: die telt per grond
(`afgevallen_membership` / `afgevallen_zonder_account` /
`afgevallen_traject_afgelopen`), want anders is "er staan er maar zoveel in de
lijst" niet na te rekenen.

## 3. Wanneer

* **Dagelijks 02:10 UTC** — `/api/cron/factuurstand-spiegel-sync`. Bewust
  vroeg in de nacht, want de opvolgmotor aan LMS-kant draait 's nachts en
  moet een **verse** factuurstand voor zich vinden. Het botst niet met de
  CRM-nachtcrons (01:05, 02:30, 03:00, 03:30).
  > ⚠️ Dit uur is afgestemd op een **aanname** over de LMS-motor, niet op een
  > gemeten feit — het exacte uur daarvan ligt aan de andere kant van de brug.
  > Draait die motor vóór 02:10, dan moet dit uur naar voren. Eén regel in
  > `vercel.json`.
* **Direct na elke factuurwijziging** — `spiegelFactuurstandNaWijziging()`
  wordt aangeroepen door:
  * `api/_lib/register-payment-internal.js` (betaling geregistreerd),
  * `api/finance-invoice-remove-payment.js` (betaling teruggedraaid),
  * `api/_lib/invoice-upsert.js` (Teamleader-sync — **alleen bij een echte
    wijziging**: nieuw, status veranderd, of betaald bedrag veranderd. De
    uurlijkse volledige sync loopt langs elke factuur; zonder dat
    vergelijkpunt zou hij duizenden keren per dag hetzelfde werk doen),
  * `api/_lib/creditnote-upsert.js#recomputeCreditedAmount` (creditering),
    gedeeld door `finance-creditnote-sync.js` en `invoice-credit.js`.

De upsert is idempotent (`onConflict: 'student_id'`). De nachtelijke ronde is
**de waarheid**; de aanroepen zijn er alleen zodat het meteen klopt.

### Bijvangst: twee dubbele kopieën opgeruimd

`credited_amount` werd op **drie** plekken herberekend met dezelfde lus
(`creditnote-upsert.js`, `finance-creditnote-sync.js`, `invoice-credit.js`).
Sinds deze PR zou die duplicatie stil gedrag gaan schelen — de gedeelde
versie meldt een creditering aan de spiegel, de kopieën niet. Beide kopieën
lopen nu via `recomputeCreditedAmount()`. Precies het patroon dat bij
`computeBedenktijd` vier uiteenlopende kopieën opleverde.

## 4. De droogloop eerst

`POST /api/factuurstand-spiegel-sync-run { "dry": true }` — of de knop in
**Onboarding-hub → LMS-koppeling → Factuurstand naar het LMS**. Doet alles
behalve schrijven, en geeft terug:

* per bronstand: `gelezen` / `niet_gekoppeld` / `onbereikbaar`;
* de twee drempels van de LMS-regel: `zonder_vervallen`, `met_1_vervallen`,
  `met_2_of_meer_vervallen`;
* de **matchgraad per weg**: `via_onboarding` / `via_bubble` / `via_email`,
  plus `niet_gekoppeld_redenen` en `koppeling_meting` (hoeveel onboardings er
  een LMS-verwijzing of een Bubble-id dragen, hoeveel e-mailadressen er een
  klant vonden);
* `facturen_meegeteld` en `is_historical_meegeteld`;
* voorbeelden (max 10 per geval) van studenten mét vervallen facturen, van
  niet-koppelbare studenten en van onbereikbare bronnen;
* de telling van `student_signals` per type en status (zie §5);
* en waaróm de rest van de LMS-studenten afviel: geen mentorship, geen
  account, of traject afgelopen.

**De matchgraad is met opzet niet in dit document ingevuld.** Deze sessie
heeft geen toegang tot de productiedatabank, en een getal uit een schatting
is erger dan geen getal. De droogloop levert het in één klik, en die klik
hoort vóór de eerste schrijfronde te gebeuren.

## 5. Wat er níét is aangeraakt

* De **39 open no-show-signalen** in `student_signals` en de bestaande
  no-show-/eerste-call-crons: onaangeroerd. Het LMS leidt no-shows voortaan
  zelf af uit `hlms_sessie`. De droogloop **telt** ze wel, per type en per
  status, zodat Maxim kan beslissen wat ermee gebeurt. Tellen is geen
  aanraken.
* **Geen enkel bericht naar klanten.** Geen mail, geen WhatsApp.
* **Niets aan Joost / de wanbetalersmotor.** De spiegel *leest* de grens van
  de motor; hij verandert er niets aan.
* **Niets aan facturen.** De spiegel schrijft alleen naar één LMS-tabel.

## 6. Bewust niet gebouwd

| Niet gebouwd | Waarom |
|---|---|
| **Betalingsregelingen uitzonderen.** De wanbetalersmotor stuurt geen aanmaningen aan klanten met een actief `payment_arrangement`; de spiegel telt hun vervallen facturen gewoon mee. | De spiegel meldt **feiten**, het LMS beslist. Een klant met een lopende regeling *heeft* vervallen facturen; of de mentor dat moet bespreken is een beleidsvraag die aan LMS-kant hoort, met de kennis dat er een regeling loopt. Er is in de doeltabel ook geen kolom om dat in kwijt te kunnen. Moet het toch hier: dan is het een nieuwe kolom aan LMS-kant, geen filter hier. |
| **Gearchiveerde / geanonimiseerde klanten apart behandelen.** | Testklanten (`is_test`) vallen wél af. Voor de rest: een gearchiveerde klant met een openstaande factuur is nog steeds een openstaande factuur. Geanonimiseerde klanten hebben geen bruikbaar e-mailadres meer en vallen in de praktijk vanzelf op `niet_gekoppeld`. |
| **Dezelfde persoon onder twee klantrijen samenvoegen** (het geval ER Schilderwerken). | Dat is een opschoonklus in het CRM, geen spiegelfunctie. Wat de spiegel wél doet: hij **meldt** het in plaats van te gokken. Let op de beperking die blijft: matcht het adres van de student op klant A terwijl de facturen op klant B staan, dan ziet de spiegel klant A en telt hij B's facturen niet. Dat is met deze gegevens niet op te lossen — samenvoegen wel. |
| **Een eigen `actief`-vlag voor studenten.** | `hlms_student` heeft er geen; de afleiding uit `eind_datum` staat op één plek (`isActieveMentorshipStudent`) en is toetsbaar. Komt er ooit een echte kolom, dan is dat één functie. |
| **De spiegel als bron voor iets anders dan mentoropvolging.** | Vier getallen per student, meer niet. Wie een dossier wil, hoort in het CRM te kijken. |
| **Een eigen migratiebestand voor `hlms_crm_factuurstand`.** | Die tabel is van het LMS en wordt daar aangemaakt. Het CRM gaat er faalzacht mee om zolang hij ontbreekt: de droogloop werkt, een echte ronde stopt met een duidelijke melding (503) in plaats van een stapel schrijffouten. |

## 7. Volgorde van in gebruik nemen

1. ~~Mergen.~~ ✅
2. ~~LMS-kant maakt `hlms_crm_factuurstand` aan.~~ ✅ 16 september.
3. **Droogloop** via de knop in de Onboarding-hub. Matchgraad en verdeling
   met Maxim doornemen; hier valt ook de beslissing over `is_historical` en
   over de oude `student_signals`-signalen.
4. **Eerste echte schrijfronde** met de knop (niet wachten op de cron, zodat
   er iemand naar kijkt).
5. **Uur van de cron afstemmen** op de LMS-motor.
