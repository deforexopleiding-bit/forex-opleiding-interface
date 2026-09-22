# GESPREKKEN_V2 — wat er af is, en wat nog niet

**Datum:** 22 september 2026
**Hoort bij:** [`02-gesprekken-audit.md`](02-gesprekken-audit.md)

De audit meet tien gaten en zet er een volgorde op. Dit document houdt bij
welke daarvan dicht zitten, achter welke schakelaar, en wat er nog ligt. Het
wordt bijgewerkt per PR, niet per goed voornemen.

---

## De schakelaar

Omgevingsvariabele **`GESPREKKEN_V2`**. Alles behalve een uitdrukkelijke
`true` is uit. Gelezen op één plek: `api/_lib/gesprekken-vlag.js`.

De stand reist mee met het antwoord van `inbox-conversations-list` — het
scherm haalt die lijst toch al op, dus er komt geen opvraging bij. Het scherm
tekent de nieuwe onderdelen alleen als:

1. dat antwoord `vlaggen.gesprekken_v2 === true` zegt, **en**
2. `modules/shared/gesprekken-v2.js` geladen is.

Die tweede voorwaarde is geen overdaad. Blijft dat script weg — script-tag
vergeten na een herschikking, netwerkfout, blokkade — dan valt het scherm terug
op de opmaak van hiervoor in plaats van halverwege een draad te struikelen over
een functie die er niet is.

**Aanzetten:** `GESPREKKEN_V2=true` in Vercel (alle omgevingen), opnieuw
uitrollen. **Terug:** de variabele weghalen of op `false` zetten, opnieuw
uitrollen. Geen migratie, geen databankwijziging, niets om terug te draaien.

Dat is werk voor Maxim; omgevingsvariabelen zet hij zelf.

---

## Wat er af is

### G3 — het venster telt af

**Was:** het scherm toonde "24u-venster is verlopen" op het moment dat het te
laat was. Hoeveel tijd er nog was, stond nergens. Je liep tegen een muur op het
moment dat je wilde gaan typen.

**Nu:** de badge in de gesprekskop leest `24u ✓ · nog 6u12`, en wordt amber
zodra er minder dan twee uur over is — terwijl het venster nog open is, want
dát is het moment waarop je er nog iets mee kunt.

De aftreksom staat in `vensterStand()` in `modules/shared/gesprekken-v2.js` en
rekent op `whatsapp_conversations.last_inbound_at`, dat al in het lijst-antwoord
meekwam. `inbox-thread-unified` stuurt het nu ook mee, zodat de kop niet van de
lijst-cache afhangt.

Drie randgevallen die de test vastlegt, omdat ze het verschil zijn tussen een
badge en een leugen:

- **niet bekend ≠ verlopen.** Een gesprek waar nooit iets binnenkwam heeft geen
  venster dat afgelopen is; daar staat de oude badge.
- **"<1m", nooit "0m".** Nul minuten leest als dicht terwijl het open is.
- **precies 24 uur is dicht** — gelijk aan wat de server rekent, zodat scherm en
  server nooit iets anders beweren.

### G9 — de verzendstatus is zichtbaar

**Was:** `whatsapp_messages` houdt `status`, `sent_at`, `delivered_at`,
`read_at` en `failed_reason` bij. Het scherm toonde er niets van, dus een
**mislukt** bericht zag er precies zo uit als een afgeleverd bericht. Van de
tien gaten het stilste en daarom het gemeenste: je denkt dat je geantwoord hebt.

**Nu:** onder elke uitgaande WhatsApp-bel staat een teken — `✓` verstuurd,
`✓✓` afgeleverd, `✓✓` in blauw gelezen, `⏳` onderweg. Bij een mislukt bericht
staat er `⚠` mét de reden uitgeschreven, niet alleen in een tooltip: een
waarschuwing die je moet aanwijzen om te lezen, lees je niet.

Twee keuzes die de moeite van het opschrijven waard zijn:

- **Geen status → geen teken.** Rijen van vóór de statusbijhouding krijgen
  niets. Een vinkje eronder zou een bewering zijn die we niet kunnen waarmaken.
- **Een onbekende status wordt zichtbaar** (`?` plus de ruwe waarde). Verzint
  Meta er morgen een bij, dan valt dat op in plaats van eruit te zien als
  afgeleverd — precies de fout die G9 is.

Mail en inkomende berichten krijgen geen teken; die hebben geen Meta-status.

### G10 — `onboarding@` staat in het Inbox-overzicht

Deze staat buiten de vlag, want er valt niets aan te zetten: het is een bron die
ontbrak.

**Was:** `inbox-v2.js` kende acht bronnen en twee daarvan waren postbussen —
`administratie@` en `info@`. `onboarding@` werd al elke vijf minuten opgehaald
door `sync-emails` en is in de E-mail-module gewoon te openen, maar wie het
Inbox-overzicht gebruikt als het bakje-waar-alles-in-komt, zag die postbus nooit.

**Nu:** `m_onb` staat in de rail, onder Klantcontact.

