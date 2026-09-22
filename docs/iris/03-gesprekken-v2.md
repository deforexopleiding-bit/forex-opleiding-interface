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

### G6 — mail bij een gesprek dat nog geen klant heeft

**Was:** `inbox-thread-unified` haalde de mail op met `.eq('customer_id', …)`.
Geen klantkoppeling betekende dus: geen mail in de draad.

Dat is omgekeerd aan wat je nodig hebt. Juist bij een gesprek dat nog niet
gekoppeld is, wil je álle context die er is — misschien staat in een mail van
vorige week precies wie dit is. Je kreeg een kale WhatsApp-draad en mocht zelf
gaan zoeken, en dat is het moment waarop mensen het opgeven.

**Nu:** is er geen klant, dan loopt de draad langs **`iris_contacten`** — één
rij per persoon, met zijn adressen én zijn nummers, ook zonder klant. Precies
waar die tabel voor gemaakt is, en wat de audit zelf voorschrijft.

Dat is een afhankelijkheid van Iris, en die is bewust. Draait Iris niet, dan
vindt de omweg niets en blijft de draad zoals hij was: geen fout, geen melding,
alleen niets extra's.

Drie randen die vastliggen in tests, want daar kan deze brug de **verkeerde**
mail in een draad zetten — erger dan geen mail:

- **Twee contacten op hetzelfde nummer levert er geen op.** Dat hoort niet te
  kunnen; gebeurt het toch, dan kiezen we er geen.
- **Een adres met een komma komt er niet door.** Een komma hakt de
  `or()`-reeks van PostgREST in tweeën, en dan zoekt de opvraging iets anders
  dan bedoeld. Zelfde les als in `_lib/iris/zoekfilter.js`.
- **Nooit met een lege filter zoeken.** Een lege `or()` is een opvraging
  *zonder* filter, en die geeft alle mail van iedereen terug.

Met een klant blijft de bestaande weg staan: die kijkt naar wat er aan de
*klant* hangt, en dat is meer dan wat er aan één persoon hangt.

> **Terzijde, en het opschrijven waard.** `iris_contacten.telefoons` bevat
> alleen cijfers, zonder plus — `normaliseerTelefoon()` is `stripToDigits`. Het
> commentaar bij die kolom in de migratie zegt "E.164 met een plus ervoor" en
> dat klopt dus niet. Wie daarop afgaat zoekt op `+32…`, vindt niets, en
> concludeert ten onrechte dat er geen contact is. Staat nu als waarschuwing bij
> de functie die de rijen vult.

### G7 — je eigen antwoord terugzien in je mailbox

`send-email.js` verstuurde via Strato's SMTP en schreef een regel in
`email_replies`. Meer niet. Strato zet uitgaande mail **nergens in de mailbox
zelf** neer, dus wie in Thunderbird kijkt of op zijn telefoon, ziet zijn eigen
antwoord niet staan.

Dat is niet alleen onhandig. Het is de directe aanleiding voor een tweede
antwoord op dezelfde mail — door dezelfde persoon een dag later, of door een
collega — omdat niets laat zien dat er al geantwoord is.

Iris deed dit al voor haar eigen verzendingen. Dit is dezelfde beweging voor de
knop waar een mens op drukt.

**De kopie wordt niet opnieuw opgebouwd.** De verleiding is om, zoals Iris doet,
een eenvoudig platte-tekstbericht in elkaar te zetten. Dat kan hier niet: deze
mail kan opmaak hebben, kopieontvangers, en bijlagen. Een kopie die de bijlage
kwijt is, is erger dan geen kopie — dan zie je in Verzonden staan dát je
geantwoord hebt, en neem je aan dat het contract meeging.

Daarom bouwt `_lib/gesprekken-verzondenkopie.js` de kopie met dezelfde opsteller
die de verzending gebruikt (nodemailer), uit exact dezelfde opdracht. Wat de
klant kreeg en wat er in Verzonden komt, is hetzelfde bericht — tot en met het
`Message-ID`, zodat een mailprogramma de kopie aan de draad hangt in plaats van
er een los bericht naast te zetten.

Drie dingen liggen vast in tests, want dit zijn de manieren waarop een kopie
kan liegen over wat je verstuurd hebt:

