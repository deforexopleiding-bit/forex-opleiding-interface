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
   **LMS-stilte** → LMS-hold → klanttype/bedrag → terminal-fase → start.
   Bij een lopende afspraak start er dus niet eens een run: anders zou die
   elke dag opgepikt en overgeslagen worden, en de klant tijdens zijn
   afspraak in de pipeline staan alsof er iets loopt.
2. **`advanceActiveRuns`** — of een lopende run een stap zet. Volgorde:
   alles-betaald → reply-stop → **LMS-stilte** → LMS-hold → openstaande
   actie → de stap zelf. Overslaan **zonder statuswijziging**: de run blijft
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
maken hebben. Het vangnet is hetzelfde als dat van de hold-poort — CRM-side
koppelwegen plus de afdruk die de factuurstand-ronde achterlaat in
`app_settings.lms_gekoppelde_klanten` (op productie bijgewerkt 21-09 om
02:10, ~180 klanten). Dat vangnet wordt **gedeeld**, niet gekopieerd.

### Langer dan een etmaal onleesbaar wordt zichtbaar

`lms-stilte` legt na elke ronde de stand van de bron vast in
`app_settings.lms_stilte_bron` (`onleesbaar_sinds` blijft staan zolang het
mis is). De bestaande brug-waakhond (elke 5 min) beoordeelt dat als tweede,
onafhankelijke wacht en mailt één keer per storing zodra het een etmaal
duurt. Korter is een hikje dat zichzelf herstelt; langer betekent dat er
dagen niemand gemaand wordt zonder dat iemand het weet.

## Wat een medewerker ziet

Eigen bak en filter-pil **"Afspraak in het LMS"** in de wanbetalers-pipeline,
naast (niet samengevoegd met) "On hold in het LMS" — bij een hold is de
coaching stilgelegd, bij een afspraak is er iets toegezegd mét einddatum. In
de rij, op de plek van de geplande datum:

> Afspraak in het LMS — stil tot en met 01-10-2026 · facturen open, ·
> afgesproken door Maxim Delo (admin)

In het klantdossier staat de `dunning_log`-regel als *"Overgeslagen: er loopt
een afspraak in het LMS"* met dezelfde zin als detail. De payload draagt
`stil_tot`, `door_naam`, `reden_soort` en `bron` mee, zodat ook aan CRM-kant
naleesbaar is wie wat heeft afgesproken.

## Verhouding tot de hold-poort (#1622) — en één vraag voor Maxim

De hold-poort leest `hlms_student_hold` rechtstreeks; deze leest het
contract. Ze staan **naast elkaar**, bewust:

* **Gemeten:** er is op productie geen enkele actieve hold zónder
  bijbehorende stilterij (`holds_actief_zonder_stilte` = leeg). De twee
  spreken elkaar vandaag dus niet tegen — de LMS-kant projecteert een
  menselijke hold naar een stilte (`bron='hold'`).
* **De vraag:** zou het LMS ooit een **automatische** betalingspauze (2+
  vervallen facturen) als hold wegschrijven, dan blokkeert de hold-poort wél
  en deze niet — terwijl jullie regel juist is dat zo'n pauze géén stilte
  zet. Dan manen we iemand niet aan die we wél hadden mogen aanmanen.
* **Waarom ik de hold-poort tóch heb laten staan:** de omgekeerde fout is
  duurder. Zou ik hem weghalen en projecteert het LMS een menselijke hold
  een keer niet, dan manen we tegen een afspraak in. Dat is precies de fout
  die deze hele brug moet voorkomen. Wil je één poort in plaats van twee, dan
  is dat één import minder in `dunning-engine.js` — zeg het en het is zo weg.

## Niet gewijzigd

* **De handmatige bulk-flows** (`cron-dunning-bulk-send`) — eerder door Maxim
  beslist. De hold-poort die daar al stond blijft staan; er komt geen
  stilte-poort bij. Een contracttest bewaakt allebei die kanten.
* **Niets geschreven naar het LMS.** Geen insert, update of delete op een
  `hlms_`-tabel; contracttest.
* Geen wijziging aan bedragen, facturen of templates.

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
