# De brug herstelt zichzelf

Een dagelijkse controle is diagnose, geen genezing. Valt de brug om tien uur 's
ochtends om, dan ontdekt de ochtendmail dat de volgende dag om zeven uur —
**eenentwintig uur** nadat Daves berichten niet meer geregistreerd werden.

Dit document beschrijft de vier lagen die dat gat dichten, en hoe je bewijst dat
ze werken. Dat laatste is geen formaliteit: **een bewaker die nog nooit is
afgegaan is een aanname, geen bewaker.**

## Wat er gemeten is vóór er iets gebouwd werd

| vraag | antwoord | bron |
| --- | --- | --- |
| Herstart systemd de service na een crash? | **Ja, al goed** — `Restart=always`, `RestartSec=10` | `install.sh` |
| Geeft systemd het ooit op? | Nee — de standaard-burst van 5/10 s wordt met `RestartSec=10` nooit gehaald, en staat nu expliciet op `StartLimitIntervalSec=0` | idem |
| Herverbindt whatsapp-web.js zelf? | **Nee.** Bij een verbroken verbinding: `emit('disconnected')` + `this.destroy()`, en verder niets | `whatsapp-web.js@1.34.7`, `src/Client.js` 847-853 |
| Deed onze eigen code iets? | Nee — twee vlaggetjes en een logregel | `lib/whatsapp.js` (voor deze wijziging) |

**De kern van het probleem:** bij een verbroken WhatsApp-sessie crasht Node niet.
Het proces blijft draaien met `verbonden = false`, systemd ziet een gezonde
service, en er is niets om te herstarten. Punt 1 was dus al geregeld en
beschermde tegen precies de verkeerde storing.

## De vier lagen

### 1 · systemd herstart altijd — ongewijzigd, op één regel na

```ini
Restart=always
RestartSec=10
StartLimitIntervalSec=0
MemoryMax=1500M
```

`StartLimitIntervalSec=0` is nieuw en verandert vandaag niets. Hij legt de
garantie vast voor het geval iemand ooit `RestartSec` verlaagt: dan zou de
standaard-burstlimiet de unit in `failed` achterlaten zónder herstart.

### 2 · Opnieuw verbinden, met oplopende wachttijd

`lib/herverbinden.js`. Bij `disconnected` en bij `auth_failure`:

```
poging 1 → na  5 s     poging 4 → na 40 s
poging 2 → na 10 s     poging 5 → na 80 s
poging 3 → na 20 s     poging 6+ → elke 120 s
```

Een geslaagde verbinding — bewezen door het **`ready`-event**, niet door een
`initialize()` die niet gooit — zet de teller terug op nul.

**Na zes mislukte pogingen sluit het proces zichzelf af met exit-code 1.**
`Restart=always` start dan een volledig vers proces met een verse Chromium. Dat
is er omdat een vastgelopen Chromium in hetzelfde proces niet te repareren is:
je kunt de pagina niet meer aanspreken, dus ook niet opnieuw initialiseren.

De teller vóór die uitgang voorkomt het omgekeerde: bij een WhatsApp-storing van
een half uur zou een proces dat meteen afsluit elke tien seconden een nieuwe
Chromium starten tot de VPS omvalt.

### 3 · Een hartslag, en waarom hij niet vals alarm geeft

De brug meldt elke **2 minuten** dat hij leeft (`lib/hartslag.js` →
`/api/brug-hartslag`). Het CRM kijkt elke **5 minuten** mee
(`cron-brug-waakhond`, `*/5 * * * *`).

> Een waakhond die blaft omdat het CRM even traag was, is binnen een week een
> waakhond waar niemand meer op reageert. Dat is een duurdere storing dan de
> storing die hij moet vangen, want dan mist hij óók de echte.

Vandaar drie lagen tussen één gemiste hartslag en een mail:

| | |
| --- | --- |
| hartslag | elke **2 min** |
| drempel | **12 min** stilte — zes gemiste slagen |
| bevestiging | pas mailen na **2 waarnemingen op rij** |
| **eerste mail dus na** | **12 tot 17 minuten**, nooit eerder |