- **Opmaak, kopieontvanger en bijlage blijven mee.**
- **Het `Message-ID` gaat mee.** Zonder dat krijgt de kopie een nieuw id en
  staat hij als tweede, losstaand bericht naast het origineel.
- **De regeleindes worden rechtgetrokken.** nodemailer zet de kopregels op
  CRLF maar laat de *tekst* staan zoals hij binnenkwam, en die komt uit een
  webformulier — dus met kale LF's. Bij het versturen is dat onzichtbaar, want
  de SMTP-laag trekt het alsnog recht. Bij een `APPEND` doet niemand dat: daar
  gaan de bytes er precies zo in als wij ze aanleveren. Een strenge server
  weigert het bericht dan, een minder strenge bewaart een kopie die als één
  lange regel oogt. Dit is de enige van de drie die de test hier heeft gevonden
  en niet het ontwerp.

Een blinde kopieontvanger blijft in *onze* kopie wél staan. De echte verzending
haalt die kopregel eruit — anders zien de ontvangers wie er meelas — maar deze
bytes gaan alleen naar onze eigen map Verzonden, en daar wil je later juist
kunnen terugzien wie je meegestuurd hebt.

**Er wordt niet op gewacht.** De mail is weg op het moment dat de kopie begint;
een IMAP-verbinding kost een paar seconden waar de gebruiker anders op staat te
wachten voor iets dat aan zijn verzending niets meer verandert. `waitUntil()`
houdt de functie in leven tot de kopie er staat. Mislukken doet hij stil, maar
niet ongemerkt: de reden komt in de logs, met alleen de *naam* van wat ontbreekt.

> **Let op bij het aanzetten.** Dit endpoint bedient ook de e-mailmodule en de
> events-module. Met `GESPREKKEN_V2` aan krijgen die er dus net zo goed een
> kopie bij. Dat is gewenst — het gat zit daar even hard — maar het is meer dan
> alleen "de gesprekken", en dat hoor je te weten voordat je de vlag omzet.

### G8 (de rest) — het gesprek in bladzijden

De draad toonde de laatste 200 berichten. Twee dingen waren daar mis mee, en ze
waren allebei stil.

**Het werk groeide mee met de geschiedenis.** Het endpoint haalde *alle*
WhatsApp-berichten van een gesprek op, plus alle mail van de klant, voegde die
samen, en gooide daarna alles weg behalve de laatste 200. Dat werkt tot het niet
meer werkt — en dan is het een tijdslimiet op het gesprek met precies die klant
met wie je het meest gepraat hebt.

**Wat je niet kreeg, zag je niet.** Het endpoint meldde al hoeveel er waren
(`counts.total`) tegenover hoeveel het teruggaf (`counts.returned`), maar het
scherm deed daar niets mee. Je las een gesprek dat halverwege begon zonder dat
iets dat zei.

**Nu** haalt elke bron — WhatsApp, mail en onze eigen antwoorden, langs het
klant-pad én langs het contact-pad uit G6 — de **nieuwste** rijen op, één meer
dan er getoond wordt, en draait die om. Die ene extra rij is het hele antwoord
op "is er nog meer?", zonder een tweede opvraging die alleen maar telt. Per bron
n+1 halen en dan samenvoegen geeft gegarandeerd de juiste nieuwste n.

`heeft_meer` en `oudste_at` komen mee in de respons; doorvragen gaat met
`?voor=<tijdstempel>`.

