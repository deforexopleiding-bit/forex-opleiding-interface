# Overschakelen van Joost naar Iris

**Datum:** 21 september 2026
**Status:** plan. **De beslissing is van Maxim; er wordt niets uitgezet zonder
dat hij dat zegt.**

De opdracht is hier duidelijk: de bestaande wanbetalersmodule blijft
ongewijzigd draaien tot Maxim beslist om over te schakelen. Dit document
beschrijft hoe dat er dan uit zou zien — niet wanneer.

---

## Eerst: waarom dit geen knop is

De verleiding bij zo'n overstap is één vlag die Joost uitzet en Iris aanzet.
Dat werkt hier niet, om een reden die de moeite is om uit te schrijven.

Joost en Iris zijn geen twee versies van hetzelfde ding. Joost is een
**motor**: hij loopt een ladder af (`aanmaning_dag7` en verder), houdt zich aan
kantooruren, en heeft in de loop van maanden een stuk of zes poorten gekregen
voor gevallen waarin hij moet zwijgen — een hold in het LMS, een afspraak, een
openstaande handmatige taak, een betaaltoezegging, een actieve
betalingsregeling. Die poorten zijn één voor één toegevoegd omdat er telkens
iets misging. Ze vertegenwoordigen kennis.

Iris is een **assistent**: ze leest, begrijpt en stelt voor. Ze heeft geen
ladder en die moet ze ook niet krijgen.

Dat betekent: de overstap is niet "Iris neemt de motor over" maar "de motor
wordt kleiner terwijl Iris groter wordt". En bij elke stap moet de vraag zijn:
welke poort van Joost zou hier verloren gaan?

---

## Wat er nu naast elkaar staat

| | Joost | Iris |
|---|---|---|
| Wat het is | aanmaanmotor met een vaste ladder | assistent die leest en voorstelt |
| Wanneer hij praat | op vaste momenten in de ladder | als er een bericht binnenkomt |
| Wie beslist | de workflow | een mens, tot de autonomie aan gaat |
| Tabellen | `dunning_*`, `pending_actions` | `iris_*` |
| Scherm | Wanbetalers in klanten-v2 | Iris (nu nog `?v2preview=iris`) |

Ze delen: de WhatsApp-lijn, de mailboxen, de verzendfuncties, de klant- en
factuurgegevens. Dat is met opzet — daar zit geen overlap die opgeruimd moet
worden.

---

## Wat er eerst moet gebeuren

Vóór er ook maar over overschakelen gepraat kan worden:

1. **De twee migraties gedraaid**, en de tabellen in gebruik.
2. **Minstens een maand schaduwmodus**, met genoeg berichten om iets over te
   zeggen. De droogtest in Instellingen zegt zelf of het er genoeg zijn (onder
   de vijftig is elke conclusie een gok).
3. **Minstens één categorie een maand op `concept`**, met een mens die de
   concepten leest en kan zeggen of ze kloppen.
4. **`IRIS_PAUZEERT_JOOST` aan**, zodat een belofte van Iris de motor al
   stillegt. Dat is de eerste plek waar de twee elkaar raken, en die wil je
   werkend zien vóór er meer volgt.

---

## De volgorde, als het zover is

### Stap 1 — Iris in het hoofdmenu

`iris` toevoegen aan `V2_ACTIVE_ALLOWLIST` in `klanten-v2.js`. Iris is dan een
gewone module naast Wanbetalers. Er verandert niets aan Joost.

**Terug:** de regel weghalen.

### Stap 2 — de reactieve laag over

Joost reageert nu op inkomende berichten via `joost-suggest`. Dat is precies wat
Iris ook doet, en het is de enige echte overlap.

Zet in `joost_config.feature_flags` de reactieve autonomie uit, en zet de
bijbehorende Iris-categorieën op `concept`. Joost blijft zijn ladder aflopen;
alleen het reageren gaat over.

**Hoe je merkt dat het goed gaat:** het aantal Joost-suggesties loopt naar nul
en het aantal Iris-concepten loopt op, en de som blijft ongeveer gelijk. Loopt
de som terug, dan valt er iets tussen wal en schip.

**Terug:** de vlaggen andersom.

### Stap 3 — de ladder erbij, niet eroverheen

Dit is de stap waar het mis kan gaan, en de enige juiste volgorde is: eerst
Iris de ladder laten **zien**, dan pas laten **lopen**.

Concreet betekent dat: Iris toont op de dossierkaart waar de klant in de ladder
staat (dat doet ze al) en stelt de volgende stap voor als concept, terwijl Joost
hem nog daadwerkelijk verstuurt. Pas als die twee een maand lang hetzelfde
voorstellen, kan de verzending over.

**Waarom deze omweg:** de ladder is niet moeilijk, maar de zes poorten eromheen
zijn het wel. Als Iris de ladder overneemt zonder die poorten, maant ze mensen
aan die een afspraak hebben lopen. Dat is precies het soort fout dat je pas
merkt als een klant boos belt.

### Stap 4 — Joost stilzetten, niet weghalen

`cron-dunning-engine` uit `vercel.json`. Het bestand blijft staan, de tabellen
blijven staan, de geschiedenis blijft leesbaar.

Dat is dezelfde aanpak als bij eerdere uitgezette crons in dit repo, en de
reden is praktisch: een motor die je kunt terugzetten is een motor waar je
minder zenuwachtig van wordt.

**Terug:** de regel terugzetten in `vercel.json`.

### Stap 5 — het Wanbetalers-scherm

Pas als er een maand niets gemist is. Het scherm uit de allowlist halen; de
4204 regels code blijven staan.

---

## Wat er NOOIT weg mag

Ook als alles over is:

- **`dunning_log`.** Dat is het bewijs van wat er wanneer naar wie is gegaan.
  Bij een betalingsgeschil is dat het enige wat telt.
- **`dunning_runs` en `pending_actions`.** Zelfde reden.
- **De poorten.** `lms-hold.js`, `lms-stilte.js`, `dunning-overdue-guard.js`,
  `dunning-office-hours.js`, `promise-maturity.js`. Iris gebruikt ze al
  gedeeltelijk en zou ze anders opnieuw moeten bouwen — slechter, want zonder
  de gevallen die ze in de praktijk hebben leren kennen.
- **De tests.** 362 dunning-tests zijn 362 keer iemand die iets ontdekt heeft.

---

## Hoe je weet dat het misgaat

Drie dingen om in de gaten te houden, met een grens erbij:

| Waar je naar kijkt | Alarm bij |
|---|---|
| open facturen ouder dan 60 dagen | stijging ten opzichte van de maand ervoor |
| berichten per week naar wanbetalers | een daling van meer dan 30% |
| klanten die drie weken niets hoorden en wel openstaan | meer dan vijf |

Dat middelste getal is de belangrijkste. Een overstap die misgaat, gaat
meestal niet mis doordat er te véél gebeurt — maar doordat er ineens niets meer
gebeurt en niemand het merkt.

---

## Wat dit document niet is

Geen aanbeveling om over te schakelen. Joost werkt, hij is maandenlang
bijgeschaafd, en hij heeft de poorten die dat bijschaven heeft opgeleverd.
Iris is jonger en heeft minder meegemaakt.

Er is één ding dat Iris kan wat Joost niet kan: een binnengekomen bericht
begrijpen en er een antwoord op schrijven. Zolang dat het verschil is, is naast
elkaar draaien geen tussenoplossing maar gewoon de juiste indeling — elk het
werk waar het voor gemaakt is.
