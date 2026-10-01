# Iris — verbeterplan

**28 september 2026.** Wat er mis is met Iris zoals ze nu staat, wat eraan moet
gebeuren, en in welke volgorde.

Dit stuk is geschreven na het doorlopen van elk tabblad met één vraag voorop:
*wat wil Maxim of Dave hier op een drukke ochtend, en hoeveel staat er tussen
hem en het antwoord?* Elke bewering hieronder is terug te voeren op een regel
code of een gemeten getal. Waar ik iets niet heb kunnen nakijken, staat dat er
met zoveel woorden bij.

> **Wat ik niet heb kunnen meten.** Deze sessie heeft geen toegang tot de
> CRM-database (de Supabase-koppeling wijst naar een ander project). Ik kon dus
> niet in `iris_opdrachten` kijken wat er letterlijk in Maxims ene opdracht
> staat. Wat hieronder over die opdracht staat, is afgeleid uit de code die hem
> schrijft en toont — en die code is eenduidig genoeg om de conclusie te dragen.
> Eén ding blijft daardoor open, en dat staat bij **O-1** aangegeven.

---

## De kern, in drie zinnen

Iris **weet** meer dan ze **laat zien**. Het datamodel legt een plan vast, een
verloop van wie wat deed, een resultaat per stap — en het scherm toont daar
vrijwel niets van. Daarnaast toont ze op twee plekken iets dat niet waar is (een
WhatsApp-venster op een mail, spam in je werkbakje), en dat is erger dan te
weinig tonen: verkeerde informatie kost je vertrouwen in alles wat er verder
staat.

---

## Post

De eerste vraag op een drukke ochtend is: **wat moet ik nú beantwoorden?**

### P-1 · Een mail krijgt een WhatsApp-venster — en het filter trapt er ook in

Een mail van Andy's advocaat draagt de badge *"venster open nog 23u34"*. Dat
venster bestaat niet voor mail. Het servicevenster van 24 uur is een regel van
Meta over WhatsApp; op een mailbericht slaat het nergens op.

Dat is niet alleen cosmetisch:

| Waar | Wat er gebeurt |
|---|---|
| `modules/iris/iris.js` → `lijstRij()` | `vensterMerk(r.venster)` staat er onvoorwaardelijk, zonder naar `r.kanaal` te kijken |
| `api/iris-post.js` regel 67 | `vensterStand(...)` wordt voor **elke** rij berekend, ook voor `kanaal='email'` |
| `api/iris-post.js` regel 202 | het filter `venster_bijna_dicht` filtert daar óók op |

Die laatste is de gemene. Een **mailgesprek kan onder "venster bijna dicht"
verschijnen** en daarmee een WhatsApp-gesprek wegdrukken dat echt bijna dicht
is. Het filter dat bedoeld is om je te laten zien waar de tijd dringt, laat je
dan precies het verkeerde zien.

**Oplossing.** Het venster hoort bij WhatsApp en nergens anders. Server: geen
venster berekenen voor mail, en het filter `venster_bijna_dicht` alleen op
WhatsApp-rijen toepassen. Scherm: het merkteken alleen tonen als het kanaal
WhatsApp is. Mail krijgt in plaats daarvan wat er voor mail wél toe doet: hoe
lang het al ligt.

### P-2 · Iris herkent spam en zet hem daarna in je werkbakje

`spam` is een echte categorie — *"reclame, phishing, onzin"* — en
`templates.js` geeft er terecht geen enkele antwoordsjabloon voor. Iris ziet dus
prima dat "Meta for Business" geen klant is.

En dan zet `cron-iris-werk` de status alsnog op `wacht_op_ons`, want dat doet
hij voor **elk** geclassificeerd inkomend bericht, ongeacht de categorie.

Daarmee is het verschil tussen een triage-hulp en gewoon een tweede inbox
precies één regel code. Nu is het een tweede inbox.

**Oplossing.** Categorieën die geen mens nodig hebben (spam, en wat daar verder
onder valt) gaan niet naar `wacht_op_ons`. Ze verdwijnen niet — ze krijgen hun
eigen stand, zodat je ze kunt nakijken als je wilt, maar ze staan niet meer
tussen het werk. Verkeerd ingedeeld? Eén klik terug, en dat is meteen de plek
waar Iris leert dat ze het mis had.

### P-3 · Een smalle lijst met veel leegte ernaast

