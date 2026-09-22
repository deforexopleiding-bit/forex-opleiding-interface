# De gesprekken-module — wat ze doet, en wat eraan mankeert

**Datum:** 21 september 2026
**Basis:** `main` op `784c1dd`
**Hoort bij:** [`00-inventaris.md`](00-inventaris.md)

Sectie 1c van de opdracht vraagt eerst te meten en dan pas te verbeteren. Dit
is het meten. De metingen komen uit de code (regels, grenswaarden,
klik-tellingen uit de opmaak, netwerkverkeer uit de pollfrequentie); waar een
getal pas op productie te halen is, staat dat erbij.

---

## 1. Waar het scherm woont

`modules/klanten-v2/views/wanbetalers-v2.js`, vanaf regel 3174 tot het eind.

| | |
|---|---|
| Het hele bestand | **7377 regels** |
| Waarvan gesprekken | **4204 regels**, 57% |
| Functies in het bestand | 174 |
| Globale `window.__wbx*`-handlers | 140 |

Die 140 globale handlers zijn geen stijlfout maar een gevolg: de opmaak wordt
als HTML-tekst opgebouwd met `onclick="__wbxIets()"` erin, en zo'n verwijzing
moet dan wel op `window` staan. Het werkt. Het maakt alleen dat elke nieuwe
knop een nieuwe globale naam kost, en dat je bij het lezen van een stuk opmaak
door het hele bestand moet zoeken wat er gebeurt.

## 2. De drie kolommen

**Links** — de gesprekslijst. Zoeken, een statusfilter (actief / afgehandeld /
archief / alles), sorteren op ongelezen-eerst.

**Midden** — de verenigde draad. WhatsApp en mail chronologisch door elkaar.
Daaronder de schrijfbalk, die per kanaal wisselt.

**Rechts** — het klantpaneel. Naam, mail, telefoon, "oudste X dagen te laat",
open facturen, abonnementen, MRR. Plus vijf directe knoppen: bekijk in klanten,
maak factuur aan, klant claimt betaald, leg afspraak vast, escaleren.

In de schrijfbalk: bijlage, template, snel antwoord, een Joost-knop, emoji, en
een ⋮-menu met bel-taak, regeling voorstellen en aanmaan-flow pauzeren.

**Dat is niet weinig.** Wie dit "een kaal scherm" noemt, heeft het niet
opengedaan. De gaten zitten elders, en ze zijn wel degelijk scherp.

## 3. De endpoints erachter

| Endpoint | Wanneer |
|---|---|
| `inbox-conversations-list` | bij openen, en elke 6 seconden opnieuw |
| `inbox-thread-unified` | bij het kiezen van een gesprek |
| `inbox-conversation-context` | idem, voor het rechterpaneel |
| `inbox-send` | bij versturen (WhatsApp) |
| `send-email` | bij versturen (mail) |
| `inbox-template-list`, `-quick-replies-list` | lui geladen bij openen van de kiezer |
| `inbox-mark-read` | bij het openen van een gesprek, faalzacht |

## 4. De metingen

### 4.1 Netwerkverkeer — het duidelijkste getal

De lijst wordt **elke 6 seconden volledig opnieuw opgehaald**
(`wanbetalers-v2.js` regel 3884), met `limit=1000` en zonder paginering
(regel 3224).

Het endpoint zelf rekent voor wat dat kost
(`inbox-conversations-list.js` regel 82): *"Bij 115 conversaties in productie
≈ 90KB response."*

Daaruit volgt, per geopend tabblad:

| | |
|---|---|
| per minuut | 10 opvragingen × 90 KB ≈ **900 KB** |
| per uur | ≈ **54 MB** |
| per werkdag van 8 uur, één tabblad | ≈ **430 MB** |
| twee mensen met het scherm open | ≈ **860 MB per dag** |

En dat terwijl er in een rustig uur misschien drie berichten binnenkomen. Er is
óók een realtime-kanaal op `whatsapp_messages` (regel 3892), dus de poll is
bedoeld als vangnet — maar hij draait onvoorwaardelijk mee, of het kanaal nu
werkt of niet.

Er staat zelfs een waarschuwing in het endpoint dat dit een keer misgaat:
*"Zie warning-log verderop als total > cap → dan moeten we alsnog op
server-side sort + paging over gaan."* Bij 115 gesprekken is dat nog ver weg.
Bij 1000 is het 800 KB per opvraging en 8 MB per minuut.

