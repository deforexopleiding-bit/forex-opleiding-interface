# WhatsApp-brug

## ⚠ Lees eerst welke versie er écht draait

`package.json` zegt `^1.26.0`. Op de VPS stond **1.34.7**, en dat verschil heeft
vier ronden gekost.

In 1.26.0 wordt de interne opslag van whatsapp-web.js blootgesteld als
`window.Store`. In 1.34.7 bestaat die global niet meer — alles hangt onder
`window.WWebJS`, met daar zelfs een functie `enforceLidAndPnRetrieval` die
precies doet wat wij zaten te zoeken. Elke poging die op `window.Store` bouwde
was dus kansloos, en gaf `null` terug op een manier die niet te onderscheiden was
van 'gevraagd, niets gevonden'.

**Twee regels die daaruit volgen:**

1. **Bouw nooit op een interne API zonder eerst te lezen wat er geïnstalleerd
   is.** Niet wat `package.json` toestaat — wat er staat. De brug rapporteert
   haar eigen versie in `/status` (`lid_kunde.bibliotheek`) en logt hem bij het
   verbinden; begin daar.
2. **Gebruik de publieke API zolang die het kan.** `client.getNumberId()`,
   `client.getChatById()`, `client.getChats()` werken ongeacht waar de
   bibliotheek haar opslag bewaart. De LID-koppeling die we uiteindelijk nodig
   hadden kwam van `getNumberId` — één publieke aanroep.

En de les die daar onder ligt, want die geldt breder dan deze brug: een controle
die `null` teruggeeft terwijl de functie niet eens bestaat, is geen meting maar
een stilte. `lib/uitkomst.js` maakt daarom onderscheid tussen `bestaat_niet`,
`geen_resultaat`, `onbruikbaar`, `gelukt` en `fout`.

### Historiek ophalen kan niet met deze combinatie

**Gemeten, niet aangenomen.** Oude berichten van Daves toestel in het CRM
krijgen loopt via `client.getChats()`. Op de VPS gaf die aanroep twee van de twee
keer een **uitzondering** — niet een lege lijst, niet `null`, maar een fout. De
foutmelding staat sindsdien in `/status` onder `lidkaart.chats_fout` en in het
paneel in de opvolgmodule.

De versies waarop dit gemeten is:

| onderdeel | versie |
| --- | --- |
| whatsapp-web.js (VPS) | **1.34.7** |
| whatsapp-web.js (package.json) | `^1.26.0` |
| WhatsApp Web-build die de brug bestuurt | **2.3000.1046904178** |

Het beeld dat daaruit volgt: de **gebeurtenissen** komen gewoon binnen — via de
socket, en versturen en ontvangen werken dan ook allebei. Wat faalt, is elke weg
die de **interne opslag van de pagina moet lezen**: `getChats` gooit,
`getChatById` levert niets, `window.Store` bestaat niet. Dat past bij een
bibliotheek die tegen een nieuwere WhatsApp Web-build praat dan waarvoor haar
selectors geschreven zijn.

**Conclusie, en die mag zo blijven staan:** met deze combinatie is historiek niet
op te halen, en er is geen omweg die de moeite waard is. Het gesprek is
**vanaf de koppeling volledig** — alles wat sindsdien heen en weer gaat komt in
het CRM. Wat daarvóór gezegd is, staat op Daves telefoon en blijft daar.

Wanneer opnieuw kijken: alleen als whatsapp-web.js naar een versie gaat die
expliciet deze WhatsApp Web-build ondersteunt. Kijk dán eerst opnieuw naar
`lidkaart.chats_status` in `/status` voor je iets bouwt.

### Lokaal genoteerde nummers

Zes van de 33 leads staan met een lokaal nummer in het CRM (`0472223752`,
`06 57340618`, …). Die passeren het leadlijst-filter — dat heeft een
staart-ingang op de laatste negen cijfers — maar `naarChatId()` geeft `null`
zodra een nummer met een `0` begint. Dat brak twee dingen tegelijk: de lidkaart
(`getNumberId` kreeg niets bruikbaars, vandaar 21 van de 28) en het versturen
(`NUMMER_ONGELDIG` bij bijna één op de vijf openstaande taken).

