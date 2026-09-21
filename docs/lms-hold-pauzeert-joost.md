> ## ⛔ ACHTERHAALD — de hold-poort bestaat niet meer (21 september 2026)
>
> Dit document beschrijft PR #1622. Die poort is **verwijderd**: het LMS kan
> sinds september ook **automatische** betalingsholds zetten (2+ vervallen
> facturen, `door` leeg, `reden_soort='betaling'`), en die horen de
> aanmaningen juist *niet* tegen te houden. De poort zou dus precies de
> wanbetalers stilleggen die wél een aanmaning moeten krijgen.
>
> Wat er nu geldt: **alleen `hlms_crm_stilte` legt de motor stil**, en daar
> staat per rij een mens onder. Een menselijke hold bereikt ons nog steeds —
> het LMS schrijft die zelf weg als stilterij met `bron='hold'`. Zie
> [`docs/lms-stilte-de-motor-zwijgt.md`](lms-stilte-de-motor-zwijgt.md).
>
> `api/_lib/lms-hold.js` en `tests/lms-hold.test.js` zijn weg; het gedeelde
> vangnet dat erin woonde staat nu in `api/_lib/lms-koppelnet.js`.
>
> Dit bestand blijft staan als verantwoording van #1622 — waarom de poort er
> kwam, en langs welke redenering hij weer weg is. Lees het niet als
> beschrijving van de huidige code.

# On hold in het LMS pauzeert Joost

> **Beslissing Maxim, 11 september 2026.** Zet de hoofdmentor een student on
> hold — bij een betaalachterstand, een gevraagd uitstel, of gewoon omdat er
> iets aan de hand is — dan stuurt de wanbetalersmotor die klant **niets**.
> Geen aanmaning, geen herinnering, geen WhatsApp, zolang de pauze loopt.

Dit is geen verfijning van de motor maar een **harde poort ervóór**. Iemand
manen die net een pauze heeft gekregen is precies het bericht dat een klant
kwijtraakt, en het is niet terug te nemen.

## Wat er gebouwd is

| Bestand | Rol |
|---|---|
| `api/_lib/lms-hold.js` | De definitie, de koppeling, de poort. Eén plek. |
| `api/_lib/dunning-engine.js` | Geen nieuwe run + geen stap voor een klant on hold. |
| `api/cron-dunning-bulk-send.js` | Bulk-aanmaanronde slaat de ontvanger over (blijft `pending`). |
| `api/cron-dunning-conversation-reminders.js` | Herinnering in een lopend gesprek gaat niet uit. |
| `api/_lib/pipeline-overview-helpers.js` + `modules/finance.html` | Eigen bak en zichtbare reden in de wanbetalersmodule. |
| `api/_lib/dunning-event-labels.js` | Leesbaar label in het klantdossier. |
| `api/_lib/factuurstand-sync.js` | Laat de afdruk achter waar het vangnet op leunt (zie §3). |
| `tests/lms-hold.test.js` | 26 toetsen, elk geval mét tegenproef. |

## 1. Hoe de hold gelezen wordt

Bron: `hlms_student_hold` in dfo-lms — `student_id`, `van`, `tot`, `reden`,
`materiaal_open`, `door`, `opgeheven_op`.

**Actief** = `van <= vandaag < tot` **en** `opgeheven_op` is leeg. De
peildatum is dezelfde als die van de wanbetalersmotor
(`todayIsoInTz()` uit `dunning-overdue-guard.js`, Europe/Amsterdam).

* `tot` is **exclusief**: op de einddatum zelf loopt de motor weer. Zo is de
  dag waarop de pauze afloopt ook de dag waarop alles hervat, zonder dat
  iemand ergens een dag moet aftrekken.
* `van` is **inclusief**.
* **Ontbrekende datums vallen naar de voorzichtige kant**, dat wil zeggen:
  naar wél een pauze. Geen `van` = al begonnen; geen `tot` = loopt tot iemand
  hem opheft. Een ontbrekend veld mag nooit de reden zijn dat er een
  aanmaning uitgaat.
* `materiaal_open` wordt **niet** gelezen. Die vlag gaat over of de student
  tijdens zijn pauze nog bij het lesmateriaal kan; dat staat los van de vraag
  of we hem mogen aanmanen. Een hold mét open materiaal is nog steeds een hold.

## 2. Van LMS-student naar CRM-klant — dezelfde koppeling, geen tweede