Staat er geen gesprek open, dan is de middelste kolom leeg en de rechter ook.
Twee derde van het scherm doet niets, terwijl de lijst — het enige dat er wél
staat — samengeperst is tot 260–320 px.

De rasterindeling is `minmax(260px,320px) minmax(420px,1fr) minmax(260px,320px)`
en die geldt ook als er niets te tonen is in kolom twee en drie.

**Oplossing.** Geen gesprek gekozen? Dan is de lijst het scherm: breed, met
ruimte voor de samenvatting die Iris toch al heeft geschreven. Zodra je iets
kiest, schuift hij terug naar de smalle kolom en komt de draad ernaast. Dat is
dezelfde beweging die elk mailprogramma maakt, en de reden dat die beweging
bestaat is precies deze.

### P-4 · 318 dingen in stapeltjes van vijftig

`STANDAARD_LIMIET = 50`, en bladeren doe je met `vanaf`. Bij 318 items zijn dat
zeven keer klikken om te weten of er onderaan nog iets ligt — en niemand doet
dat zeven keer.

**Oplossing.** Dit is geen paginering-probleem maar een sorteer-probleem. Wat
onderaan ligt zou je niet moeten hoeven zoeken: als het belangrijk is, hoort het
bovenaan. Doorlopend laden in plaats van pagina's, en daarbovenop een ordening
die zegt wat er als eerste moet gebeuren in plaats van alleen wat het laatst
binnenkwam.

---

## Opdrachten

De eerste vraag hier is: **wat kan ik haar eigenlijk vragen?** En de tweede:
**heeft ze het gedaan?** Op allebei geeft het scherm op dit moment geen antwoord.

### O-1 · Je ziet niet wat Iris gedaan heeft

Maxims enige opdracht — *"Taak aanmaken: opvolging mail Andy's advocaat"*, met
de vraag om bij te houden of er gereageerd wordt en hem te verwittigen als dat
uitblijft — staat op **Geregeld**, en klap je hem open dan staat er het woord
"geregeld" en een knop "Terug openen". Meer niet.

Dat is niet omdat er niets is. Het is omdat het scherm het niet ophaalt:

| Wat er vastligt | Waar | Wordt het getoond? |
|---|---|---|
| `plan` (jsonb) | `iris_opdrachten.plan`, gevuld door `iris-opdracht.js` | **nee** — het scherm rendert `acties`, niet `o.plan` |
| `verloop` (jsonb) | elke overgang schrijft een regel: *opdracht gegeven*, *plan gemaakt*, *beantwoord*, *afgesloten* | **nee** — nergens gerenderd |
| `resultaat` per stap | `iris_acties.resultaat`, bevat o.a. `{taak_id}` | **nee** |
| `fout` per stap | `iris_acties.fout` | ja |

En het woord "geregeld" dat er wél staat, is `o.na_uitvoeren` — een
enum-waarde (`'wacht'` of `'geregeld'`) die cursief wordt afgedrukt alsof het
een zin is.

Het plan-blok hangt bovendien aan `acties.length`. Zijn er geen `iris_acties`
aangemaakt, dan valt het hele blok weg en houd je precies over wat Maxim zag.

> **Wat hier open blijft.** Zonder databasetoegang kan ik niet zien óf er voor
> deze opdracht een `iris_acties`-rij bestaat. Twee mogelijkheden: er is er geen
> (dan is het plan-blok terecht leeg en is het probleem dat `plan` en `verloop`
> niet getoond worden), of er is er wel een (dan is het probleem dat de rij niet
> mee opgehaald wordt). **Eén query beantwoordt dat**, en die staat onderaan dit
> stuk klaar. De oplossing hieronder dekt allebei de gevallen.

**Oplossing.** Het detail van een opdracht toont: het plan in gewone taal, het
verloop als tijdlijn, en per stap wat eruit kwam — inclusief een link naar wat
er is aangemaakt. Ook ná "Geregeld", want dat is juist het moment waarop je wilt
kunnen nakijken wát er geregeld is. En `na_uitvoeren` wordt een zin in plaats
van een enum-woord.

### O-2 · "Verwittig me als er geen reactie komt" bestaat niet

Dit is het belangrijkste dat ik gevonden heb, want hier deed Iris iets anders
dan waar om gevraagd werd.

`taak_aanmaken` doet dit, en niets meer:

```js
.from('pending_actions').insert({
  action_type: 'MANUAL_FOLLOWUP',
  status: 'PENDING',
  payload: { source: 'iris', iris_actie_id: …, omschrijving: … },
})
```

