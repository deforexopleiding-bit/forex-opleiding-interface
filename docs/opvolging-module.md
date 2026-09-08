# Opvolging — het dagsysteem van Dave

Deze module beslist wie Dave vandaag belt, en het dagrapport beoordeelt
achteraf of dat gebeurd is. Beide gaan over **een persoon**, en dat maakt de
eisen anders dan bij de rest van de repo: een cijfer dat niet klopt kost hier
niet alleen zichzelf maar de geloofwaardigheid van het geheel.

---

## ⚠ De alibi-test

**Een test die het waargenomen gedrag vastlegt in plaats van het bedoelde
gedrag, maakt een bug permanent en onzichtbaar.**

Lees dat nog een keer, want het is precies het omgekeerde van wat een test
hoort te doen. Zo'n test wordt niet rood als de bug erin zit — hij wordt rood
als iemand hem repareert. Hij beschermt de fout.

En hij is bijna niet te herkennen aan de buitenkant. Een gewone falende test
schreeuwt. Een alibi-test staat groen in een suite van tweeduizend, met een
naam die klinkt als een eis en een commentaarregel die uitlegt waarom het zo
hoort. Hij ziet er béter uit dan de tests eromheen.

### Het geval waar deze regel vandaan komt

Op 5 september 2026 werd de instroom van event-aanmeldingen gebouwd
(`dca79dde`). De kop van `api/_lib/opvolging-aanmelding.js` beschreef in
diezelfde commit twee belmomenten:

```
//   A — de aanmelding zelf: bellen binnen 24 uur, vraag of alles goed ging.
//   B — vier dagen voor het event: dezelfde kaart wordt weer wakker.
```

De code eronder deed alleen B. Elke kaart kreeg bij het aanmaken meteen
`due = eventdatum − 4`, ook als de aanmelding weken eerder binnenkwam. De kaart
werd dus geboren in slaaptoestand en Dave zag hem pas vlak voor het event.
Ronde A heeft nooit bestaan.

En in dezelfde commit stond de test:

```js
test('een verse aanmelding ver vooraf krijgt een slapende kaart', () => {
  // Event op 20 september, dus wakker op de 16e. Tot dan staat hij niet in de
  // lijst: de dagweergave toont alleen due <= vandaag.
  assert.equal(r.due, '2026-09-16');
});
```

Alles aan die test is verleidelijk. De naam leest als een eis. Het commentaar
legt een mechanisme uit dat écht bestaat. De verwachte waarde is exact
uitgerekend. Hij is groen en blijft groen.

En hij bewaakt niets. Hij is nooit "stilletjes gesneuveld" en heeft de fout ook
niet "niet gemerkt" — hij hééft er nooit naar gekeken. Hij schreef op wat de
code deed en gaf dat de status van bedoeling.

Twee dagen later meldde Maxim dat verse aanmeldingen geen taak voor eerste
contact kregen. Zeven mensen hadden zich aangemeld en sliepen veertien tot
zeventien dagen. De suite stond al die tijd groen.

### Waarom dit hier apart genoemd wordt

Dit is niet de enige vorm die deze week bovenkwam. De familie is groter, en de
andere leden lijken er genoeg op om ze in één adem te noemen:

| vorm | wat de test aanraakte | wat hij had moeten aanraken |
| --- | --- | --- |
| **alibi** | het gedrag zoals het is | het gedrag zoals afgesproken |
| **hulpfunctie** | `schrijfCallUitkomst()` rechtstreeks | de knop die Dave indrukt |
| **commentaar** | het wóórd `requireAuth` in een comment bovenaan | de aanroep `AuthShared.requireAuth(` |
| **definitie** | `export function bouwVensters({ afspraken` | de aanroep met die parameter |
| **venster** | een `slice()` die net vóór de code eindigde | het blok dat de bewering bevat |

Ze hebben één ding gemeen: **de test raakte iets aan wat lijkt op het onderwerp,
in plaats van het onderwerp zelf.** En allemaal waren ze groen.

### Wat te doen in plaats daarvan

1. **Schrijf de test vóór de fix, en kijk of hij rood wordt.** Een test die
   nooit rood is geweest, heeft nooit iets bewezen. Bij een bugfix is dit geen
   formaliteit maar de enige meting die telt.