**De landcode wordt niet geraden.** Vijf van die zes zijn Belgisch en één is
Nederlands; een vaste `32` zou dat ene nummer naar een wildvreemde sturen.
`lib/landcode.js` stelt de kandidaten op (`32` + rest, `31` + rest), legt ze aan
`client.getNumberId()` voor, en accepteert **alleen bij precies één
bevestiging**. Twee treffers is gokken, en dat doen we niet bij een
privacyfilter.

Eén zoeker met één cache, gebruikt door zowel het opbouwen van de lidkaart als
`wa.stuur()`. De uitkomst wordt per lokaal nummer onthouden zolang het proces
draait — anders vraagt een gesprek van vijf berichten vijf keer aan WhatsApp of
dat nummer bestaat.

Levert geen enkele kandidaat iets op, dan is de foutcode `LANDCODE_ONBEKEND` en
niet `NUMMER_ONGELDIG`: het nummer is wél geprobeerd, en de melding zegt dat het
aangevuld moet worden in plaats van dat de brug stuk is.

`/status` telt per uitkomst — alleen aantallen. Er zijn er zes, en dat is met
opzet:

| uitkomst | betekenis |
| --- | --- |
| `gevonden` | precies één kandidaat bevestigd |
| `meerdere` | twee bevestigd — een gok, dus nee |
| `geen` | alle kandidaten geprobeerd, geen enkele bevestigd |
| `mislukt` | er ging bij minstens één kandidaat iets mis; we **weten** het niet |
| `niet_meetbaar` | deze whatsapp-web.js kan de vraag niet stellen |
| `niet_lokaal` | het nummer was al internationaal |

**Alleen de eerste drie gaan de cache in.** `bevestig` gooit als WhatsApp nog
niet klaar is of de verbinding net wegviel, en de lidkaart wordt bij het
opstarten gebouwd — juist het moment waarop dat het vaakst gebeurt. Zou een
mislukking als `geen` blijven hangen, dan stonden die zes nummers voorgoed op
'niet te bepalen' tot iemand herstart, en niets zou zeggen dat het aan de meting
lag in plaats van aan het nummer.

Gaat er bij ook maar één kandidaat iets mis, dan is de hele uitkomst `mislukt` —
ook als de andere wél bevestigde. We weten niet of de kandidaat die gooide óók
bevestigd zou hebben, en dan waren het er twee geweest.

`niet_meetbaar` staat er apart omdat 'deze bibliotheek kan het niet' iets anders
is dan 'WhatsApp kent dit nummer niet' — precies het onderscheid waar de hele
LID-zoektocht op is stukgelopen.

`naarChatId()` blijft ongewijzigd weigeren. Dat is de juiste regel: die functie
mag niet raden. De oplossing zit ervóór, niet erin.

### Wat 'bestaat_niet' óók kan betekenen

`getNumberId` en `getChatById` stonden allebei op `bestaat_niet ×6`, terwijl het
aftasten meldde dat die functies er wél waren. Dat wrong, en terecht: de oorzaak
zat in onze eigen meting. De code schreef `bestaat: !!chatId && kunde.api.…`, en
`naarChatId()` geeft `null` bij minder dan tien cijfers of een leidende nul —
zes leadlijst-nummers missen een landcode. Onbruikbare **invoer** kreeg zo de
vorm van een ontbrekende **functie**: dezelfde verwarring als hierboven, één laag
dieper.

Vandaar de status `onbruikbare_invoer` en de losse parameter `invoerOk` in
`lib/uitkomst.js`. Wie een nieuwe meting toevoegt: houd 'kan de bibliotheek dit'
en 'hebben wij bruikbare invoer' altijd uit elkaar.

## 7 september — het LID-achtervoegsel, en waar je naar kijkt na deze update

Op maandagochtend kwam er geen enkel WhatsApp-bericht meer binnen. De brug zag
92 gebeurtenissen en liet er één door; de reden stond overal op
`niet_op_leadlijst`. Die reden klopte, en dat was juist het verraderlijke: het
nummer dat gefilterd werd wás geen nummer maar het LID.

Twee dingen versterkten elkaar:

1. `getContactById` geeft bij een LID het LID terug. Dat werd geteld als
   `opgelost.contact` — succes — terwijl er niets vertaald was.
2. De lidkaart had 29 koppelingen en miste toch 67 van de 71 opzoekingen.

Wat er veranderd is:

- **Een fout antwoord heet nu `onbruikbaar`.** `beoordeelKandidaat()` in
  `lib/sleutel.js` weigert een antwoord dat gelijk is aan de vraag (dat is geen
  vertaling maar dezelfde identiteit opnieuw) en alles wat geen
  telefoonnummervorm kan hebben. De reden staat in `onbruikbaar_reden`.
- **De kaart bewaart een LID onder twee vormen**, met en zonder
  apparaat-achtervoegsel (`<lid>:<apparaat>@lid`). Vermoeden: `replace(/\D/g,'')`
  laste dat achtervoegsel vast aan het LID, waardoor dertien cijfers er veertien
  werden — precies de vormen `lid/14` en `lid/15` die binnenkwamen.
- **`getNumberId` heeft een cache.** Er stonden 6919 aanroepen voor 32
  leadnummers op één dag, omdat de kaart elke vijf minuten alles opnieuw vroeg.
  Alleen een écht antwoord gaat de cache in; een mislukking niet.

### Waar je na deze update naar kijkt in `/status`

| veld | wat het betekent |
| --- | --- |
| `opgelost.lidkaart_basis` | **Dit is de meting.** Hoe vaak de kaart pas raakte ná het afsnijden van het achtervoegsel. Loopt dit op, dan was het vermoeden juist. Blijft het op nul terwijl `lidkaart` ook laag blijft, dan is er iets anders aan de hand en is er niets stilletjes 'gerepareerd'. |
| `sleutel_opslag` vs `sleutel_zoek` | De twee kanten van de kaart naast elkaar. Staat er bij opslag `lid/13` en bij zoeken `lid/13+apparaat`, dan is dat het hele verhaal. |
| `sleutel_raak` | Per zoekvorm hoeveel er raak waren. `sleutel_zoek` min `sleutel_raak` is wat de kaart nog steeds mist. |
| `opgelost.onbruikbaar` + `onbruikbaar_reden` | Hoe vaak WhatsApp iets teruggaf dat geen nummer was, en waarom we dat vonden. Dit stond eerder als `contact`-succes geboekt. |
| `lidkaart.ingangen` vs `.koppelingen` | Meer ingangen dan koppelingen betekent dat er LID's met een achtervoegsel bij zitten. |
| `wegen.getNumberId.geprobeerd` | Hoort nu veel lager te liggen dan de 6919 van 7 september: de cache vraagt hetzelfde nummer niet elke ronde opnieuw. |

Deze velden dragen geen enkel gegeven: een domein, een lengte en een ja/nee.
Nooit een LID en nooit een nummer — `tests/whatsapp-lid-sleutel.test.js`
controleert dat op de volledige momentopname.

### Bijwerken op de VPS

Geen `npm install` nodig; er is geen afhankelijkheid bij gekomen.

```bash
cd ~/whatsapp-brug && git pull && sudo systemctl restart whatsapp-brug
```

Daarna `/status` opvragen en de tabel hierboven aflopen.

## Wat de brug doet

De schakel tussen Daves WhatsApp en de opvolgmodule in het CRM. Ze meldt wanneer
een bericht verzonden, afgeleverd of gelezen is en wanneer er een antwoord
binnenkomt, en ze kan namens het CRM een bericht versturen.

**Deze service draait niet op Vercel.** `whatsapp-web.js` heeft een echte
browser nodig en een sessie die blijft bestaan — allebei onmogelijk in een
serverless functie die na elke aanvraag verdwijnt. Vandaar een eigen VPS.

---

## Privacy — lees dit eerst

Dave gebruikt één telefoon, voor werk en voor thuis. Daarom haalt de brug elke
vijf minuten bij het CRM de lijst met **bekende leadnummers** op, en negeert ze
elk gesprek met een nummer dat daar niet in staat: niet doorsturen, niet loggen,
niets onthouden.

Drie dingen die daarbij vastliggen:

- **Standaard nee.** Kan de leadlijst niet opgehaald worden, dan is de lijst
  leeg en gaat er dus *niets* door. Liever een uur geen opvolging dan één
  privégesprek in het CRM.
- **Het filter staat vooraan.** In `lib/whatsapp.js`, vóór de eerste regel die
  een berichttekst aanraakt. Er is geen pad waarlangs een tekst eerst ergens
  anders langskomt.
- **De logs bevatten geen berichten.** Alleen aantallen, soorten en tijdstippen.
  Ook niet bij een fout.

