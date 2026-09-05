#!/usr/bin/env bash
#
# services/whatsapp-brug/install.sh
#
# Zet de WhatsApp-brug in één keer op een verse Ubuntu 24.04.
#
#   sudo bash install.sh
#
# Doet: Node 20, de Chromium-bibliotheken die puppeteer nodig heeft, een eigen
# systeemgebruiker, de service naar /opt, npm install, een systemd-unit met een
# geheugengrens, de firewall dicht op alles behalve SSH en de brugpoort. Eindigt
# met wat er nog ingevuld moet worden.
#
# TWEE KEER DRAAIEN MAG. Elke stap controleert eerst of hij al gedaan is. Een
# bestaande .env wordt nooit overschreven, en de map met de ingelogde
# WhatsApp-sessie wordt nooit aangeraakt — anders zou een tweede run je
# koppeling weggooien en om een nieuwe QR vragen.

set -Eeuo pipefail

DOEL_MAP="${DOEL_MAP:-/opt/whatsapp-brug}"
GEBRUIKER="${GEBRUIKER:-brug}"
UNIT="/etc/systemd/system/whatsapp-brug.service"
NODE_MAJOR=20

# ── Uitvoer ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'
else B=""; G=""; Y=""; R=""; N=""; fi

stap()  { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()    { printf '    %s✓%s %s\n' "$G" "$N" "$1"; }
overg() { printf '    %s·%s %s\n' "$Y" "$N" "$1"; }
stop()  { printf '\n%sKan niet doorgaan:%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

# Bij een fout halverwege: zeg wélke regel het was. Zonder deze val is een
# mislukte installatie een muur van apt-uitvoer zonder aanwijzing.
trap 'printf "\n%sAfgebroken op regel %s.%s Draai het script opnieuw nadat je de fout hierboven hebt opgelost — dat mag veilig.\n\n" "$R" "$LINENO" "$N" >&2' ERR

# ── Voorwaarden ────────────────────────────────────────────────────────────
stap "Voorwaarden controleren"

[ "$(id -u)" -eq 0 ] || stop "dit script moet als root draaien. Gebruik: sudo bash install.sh"

[ -r /etc/os-release ] || stop "/etc/os-release ontbreekt; dit lijkt geen Ubuntu."
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || stop "dit script is voor Ubuntu, gevonden: ${PRETTY_NAME:-onbekend}."
case "${VERSION_ID:-}" in
  24.04) ok "Ubuntu ${VERSION_ID}" ;;
  22.04) overg "Ubuntu ${VERSION_ID} — getest op 24.04, dit werkt meestal ook." ;;
  *)     stop "Ubuntu ${VERSION_ID:-onbekend} is niet ondersteund. Verwacht 24.04 (of 22.04)." ;;
esac

BRON_MAP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$BRON_MAP/server.js" ] || stop "server.js niet gevonden naast dit script ($BRON_MAP). Draai het vanuit de map services/whatsapp-brug."

# ── Pakketten ──────────────────────────────────────────────────────────────
stap "Systeempakketten"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git ufw >/dev/null
ok "basis aanwezig"

# Chromium-bibliotheken. Dit is de stap die het vaakst vergeten wordt: zonder
# deze start Chromium niet en blijft de brug hangen op "client starten…" zonder
# een duidelijke fout.
# Op 24.04 heet libasound2 'libasound2t64' en libatk 'libatk1.0-0t64'.
CHROOM_PAKKETTEN=(
  libnss3 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 fonts-liberation
)
for kandidaat in libasound2t64 libasound2; do
  if apt-cache show "$kandidaat" >/dev/null 2>&1; then CHROOM_PAKKETTEN+=("$kandidaat"); break; fi
done
for kandidaat in libatk1.0-0t64 libatk1.0-0; do
  if apt-cache show "$kandidaat" >/dev/null 2>&1; then CHROOM_PAKKETTEN+=("$kandidaat"); break; fi