### 4.2 Klikken per antwoord

Geteld uit de opmaak, vanaf een open lijst tot het bericht weg is.

**Binnen het venster van 24 uur, WhatsApp:**

1. gesprek aanklikken
2. in het tekstvak klikken
3. typen
4. Verstuur

**Vier handelingen**, waarvan één het denkwerk. Dat is niet slecht.

**Buiten het venster:**

1. gesprek aanklikken
2. tekstvak blijkt geblokkeerd, met de melding "24u-venster is verlopen"
3. de keuzelijst opendoen
4. een template kiezen uit een lijst met kale namen (`aanmaning_dag7`)
5. Verstuur

**Vijf handelingen, plus een verrassing.** De verrassing is het probleem: je
denkt te gaan typen en loopt tegen een muur. Had je dat drie seconden eerder
geweten, dan had je een andere zin bedacht.

**Mail:** kanaal omzetten, onderwerp, tekst, versturen. **Vijf handelingen.**

### 4.3 Hoeveel er tegelijk wordt opgehaald

| Wat | Grens | Paginering |
|---|---|---|
| gesprekslijst | 1000 | nee |
| draad | 200 berichten | nee |
| klantcontext | 25 facturen | n.v.t. |

De draad haalt bij élke wisseling 200 berichten op, ook als je alleen even wilt
kijken wie het ook alweer was.

### 4.4 Wat pas op productie te meten is

Deze drie horen in dit document maar staan hier als openstaand, niet als getal:

1. **laadtijd van de lijst** bij het openen — te meten in het netwerkpaneel.
2. **hoeveel gesprekken er niet aan een klant hangen** — `select count(*) from
   whatsapp_conversations where customer_id is null`.
3. **hoe vaak de ongelezen-teller ernaast zit** — vergt een steekproef.

## 5. De tien gaten

Op volgorde van hoe zwaar ze wegen.

### G1 — Geen microfoon

Elk antwoord moet getypt. Dit is de kern van wat Iris moet worden: inspreken
wat er moet gebeuren en één keer tikken. Zonder dit is de rest versiering.

### G2 — Geen ongedaan-venster

`__wbxInboxSend()` roept meteen `inbox-send` aan. Verstuurd is weg. Eén
verkeerde klik naar een boze klant is onherstelbaar, en het is precies bij
boze klanten dat je het snelst verkeerd klikt.

### G3 — Het venster is er alleen als eindtoestand

De UI toont "24u-venster is verlopen" zodra het te laat is. Nergens staat
hoeveel tijd er nog is. De gegevens zijn er wel: `last_inbound_at` zit in het
antwoord van `inbox-conversation-context` én van `inbox-thread-unified`, en
`window_open` / `can_send_text` worden allebei al meegestuurd. Er wordt alleen
niet mee gerekend.

Dit is een van die gaten waar de oplossing kleiner is dan het gat: "venster
open nog 6u12" is een aftreksom op gegevens die er al zijn.

### G4 — Geen toewijzing

Nergens staat wie dit oppakt. Twee mensen antwoorden, of niemand. Bij twee
mensen op één postbus is dat geen randgeval maar de normale gang van zaken.

### G5 — De filters zijn te grof

Status en zoeken. Wat ontbreekt is precies waar je op wilt filteren: wacht op
ons · wacht op klant · venster bijna dicht · belofte vandaag · niet gekoppeld.

Twee daarvan zijn met de huidige gegevens al te bouwen (venster, niet
gekoppeld). De andere hebben de `iris_gesprekken`-status nodig.

### G6 — Mail hangt aan `customer_id`

`inbox-thread-unified.js` haalt mail op met `.eq('customer_id', conv.customer_id)`.
Geen klantkoppeling betekent: geen mail in de draad.

Dat is omgekeerd aan wat je nodig hebt. Juist bij een gesprek dat nog niet
gekoppeld is, wil je alle context die er is — misschien staat in een mail van
vorige week precies wie dit is.

Iris lost dit op door mail aan het **contact** te hangen in plaats van aan de
klant. Een contact bestaat ook zonder klantkoppeling.

### G7 — Geen kopie in Verzonden

`send-email.js` schrijft in `email_replies` maar doet geen IMAP `APPEND` naar
de map Verzonden. Wie in Thunderbird of op zijn telefoon kijkt, ziet zijn eigen
antwoord niet. Voor een klantgesprek waar twee mensen aan werken is dat een
gat waar dingen doorheen vallen.