Eén regel met een omschrijving. **Geen datum, geen bewaking, geen bericht.**

Maxim vroeg om drie dingen: hou bij of er gereageerd wordt · verwittig me · als
het binnen een paar dagen uitblijft. Daarvan is er nul gebeurd. Er is een
to-do-regel aangemaakt in een module waar hij niet werkt.

Het dichtste dat er bestaat is `pending-actions-stale-list`: een read-only
widget dat handmatige acties toont die langer dan drie dagen open staan. Dat
widget hangt in **Wanbetalers → Acties**, telt ouderdom vanaf `created_at`, en
kijkt niet of er iets binnengekomen is. Het stuurt ook niets; je moet er zelf
gaan kijken.

**Oplossing.** Een opvolging is een eigen ding, en het goede nieuws is dat de
tabel er al op voorbereid is: `pending_actions` heeft `scheduled_for`. Wat
ontbreekt is de bewaking en het bericht.

Concreet: een opvolging legt vast *waarop* gewacht wordt (dit gesprek, dit
mailadres), *tot wanneer*, en *wie* er bericht krijgt. Een cron kijkt dagelijks
of er sindsdien iets binnengekomen is op dat spoor. Zo ja: de opvolging sluit
zichzelf en zegt dat erbij. Zo nee, en de termijn is om: Maxim krijgt bericht,
met de link naar het gesprek erbij.

Dat is geen nieuw product; het is de bestaande tabel plus een datum, een cron en
een melding.

### O-3 · Een leeg vak zonder te weten wat je erin mag zeggen

Het invoerveld heeft één voorbeeld in de placeholder en verder niets. Wat Iris
kan, staat wél ergens — in `_lib/iris/opdracht.js` staat de lijst met tien
staptypes, netjes uitgeschreven — maar die lijst gaat naar het taalmodel en niet
naar de mens die ervoor zit.

Dat is de verkeerde kant op. Het model wéét wat het kan; jij moet het raden.

Nog scherper: van die tien staptypes zijn er vijf die bij uitvoering een fout
gooien (*"nog niet ingebouwd"*, *"versturen loopt via de Post"*). Vraag je iets
dat daarop uitkomt, dan ontdek je dat pas ná het plan.

**Oplossing.** Onder het invoerveld een handvol knoppen met wat Iris
daadwerkelijk kán — niet alle tien, maar de paar die werken en die je vaak
nodig hebt. Klikken vult het veld met een halve zin die je afmaakt. En de
staptypes die nog niet bestaan, worden niet voorgesteld in plaats van te falen
bij het uitvoeren.

---

## Belrij

Deze tab is de beste van de zes, en dat is leerzaam: hij toont per rij hoe vaak
er al geprobeerd is, of iemand vandaag al aan de beurt geweest is
(*"vandaag geweest"* — precies het gegeven dat een dubbel telefoontje
voorkomt), en of er geëscaleerd moet worden, met de reden in de tooltip.

**B-1 · De drempel staat er als losse zin.** *"Escaleren na X pogingen in Y
dagen"* staat in de kop, maar bij een rij die daar nog niet is zie je niet hoe
ver hij is. "2 van 3 pogingen" zegt meer dan een regel die je zelf moet
toepassen.

**B-2 · Bellen zelf gebeurt ergens anders.** De lijst is een lijst; het nummer
moet je overnemen. Een belknop die de softphone opent scheelt per telefoontje
een handeling en een kans op een typefout.

---

## Dossiers · Instellingen · Logboek

Deze drie zijn geen dagelijkse tabs, en dat is prima — ze hoeven niet te
schitteren. Twee dingen vallen wel op.

**D-1 · Het logboek is een logboek en geen antwoord.** Waar je 's ochtends mee
zit is *"heeft Iris vannacht iets gedaan dat ik moet weten?"*. Een chronologisch
logboek dwingt je dat zelf te concluderen.

**D-2 · Instellingen toont een droogtest, en dat is goed.** Die droogtest
(*"69 berichten over 7 dagen"*) is precies het soort antwoord dat de rest van
Iris mist: een getal waar je iets aan hebt in plaats van een lijst waar je
doorheen moet. Dat patroon hoort vaker terug te komen.

---

## De layout

Iris heeft nu per tab een eigen indeling. Dat is precies waarom je bij elke tab
opnieuw moet zoeken waar iets staat.