**De grens is kleiner-of-gelijk, niet kleiner.** Bij mail is de tijdstempel op
de seconde nauwkeurig, dus twee berichten in dezelfde seconde is geen bedenksel
— en met "kleiner dan" zou zo'n bericht op de bladzijdegrens verdwijnen zonder
dat iemand het merkt. Liever één bericht dubbel ophalen en het in het scherm
eruit halen (`nieuweDraadItems()`, op kanaal + id, want een WhatsApp-bericht en
een mail komen uit verschillende tabellen en hun id's zeggen niets over elkaar).

In het scherm staat boven de draad **"↑ Toon oudere berichten"**, achter de
vlag, en alleen als er echt meer is — een knop die niets oplevert is erger dan
geen knop. Twee dingen die die knop goed moet doen:

1. **Niet naar beneden springen.** Er komt inhoud *boven* je te staan, dus de
   plek waar je las schuift weg. De gewone repaint springt omlaag zodra er
   berichten bij zijn; dat klopt bij een nieuw binnengekomen bericht en is hier
   precies verkeerd. Er is daarom een eigen repaint die meet hoeveel hoger de
   draad is geworden en de schuifbalk evenveel meeschuift.
2. **Stoppen als er niets bij komt.** Levert een bladzijde alleen berichten op
   die we al hadden, dan komen we niet verder — dan gaat de knop weg in plaats
   van eindeloos hetzelfde op te halen.

> **Let op bij `counts`.** Die tellen nu wat er in *deze* bladzijde zit, niet
> wat er in totaal bestaat. Voor "is er meer" is `heeft_meer` het antwoord. Een
> telling van alles zou een tweede opvraging kosten die niemand gebruikt.

### G5 (de rest) — wacht op ons · wacht op klant · belofte vandaag

De drie filters die er nog niet waren. Ze hoefden **geen** nieuwe tabel: de
gegevens lagen er al en werden alleen niet gelezen.

- `iris_gesprekken.status` — `cron-iris-werk` zet `wacht_op_ons` zodra er iets
  binnenkomt, `iris-verstuur` zet `wacht_op_klant` zodra Iris iets stuurt.
- `iris_beloftes` — een toezegging met een datum, status `actief`.

**Wat er wél moest gebeuren, en waarom het filter zonder dat onbruikbaar was.**
`wacht_op_klant` werd alleen door *Iris* gezet. Antwoordde een mens vanuit dit
scherm, dan bleef het gesprek op `wacht_op_ons` staan. Het filter "wacht op ons"
zou dus gesprekken blijven tonen die je net beantwoord hebt — en een filter dat
je eigen werk niet ziet, leer je binnen een dag te negeren. `inbox-send` zet die
stand nu ook, faalzacht (het bericht is op dat moment al bij Meta) en nooit over
een stand heen die een mens bewust koos: `geregeld` en een lopende belofte
blijven staan.

**"Belofte vandaag" leunt op de beloftes zelf, niet op de status
`belofte_loopt`.** Die status staat wel in de tabel maar wordt door niets gezet;
een filter daarop zou altijd leeg zijn, en dat leert je binnen een dag dat het
scherm niet klopt.

**Vandaag is de lokale dag.** Met `toISOString()` zou een toezegging voor morgen
er om half elf 's avonds al als "vandaag" uitzien. Dat is de off-by-one waar dit
project eerder op stukliep; hier zou hij een belofte een dag te vroeg laten
oplichten.

**De opvraging gaat in blokken van 150.** De lijst kan tot 1000 gesprekken
teruggeven, en een `.in()` met 1000 sleutels van ruim veertig tekens wordt een
URL van tientallen kilobytes — die knapt ergens tussen PostgREST en de proxy,
niet met een nette fout maar met een lege lijst of een 414. Bij de 115
gesprekken van vandaag is het gewoon één blok.

Lukt de hele omweg niet, dan krijgt elke regel géén werkstand en toont de lijst
wat hij altijd toonde. Uitdrukkelijk in zijn geheel: een halve uitkomst zou
erger zijn, want dan verbergt een filter een gesprek omdat het toevallig in het
blok zat dat misging. Om dezelfde reden krijgt een gesprek dat Iris nog niet
gezien heeft `null` als stand en niet `nieuw` — niet-weten is geen status.

---

## Wat er nog ligt

Ongewijzigd ten opzichte van de tabel in de audit, minus wat hierboven staat.

| Gat | Wat | Waarom het nog niet af is |
|---|---|---|
| G1 | microfoon in de gesprekken-module | Iris heeft er een (via de browser); de gesprekken-module zelf nog niet |
| G2 | het uitstel op de SERVER parkeren | de huidige versie wacht in het scherm; zie hieronder |
| G4 | toewijzing aan Maxim, Dave of Iris | `iris_gesprekken.toegewezen_aan` bestaat al en wordt nu al meegestuurd met de lijst; wat ontbreekt is het tonen en het zetten |
| G8 | paginering van de LIJST | de draad is gedaan (zie hierboven); de gesprekslijst haalt nog altijd `limit=1000` in één keer op, en waarschuwt daar zelf voor met `capOverflowWarning` |

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