### G8 — Geen paginering

Zie 4.1 en 4.3. Werkt nu, groeit mee tot het knapt, en het endpoint
waarschuwt er zelf voor.

### G9 — De verzendstatus is onzichtbaar

`whatsapp_messages` houdt `status`, `sent_at`, `delivered_at`, `read_at` en
`failed_reason` bij. Het scherm toont er niets van.

Dat betekent dat een **mislukt** bericht er hetzelfde uitziet als een
afgeleverd bericht. Je denkt dat je geantwoord hebt. Dit is het stilste van
alle gaten en daarom het gemeenste.

### G10 — `onboarding@` ontbreekt in het Inbox-overzicht

De mail komt binnen (zie de inventaris) en `inbox-v2.js` toont alleen
`administratie@` en `info@`, dus wie het Inbox-overzicht gebruikt als het
bakje-waar-alles-in-komt, ziet die postbus nooit.

> **Correctie, 22 september.** De eerste versie van deze regel zei dat
> `onboarding@` "geen scherm" heeft. Dat is te sterk: de E-mail-module
> (`email-v2.js`, `MAILBOXES`) heeft alle zeven postbussen, `onboarding@`
> inbegrepen. Wat ontbrak was de bron in het Inbox-overzicht. Het gat is dus
> kleiner dan het hier stond, en dat hoort in het document te staan in plaats
> van stilletjes rechtgezet te worden.

## 6. Wat er goed is, en dus blijft

Eerlijk zijn gaat twee kanten op. Dit werkt en wordt niet aangeraakt:

- **De verenigde draad.** WhatsApp en mail door elkaar is precies goed, en het
  bestaat al.
- **Het klantpaneel.** Open facturen met "+12d" ernaast, MRR, abonnementen —
  dat is de dossierkaart die de opdracht vraagt, en hij staat er.
- **De poort op het venster.** `inbox-send` geeft een 422 buiten de 24 uur. Het
  scherm mag falen, de server niet, en die faalt niet.
- **De faalzachte gelezen-markering.** Eén poging, geen herhaling. Een teller
  die ernaast zit is beter dan een scherm dat vastloopt.
- **De volgorde-opmerking bij `limit=1000`.** Iemand heeft de Priscilla
  Mauricia-bug opgelost door de volledige lijst op te halen in plaats van de
  sortering half te doen. De oplossing kost netwerk, maar de redenering klopt
  en staat opgeschreven.

## 7. Hoe het beter wordt

Achter `GESPREKKEN_V2`. Die vlag uit betekent: het bestaande scherm,
byte-identiek gedrag.

| Gat | Aanpak | Fase |
|---|---|---|
| G3 | aftelling op gegevens die er al zijn | 3 |
| G9 | verzendstatus per bericht tonen | 3 |
| G5 | filters op `iris_gesprekken` | 3 |
| G4 | toewijzing aan Maxim, Dave of Iris | 3 |
| G6 | mail aan het contact, niet aan de klant | 3 |
| G1 | microfoon overal waar tekst kan | 4 |
| G2 | ongedaan-venster van 30 seconden | 4 |
| G8 | paginering en trager pollen | 3 |
| G7 | IMAP `APPEND` naar Verzonden | 4 |
| G10 | `onboarding@` erbij in de lijst | 3 |

### Wat er niet gebeurt

- De aanmaanmotor wordt niet aangeraakt. Gebruikt Joost dezelfde verzendweg,
  dan verandert die weg niet van gedrag.
- Er verdwijnt geen bericht, geen gesprek en geen koppeling.
- Elke schemawijziging is additief; geen kolom verdwijnt zolang iets hem
  gebruikt.
- De oude weergave blijft, met één schakelaar terug.

## 8. Meten of het geholpen heeft

Na afloop opnieuw invullen, met de getallen uit sectie 4:

| Wat | Voor | Na |
|---|---|---|
| netwerk per uur per tabblad | ≈ 54 MB | *in te vullen* |
| klikken per antwoord binnen het venster | 4 | *in te vullen* |
| klikken per antwoord buiten het venster | 5 + een verrassing | *in te vullen* |
| is te zien hoeveel venster er nog is | nee | *in te vullen* |
| is te zien of een bericht aankwam | nee | *in te vullen* |
| is te zien wie het oppakt | nee | *in te vullen* |
| mail zichtbaar zonder klantkoppeling | nee | *in te vullen* |