2. **Voer de regressie opzettelijk opnieuw in en tel hoeveel tests rood worden.**
   Nul betekent dat je niets bewaakt hebt, hoe uitgebreid de suite ook oogt. In
   deze module staat het aantal per ingebouwde fout in elke PR-beschrijving; dat
   is geen opsmuk maar het bewijs.

3. **Volg het pad dat de gebruiker loopt.** Roep de knop aan, niet de
   hulpfunctie eronder. Lees de `select()` uit de bron in plaats van het
   antwoordobject zelf op te bouwen — anders test je een veld dat de query niet
   ophaalt.

4. **Als de kop van een bestand iets anders beschrijft dan de code eronder, is
   er geen twijfel wie er wint: het commentaar.** Dat is de afspraak; de code is
   een poging daartoe. Wijkt de test af van het commentaar, dan is dat een
   bevinding, geen detail.

5. **Wees achterdochtig bij een testnaam die het gedrag beschrijft**
   ("krijgt een slapende kaart", "valt terug op de jid, zoals het was"). Een
   goede naam beschrijft de belofte aan de gebruiker, niet de implementatie.
   `zoals het was` in een testnaam is een rode vlag: het was fout, anders had je
   hem niet aangeraakt.

---

## ⚠ De blinde vlek die geen blinde vlek was

Dit is de belangrijkste vondst van de bewakingsronde, en hij hoort naast de
alibi-test hierboven omdat het dezelfde ziekte is in een ander orgaan: **iets
boeken als "onbekend" terwijl je het antwoord wél had.**

### Wat er gebeurde

De dagelijkse gezondheidscontrole (`api/cron-opvolging-gezondheid.js`) heeft een
vijfde controle die kijkt of de WhatsApp-brug bericht doorlaat. Die controle
riep de brug aan met een **verzonnen variabelenaam** (`WHATSAPP_BRUG_TOKEN` —
komt nergens anders in deze repo voor; het geheim heet `WHATSAPP_BRUG_SECRET`)
en met de **verkeerde header** (`Authorization: Bearer` in plaats van
`X-Brug-Secret`). De brug antwoordde dus met **401**.

En toen ging het pas echt mis:

```js
if (!resp.ok) return controleerBrug({ status: null, fout: 'HTTP ' + resp.status });
//                                    ^^^^^^^^^^^^ → NIET_GEMETEN
```

Die 401 werd geboekt als **niet gemeten** — de emmer voor "we konden hier niets
over zeggen". In de dagmail stond netjes `[NIET GEMETEN] brug`, wat leest als
"er ontbreekt nog een instelling". Er ontbrak niets. De controle was kapot.

**Zonder de vraag "waarom is die niet gemeten, de variabelen staan er toch?" had
deze controle jaren stil kunnen falen.** Een bewaker die zijn eigen storing als
blinde vlek rapporteert is erger dan geen bewaker: hij geeft dekking.

### De regel

> **`niet_gemeten` mag alleen als je VOORAF weet dat je niets kunt meten.**
>
> Dat zijn twee gevallen, en niet meer dan twee:
> 1. **een ontbrekende instelling of koppeling** — de variabele staat er niet,
>    de brug is niet ingericht, het adres is onbekend;
> 2. **een lege meting** — nul rijen, er is die dag niets gebeurd.
>
> **Een antwoord dat je WEL kreeg maar niet leuk vindt — een 401, een 500, een
> tijdslimiet, een exception, een verminkte antwoordvorm — is een `fout`.**

Het verschil is niet cosmetisch. `fout` betekent "iemand kijkt hiernaar";
`niet_gemeten` betekent in de praktijk "dit staat er al weken en niemand kijkt
er meer naar". Een storing in de tweede emmer is een storing die niemand ziet.

### Het stond op vijf plekken

Nadat de brug-controle door de mand viel, zijn de andere vier nagelopen. Vier
deden precies hetzelfde:

| plek | boekte als | is in werkelijkheid |
| --- | --- | --- |
| brug: elke niet-ok HTTP-status | niet gemeten | storing |
| printweergave: HTTP 500 op de pagina | niet gemeten | storing |
| instroom: leesfout op `opvolging_taken` | niet gemeten | storing |
| optelling + dubbels: exception uit `bouwRapport()` | niet gemeten | storing |
| optelling: rapport zonder `volume`-blok | niet gemeten | verminkt antwoord |

