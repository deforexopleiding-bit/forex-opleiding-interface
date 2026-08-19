# Bijlage-download achter een ondertekend token (bug 3)

**Status:** klaar voor review, **niet gemerged**.
**Branch:** `claude/email-attachment-signed-token`
**Volgt op:** #1329 (RLS-hardening) en #1330 (auth op email-body + mark-read).

---

## Het lek

`api/email-attachment.js` had **geen enkele** auth-check. Dit was genoeg om
elke bijlage uit elke gekoppelde mailbox te downloaden:

```
GET /api/email-attachment?mailbox=info@deforexopleiding.nl&uid=1234&index=0
```

Geen token, geen sessie, geen rolcheck — net als `email-body` en `mark-read`
vóór #1330 stond dit open voor het hele internet. Alleen `mailbox` moest in de
`ACCOUNTS`-lijst staan, en `uid` is een oplopend IMAP-nummer: raden is triviaal.

## Waarom `requireCrmStaff()` hier niet volstaat

Bij `email-body` en `mark-read` kon de fix simpel zijn: die worden met `fetch()`
aangeroepen, dus de frontend kan er een `Authorization`-header op zetten.

Bijlagen niet. Die worden geopend via een **browser-navigatie**:

* `modules/email.html` ~4744 — `<a href="…" download target="_blank">`
* `modules/email.html` ~2769 — `window.open(url, '_blank')` voor de PDF-preview
* `modules/klanten-v2/views/email-v2.js` ~1061 — idem, in de bijlagenstrip

Een `<a href>` en `window.open()` sturen géén headers mee. `requireCrmStaff`
erop zetten zou dus simpelweg het downloaden van bijlagen breken.

## De oplossing: kortlevend HMAC-token in de query-string

```
GET /api/email-attachment?mailbox=…&uid=…&index=…&t=v1.<exp>.<hmac>
```

### Eigenschappen

| Eigenschap | Hoe |
|---|---|
| **Onvervalsbaar** | HMAC-SHA256 over `v1\|mailbox\|uid\|exp`. Zonder de sleutel is er geen geldig token te maken, en `exp` ophogen breekt de handtekening. |
| **Gebonden aan de mail** | Een token voor mailbox A / uid 1 werkt niet voor mailbox B of uid 2. |
| **Kortlevend** | 30 minuten (`EMAIL_ATTACHMENT_TOKEN_TTL_SECONDS`). Een gelekte link is daarna waardeloos. |
| **Constant-time vergelijking** | `crypto.timingSafeEqual`, met lengte-check ervoor (die functie gooit bij ongelijke lengte). |

### Scope: per mail, niet per bijlage

Het token dekt `(mailbox, uid)` — niet de individuele `index`. Bewust: wie de
mail mag lezen mag ook alle bijlagen van diezelfde mail lezen, dus `index` is
geen aparte rechtengrens. Zo heeft één geopende mail één token nodig in plaats
van N, en blijft de renderfunctie synchroon.

### Uitgifte zonder extra round-trip

`/api/email-body` mint het token en zet het in zijn respons
(`attachment_token` + `attachment_token_expires_at`). Dat endpoint zit sinds
#1330 achter `requireCrmStaff()` en levert al de bijlagenlijst — de frontend
heeft dus geen apart token-endpoint of extra fetch nodig, en de bestaande
synchrone renderfuncties konden blijven zoals ze waren.

Mislukt het minten (ontbrekende sleutel), dan is dat **fail-soft**: de mailbody
laadt gewoon, alleen de bijlage-links geven dan 403.

### Sleutelbeheer — geen verplichte nieuwe env-var

```
EMAIL_ATTACHMENT_TOKEN_SECRET   (optioneel)  → wordt gebruikt als hij bestaat
SUPABASE_SERVICE_ROLE_KEY       (aanwezig)   → anders hiervan afgeleid
```

De fallback is geen hergebruik van de service-role key als HMAC-sleutel, maar
een **afgeleide**: `HMAC(service_role_key, 'email-attachment-token-v1')`.
Daarmee deployt dit zonder configuratiestap — belangrijk, want een ontbrekende
env-var zou hier stilletjes alle bijlagen breken. Wil je de sleutel kunnen
roteren zonder aan de service-role key te komen: zet
`EMAIL_ATTACHMENT_TOKEN_SECRET` (32+ random bytes). Alle op dat moment
uitgegeven tokens vervallen dan direct — maximaal 30 minuten hinder.

### Bearer blijft ook werken

Het endpoint accepteert **token OF Bearer**. De token-check komt eerst (normale
pad, geen DB-call); pas als die faalt wordt `requireCrmStaff(req)` geprobeerd.
Zo blijven `fetch`-callers, scripts en toekomstige server-to-server-aanroepen
werken zonder token. Falen beide → 403, en de *reden* wordt alleen gelogd, niet
teruggegeven — anders is het endpoint een orakel voor het raden van tokens.

---

## Testen

`tests/attachment-token.test.js` — 11 tests, alle groen:

* vers token valideert; `uid` mag string of number zijn;
* token van mailbox A werkt niet voor mailbox B, en niet voor een andere uid;
* verlopen token → `expired`; `exp` ophogen → `bad_signature`;
* ontbrekend/misvormd token → `missing` / `malformed`;
* verzonnen handtekening van de juiste lengte → `bad_signature` (dwingt de
  `timingSafeEqual`-tak af);
* `signAttachmentToken` eist mailbox én uid;
* wiring: `email-attachment.js` doet de auth vóór `new ImapFlow`, en
  `email-body.js` mint het token in zijn respons.

### Handmatig na deploy

```bash
# zonder token → verwacht 403
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<preview>/api/email-attachment?mailbox=info@deforexopleiding.nl&uid=1234&index=0"

# met een verzonnen token → verwacht 403
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<preview>/api/email-attachment?mailbox=info@deforexopleiding.nl&uid=1234&index=0&t=v1.9999999999.aaaa"
```

In de browser als CRM-staff:

1. `/modules/email.html` → mail met bijlage openen → bijlage downloaden (werkt).
2. Zelfde mail → PDF-preview-knop (`window.open`) → PDF opent inline.
3. Klanten-v2 → e-mailweergave → bijlagenstrip → download werkt.
4. Mail 30+ minuten open laten staan en dán klikken → 403 verwacht; pagina
   verversen geeft een vers token en het werkt weer. Dit is het enige merkbare
   gedragsverschil voor staff.

---

## Bestanden

| Bestand | Wat |
|---|---|
| `api/_lib/attachment-token.js` | `signAttachmentToken()` / `verifyAttachmentToken()` (nieuw) |
| `api/email-attachment.js` | accepteert `?t=` of Bearer; 403 zonder beide, vóór de IMAP-connect |
| `api/email-body.js` | mint het token en zet het in de respons |
| `modules/email.html` | `attachTokenParam()` + 2 URL-bouwers |
| `modules/klanten-v2/views/email-v2.js` | `_attStrip` krijgt het token door |
| `tests/attachment-token.test.js` | 11 tests (nieuw) |
