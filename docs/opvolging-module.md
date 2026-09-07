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
zet hem 's nachts op morgen. De volgende dag staat hij er weer, en zo elke dag
tot het event.

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