done
for kandidaat in libatk-bridge2.0-0t64 libatk-bridge2.0-0; do
  if apt-cache show "$kandidaat" >/dev/null 2>&1; then CHROOM_PAKKETTEN+=("$kandidaat"); break; fi
done
apt-get install -y -qq "${CHROOM_PAKKETTEN[@]}" >/dev/null
ok "Chromium-bibliotheken voor puppeteer"

# Een systeem-Chromium is op een kale VPS vaak stabieler dan de meegeleverde.
# Snap-versies kan puppeteer niet aansturen, dus die slaan we over.
CHROMIUM_PAD=""
for pad in /usr/bin/chromium /usr/bin/chromium-browser; do
  [ -x "$pad" ] && { CHROMIUM_PAD="$pad"; break; }
done
if [ -z "$CHROMIUM_PAD" ]; then
  if apt-get install -y -qq chromium-browser >/dev/null 2>&1 || apt-get install -y -qq chromium >/dev/null 2>&1; then
    for pad in /usr/bin/chromium /usr/bin/chromium-browser; do
      [ -x "$pad" ] && { CHROMIUM_PAD="$pad"; break; }
    done
  fi
fi
if [ -n "$CHROMIUM_PAD" ]; then ok "systeem-Chromium: $CHROMIUM_PAD"
else overg "geen systeem-Chromium; puppeteer gebruikt zijn eigen versie"; fi

# ── Node ───────────────────────────────────────────────────────────────────
stap "Node.js"
huidig=0
command -v node >/dev/null 2>&1 && huidig="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "${huidig:-0}" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  ok "Node $(node -v) is al goed"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) geïnstalleerd"
fi

# ── Gebruiker en map ───────────────────────────────────────────────────────
stap "Gebruiker en map"
# Niet als root draaien: deze service stuurt een browser aan die het internet
# op gaat, en dat wil je niet met alle rechten van de machine.
if id -u "$GEBRUIKER" >/dev/null 2>&1; then
  overg "gebruiker '$GEBRUIKER' bestaat al"
else
  adduser --system --group --home "$DOEL_MAP" --disabled-login "$GEBRUIKER" >/dev/null
  ok "gebruiker '$GEBRUIKER' aangemaakt"
fi
mkdir -p "$DOEL_MAP"

# Alleen de code kopiëren. .env en .wwebjs_auth blijven expliciet buiten schot:
# daar staan het geheim en de ingelogde WhatsApp-sessie in, en die mag een
# tweede run nooit weggooien.
stap "Code plaatsen in $DOEL_MAP"
if [ "$BRON_MAP" = "$DOEL_MAP" ]; then
  overg "al op zijn plek"
else
  cp -r "$BRON_MAP/lib" "$DOEL_MAP/"
  cp "$BRON_MAP/server.js" "$BRON_MAP/package.json" "$DOEL_MAP/"
  [ -f "$BRON_MAP/.env.example" ] && cp "$BRON_MAP/.env.example" "$DOEL_MAP/"
  ok "server.js, lib/ en package.json gekopieerd"
fi

if [ -f "$DOEL_MAP/.env" ]; then
  overg ".env bestaat al — niet overschreven"
  NIEUWE_ENV=0
else
  cp "$DOEL_MAP/.env.example" "$DOEL_MAP/.env"
  # Het geheim alvast genereren scheelt een stap, en een willekeurig geheim is
  # altijd beter dan een leeg veld dat iemand vergeet in te vullen.
  GEGENEREERD="$(openssl rand -hex 32)"
  sed -i "s|^BRUG_SECRET=.*|BRUG_SECRET=${GEGENEREERD}|" "$DOEL_MAP/.env"
  [ -n "$CHROMIUM_PAD" ] && sed -i "s|^CHROMIUM_PAD=.*|CHROMIUM_PAD=${CHROMIUM_PAD}|" "$DOEL_MAP/.env"
  ok ".env aangemaakt met een vers gegenereerd BRUG_SECRET"
  NIEUWE_ENV=1