Eén trage levering, één herstart, één netwerkhikje: allemaal ruim binnen de
marge. En er gaat **één** mail per storing — zodra er weer een hartslag
binnenkomt, wordt het meld-merk gewist en mag hij bij een volgende storing
opnieuw blaffen.

### 4 · Een verbroken verbinding is een gebeurtenis

De brug duwt bij `disconnected` **onmiddellijk** een melding naar het CRM, in
plaats van te wachten tot iemand de volgende meting doet.

## De privacygrens verandert niet

De hartslag draagt **alleen het feit dat de brug leeft plus tellingen**: geen
nummer, geen jid, geen berichttekst, geen naam. De ontvangkant
(`api/brug-hartslag.js`) pakt expliciet de velden die hij kent en negeert de
rest, zodat een toekomstige wijziging aan de brugkant hier nooit ongemerkt iets
anders binnenschuift. Er staat een test op die de hartslag afkeurt zodra er een
nummer-achtige reeks in voorkomt.

## ⚠ Het bewijs — en één val in de voor de hand liggende proef

**`systemctl stop` bewijst het zelfherstel NIET.** `Restart=always` herstart
nadrukkelijk *niet* na een bewuste `systemctl stop`; dat is gedocumenteerd
systemd-gedrag. Wie het zo test, ziet de service niet terugkomen en concludeert
ten onrechte dat de zelfheling stuk is.

Twee proeven, elk voor een andere laag:

### Proef A — komt hij terug na een crash? (± 15 seconden)

```bash
systemctl show whatsapp-brug -p Restart -p RestartSec -p StartLimitIntervalSec
systemctl show whatsapp-brug -p MainPID          # noteer het nummer
date -Is; systemctl kill -s SIGKILL whatsapp-brug
sleep 15
date -Is; systemctl show whatsapp-brug -p MainPID -p NRestarts
systemctl is-active whatsapp-brug                # verwacht: active
```

Verwacht: een **ander** MainPID, `NRestarts` één hoger, en ongeveer 10 seconden
tussen de twee `date`-regels. `kill -s SIGKILL` bootst een crash na; `stop` niet.

### Proef B — gaat het alarm af? (± 20 minuten)

```bash
date -Is; systemctl stop whatsapp-brug
# wacht 20 minuten — hier is 'stop' juist wél de goede knop:
# hij blijft liggen, en dat is precies de storing die we willen naspelen
sleep 1200
date -Is; systemctl start whatsapp-brug
```

Verwacht in die twintig minuten **één** mail met onderwerp
`[Brug] geen hartslag — de brug ligt stil`, met de gemeten stilte erin. Niet
vier mails, en niet nul.

### Proef C — herstelt hij zich na een verbroken sessie?

Alleen na te spelen door de koppeling op de telefoon te verbreken
(WhatsApp → Gekoppelde apparaten → uitloggen). Verwacht in `journalctl -u
whatsapp-brug -f`: `verbinding verbroken` gevolgd door `poging 1 over 5 s`, en
na zes mislukte pogingen een procesafsluiting met een verse start erachter.

## Wat de tests wél en niet bewijzen

`tests/brug-zelfherstel.test.js` — 17 tests, en tien opzettelijk ingebouwde
regressies werden alle tien gevangen (de zwaarste, "plan geen herverbinding" —
de oude toestand — maakt er zes rood).

**Wat ze niet bewijzen:** dat `client.on('disconnected')` de herverbinder
werkelijk aanroept. Die bedrading zit in `lib/whatsapp.js` en die is hier niet
uitvoerbaar te testen, want `whatsapp-web.js` heeft een echte Chromium nodig.
Een test die de brontekst leest en op `herverbinder.verbroken(` zoekt zou groen
staan zonder één regel uit te voeren — precies de vorm die in
[`opvolging-module.md`](opvolging-module.md) als alibi beschreven staat. Die
bedrading wordt door **proef C** bewezen en door niets anders.