### Vaste structuur

Elke tab, zonder uitzondering:

```
┌──────────────────────────────────────────────┐
│  Wat er nú moet gebeuren        (één regel)  │  ← alleen als er iets is
├──────────────────────────────────────────────┤
│  Filters                          (één rij)  │
├────────────────┬─────────────────────────────┤
│  De lijst      │  Wat je gekozen hebt        │
│                │                             │
│  breed als er  │  leeg tot je kiest —        │
│  niets gekozen │  en dan neemt hij de ruimte │
│  is            │                             │
└────────────────┴─────────────────────────────┘
```

Drie regels die dat ordenen:

1. **De ruimte volgt de aandacht.** Niets gekozen → de lijst krijgt het scherm.
   Wel iets gekozen → de lijst wordt smal, het gekozene krijgt de ruimte. Geen
   kolom die leeg staat te zijn omdat de indeling het zo wil.
2. **Eén ding schreeuwt, en alleen als het schreeuwen waard is.** De
   bovenste regel is voor wat actie vraagt — een venster dat bijna dichtgaat,
   een opvolging die verlopen is. Is er niets, dan is die regel er ook niet. Een
   balk die er altijd staat, lees je na twee dagen niet meer.
3. **Een getal boven een lijst.** Overal waar nu een lijst staat waar je
   doorheen moet, hoort er eerst te staan hoe groot het is en wat ervan dringt.
   Het droogtest-patroon uit Instellingen, maar dan overal.

### Wat er nadrukkelijk niet komt

Geen kleurcodes die je moet leren. Geen tweede navigatielaag. Geen
uitklapmenu's voor iets dat in één rij past. Alles wat je moet onthouden om het
scherm te kunnen lezen, is een ontwerpfout.

---

## De PR-lijst

Op volgorde van wat het meest oplevert per hoeveelheid werk. Elke PR staat
achter de bestaande preview (Iris staat niet in het menu) en heeft eigen tests.

| # | Wat | Waarom eerst | Omvang |
|---|---|---|---|
| **1** | **P-1 venster alleen bij WhatsApp** (scherm + server + filter) | Het scherm liegt nu, en het filter geeft verkeerde uitkomsten. Alles wat je daarna bouwt staat op dat vertrouwen. | klein |
| **2** | **P-2 spam niet in "wacht op ons"** | Eén regel in de cron, en je werkbakje wordt weer een werkbakje. | klein |
| **3** | **O-1 plan, verloop en resultaat tonen** | De gegevens liggen er al; dit is alleen ophalen en tonen. Grootste winst voor het minste werk. | midden |
| **4** | **O-3 voorbeelden en snelknoppen** | Zonder dit weet niemand wat Iris kan, en blijft de tab leeg — hoe goed de rest ook wordt. | klein |
| **5** | **O-2 opvolging die echt opvolgt** | Het zwaarste en het belangrijkste: hier deed Iris iets anders dan gevraagd. Vereist een migratie. | groot |
| **6** | **P-3 + layout: ruimte volgt de aandacht** | Raakt elke tab, dus beter ná de inhoudelijke fixes zodat het één keer goed gaat. | midden |
| **7** | **P-4 doorlopend laden + ordening op wat dringt** | Pas zinvol als de ordening klopt; anders laad je sneller de verkeerde volgorde. | midden |
| **8** | **B-1 + B-2 belrij: voortgang en een belknop** | Kleine winst op een tab die al werkt. | klein |
| **9** | **D-1 logboek wordt een ochtendantwoord** | Fijn, niet dringend. | midden |

**PR 5 vraagt een migratie** (een opvolging heeft een spoor en een termijn
nodig). Die zet ik klaar met een controle vooraf en achteraf, zoals afgesproken.

---

## Eén query die nog openstaat

Voor **O-1** wil ik weten of er voor Maxims opdracht een `iris_acties`-rij
bestaat. Dat verandert niets aan wat er gebouwd moet worden, maar wel aan wat ik
erover opschrijf:

```sql
select o.id, o.status, o.na_uitvoeren,
       jsonb_array_length(o.plan)    as stappen_in_plan,
       jsonb_array_length(o.verloop) as regels_in_verloop,
       (select count(*) from iris_acties a where a.opdracht_id = o.id) as acties
from iris_opdrachten o
order by o.aangemaakt_op desc
limit 5;
```

Draai je die, dan vul ik het antwoord hier in.