De bron erbij zetten was één regel; het werk zat in de regels eromheen. De
bronnenlijst stond in vijf opsommingen (registry, groepen, endpoints,
`_VALID_SRCS`, de staat) plus twee plekken die de e-mailbronnen bij naam noemden
(`v === 'm_adm' || v === 'm_info'`). Drie daarvan vergeten valt niet op: de bron
verschijnt gewoon, telt alleen verkeerd. `_VALID_SRCS` en de staat worden nu uit
de registry afgeleid, de teltakken vragen naar het **soort** bron, en een test
loopt de resterende opsommingen tegen elkaar na.

**Correctie op de audit.** Daar stond "`onboarding@` heeft geen scherm". Dat was
te sterk — de E-mail-module heeft alle zeven postbussen. Het gat was kleiner dan
opgeschreven, en dat staat nu ook zo in
[`02-gesprekken-audit.md`](02-gesprekken-audit.md).

### G5 (deels) — twee filters die nu al kunnen

**Was:** de gesprekslijst filtert op status en zoekterm. Waar je écht op wilt
filteren — wacht op ons · wacht op klant · venster bijna dicht · belofte vandaag
· niet gekoppeld — kon niet.

**Nu:** twee van de vijf, als een rij **Focus**-knoppen met een teller erop. Een
filter zonder getal moet je aanklikken om te weten of het iets oplevert, en dat
doe je dus niet — waarna het gat waar het filter voor bedoeld was gewoon blijft
bestaan. Nog eens klikken zet de stand weer uit.

Let op het verschil tussen de twee, want het is geen detail:

| Stand | Wat hij doet |
|---|---|
| **Venster bijna dicht** | *versmalt* de lijst die je al zag: minder dan twee uur over om vrije tekst te sturen. |
| **Niet gekoppeld** | *vervangt* hem, en toont juist wat je nooit zag. |

Een gesprek zonder klantkoppeling heeft geen openstaande facturen, dus
`is_debtor` is onwaar en de wanbetalerslijst laat 'em weg. Dat is geen fout in
die lijst — het is de reden dat zulke gesprekken ongezien blijven liggen. Een
filter dat binnen de bestaande selectie zoekt zou daarom altijd nul opleveren en
eruitzien alsof er niets aan de hand is.

Twee gevolgen die het opschrijven waard zijn:

- **Het zoeken gebeurt nu vóór de wanbetaler-poort** in plaats van erna. Voor de
  gewone lijst maakt dat niets uit (beide filters staan los van elkaar), maar
  zonder die volgorde zou een zoekterm in de stand "niet gekoppeld" niets doen.
- **De lege-lijst-tekst hoort bij de stand.** "Geen wanbetaler-gesprekken" onder
  een stand die juist buiten de wanbetalers kijkt, is ronduit verwarrend.

En één ding dat onderweg strakker werd: alle aanroepen van het hulpscript lopen
nu via `_gv2()`, dat het script teruggeeft óf niets. Daardoor staat
`window.GESPREKKEN_V2` in `wanbetalers-v2.js` op precies twee plekken, en is een
aanroep die de vlag omzeilt geen kwestie van goed lezen meer maar van een test
die omvalt.

### G8 (het pollen) — van ≈54 MB per uur naar ≈7

**Was:** de gesprekslijst werd elke **zes seconden** volledig opnieuw opgehaald.
Het endpoint rekent zelf voor wat dat kost — bij 115 gesprekken ongeveer 90 KB
per opvraging. Dat is 900 KB per minuut, **54 MB per uur**, 430 MB per werkdag
per geopend tabblad; bij twee mensen het dubbele. En dat terwijl er in een rustig
uur misschien drie berichten binnenkomen.

Er was óók al een realtime-kanaal op `whatsapp_messages`. De poll is het
vangnet, maar draaide onvoorwaardelijk mee — of dat kanaal nu werkte of niet.
Daar zit de winst: als het vangnet weet dat er iemand anders oplet, hoeft het
niet om de zes seconden te kijken.

**Nu:** vier standen.

| Stand | Interval | Per uur |
|---|---|---|
| tabblad verborgen | niet pollen | 0 |
| kanaal **bewezen** | 45 s | ≈ 7 MB |
| kanaal verbonden, **onbewezen** | 20 s | ≈ 16 MB |
| geen kanaal | 6 s | ≈ 54 MB (zoals het was) |

**Waarom drie standen en niet twee.** "Kanaal verbonden" en "kanaal werkt" zijn
niet hetzelfde: een abonnement kan keurig `SUBSCRIBED` melden terwijl RLS elk
bericht wegfiltert. Dan komt er nooit iets binnen en zou een trage poll betekenen
dat je berichten drie kwartier te laat ziet. Er is geen manier om dat vooraf te
weten, dus verdient het kanaal zijn vertrouwen: verbonden levert een matige
versnelling op, en pas na één echt bezorgd bericht gaat de poll naar 45 s.
Bewijs boven belofte. Valt het kanaal weg, dan gaan beide vlaggen uit en staat
het vangnet meteen weer op zes seconden.

