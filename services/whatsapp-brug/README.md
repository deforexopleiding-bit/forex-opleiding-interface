# WhatsApp-brug

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
die niet op de lijst staan.

---

## Installeren op een verse Ubuntu-VPS

Getest op Ubuntu 22.04 en 24.04. Reken op een kwartier.

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

### 6. Firewall

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
{ "soort": "afgeleverd", "nummer": "32470111222",
  "tijdstip": "2026-09-04T12:00:00.000Z", "bericht_id": "true_...@c.us" }
```

`soort` is `verzonden`, `afgeleverd`, `gelezen` of `antwoord_ontvangen`. Bij dat
laatste zit `tekst` erbij, en `media_type` zodat een ingesproken bericht in de
opvolging als spraakbericht telt in plaats van als tekstje.

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