fi
chmod 600 "$DOEL_MAP/.env"
chown -R "$GEBRUIKER":"$GEBRUIKER" "$DOEL_MAP"

stap "Node-pakketten"
sudo -u "$GEBRUIKER" env HOME="$DOEL_MAP" npm install --omit=dev --no-audit --no-fund --prefix "$DOEL_MAP" >/dev/null
ok "geïnstalleerd"

# ── systemd ────────────────────────────────────────────────────────────────
stap "systemd-unit"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=DFO WhatsApp-brug
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${GEBRUIKER}
Group=${GEBRUIKER}
WorkingDirectory=${DOEL_MAP}
EnvironmentFile=${DOEL_MAP}/.env
ExecStart=/usr/bin/node ${DOEL_MAP}/server.js
Restart=always
RestartSec=10
# Chromium is zwaar. Zonder deze grens kan één vastlopende browser de VPS
# volledig vullen en neemt hij de rest van de machine mee.
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable whatsapp-brug >/dev/null 2>&1
ok "unit geschreven en ingeschakeld"

# ── Firewall ───────────────────────────────────────────────────────────────
stap "Firewall"
BRUG_POORT="$(grep -E '^PORT=' "$DOEL_MAP/.env" | cut -d= -f2 | tr -d '[:space:]')"
BRUG_POORT="${BRUG_POORT:-8088}"
BIND_ADRES="$(grep -E '^BIND=' "$DOEL_MAP/.env" | cut -d= -f2 | tr -d '[:space:]')"
BIND_ADRES="${BIND_ADRES:-127.0.0.1}"

# GEEN `ufw --force reset`. Dat stond hier wel, en het heeft op 5 september de
# brug onbereikbaar gemaakt: de reset gooide 80 en 443 dicht, waar Caddy als
# reverse proxy voor de brug op luistert. De service draaide gewoon door, maar
# het CRM meldde 'brug niet bereikbaar' — en dat is precies het soort storing
# waar je een uur naar zoekt, want alles lijkt te werken.
#
# `ufw allow` is uit zichzelf idempotent: dezelfde regel twee keer toevoegen is
# een no-op. Regels toevoegen zonder te resetten geeft dus hetzelfde eindbeeld
# zonder dat er iets verdwijnt wat iemand anders heeft neergezet.
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ok "poort 22 (SSH) open"

# ── Staat er een reverse proxy voor? ────────────────────────────────────────
# Zo ja, dan komt het verkeer van het CRM binnen op 80/443 en niet op de
# brugpoort. Die twee moeten dan open blijven, anders is de brug onbereikbaar
# terwijl hij draait. Meerdere signalen, want een van de drie kan ontbreken:
# de unit kan actief zijn zonder configbestand, of andersom vlak na installatie.
PROXY=""
for dienst in caddy nginx; do
  if systemctl is-active --quiet "$dienst" 2>/dev/null || systemctl is-enabled --quiet "$dienst" 2>/dev/null; then
    PROXY="$dienst"; break
  fi
done
if [ -z "$PROXY" ] && [ -f /etc/caddy/Caddyfile ]; then PROXY="caddy"; fi
if [ -z "$PROXY" ] && [ -d /etc/nginx/sites-enabled ] && [ -n "$(ls -A /etc/nginx/sites-enabled 2>/dev/null)" ]; then PROXY="nginx"; fi
# Laatste vangnet: luistert er iets op 80 of 443, wat het ook is?
if [ -z "$PROXY" ] && command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE ':(80|443)\s'; then PROXY="onbekende webserver"; fi
fi

if [ -n "$PROXY" ]; then
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ok "poort 80 en 443 open — ${PROXY} staat als reverse proxy voor de brug"
else
  # Niets gevonden. We halen 80/443 hier NIET weg: als ze al openstonden is dat
  # een keuze van iemand anders, en die overrulen we niet ongevraagd.
  if ufw status 2>/dev/null | grep -qE '^(80|443)/tcp'; then
    overg "poort 80/443 stonden al open — met rust gelaten"
  else
    overg "geen reverse proxy gevonden; 80 en 443 blijven dicht"
  fi