Groepsgesprekken vallen er altijd buiten — daar zitten per definitie mensen in
die niet op de lijst staan. Dat geldt voor alle drie de wegen: inkomend,
uitgaand en de statusbevestigingen. Bij uitgaand wordt het nummer van de
**ontvanger** tegen de lijst gehouden, vóór er ook maar iets van het bericht
wordt aangeraakt.

---

## Installeren — één commando

Op een verse Ubuntu 24.04, als root:

```bash
git clone https://github.com/deforexopleiding-bit/forex-opleiding-interface.git /tmp/crm
cd /tmp/crm/services/whatsapp-brug
sudo bash install.sh
```

Dat is alles. Het script installeert Node, de Chromium-bibliotheken, zet de
service in `/opt/whatsapp-brug` onder een eigen gebruiker, schrijft de
systemd-unit met geheugengrens, sluit de firewall op alles behalve SSH en de
brugpoort, en genereert alvast een `BRUG_SECRET`. Aan het eind toont het precies
wat er nog in Vercel moet en hoe je koppelt.

**Twee keer draaien mag.** Elke stap kijkt eerst of hij al gedaan is. Een
bestaande `.env` wordt nooit overschreven en de map met de ingelogde
WhatsApp-sessie wordt niet aangeraakt — een tweede run kost je dus geen nieuwe
QR. Draait het script niet als root, of is het geen Ubuntu 24.04, dan stopt het
met een leesbare regel vóórdat er iets gewijzigd is.

Daarna nog drie dingen, die het script ook zelf op het scherm zet:

1. `WHATSAPP_BRUG_SECRET` en `WHATSAPP_BRUG_URL` in Vercel.
2. `BIND` in `/opt/whatsapp-brug/.env` — standaard `127.0.0.1`, zie
   [Firewall en bereikbaarheid](#6-firewall-en-bereikbaarheid).
3. De QR scannen, via `/api/opvolging-whatsapp-status?wat=qr` in het CRM.

Meekijken: `journalctl -u whatsapp-brug -f`

---

## Achtergrond: dezelfde stappen met de hand

Alleen nodig als je het script niet wilt gebruiken, of als er iets misgaat en je
wilt weten wáár. Getest op Ubuntu 22.04 en 24.04.

### 1. Node 20 en de basis

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
node -v      # v20.x of hoger
```

### 2. Chromium-dependencies voor puppeteer

Zonder deze bibliotheken start Chromium niet en blijft de brug hangen op
"WhatsApp-client starten…". Dit is de stap die het vaakst vergeten wordt.

```bash
sudo apt install -y \
  chromium-browser \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 fonts-liberation
```

> Op Ubuntu 24.04 heet het pakket soms `chromium` in plaats van
> `chromium-browser`, en levert snap een versie die puppeteer niet kan
> aansturen. Werkt `chromium-browser` niet, installeer dan
> `sudo apt install -y chromium` en zet `CHROMIUM_PAD=/usr/bin/chromium`.

### 3. Een eigen gebruiker

Niet als root draaien. Deze service stuurt een browser aan die het internet op
gaat; dat wil je niet met alle rechten van de machine.

```bash
sudo adduser --system --group --home /opt/whatsapp-brug brug
sudo -u brug git clone https://github.com/deforexopleiding-bit/forex-opleiding-interface.git /tmp/crm
sudo -u brug cp -r /tmp/crm/services/whatsapp-brug/. /opt/whatsapp-brug/
sudo rm -rf /tmp/crm
cd /opt/whatsapp-brug
sudo -u brug npm install --omit=dev
```

### 4. Instellen

```bash
sudo -u brug cp .env.example .env
sudo -u brug chmod 600 .env
sudo -u brug nano .env
```

Het geheim genereer je zo, en dezelfde waarde zet je straks in Vercel:

```bash
openssl rand -hex 32
```

| Variabele | Wat het is |
|---|---|
| `BRUG_SECRET` | Gedeeld geheim. **Zelfde waarde als `WHATSAPP_BRUG_SECRET` in Vercel.** |
| `CRM_BASE_URL` | `https://forex-opleiding-interface.vercel.app` |
| `PORT` / `BIND` | Standaard `8088` op `127.0.0.1`. Zie stap 6. |
| `ALLOWED_IPS` | Optionele IP-allowlist, komma-gescheiden. Leeg = uit. |
| `SESSIE_PAD` | Waar de ingelogde sessie staat. **Niet weggooien**, anders opnieuw scannen. |
| `CHROMIUM_PAD` | Leeg laten, of `/usr/bin/chromium-browser` als de meegeleverde niet start. |

### 5. Draaien onder systemd

```bash
sudo tee /etc/systemd/system/whatsapp-brug.service >/dev/null <<'UNIT'
[Unit]
Description=DFO WhatsApp-brug
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brug
Group=brug
WorkingDirectory=/opt/whatsapp-brug
EnvironmentFile=/opt/whatsapp-brug/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
# Chromium is zwaar; zonder deze grens kan één vastlopende browser de VPS vullen.
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-brug
sudo systemctl status whatsapp-brug
```

Meekijken:

```bash
journalctl -u whatsapp-brug -f
```

<details>
<summary>Liever pm2 dan systemd</summary>

```bash
sudo npm install -g pm2
cd /opt/whatsapp-brug
sudo -u brug pm2 start server.js --name whatsapp-brug
sudo -u brug pm2 save
sudo env PATH=$PATH pm2 startup systemd -u brug --hp /opt/whatsapp-brug
```

`pm2 logs whatsapp-brug` om mee te kijken. Systemd is te verkiezen: minder
bewegende delen, en de sessie overleeft een herstart van de machine net zo goed.
</details>

### 6. Firewall en bereikbaarheid

Het installatiescript zet de firewall dicht op alles behalve SSH en, als `BIND`
niet op localhost staat, de brugpoort. Staat er een reverse proxy voor (Caddy of
nginx), dan houdt het **80 en 443 open**.

> **Waarom die twee open moeten blijven.** Met een reverse proxy ervoor komt het
> verkeer van het CRM binnen op 443, niet op de brugpoort. Gaan 80 en 443 dicht,
> dan meldt het CRM *brug niet bereikbaar* terwijl de service gewoon draait — en
> daar zoek je een uur naar, want alles lijkt in orde. Dat is op 5 september
> precies zo gebeurd: het script deed toen `ufw --force reset` en gooide de
> Caddy-regels weg.
>
> Het script reset de firewall daarom **niet meer**. `ufw allow` is uit zichzelf
> idempotent, dus regels toevoegen zonder te resetten geeft hetzelfde eindbeeld
> zonder dat er iets verdwijnt wat iemand anders heeft neergezet. Wordt er geen
> proxy gevonden maar staan 80/443 al open, dan blijven ze open.

Wat hieronder staat is de keuze die je daarna nog zelf maakt.

De brug luistert standaard op `127.0.0.1` en is dan van buiten niet bereikbaar.
Dat is veilig, maar Vercel kan er dan ook niet bij. Twee wegen:

**A. Achter een reverse proxy met HTTPS (aanbevolen).** Laat `BIND=127.0.0.1`
staan en zet Caddy ervoor:

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
brug.jouwdomein.nl {
    reverse_proxy 127.0.0.1:8088
}
CADDY
sudo systemctl reload caddy

sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
```

In Vercel wordt `WHATSAPP_BRUG_URL` dan `https://brug.jouwdomein.nl`.

**B. Rechtstreeks op de poort.** Zet `BIND=0.0.0.0` en open alleen 8088. Dan
loopt het verkeer over onversleuteld HTTP en reist het gedeelde geheim in
leesbare vorm mee — alleen doen als er echt geen domein beschikbaar is.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 8088/tcp
sudo ufw --force enable
```

### 7. Koppelen

Bij de eerste start toont de brug een QR. Die haal je op via het CRM, niet van
de VPS zelf:

```
GET /api/opvolging-whatsapp-status?wat=qr
```

Scannen doe je op Daves telefoon onder **WhatsApp → Instellingen → Gekoppelde
apparaten → Apparaat koppelen**. Daarna staat de sessie in `SESSIE_PAD` en vraagt
een herstart geen nieuwe QR.

Controleren:

```bash
curl -s -H "X-Brug-Secret: $BRUG_SECRET" http://127.0.0.1:8088/status | jq
```

---

## Wat in Vercel moet staan

| Variabele | Waarde |
|---|---|
| `WHATSAPP_BRUG_URL` | `https://brug.jouwdomein.nl` (geen slash aan het eind) |
| `WHATSAPP_BRUG_SECRET` | Dezelfde waarde als `BRUG_SECRET` op de VPS. **Sensitive.** |

Ontbreken ze, dan geven de CRM-endpoints een 503 met een melding die zegt wélke
variabele mist — geen stille storing.

---

## De endpoints van de brug

Alles behalve `/healthz` vereist de header `X-Brug-Secret`, en het IP moet op
`ALLOWED_IPS` staan als die gezet is.

| Route | Doet |
|---|---|
| `GET /healthz` | Leeft het proces? Geen geheim nodig, verklapt niets. |
| `GET /status` | Verbonden ja of nee, het gekoppelde nummer, wanneer laatst iets gezien, de stand van de leadlijst. |
| `GET /qr` | De actuele QR als dataURL, zolang er nog niet gekoppeld is. |
| `POST /send` | `{ nummer, tekst }`. Weigert nummers buiten de leadlijst. |

En de brug duwt zelf naar `CRM_WEBHOOK_PATH`:

```json
{ "soort": "uitgaand", "nummer": "32470111222", "media_type": "ptt",
  "tijdstip": "2026-09-05T06:30:00.000Z", "bericht_id": "true_...@c.us" }
```

| `soort` | Wanneer | Tijdstip | `tekst` | `media_type` |
|---|---|---|---|---|
| `uitgaand` | Dave stuurt iets — ook vanaf zijn eigen telefoon | moment van **versturen** | nee | ja |
| `verzonden` / `afgeleverd` / `gelezen` | statusverandering op wat wij stuurden | moment van de **bevestiging** | nee | ja |
| `antwoord_ontvangen` | de lead stuurt iets | moment van het bericht | ja | ja |

`media_type` `ptt` of `audio` betekent een ingesproken bericht; dat telt in de
opvolging als spraakbericht in plaats van als tekstje.

**Waarom `uitgaand` een eigen weg heeft.** `whatsapp-web.js` doet in `Client.js`
`if (msg.id.fromMe) return;` vlak vóór het `message`-event, dus eigen berichten
komen daar nooit langs. Alleen `message_create` ziet ze — en dat geldt ook voor
wat Dave op zijn telefoon inspreekt, want de hook hangt aan de berichtenstore
die het gekoppelde apparaat meesynct. Zonder die handler is *"heeft deze lead
vanmorgen een spraakbericht gehad?"* een vraag die het systeem niet kan
beantwoorden.

**Bij uitgaand gaat er geen berichttekst mee.** Voor de meting is alleen nodig
dát er iets uitging en of het ingesproken was; de inhoud van wat Dave naar een
lead stuurt is gevoeliger dan nodig en blijft op de telefoon.

**Eén bericht, één regel.** Een bericht dat het CRM zelf verstuurt levert zowel
een `uitgaand` als een `verzonden` op. Die twee beschrijven hetzelfde moment en
delen daarom in het CRM één idempotency-sleutel, zodat er één rij overblijft in
plaats van twee. `uitgaand` wint, want die draagt het echte verzendmoment en het
`media_type`; de ack draagt geen van beide betrouwbaar.

---

## Onderhoud

**De sessie is verlopen en er is een nieuwe QR nodig.** Gebeurt als Dave het
apparaat ontkoppelt of WhatsApp de sessie intrekt. `journalctl` toont dan
`authenticatie mislukt`. Haal de QR opnieuw op en scan; de map hoeft niet leeg.

**Opnieuw beginnen.** Alleen als koppelen niet meer lukt:

```bash
sudo systemctl stop whatsapp-brug
sudo -u brug rm -rf /opt/whatsapp-brug/.wwebjs_auth
sudo systemctl start whatsapp-brug
```

**Code bijwerken.** `install.sh` opnieuw draaien vanuit een verse clone is de
kortste weg: de code wordt vervangen, `.env` en de sessie blijven staan.

**Bijwerken.** `whatsapp-web.js` volgt WhatsApp Web, en dat verandert zonder
aankondiging. Werkt de brug ineens niet meer, kijk dan eerst of er een nieuwe
versie is:

```bash
cd /opt/whatsapp-brug
sudo -u brug npm update whatsapp-web.js
sudo systemctl restart whatsapp-brug
```

**Wat je hier nooit doet.** De map `.wwebjs_auth` committen of kopiëren: daar
zit een ingelogde WhatsApp-sessie in. En `.env` staat op `chmod 600` omdat het
geheim erin de leadlijst opvraagbaar maakt.
