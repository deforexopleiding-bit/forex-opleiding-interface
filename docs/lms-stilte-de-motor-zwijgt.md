# De aanmaanmotor zwijgt als er een afspraak loopt

De CRM-helft van een brug waarvan de LMS-helft al op productie staat
(dfo-lms-prototype #286/#287). Het spiegelbeeld van `hlms_crm_factuurstand`:
daar schrijft het CRM en leest het LMS, **hier schrijft het LMS en leest de
motor**.

> **Geen CRM-migratie nodig.** `dunning_log.event_type` is een vrij tekstveld
> (`2026-06-07-dunning-foundation.sql` r79), `app_settings` bestaat al. Er
> hoeft niets gedraaid te worden voordat dit live mag.

## Het contract (gemeten op productie, 21 september 2026)

`public.hlms_crm_stilte` in dfo-lms — één rij per student:

| kolom | | |
|---|---|---|
| `student_id` | uuid | PK, FK → `hlms_student(id)` ON DELETE CASCADE |
| `stil_tot` | date NOT NULL | **tot en MET die dag** |
| `reden` | text NOT NULL | CHECK: betaling / ziekte / vakantie / geen_contact / afspraak / anders |
| `reden_tekst` | text | de zin die een mens leest |
| `door` | uuid | **CHECK (door IS NOT NULL)** — er bestaat geen stilte zonder mens |
| `door_naam` | text | **mag leeg zijn** — nooit blind afdrukken |
| `bron` | text NOT NULL | CHECK: hold / belofte / hand |

RLS staat aan, 1 policy. Wij lezen met de service-sleutel die er al is en
schrijven **niets** — daar staat een contracttest op.

**De enige rij die er vandaag staat:** student `94da55c0…` (Maxim test),
`stil_tot` 2026-10-01, `bron` hold, `reden_tekst` "facturen open,",
`door_naam` "Maxim Delo (admin)". Actief vandaag.

## Hoe de motor vandaag beslist, en waar de poort staat

Gemeten op de CRM-databank, 21 september: **131 klanten met een open
factuur, 108 met een vervallen factuur**, 34 actieve runs, 106 gepauzeerde,
7 wachtende bulk-ontvangers.

De motor beslist op twee plekken per klant, en de stilte-poort staat op
allebei:

1. **`detectAndStartRuns`** — of er een nieuwe run start. Volgorde:
   arrangement-filter → **harde vervaldatum-poort** → `markOverdue` →
   **LMS-stilte** → klanttype/bedrag → terminal-fase → start.
   Bij een lopende afspraak start er dus niet eens een run: anders zou die
   elke dag opgepikt en overgeslagen worden, en de klant tijdens zijn
   afspraak in de pipeline staan alsof er iets loopt.
2. **`advanceActiveRuns`** — of een lopende run een stap zet. Volgorde:
   alles-betaald → reply-stop → **LMS-stilte** → openstaande actie → de
   stap zelf. Overslaan **zonder statuswijziging**: de run blijft
   `active` en de dagcron pikt hem morgen opnieuw op.

Daarnaast de gespreksherinneringen (`cron-dunning-conversation-reminders`) —
een herinnering is ook een bericht.

### De dag ná `stil_tot` loopt alles vanzelf door

Er is **geen hervat-cron** en geen kolom die bijgewerkt moet worden. De datum
in het LMS is de enige waarheid en die wordt elke ronde opnieuw gelezen.

De gevraagde hercontrole ("is ze nog vervallen?") zit er al in, en wel vóór
de poort: in `detect` staat de harde vervaldatum-poort ervoor, in `advance`
de alles-betaald-check. Betaalde de klant tijdens de afspraak, dan komt hij
de dag erna niet eens bij de stilte-poort langs. Een contracttest pint die
volgorde vast.

## Faalzacht, naar de voorzichtige kant

Kan de stilte niet gelezen worden, dan gaat er die run **niets** uit naar
klanten met een LMS-koppeling, met een eigen reden-code
(`lms_stilte_onbekend` — "we konden niet kijken" is iets anders dan "er is
een afspraak"). De volgende run probeert het opnieuw.

**Klanten zonder LMS-koppeling gaan gewoon door.** Anders legt één storing de
complete inning stil, ook voor de ~100 wanbetalers die niets met het LMS te
maken hebben. Het vangnet zit in `api/_lib/lms-koppelnet.js` — CRM-side
koppelwegen plus de afdruk die de factuurstand-ronde achterlaat in
`app_settings.lms_gekoppelde_klanten` (op productie bijgewerkt 21-09 om
02:10, ~180 klanten). Eén plek, gedeeld met de factuurspiegel.

### Langer dan een etmaal onleesbaar wordt zichtbaar

`lms-stilte` legt na elke ronde de stand van de bron vast in
`app_settings.lms_stilte_bron` (`onleesbaar_sinds` blijft staan zolang het
mis is). De bestaande brug-waakhond (elke 5 min) beoordeelt dat als tweede,
onafhankelijke wacht en mailt één keer per storing zodra het een etmaal
duurt. Korter is een hikje dat zichzelf herstelt; langer betekent dat er
dagen niemand gemaand wordt zonder dat iemand het weet.

## Wat een medewerker ziet

Eigen bak en filter-pil **"Afspraak in het LMS"** in de wanbetalers-pipeline,
— sinds 21 september de enige LMS-bak (de bak "On hold in het LMS" is met de
hold-poort mee verdwenen). In de rij, op de plek van de geplande datum:

> Afspraak in het LMS — stil tot en met 01-10-2026 · facturen open, ·
> afgesproken door Maxim Delo (admin)

In het klantdossier staat de `dunning_log`-regel als *"Overgeslagen: er loopt
een afspraak in het LMS"* met dezelfde zin als detail. De payload draagt
`stil_tot`, `door_naam`, `reden_soort` en `bron` mee, zodat ook aan CRM-kant
naleesbaar is wie wat heeft afgesproken.

## De hold-poort is weg (21 september 2026)

#1622 zette een tweede poort naast deze, die `hlms_student_hold` rechtstreeks
las. Die is verwijderd op beslissing van Maxim, en de reden is precies het
onderscheid uit de eerste alinea van dit document:

* Het LMS kan **automatische betalingsholds** zetten (2+ vervallen facturen,
  `door` leeg, `reden_soort='betaling'`). Die leggen alleen de coaching stil.
  De oude poort zou ze als zwijggebod lezen en dus precies de wanbetalers
  stilleggen die wél een aanmaning horen te krijgen — de hele doelgroep van
  deze motor.
* Een **menselijke** hold bereikt ons nog steeds: het LMS projecteert die
  zelf naar een stilterij met `bron='hold'`, dus langs deze poort, met een
  naam eronder.

**Meting op 21 september, eerlijk:** op productie stond op dat moment exact
één hold — de testpauze van Maxim op student "Maxim test", met `door` gevuld.
**Nul** automatische betalingsholds, terwijl er 15 rode
`factuur_vervallen`-kaarten open stonden: het LMS roept
`hlms_hold_automatisch_aan` vandaag nog niet aan (dat zoekt Cowork aan
LMS-kant uit). En in 8.088 `dunning_log`-regels staat geen enkele
`skipped_lms_hold` — de poort heeft op productie nooit iemand overgeslagen.

De fout is dus nog niet gebeurd. Dat is geen reden om te wachten maar de
reden om nu te handelen: zodra het LMS de eerste automatische hold schrijft,
valt de inning stil zonder dat er iets kapot gaat — er gaan alleen berichten
níét uit, en dat merkt niemand meteen. Omdat er geen productiegeval is om
naar te wijzen, bouwt `tests/lms-geen-hold-poort.test.js` het geval zelf na:
een student met alleen een automatische betalingshold wordt gemaand, een
student met een menselijke afspraak niet, en de motor bevraagt
`hlms_student_hold` niet meer.

### Wat er van de hold-poort over is

`api/_lib/lms-hold.js` is verwijderd. Het gedeelde vangnet dat erin woonde is
verhuisd naar **`api/_lib/lms-koppelnet.js`** — dat had nooit iets met holds
te maken, het beantwoordt de vraag "wie hangt er aan het LMS?" en wordt
gebruikt door de stilte-poort én door de factuurspiegel. Met de poort
verdwenen ook het event `skipped_lms_hold`, het label in het klantdossier en
de pipeline-bak "On hold in het LMS"; dat kon schoon omdat er geen enkele
historische logregel met dat event bestaat.

### Eén afwijking: de bulk-flow

Bij #1641 gold "de handmatige bulk-flows blijven zoals ze zijn", en daar
stond de hold-poort van #1622. Die moest nu weg. Hem alleen weghalen zou
bulk **onbeschermd** achterlaten tegen een echte afspraak — de dure kant van
de fout, en precies waar deze brug tegen gebouwd is. Daarom is de poort in
`cron-dunning-bulk-send.js` **vervangen** door de stilte-poort in plaats van
verwijderd: zelfde plek (vóór de atomische claim), zelfde gedrag (ontvanger
blijft `pending`, teller heet nu `lms_stilte`).

Bulk is daarmee even goed beschermd tegen een menselijke afspraak als
gisteren, en gaat niet meer uit op een pauze die een script heeft gezet. Wil
Maxim bulk tóch helemaal zonder LMS-poort, dan is dat één import en één
`if`-blok minder in dat bestand.

Eén ding is bij die verhuizing meteen rechtgezet: de stand werd opgehaald
vóór de check "zijn er wel wachtende ontvangers?". Deze cron draait elke 3
minuten, dus dat waren 480 bevragingen per dag voor niets. De bevraging
staat nu ná die check.

## Bekend bij de eerste live test

De stilterij op productie hangt aan student `94da55c0…` met e-mailadres
`events@deforexopleiding.nl`. Dat adres koppelt in het CRM aan klant
`32ccb9b7…`, en **die klant staat op `is_test = true`**. De koppeling van de
factuurspiegel weigert testklanten met opzet (`isEchteKlant`), dus deze
stilte levert **geen blokkade** op in de motor — niet omdat de poort stuk is,
maar omdat er geen echte klant aan hangt.

Wil je het live zien werken, dan is de kortste weg een stilterij op een
student die aan een echte klant met een vervallen factuur hangt. In de
cron-log is de poort sowieso zichtbaar: `[dunning-engine] lms-stilte: N
lopende afspra(a)k(en), M gekoppeld aan een klant, …`.