Twee dingen die onderweg bleken:

- **`CLOSED` en `TIMED_OUT` vielen stil.** De oude code keek alleen naar
  `CHANNEL_ERROR`. Nu telt alles wat niet `SUBSCRIBED` is als "het vangnet is
  weer alleen" — anders blijft de poll traag terwijl er niemand meer oplet.
- **Een verborgen tabblad pollt niet**, dus bij terugkomen is de lijst zo oud als
  je weg was. Daarom haalt hij één keer op zodra iemand weer kijkt: dát is
  precies wanneer het uitmaakt.

De timer zelf blijft elke zes seconden tikken (dat kost niets); alleen het
*besluit* om op te halen is verplaatst naar `magOphalen()`. Het interval
opnieuw opbouwen bij elke kanaalwissel is namelijk precies hoe je twee timers
naast elkaar krijgt zonder het te weten.

Wat G8 nog niet doet: **paginering**. De lijst haalt nog altijd `limit=1000` in
één keer op, en de draad 200 berichten per gespreksklik. Dat is een grotere
ingreep in het endpoint en staat los van het pollen.

### G2 — een ongedaan-venster van dertig seconden

**Was:** `__wbxInboxSend()` riep meteen `inbox-send` aan. Verstuurd is weg. Eén
verkeerde klik naar een boze klant is onherstelbaar, en het is precies bij boze
klanten dat je het snelst verkeerd klikt.

**Nu:** je klikt, de schrijfbalk verandert in een teller — *"Gaat weg over 30s"*
— met **Toch niet** en **Nu versturen**. Terughalen zet je tekst terug in het
veld, want negen van de tien keer wil je 'm aanpassen en niet weggooien.

**De bevestiging vooraf verdwijnt daarmee**, en dat is geen versoepeling maar
het omgekeerde. Een "weet je het zeker?" vraagt iets op het moment dat je het
antwoord al hebt bedacht: ja, natuurlijk, daarom klik ik. Na de derde keer lees
je 'm niet meer. Het ongedaan-venster grijpt in op het moment dat het inzicht
kómt — één seconde later, als je je eigen zin ziet staan. Bijkomend: het scheelt
een klik per antwoord, en de audit telde er vier.

#### De beperking, en waarom hij de goede kant op valt

Het wachten gebeurt **in het scherm**, niet op de server. Sluit je het tabblad
binnen die dertig seconden, dan vertrekt het bericht niet. De balk zegt dat er
zelf bij, en bij het wegklikken vraagt de browser om bevestiging.

Dat is een echte beperking. Hij valt alleen de goede kant op: er gaat niets
ongewild wég. Het alternatief — de verzending op de server parkeren — vraagt een
tabel, een cron en een ingreep in de verzendweg die Joost deelt. Dat is een
aparte beslissing en een aparte PR; deze versie lost het geval op waar de klacht
over ging (je klikt, je ziet het, je haalt het terug) zonder één regel aan die
verzendweg te veranderen.

Eén bericht tegelijk: zolang er eentje aftelt, staat de schrijfbalk op de teller.
Een tweede beginnen terwijl de eerste nog terug kan, maakt van "welke haal ik
terug?" een raadsel.

---

## Wat er nog ligt

Ongewijzigd ten opzichte van de tabel in de audit, minus de twee hierboven.

| Gat | Wat | Waarom het nog niet af is |
|---|---|---|
| G1 | microfoon in de gesprekken-module | Iris heeft er een (via de browser); de gesprekken-module zelf nog niet |
| G2 | het uitstel op de SERVER parkeren | de huidige versie wacht in het scherm; zie hieronder |
| G4 | toewijzing aan Maxim, Dave of Iris | heeft `iris_gesprekken` nodig |
| G5 | de drie overige filters | wacht op ons · wacht op klant · belofte vandaag — die hebben de toestand per gesprek uit G4 nodig |
| G6 | mail aan het contact, niet aan de klant | raakt `inbox-thread-unified` dieper |
| G7 | IMAP `APPEND` naar Verzonden | raakt `send-email.js` |
| G8 | paginering | het pollen is gedaan (zie hierboven); de lijst haalt nog altijd `limit=1000` in één keer op |

---

## Meten of het geholpen heeft

De tabel in sectie 8 van de audit blijft openstaan tot de vlag op productie
aanstaat. Twee regels kunnen dan meteen ingevuld:

| Wat | Voor | Na |
|---|---|---|
| is te zien hoeveel venster er nog is | nee | **ja** |
| is te zien of een bericht aankwam | nee | **ja** |
| netwerk per uur per tabblad | ≈ 54 MB | **≈ 7 MB** met een bewezen kanaal, ≈ 16 MB zonder, 0 bij een verborgen tabblad |

Het netwerkgetal is een rekensom op de gekozen intervallen en de 90 KB die het
endpoint zelf noemt, niet een meting op productie. Dat laatste kan pas als de
vlag aanstaat — in het netwerkpaneel, met het scherm een uur open.

De klikken per antwoord veranderen pas met G1 (microfoon) en G2 (ongedaan).