Die laatste is de scherpste: een rapportmotor die crasht is precies wat deze
bewaking hoort te vangen, en juist die crash verdween in de blinde-vlek-emmer.

Wat wél blinde vlek blijft: nul open aanmeldingen, nul zoomcalls op een dag, een
brug die verbonden is maar sinds de herstart niets zag. Dat zijn lege metingen,
geen geweigerde antwoorden. Er staat een test op die dat vasthoudt, want "dan
maken we alles maar `fout`" is de tegenovergestelde fout en levert een dagmail
op waar niemand meer naar kijkt.

### En de test zag het niet, om de bekende reden

Er stónden tests op `controleerBrug()`. Ze waren groen. Alle drie de fouten
zaten een laag dieper, in `meetBrug()` — de variabelenaam, de header en de
staat-toekenning. De pure functie kreeg keurig `{status: null}` aangereikt en
oordeelde daar keurig over.

Erger nog: **drie tests cementeerden de verwarring**, met een storing als bewijs
voor een blinde vlek:

```js
test('onbereikbaar is NIET GEMETEN, geen fout en zeker geen ok', () => {
  const r = beoordeelPrintweergave({ bereikbaar: false, fout: 'HTTP 500' });
  assert.equal(r.staat, NIET_GEMETEN);
});
```

Een HTTP 500 als bewijs voor "niet gemeten". Geschreven een paar uur nadat dit
document over precies die vorm werd geschreven. Zie de alibi-test hierboven: de
regel is niet moeilijk te begrijpen, hij is moeilijk toe te passen op je eigen
werk van vijf minuten geleden.

## Twee instroommomenten

Sinds de reparatie van 7 september kent een aanmeldkaart twee momenten, en die
worden door twee **verschillende** functies berekend — precies omdat één
gedeelde functie de fout hierboven veroorzaakte:

| | wanneer | functie |
| --- | --- | --- |
| **Ronde A** | de dag na de aanmelding (`registered_at`) | `dueVoorRondeA` |
| **Ronde B** | vier dagen voor het event | `dueVoorRondeB` |

Ronde A hangt aan het moment van **aanmelden**, niet aan de dag waarop de cron
draait. Anders schuift de kaart elke kwartierronde een dag mee en komt hij nooit
boven.

De overgang naar ronde B gebeurt bij het **afhandelen** van ronde A, niet bij
het aanmaken. Vandaag loopt dat via één pad: `opvolging-aanmelding-actie.js` bij
`bevestigd`. Bereikt Dave de lead niet, dan blijft de kaart open en komt hij
elke dag terug tot het event — zie de openstaande ontwerpvraag onderaan.

## Wat de cijfers betekenen

Drie woorden die in deze module niet door elkaar mogen lopen, en die op één
plek gedefinieerd staan (`api/_lib/opvolging-poging-telling.js`):

| woord | betekenis |
| --- | --- |
| **poging** | Dave heeft gebeld of geappt. Telt altijd, ook als niemand opnam. |
| **contact** | de verbinding kwam tot stand (`isContact`). |
| **gesprek** | contact **én** minstens `drempels.gesprek_min_sec` seconden (`isGesprek`). |

`isGesprek` geeft `null` als de duur ontbreekt. **Onbekend is geen nee.** Een
lead die uit de lijst is gehaald terwijl van geen enkele call de duur gemeten
is, hoort in de blinde vlekken van het rapport en niet in de bevindingen — daar
valt geen oordeel over te vellen, dus wordt het er ook niet geveld.

De belpogingen vallen in vier emmers die elkaar uitsluiten en die per definitie
optellen:

```
niet_opgenomen + zonder_duur + gesproken + te_kort === uit
```

Klopt die optelling niet, dan valt er ergens een categorie stil weg. Dat is
precies wat er op 7 september gebeurde: `5 + 1` bij negen pogingen.

## Wat er met een niet-bereikte lead gebeurt

Belt Dave in ronde A en neemt niemand op, dan gebeurt er **niets bijzonders**.
De poging wordt geregistreerd, de kaart blijft open, en `cron-opvolging-doorrol`
haalt hem 's nachts naar de dag waarop die cron draait. De volgende dag staat
hij er weer, en zo elke dag tot het event.