fi

if [ "$BIND_ADRES" = "127.0.0.1" ]; then
  # De brug luistert alleen op localhost, dus de poort openzetten heeft geen
  # zin. Zet BIND=0.0.0.0 in .env en draai dit script opnieuw als Vercel er
  # rechtstreeks bij moet.
  overg "poort ${BRUG_POORT} NIET geopend — de brug luistert op 127.0.0.1"
else
  ufw allow "${BRUG_POORT}/tcp" >/dev/null
  ok "poort ${BRUG_POORT} (brug) open"
fi
ufw --force enable >/dev/null
ok "firewall aan; bestaande regels zijn niet weggegooid"

# ── Starten ────────────────────────────────────────────────────────────────
stap "Service starten"
systemctl restart whatsapp-brug
sleep 3
if systemctl is-active --quiet whatsapp-brug; then ok "draait"
else overg "nog niet actief — kijk met: journalctl -u whatsapp-brug -n 50"; fi

# ── Wat er nog moet gebeuren ───────────────────────────────────────────────
GEHEIM="$(grep -E '^BRUG_SECRET=' "$DOEL_MAP/.env" | cut -d= -f2- | tr -d '[:space:]')"
CRM="$(grep -E '^CRM_BASE_URL=' "$DOEL_MAP/.env" | cut -d= -f2- | tr -d '[:space:]')"

printf '\n%s────────────────────────────────────────────────────────────%s\n' "$B" "$N"
printf '%s  Klaar. Nog drie dingen.%s\n' "$B" "$N"
printf '%s────────────────────────────────────────────────────────────%s\n\n' "$B" "$N"

printf '%s1. Zet deze twee in Vercel%s (Settings → Environment Variables):\n\n' "$B" "$N"
printf '     WHATSAPP_BRUG_SECRET = %s\n' "${GEHEIM:-<leeg — vul BRUG_SECRET in .env>}"
printf '                            (markeer als Sensitive)\n'
printf '     WHATSAPP_BRUG_URL    = https://brug.jouwdomein.nl\n'
printf '                            (het adres waarop DEZE server bereikbaar is,\n'
printf '                             zonder slash aan het eind)\n\n'

printf '%s2. Controleer %s/.env%s:\n\n' "$B" "$DOEL_MAP" "$N"
if [ "${NIEUWE_ENV:-0}" -eq 1 ]; then
  printf '     CRM_BASE_URL  staat nu op %s\n' "${CRM:-<leeg>}"
else
  printf '     (bestaande .env is niet aangeraakt)\n'
fi
printf '     BIND          %s\n' "$BIND_ADRES"
if [ "$BIND_ADRES" = "127.0.0.1" ]; then
  printf '                   → zet een reverse proxy met HTTPS ervoor (zie README),\n'
  printf '                     of zet BIND=0.0.0.0 en draai dit script opnieuw.\n'
fi
printf '     ALLOWED_IPS   optioneel; leeg = alleen het geheim beschermt de brug\n\n'
printf '     Na een wijziging:  systemctl restart whatsapp-brug\n\n'

printf '%s3. Koppel WhatsApp.%s Haal de QR op via het CRM:\n\n' "$B" "$N"
printf '     %s/api/opvolging-whatsapp-status?wat=qr\n\n' "${CRM:-https://forex-opleiding-interface.vercel.app}"
printf '   Scannen op Daves telefoon: WhatsApp → Instellingen → Gekoppelde\n'
printf '   apparaten → Apparaat koppelen.\n\n'

printf '%sStatus van hieraf%s:\n' "$B" "$N"
printf '     curl -s -H "X-Brug-Secret: %s" \\\n' "${GEHEIM:-<geheim>}"
printf '       http://127.0.0.1:%s/status\n\n' "$BRUG_POORT"
printf '%sMeekijken%s:  journalctl -u whatsapp-brug -f\n\n' "$B" "$N"