`api/_lib/lms-hold.js` gebruikt **`zoekKlantKandidaten()` + `kiesKlant()`**
uit `api/_lib/factuurstand-spiegel.js` (PR #1614). Er staat in de hold-lib
geen enkele eigen klant-lookup; een contracttest wordt rood zodra dat
verandert. Dus ook hier: drie wegen in volgorde van zekerheid
(`onboardings.dfo_lms_student_id` → `onboardings.bubble_user_id` →
`lower(customers.email)`), en **twee kandidaten is geen keuze** — dan wordt
er niet gekoppeld en komt er een waarschuwing in de log.

**Eén verschil met de spiegel, en het is opzettelijk.** De spiegel schrijft
alleen voor actieve mentorship-studenten (mentorship + `auth_id` + traject
loopt). Voor een hold geldt die zeef **niet**. Een hold is een uitgesproken
beslissing van de hoofdmentor over déze student; of die student ook aan de
voorwaarden voor de factuurspiegel voldoet doet niet ter zake. Die zeef
bestaat om lege spiegelrijen te voorkomen, niet om berichten toe te laten.

Een hold waarvan de student **niet** aan een klant te koppelen is, blokkeert
niets — maar wordt wel geteld en gelogd (`niet_gekoppeld`), want dat is een
gegevensprobleem dat iemand hoort te zien.

## 3. Faalzacht — en hier naar de voorzichtige kant

Kan het LMS niet gelezen worden, dan **weten we niet wie er on hold staat**.
Dan verstuurt de motor die run niets naar klanten die aan een LMS-student
gekoppeld zijn. Eén dag later aanmanen is minder erg dan iemand manen die
net een pauze kreeg.

Let op wat "faalzacht" hier dús niet betekent: niet "ga door alsof er niets
is". Overal elders in de dunning-modules is fail-**open** de juiste keuze (een
glitch mag de motor niet stilzetten); bij deze poort is fail-**closed** de
juiste, want de schade zit aan de verzendkant. Het wordt luid gelogd:

```
[lms-hold] LMS-holds NIET te lezen — de motor houdt zich deze run in voor
alle klanten met een LMS-koppeling. Reden: <reden>
```

**Klanten zonder LMS-koppeling gaan gewoon door.** Anders zou één LMS-storing
de complete inning stilleggen, ook voor de honderden wanbetalers die niets
met het LMS te maken hebben. Er staat een toets op allebei de kanten.

### Waar het vangnet zijn lijst vandaan haalt

Twee van de drie koppelwegen staan in het CRM zelf en zijn dus óók leesbaar
als het LMS plat ligt. De derde — het e-mailadres — heeft aan CRM-kant geen
enkel spoor. Daarom laat de nachtelijke spiegelronde een **afdruk** achter in
`app_settings.lms_gekoppelde_klanten` van de klanten die hij die ronde heeft
kunnen koppelen.

Het is nadrukkelijk een afdruk en geen tweede waarheid: hij wordt alleen
geschreven door de ronde die de koppeling toch al uitrekent, alleen gebruikt
om het vangnet **breder** te maken, nooit om iets te versturen. Ontbreekt hij
of is hij oud, dan doet het vangnet het nog steeds met de twee CRM-wegen —
vandaar dat `bijgewerkt_op` meegaat. Een ronde die niets koppelde laat de
oude afdruk **ongewijzigd** staan: een lege afdruk zou het vangnet legen.

## 4. Hervatten gebeurt vanzelf

Op een lopende run slaat de motor de stap **over** zonder de status te
wijzigen — precies zoals bij een openstaande handmatige actie. De run blijft
`active`, de dagelijkse cron pikt hem de volgende ronde opnieuw op, en zodra
de einddatum voorbij is loopt alles gewoon door.

Er is dus **geen aparte cron** nodig om een hold te laten aflopen, en geen
kolom die ergens bijgewerkt moet worden: de datum in het LMS is de enige
waarheid en die wordt elke ronde opnieuw gelezen. Dezelfde hercontrole als
bij een beloofde betaaldatum.

Bij de **bulk-ronde** blijft de ontvanger op `pending` staan (niet op
`skipped`): een hold is tijdelijk, en `skipped` zou betekenen dat de klant
zijn aanmaning ook ná de pauze nooit meer krijgt. Gevolg dat een mens moet
weten: zolang de pauze loopt blijft die bulk-job openstaan — er is immers nog
wél iets te versturen, alleen nu niet. De toets gebeurt vóór de atomische
claim, zodat er geen statuswissel heen-en-weer is.

## 5. Wat een medewerker ziet

In **Finance → Wanbetalers → Pipeline**:

* een eigen filter-pil en KPI-teller **"On hold in het LMS"** (bewust niet
  samengevoegd met "Openstaande actie": dit is een beslissing van de
  hoofdmentor, geen taak van finance — wie ernaar kijkt moet weten dat er
  niets te doen is behalve wachten);
* in de rij, op de plek van de geplande datum:
  **"On hold in het LMS tot 01-10-2026 — betaalachterstand"**. Die datum zou
  daar anders als belofte lezen ("morgen gaat er iets uit") terwijl er juist
  niets uitgaat.

In het **klantdossier** staat de logregel als *"Overgeslagen: student staat
on hold in het LMS"* met dezelfde zin als detail.

## 6. Wat er NIET gewijzigd is

* **Geen enkele wijziging aan bedragen, facturen of templates.**
* De interne boekhouding loopt door: `markOverdue()` (mentor-bonussen op
  `wachten_op_betaling`) gebeurt nog steeds. Een hold houdt **berichten**
  tegen, geen administratie — de factuur ís te laat, ook als we er even niet
  over beginnen.
* De incasso-cron (`cron-incasso-auto`) is **niet** aangeraakt: die maakt een
  dossier aan en verstuurt uit zichzelf geen klantbericht. Wil je dat een
  hold ook het aanmaken van een incassodossier tegenhoudt, dan is dat een
  aparte beslissing — zeg het en het is drie regels.
* De Joost-autonomiepaden (`joost-send-autonomous`, `joost-outbound-*`) staan
  achter feature-flags die uit staan en zijn hier niet geraakt. Zodra er één
  aangezet wordt hoort de poort daar ook langs; de contracttest noemt nu de
  drie paden die vandaag versturen.