**Dat is een bewuste keuze, geen omissie** (Maxim, 7 september 2026). Er komt
géén automatisme dat de kaart bij uitblijvend contact naar event min vier
parkeert. Wie niet reageert blijft in beeld tot iemand er een besluit over
neemt; de uitgang wordt een handeling van Dave, geen stille verschuiving.

Bouw hier dus geen parkeer-logica in. Die zou er later weer uit moeten.

## Uitgesteld — de bedenktijd-kaart

**Wat het zou zijn.** Een `later_opnieuw`-uitkomst ("bedenktijd, opvolgen over
3 maanden") maakt automatisch een kaart in de werklijst met `due` op de
afgesproken datum, zodat een belofte aan de klant niet in een vrij tekstveld
blijft liggen.

**Waarom het nu niet gebouwd wordt.** Twee redenen, en de tweede is de
belangrijkste:

1. Het gaat om ongeveer **vier gevallen per maand**. De zestien die er op
   7 september lagen zijn met de hand opgepakt; een automatisme daarvoor bouwen
   terwijl er grotere dingen open staan, is de moeite niet waard.
2. **De basis zou nu wankel zijn.** De oude gevallen zijn alleen te herkennen
   aan losse tekst in `snelle_notitie` ("bedenktijd opvolgen over 3 maanden").
   Matchen op die zin breekt zodra iemand hem anders formuleert — precies de
   fragiele weg die deze module elders juist heeft afgeschaft.

**Wanneer het wél de moeite is.** Zodra `follow_up_appointments.uitkomst`
structureel gevuld is — dat gebeurt sinds 7 september bij elke uitkomst via
`writeUitkomst()` in `api/follow-up-appointment-outcome.js`. Dan is dit een
handvol regels op een enum in plaats van tekstherkenning: lees `uitkomst =
'later_opnieuw'`, lees de maanden, zet de `due`. Geen parser, geen giswerk.

**Let op bij het oppakken:** `follow_up_leads` is hier niet de plek. Zie de
waarschuwing hieronder.

## ⚠ `follow_up_leads` is een administratie die nooit gewerkt heeft

De tabel is leeg — nul rijen, geen RLS-fout. Toch bestaat de code die hem zou
vullen al lang: `createFollowupLead()` in
`api/follow-up-appointment-outcome.js` wordt aangeroepen bij `no_show`,
`later_opnieuw` en `terugbel`.

Elke fout daarvan verdwijnt hier:

```js
} catch (e) {
  extraWarnings.push('follow_up_lead-aanmaak mislukt: ' + (e.message || 'onbekend'));
}
```

Een waarschuwing in het antwoord die niemand leest. De uitkomst slaagt, de
notitie wordt geschreven, de status wordt gezet — en de klant verdwijnt. Op
7 september bleken er **225 mensen** op die manier uit beeld: 94 no-shows,
88 zelf-geannuleerd, 23 gesprek-gehad-zonder-beslissing, 16 bedenktijd, 4
wacht-op-nieuwe-afspraak. Daves werklijst telde er op dat moment 34.

**Nieuwe opvolgkaarten horen in `opvolging_taken`** — de lijst waar Dave uit
werkt. Niet in `follow_up_leads`, en zeker niet in allebei.

## Openstaand — de uitgang, in een eigen ronde

**Knop "Annuleren voor event" op de aanmeldkaart.** Dave gebruikt hem wanneer er
voldoende moeite is gedaan en de persoon niet reageert. Twee dingen tegelijk:

1. de opvolgkaart sluiten, en
2. **doorschrijven naar de eventmodule**: de persoon daar op geannuleerd zetten,
   langs dezelfde route als de bestaande annulering in die module. Niet alleen
   de kaart dichtdoen — dan blijft de eventlijst een aanmelding tonen die er
   geen meer is.

**Nog verder weg, uitdrukkelijk niet nu:** een automatisering die bij zo'n
annulering de klant een WhatsApp én een mail stuurt dat zijn inschrijving
geannuleerd is.

Beide staan hier zodat ze niet wegzakken, en beide krijgen hun eigen ronde. De
volgorde is met opzet: eerst het bellen helemaal af, dan pas de uitgang. Een
knop die er tussendoor komt laat het bellen half af achter.

## ⚠ Het rapport beoordeelde een verzameling waar de brug nooit van gehoord had

Derde geval van dezelfde ziekte als de twee hierboven, en het scherpste: **twee
onderdelen die over "dezelfde" mensen gaan, maar die verzameling verschillend
opbouwen.** Zolang niemand ze naast elkaar legt, ziet het er aan beide kanten
gezond uit.

### Wat er gebeurde

De WhatsApp-brug mag alleen gesprekken doorgeven van nummers die op de leadlijst
staan. Dat is een privacygrens en geen bug: Daves privécontacten lopen over
dezelfde telefoon. Die lijst komt uit `api/opvolging-whatsapp-nummers.js`, en die
bouwde hem **uitsluitend uit `opvolging_taken`**.

Sectie 3 van het rapport vraagt iets anders: kreeg elke lead **met een zoomcall**
die dag vóór 09:00 een spraakbericht? Dat is een andere verzameling.

Gemeten op 8 september: **acht zoomcalls, nul bijbehorende opvolgtaken.** De brug
had letterlijk nooit van die mensen gehoord en gooide elk bericht weg als
`niet_op_leadlijst` — 20 keer op `message_create`, 21 keer op `message`. De brug
leefde, de logging werkte, de cijfers waren nul. En sectie 3 concludeerde
vervolgens "geen spraakbericht" over iemand die haar werk wél gedaan had.

Beide kanten deden precies wat ze moesten doen. De fout zat in de ruimte
ertussen.

### Wat eraan is gedaan

1. **De leadlijst kent nu ook de zoomcall-leads** — een tweede bron op
   `follow_up_appointments`, maar **alleen binnen een krap venster**: van
   gisteren tot drie dagen vooruit, en alleen bij een levende status. Grenzen en
   uitleg staan in `api/_lib/opvolging-leadlijst-venster.js`.

   Krap houden is geen detail. De hele afsprakenhistorie toevoegen zou de
   privacygrens permanent verbreden, en dat is precies wat dit filter moet
   voorkomen. Iemand met een afspraak van drie maanden geleden hoort er niet in.
   De vorm van het antwoord verandert niet: alleen cijferreeksen, geen namen,
   geen ids, nog steeds achter `X-Brug-Secret`.

2. **Het rapport zwijgt over de dagen die het niet kon meten** —
   `DEKKING_VANAF` in datzelfde bestand. Een dag vóór die datum levert een
   **blinde vlek** op sectie 3 in plaats van een verwijt, met de zin erbij dat
   dit *niet* betekent dat er geen spraakbericht is gestuurd. Per dag, dus een
   weekrapport dat over de deploydag heen loopt beoordeelt de dagen erna gewoon.

   Waarom een datum en geen berekening: of een nummer op de lijst stond op het
   moment dat het bericht ging, is achteraf nergens uit af te leiden — de lijst
   wordt live opgebouwd en niet bewaard. Het enige harde feit is de dag waarop de
   fix live ging. **Schuift de deploy op, dan moet die datum meeschuiven**,
   anders beweert het rapport iets gemeten te hebben wat het niet kon meten.

3. **Een test die de grens vastlegt** — `tests/opvolging-leadlijst-zoomcalls.test.js`
   legt vast dat een lead met alleen een zoomcall in het venster **wel** in de
   lijst zit en een afspraak van drie maanden geleden **niet**. Zonder die test
   schuift de privacygrens ooit stilletjes op zonder dat iemand het merkt.

### De les

Als twee onderdelen over "dezelfde" mensen gaan maar die verzameling elk apart
opbouwen, lopen ze uiteen — en dan meet het ene iets over een populatie die het
andere nooit gezien heeft. Er is geen foutmelding die dat zichtbaar maakt: beide
kanten rapporteren keurig hun eigen nul.

De vraag om te stellen bij elke controle die over een groep gaat: **kijkt de
meting naar precies dezelfde lijst als de uitvoering?** Zo niet, dan is het
resultaat geen oordeel maar een blinde vlek, en dan hoort het rapport dat te
zeggen.

**Wat de berichten van 8 september betreft: die zijn weg.** De brug gooide ze
weg voordat er iets van werd vastgelegd, dus er valt niets te herstellen. Het
rapport hoort daarover te zeggen dat het het venster niet kon meten — niet dat
er geen bericht is gestuurd.

## ⚠ De doorrol sloeg elke nacht een dag over

Dit is de duurste van de vier vondsten in deze reeks, want hij deed niet één
keer iets fout maar **elke nacht sinds de module bestaat**, en het enige spoor
was een datum die er op het eerste gezicht redelijk uitzag.

### Wat er gebeurde

Maxim meldde dat de openstaande kaarten van de opwarmronde van 7 september niet
waren meegekomen naar de 8e. De vijf leads die Dave die dag niet te pakken
kreeg — Achraf Deflaoui, Kris Sienaert, Said Hachemi, Gevorg Khetchoumian en
Werner De Kesel — stonden alle vijf op `due 2026-09-09`.

Dat is niet 'blijven liggen'. Dat is een dag **overslaan**: op 8 september
stonden ze op geen enkele lijst. Alle vijf droegen `updated_at 2026-09-07T23:59`,
dus de doorrol had ze wél aangeraakt en er de verkeerde datum op gezet. De twee
die Dave wél afrondde stonden correct op 19 en 22 september, dus de bevestigflow
klopte. En de 19 taken die op de 8e wel in de lijst stonden, stonden daar al
vóór de doorrol liep.

### De oorzaak

In `vercel.json` staat de cron op `59 23 * * *`, en **Vercel draait crons in
UTC**. 23:59 UTC is 01:59 in Amsterdam — het is dan dus al de volgende dag. De
cron rekende vervolgens keurig uit wat 'morgen' was vanuit Amsterdams
perspectief, en kwam daarmee op overmorgen uit.

Het pijnlijke detail: in de code stond een comment dat precies deze val
beschreef, maar met de richting verkeerd om. Er is nooit iemand geweest die het
nagerekend heeft, en in ons geheugen stond dat deze cron om 23:59 *Amsterdamse*
tijd draaide. Dat klopte niet.

### De fix is geen tijdzonecorrectie

`59 21 * * *` invullen klopt in de zomer en is in de winter weer mis, want
Nederland schuift twee keer per jaar. Elk vast UTC-uur is dus de helft van het
jaar verkeerd.

De regel is daarom **zelfhelend** gemaakt: de doorrol redeneert niet meer in
morgen maar in **vandaag**. Elke openstaande taak met een `due` vóór de huidige
Amsterdamse datum krijgt die datum.

| | |
|---|---|
| idempotent | twee keer draaien verandert de tweede keer niets |
| tijdstip-onafhankelijk | het maakt niet uit hoe laat de cron valt, zomer of winter |
| zelfhelend | slaat een nacht over of faalt een run, dan haalt de volgende run alles alsnog naar voren |

Dat laatste is het punt. Het verschil tussen *werkt* en *blijft werken* is dat
de tweede zichzelf herstelt in plaats van kaarten voorgoed in het verleden te
laten hangen. Het repareert daarmee ook de vijf van 7 september, zonder aparte
inhaalquery.

De som zelf staat nu als `doorrolDag(nuMs)` in `api/_lib/opvolging-doorrol.js`,
met een test eronder die vastlegt dat `2026-09-07T23:59:00Z` de **8e** oplevert.
In een handler zie je zo'n rekensommetje alleen in productie werken.

### En de belangrijkste helft: waarom wist het systeem dit niet zelf?

De gezondheidscontrole draait elke ochtend om 07:00, **meteen na de doorrol**,
en heeft dit niet gezien. Vijf kaarten verdwenen uit de dag en er ging geen
enkel belletje af. Maxim moest het zelf opmerken — en hij wordt het terecht beu
dat hij telkens degene is die scherp moet zijn.

Daarom is er een **zesde controle** bij: staat er een openstaande taak met een
`due` in het verleden? Die hoort er per definitie nooit te zijn — alles wat open
is hoort vandaag of later te staan. Het is een van de weinige controles die niet
over een cijfer gaat maar over **de gezondheid van het dagritme zelf**.

De vier eerdere controles kijken allemaal naar een som, een dubbeling of een
teller. Dat is precies waarom deze ontbrak: niet elke storing laat zich zien als
een getal dat niet klopt. Was hij er op 8 september geweest, dan had Maxim het
die ochtend van het systeem gehoord in plaats van het zelf te moeten zien.

Hij meldt de namen mee (`Achraf Deflaoui (2026-09-07)` …), want weten dát er iets
mis is zonder te weten bij wie kost nog steeds een halve ochtend. En nul open
kaarten is `NIET_GEMETEN`, niet `ok`: een lege lijst bewijst niets over het
dagritme.

### De les

Een cron die een datum uitrekent, rekent hem uit in de tijdzone van de machine
en niet in die van de gebruiker. Twee vragen horen daarom bij elke geplande taak
te staan, en ze staan hier omdat ze in dit geval geen van beide gesteld waren:

1. **In welke tijdzone draait dit, en heb ik dat nagerekend?** Niet: wat staat
   erover in een comment.
2. **Wat gebeurt er als deze run overslaat?** Een taak die alleen goed werkt als
   hij élke keer draait, is een taak die stil kapotgaat.

Een regel die naar *vandaag* rekent in plaats van naar *morgen* beantwoordt ze
allebei tegelijk.

### Naschrift: de zelfhelende regel repareerde de schade niet

Bij de fix hierboven schreef ik dat de zelfhelende regel de vijf kaarten van 7
september vanzelf zou repareren. **Dat was fout, en Maxim ving het.**

De regel is `due < vandaag` → `due = vandaag`. De vijf stonden op
`due 2026-09-09`, en dat ligt op de 8e in de **toekomst**:

```
'2026-09-09' < '2026-09-08'  →  false
```

Ze werden dus niet aangeraakt. Ze duiken op de 9e vanzelf op, en 8 september
blijft de dag die ze hebben overgeslagen.

De les zit in het onderscheid: een zelfhelende regel voorkomt het probleem
**vanaf nu**, maar hij haalt de bestaande schade niet weg. Dat zijn twee
verschillende opdrachten, en de eerste voelt alsof hij de tweede meeneemt. Dat
doet hij niet.

De reparatie is met de hand gedaan: de vijf zijn eenmalig naar 8 september
gehaald. De vingerafdruk daarvoor is `status='open'` + `due = 2026-09-09` +
een `updated_at` in het venster van de kapotte doorrol — dat laatste is het
beslissende deel, want er stonden ook kaarten die terecht op 9 september
hoorden, en 01:59 Amsterdamse tijd is een moment waarop geen mens een kaart
verzet.

### En de zesde controle was niet genoeg

`controleerDagritme` kijkt of er een open kaart met een due in het **verleden**
staat. Deze fout maakte er een in de **toekomst**. Die controle had hem dus
nooit gezien — de controle die uit de fout geboren werd, kon de fout zelf niet
vangen.

Daarom is er een zevende: `controleerDoorrol`. Die rekent na op welke dag de
doorrol vannacht richtte.

**Waarom dat niet met een vuistregel op de rijen kan.** "Een open kaart die ver
vooruit staat is verdacht" geeft vals alarm op precies de kaarten die het goed
doen: een bevestigde aanmelding slaapt legitiem tot vier dagen voor het event,
en `cron-opvolging-aanmeldingen` draait elk kwartier — ook 's nachts — en maakt
dan kaarten met een due weken vooruit. Een nachtvenster is dus geen
vingerafdruk.

De doorrol laat daarom een merkteken achter in `app_settings`
(`opvolging_doorrol_laatste`): de dag waarop hij richtte, het moment waarop hij
draaide, hoeveel kaarten hij verzette en een greep uit de ids. De controle leidt
de dag **opnieuw** af uit dat ruwe tijdstip — daar zat de fout — en vergelijkt.
Geen zelfbevestiging, want de twee komen langs verschillende wegen.

**En er zit geen marge op, terwijl de opdracht "meer dan een dag vooruit" was.**
Gemeten: `updated_at 2026-09-07T23:59Z` is in Amsterdam `2026-09-08`, en de due
werd `2026-09-09`. Dat is precies **één** dag. Een drempel op *meer dan* een dag
had deze fout dus óók gemist. Na een doorrol hoort de due exact de dag van de
run te zijn; alles daarvoor of daarna is fout. Het teruggezette drempelgedrag is
als sabotage getest: drie rode tests.

Dat is deze week de derde keer dat een drempel net verkeerd genoeg stond om het
ding te missen waarvoor hij bedacht was — na de tien seconden gespreksduur en
de vaste schaal op de tijdlijn. **Bij een drempel hoort de vraag: wat is de
gemeten waarde van het geval dat ik wil vangen, en valt die er ruim binnen?**
