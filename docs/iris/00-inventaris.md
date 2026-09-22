# Iris — inventaris (fase 0)

**Datum:** 21 september 2026
**Basis:** `main` op commit `784c1dd`
**Werkwijze:** de masterprompt geeft feiten uit notities. Dit document zet die
naast wat er écht in de code en de databank staat. **De code wint.** Elke regel
hieronder is nagekeken in een bestand; waar ik iets niet kon nakijken (databank,
Meta-console) staat dat er met zoveel woorden bij.

---

## 0. De korte versie

Het CRM is **veel verder** dan de masterprompt aanneemt. Drie dingen die de
opdracht als "nog te bouwen" beschrijft, bestaan al en draaien in productie:

| Masterprompt zegt | Werkelijkheid |
|---|---|
| "`onboarding@` wordt niet gevolgd, er komt niemand kijken" | Wordt **wél** elke 5 minuten via IMAP opgehaald en landt in `email_messages` (`api/sync-emails.js` regel 14). Wat ontbreekt is niet de instroom maar een **scherm dat er iets mee doet**. |
| "de brug van LMS on hold/belofte naar het CRM moet nog gebouwd worden" | Bestaat sinds PR #1622 (`api/_lib/lms-hold.js`) en PR #1641 (`api/_lib/lms-stilte.js`, de commit waar deze sessie op staat). De aanmaanmotor zwijgt al bij een menselijke afspraak in het LMS. |
| "belofte betaaldatum … tot die datum stuurt Iris niets" | Bestaat als `MANUAL_CONFIRM_PROMISE` + `api/_lib/promise-maturity.js` + cron `cron-dunning-promise-maturity`. Inclusief rijping, coulance-dagen en gebroken-belofte-afhandeling. |

De gesprekken-module is ook geen kaal scherm: het is een driedelige weergave met
WhatsApp én mail in één draad, een klantpaneel met open facturen, een
template-kiezer, snelle antwoorden en een Joost-knop. Wat er ontbreekt is
scherp te benoemen (sectie 7) en dat is precies wat fase 3 gaat doen.

**Gevolg voor de bouw:** Iris wordt op meer plekken een *schil om bestaande
machinerie* dan een nieuwe machine. Dat is goedkoper, veiliger en sneller. Waar
ik daardoor van de masterprompt afwijk, staat het in sectie 9.

---

## 1. Het platform zelf

| | |
|---|---|
| Repo | `deforexopleiding-bit/forex-opleiding-interface`, branch `main` |
| Frontend | vanilla JS, geen framework. Eén shell-pagina met view-registratie. |
| Backend | 850 serverless functies in `api/*.js`, ES modules, Node 22 |
| Helpers | 250 modules in `api/_lib/` |
| Crons | **62** in `vercel.json` |
| Tests | 3638 asserties, `node --test`. Baseline: **2 rood**, de twee bekende. |
| Migraties | `docs/sql-migrations/*.sql`, 283 bestanden, datum-prefix |

### 1.1 De shell en de views — belangrijk voor waar Iris komt te wonen

Er is **geen** losse pagina per module meer. Alles hangt in
`modules/klanten-v2/index.html`, die per view één script inlaadt:

```html
<script src="views/wanbetalers-v2.js?v=53"></script>
```

Een view registreert zichzelf met twee regels aan het eind van zijn IIFE:

```js
window.DFO.VIEWS['binnenkort/'] = soonView;
if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('binnenkort');
else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('binnenkort');
```

en moet daarnaast in `V2_ACTIVE_ALLOWLIST` staan (`klanten-v2.js` regel 535),
anders navigeert de shell weg naar een legacy-URL. Met `?v2preview=<id>` kan een
view getoond worden zonder in de allowlist te staan — dat is het
voorproef-mechanisme en precies wat Iris in het begin nodig heeft.

De losse `.html`-bestanden in `modules/` (`finance.html`, `open-acties.html`, …)
zijn de oude weg. Nieuwe modules gaan door de shell.

> **Beslissing.** Iris' code komt in `modules/iris/` zoals de masterprompt
> vraagt, maar registreert zich als shell-view (`DFO.VIEWS['iris/']`). Zo houdt
> ze haar eigen map én krijgt ze de navigatie, de rechten en het uiterlijk van
> de rest van het CRM gratis. Een losse pagina zou alle drie opnieuw moeten
> bouwen. Zie sectie 9, beslissing B1.

### 1.2 Release-ritueel

`?v=` ophogen bij elke wijziging aan een view-bestand, anders krijgt de browser
de oude versie. Dat is geen stijlkwestie: de shell cachet agressief.

### 1.3 Rechten

`role_permissions` (rol × feature_key × allowed). De DB-functie
`user_has_permission()` doet een `EXISTS` op `allowed = true`, dus **een
ontbrekende rij is hetzelfde als een verbod**. Elke nieuwe `iris.*`-sleutel
heeft dus een migratie nodig die rollen toekent, anders zit de module dicht voor
iedereen behalve `super_admin`. Patroon:
`docs/sql-migrations/2026-09-04-opvolging-role-permissions.sql`.

Server-side: `requirePermission(req, 'sleutel')` → `false` wordt een 403.
Frontend: `window.RBAC.canSync('sleutel')` na `ensurePermissionsLoaded()`.

### 1.4 RLS

Harde regel uit `docs/rls-regels-nieuwe-tabellen.md`: elke nieuwe tabel in
`public` krijgt RLS aan én een policy met een rolcheck. Nooit `USING (true)`.
Het recept voor 95% van de gevallen:

```sql
ALTER TABLE public.mijn_tabel ENABLE ROW LEVEL SECURITY;
CREATE POLICY mijn_tabel_staff ON public.mijn_tabel
  FOR ALL TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());
```

Reden: `handle_new_user()` maakt bij élke signup een `profiles`-rij met rol
`viewer`. "Iedere ingelogde gebruiker" is dus ook elke student.

---

## 2. Het kanaal: hoe de gesprekken-module vandaag werkt

Dit is wat de masterprompt in sectie 1b vraagt uit te zoeken. Hier staat het.

### 2.1 Welke WhatsApp-koppeling

**Meta WhatsApp Cloud API, rechtstreeks, geen BSP.** Bevestigd in
`api/_lib/meta-whatsapp.js`:

- Graph API `v20.0`, basis `https://graph.facebook.com/v20.0`
- Versturen: `POST /{PHONE_NUMBER_ID}/messages`
- Templates lezen: `GET /{WABA_ID}/message_templates`
- Webhook-handtekening: `X-Hub-Signature-256`, HMAC-SHA256 over de rauwe body
  met het app-secret

Env-vars: `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`,
`META_WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_WHATSAPP_APP_SECRET`,
`META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

Het servicevenster van 24 uur en de templates daarbuiten kloppen dus, precies
zoals de masterprompt vermoedde.

### 2.2 Via welk nummer

Niet één nummer maar **meerdere lijnen, gerouteerd per module**. De tabel
`whatsapp_module_config` koppelt `phone_number_id` → `module`
(`finance` / `events` / `onboarding`) plus afdelingsgegevens
(`afdeling_telefoon`, `afdeling_email`, `afdeling_ondertekenaar`).

`api/_lib/module-context.js` doet de opzoeking **strikt**: geen match op een
actief `phone_number_id` betekent `null`, géén stille terugval naar `finance`.
Dat is met opzet zo gemaakt (de oude terugval liet Joost op event-leads
reageren alsof het wanbetalers waren).

**Iris hoort bij de `finance`-lijn**, want dat is de lijn van de
wanbetalers-gesprekken. Welk nummer daar concreet onder hangt staat in de
databank, niet in de repo — na te kijken in
`/modules/klanten-v2` → Instellingen, of met
`select module, phone_number_id, display_label from whatsapp_module_config`.

### 2.3 Welke endpoints en tabellen

**Tabellen** (`docs/sql-migrations/2026-06-07-whatsapp-inbox-foundation.sql`):

`whatsapp_conversations` — één rij per telefoonnummer, uniek op `phone_number`:

| kolom | betekenis |
|---|---|
| `customer_id` | gekoppelde klant, NULL = niet gekoppeld |
| `phone_number` | E.164 mét `+` |
| `status` | `open` / `closed` / `archived` |
| `last_message_at`, `last_message_preview` | voor de lijst |
| `unread_count` | teller |
| **`last_inbound_at`** | **de bron voor het 24u-venster** |
| `phone_number_id` | welke lijn (later toegevoegd) |

`whatsapp_messages`:

| kolom | betekenis |
|---|---|
| `direction` | **`in` / `out`** — let op, níet `inbound`/`outbound` |
| `meta_wamid` | UNIQUE → dit is de idempotentie-sleutel |
| `body`, `media_url`, `media_type` | inhoud |
| `template_name`, `template_variables` | bij template-sends |
| `status` | `queued` / `sent` / `delivered` / `read` / `failed` |
| `sent_at`, `delivered_at`, `read_at`, `failed_reason` | verzendstatus |
| `sent_by_user_id` | NULL bij automatisch |

> De `direction`-val is echt: `api/inbox-thread-unified.js` heeft er een
> expliciete normalisatie voor moeten inbouwen. Iris moet die val niet opnieuw
> in lopen.

`whatsapp_meta_templates` — lokaal beheerde templates met submit/approve-flow
naar Meta. `status` ∈ `LOCAL` / `SUBMITTED` / `APPROVED` / `REJECTED` /
`PAUSED` / `DISABLED`. Uniek op `(business_account_id, name, language)`. Plus
`meta_param_mapping` (jsonb) voor de named-placeholder-vertaling uit C4.

**Endpoints:**

| Endpoint | Doet |
|---|---|
| `api/inbox-webhook.js` (2044 r.) | Meta-webhook. GET = handshake, POST = inkomende berichten + statusupdates. |
| `api/inbox-conversations-list.js` | de lijst links |
| `api/inbox-messages-list.js` | alleen WhatsApp |
| **`api/inbox-thread-unified.js`** | **WhatsApp + mail chronologisch in één draad** |
| `api/inbox-conversation-context.js` | klant + open facturen + abonnementen + `window_open` |
| `api/inbox-send.js` | versturen: `text` / `template` / `image` / `document` / `video` |
| `api/inbox-send-template.js` (710 r.) | template met variabele-resolutie |
| `api/inbox-mark-read.js`, `-mark-unread.js` | gelezen-status |
| `api/inbox-link-conversation-to-customer.js` | handmatig koppelen |
| `api/inbox-conversation-set-status.js` | open / afgehandeld / gearchiveerd |
| `api/inbox-template-list.js`, `-quick-replies-list.js` | keuzelijsten |

**Rechten:** `finance.inbox.view` (lezen) en `finance.inbox.send` (versturen).
`inbox-send.js` doet een getrapte controle: eerst grof
(`finance.inbox.send` ∨ `events.simone.use` ∨ `onboarding.inbox.send`), dan fijn
op basis van `conv.phone_number_id` → module. Zo kan iemand met alleen
events-rechten niet namens finance versturen.

### 2.4 Hoe mail in hetzelfde gesprek komt

Via `api/inbox-thread-unified.js`, en dat is een wat rommelige constructie die
Iris moet kennen:

1. **WhatsApp** — `whatsapp_messages` op `conversation_id`.
2. **Inkomende mail** — `email_messages` op `customer_id`. Dus: **alleen als de
   conversatie aan een klant gekoppeld is, is er mail**. Geen koppeling = geen
   mail in de draad.
3. **Uitgaande mail** — `email_replies`, opgezocht via `ilike` op
   `to_address` = `customers.email`. Niet via een thread-id.

De richting van een mail wordt bepaald met een **hardgecodeerde lijst van onze
zeven mailboxen** (`OUR_MAILBOXES` in `inbox-thread-unified.js`). Staat het
afzenderadres erin → uitgaand, anders inkomend. Dat werkt, maar het is een
lijst op twee plaatsen (ook in `api/send-email.js`) en dus een driftrisico.

Achter de vlag `unified_inbox_enabled` (`api/finance-inbox-feature-flags.js`,
gelezen uit `joost_config.feature_flags` op module `finance`). Staat de vlag
uit, dan gebruikt de UI het oude `inbox-messages-list` en blijft dit endpoint
ongemoeid.

### 2.5 Welke templates goedgekeurd zijn

Staat in de databank, niet in de repo:

```sql
select name, language, category, status, approved_at
from whatsapp_meta_templates
where status = 'APPROVED'
order by name;
```

Wat ik in de code terugvind aan namen: de dunning-ladder
(`aanmaning_dag7` e.v.) en `opvolging_geen_reactie2`. Iris' template-keuze moet
hoe dan ook **op status filteren, niet op naam** — namen veranderen, `APPROVED`
niet.

### 2.6 Hoe het 24u-venster bepaald wordt

Op één plek, consequent: `last_inbound_at` op de conversatie.

```js
canSendText = (Date.now() - new Date(conv.last_inbound_at).getTime()) < 24*3600*1000;
```

- `api/inbox-send.js` — server-side poort. Buiten het venster: **422** met
  `error: '24h_window_expired'`.
- `api/inbox-thread-unified.js` — geeft `conversation.can_send_text` mee.
- `api/inbox-conversation-context.js` — geeft `conversation.window_open` mee.

De UI toont **alleen de eindtoestand** ("24u-venster is verlopen"), nooit
hoeveel tijd er nog rest. Dat is gat G3 in sectie 7.

---

## 3. Mail

### 3.1 Instroom — beter dan de masterprompt denkt

`api/sync-emails.js`, cron `*/5 * * * *`, IMAP via `imapflow`. **Zeven**
mailboxen, allemaal al actief:

```
leads · info · partners · administratie · onboarding · events · welkom
```

Wachtwoorden per mailbox in `IMAP_PASS`, `IMAP_PASS_INFO`,
`IMAP_PASS_PARTNERS`, `IMAP_PASS_ADMINISTRATIE`, `IMAP_PASS_ONBOARDING`,
`IMAP_PASS_EVENTS`, `IMAP_PASS_WELKOM`. Host in `IMAP_HOST` / `IMAP_PORT`.

Idempotent via `upsert(..., { onConflict: 'mailbox,imap_uid' })`. Per mailbox
geïsoleerd: een fout in één stopt de rest niet. Er is een tijdrem zodat de
functie binnen de Vercel-limiet blijft.

> **`onboarding@` wordt dus wél opgehaald.** De masterprompt zegt van niet.
> Dat betekent: **geen `cron-iris-mail-ophalen` nodig, geen
> `IRIS_IMAP_*`-variabelen nodig.** Dat scheelt een cron, een set secrets en een
> hele klasse bugs. Zie beslissing B2.

Wat wél ontbreekt: `onboarding@` heeft geen scherm. `inbox-v2.js` toont alleen
`administratie@` en `info@`. Dat is een UI-gat, geen infrastructuurgat.

De kolomnamen in `email_messages` wijken af van wat je zou verwachten —
`date_received` (niet `received_at`), `snippet` (niet `body_snippet`),
`category_confidence`, `category_reason`. `CLAUDE.md` waarschuwt hier al voor en
heeft gelijk.

### 3.2 Uitstroom

Twee wegen:

- `api/_lib/email.js` — dunne faalzachte mailer (`sendMail({to, subject, html})`).
  Strato SMTP via nodemailer, `smtp.strato.de:465`, TLS bij verbinding. Gooit
  nooit; geeft `{sent:false, reason}` terug.
- `api/send-email.js` — de volle weg, met `SMTP_ACCOUNTS` per mailbox,
  threading en opslag in `email_replies`.

**Bevestigd ontbrekend:** geen IMAP `APPEND` naar Verzonden. Onze uitgaande mail
staat alleen in `email_replies`, niet in de mailbox. Wie in Thunderbird of op
zijn telefoon kijkt, ziet zijn eigen antwoord niet. Dat is gat G7.

Threading (`In-Reply-To` / `References`) — `send-email.js` zet die headers in de
antwoordmodus. Voor koude uitgaande mail niet, wat logisch is.

---

## 4. De wanbetalersmodule ("Joost")

Groter dan de masterprompt suggereert, en zorgvuldig gebouwd. Niet aanraken
behalve waar sectie 1c het uitdrukkelijk vraagt.

- **UI:** `modules/klanten-v2/views/wanbetalers-v2.js` — **7377 regels**.
- **Motor:** `api/cron-dunning-engine.js` (elk uur) + ~25 helpers in `_lib/`
  (`dunning-engine`, `dunning-step-executors`, `dunning-office-hours`,
  `dunning-overdue-guard`, `dunning-skip-helpers`, …).
- **Poorten die al bestaan en die Iris moet respecteren:**
  - `dunning-overdue-guard.js` — nooit manen vóór de vervaldatum.
  - `dunning-office-hours.js` — kantooruren, met correcte zomer-/wintertijd.
  - `pending-actions-guard.js` — een openstaande handmatige taak blokkeert de motor.
  - `lms-hold.js` — actieve hold in het LMS blokkeert.
  - `lms-stilte.js` — menselijke afspraak in het LMS (`hlms_crm_stilte`) blokkeert.
  - `promise-maturity.js` — een betaaltoezegging blokkeert tot ze rijpt.
- **Tests:** ruim 20 testbestanden alleen voor dunning.

### De belangrijkste bevinding voor sectie 6.3 van de masterprompt

De gevraagde haak "laat Joost pauzeren bij een belofte of on hold" **bestaat
al**, twee keer zelfs, en netjes gedocumenteerd in `api/_lib/lms-stilte.js`:

- `lms-hold.js` leest `hlms_student_hold` rechtstreeks;
- `lms-stilte.js` leest het contract `hlms_crm_stilte` (`stil_tot`, `reden`,
  `door`, `bron`).

Beide staan bewust naast elkaar, met een uitgeschreven afweging over welke kant
van de fout goedkoop is (een dag later geld) en welke duur (verloren
vertrouwen).

`IRIS_PAUZEERT_JOOST` wordt daarmee een **derde, kleine bron** in dezelfde
poort: "bestaat er een actieve `iris_belofte` voor deze klant?" — niet een nieuw
mechanisme. Dat is een PR van tientallen regels in plaats van honderden, en hij
erft de bestaande tests. Zie beslissing B3.

---

## 5. Het LMS

Apart Supabase-project (`dfo-lms`, `absicpdidnoblirngiia`), benaderd via
`api/_lib/dfo-lms-db.js` met `DFO_LMS_SUPABASE_URL` +
`DFO_LMS_SUPABASE_SERVICE_ROLE_KEY`. Ontbreken ze, dan geeft de helper `null`
en slaat de aanroeper zijn werk over — nooit een crash.

Naamgeving is een valkuil en het bestand waarschuwt er zelf voor. Drie systemen
in één repo:

1. **Bubble** — het oude LMS (`_lib/bubble.js`).
2. **de trial-site** — `lms_gebruikers` / `lms_toegang` / `lms_producten`,
   **in het CRM-project**, van een collega. **Niet aanraken.**
3. **dfo-lms** — de `hlms_*`-tabellen. Dit is wat we bedoelen. Prefix in code:
   `dfo_lms` / `dfoLms`, nooit het kale `lms`.

Richting is altijd CRM → LMS. Bestaande bruggen:
`hlms_crm_factuurstand` (CRM schrijft, LMS leest) en `hlms_crm_stilte` (LMS
schrijft, aanmaanmotor leest).

Voor Iris' mentorsignalen (`hlms_signaal`) geldt: lezen mag met de bestaande
sleutel, schrijven naar het LMS nooit vanuit deze sessie.

---

## 6. Bellen

- **Softphone:** `modules/shared/klx-softphone.js`, SIP via `sip.js`.
  API: `KlxSoftphone.open({ phone, name, customerId, source, opvolgingTaakId })`
  en `KlxSoftphone.call(phone, { displayName, line, opvolgingTaakId })`.
- **Log:** `POST /api/softphone-call-log` → tabel `call_log`
  (`migrations/049_call_log.sql`): `to_number`, `line` (`nl`/`be`),
  `started_at`, `ended_at`, `duration_sec`, `outcome_hint` ∈
  `answered` / `no_answer` / `busy` / `failed` / `local_cancel`, plus een vrij
  `meta` jsonb-veld dat uitdrukkelijk bedoeld is voor context.
- **`local_cancel`** is precies de uitkomst "afgebroken vóór er opgenomen is"
  die de masterprompt bij de pogingtelling wil uitsluiten. Die hoeven we niet
  zelf te bedenken.
- **`meta` jsonb** betekent dat `irisDossierId` erin past **zonder
  schemawijziging** aan `call_log`. Zie beslissing B4.
- Dave's opvolging telt pogingen in `opvolging_pogingen`, leidend veld
  `resultaat`. Niet aanraken; Iris telt in `iris_belpogingen`.

---

## 7. De gesprekken-module: wat er is en wat eraan mankeert

Vooruitblik op `02-gesprekken-audit.md`; hier de grove vorm.

**Wat er is.** Drie kolommen. Links de gesprekslijst met zoeken, een
status-filter en sortering op ongelezen-eerst. Midden de verenigde draad
(WhatsApp + mail) met een compose-balk die per kanaal wisselt. Rechts een
klantpaneel: naam, mail, telefoon, "oudste X dagen te laat", open facturen,
abonnementen, MRR, en vijf directe actieknoppen (bekijk in klanten, maak
factuur, klant claimt betaald, leg afspraak vast, escaleren). In de compose-balk
zitten bijlage, template, snel antwoord, een Joost-knop, emoji, en een ⋮-menu
met bel-taak, regeling voorstellen en aanmaan-flow pauzeren.

Dat is niet niks. De gaten zitten elders:

| | Gat | Waarom het pijn doet |
|---|---|---|
| G1 | Geen microfoon | Elk antwoord moet getypt. De hele belofte van Iris hangt hierop. |
| G2 | Geen ongedaan-venster | Verstuurd is weg. Eén verkeerde klik naar een boze klant is onherstelbaar. |
| G3 | Venster alleen als eindtoestand | "Verlopen" zie je pas als het te laat is. Niemand weet dat er nog 40 minuten zijn. |
| G4 | Geen toewijzing | Niet te zien of Maxim of Dave dit oppakt. Twee mensen antwoorden, of niemand. |
| G5 | Filters te grof | Alleen status + zoeken. Geen "wacht op ons", "venster bijna dicht", "niet gekoppeld". |
| G6 | Mail hangt aan `customer_id` | Een niet-gekoppelde conversatie toont geen mail. Precies bij de gesprekken waar je context het hardst nodig hebt. |
| G7 | Geen kopie in Verzonden | Je eigen antwoord is buiten het CRM onvindbaar. |
| G8 | Geen paginering | `limit=1000` op de lijst, `limit=200` op de draad. Groeit mee tot het knapt. |
| G9 | Verzendstatus niet zichtbaar | `delivered_at` / `read_at` / `failed_reason` staan in de databank maar niet op het scherm. |
| G10 | `onboarding@` ontbreekt in het Inbox-overzicht | De mail komt binnen en staat in de E-mail-module, maar niet in de bronnenlijst van `inbox-v2.js`. |

G1, G2, G3 en G9 zijn het zwaarst en worden als eerste aangepakt.

---

## 8. Wat ik niet heb kunnen nakijken

Eerlijk zijn over de randen van deze inventaris:

1. **De databank.** De Supabase-koppeling in deze sessie ziet alleen een
   onverwant project; het CRM-project (`nsjnsvlmdhunzqkdvagm`) niet. Er zijn ook
   geen databank-credentials in de omgeving. **Gevolg: ik kan geen SQL draaien.**
   Alle migraties worden geschreven als bestand in `docs/sql-migrations/` en
   moeten door Maxim uitgevoerd worden. Dat is dezelfde werkwijze als de 283
   migraties die er al liggen, dus geen afwijking van de gewoonte — maar het is
   wel een afwijking van "je draait zelf additieve SQL-migraties" uit de
   masterprompt.
2. **Welk telefoonnummer** onder de finance-lijn hangt. Staat in
   `whatsapp_module_config`.
3. **Welke templates goedgekeurd zijn.** Staat in `whatsapp_meta_templates`.
4. **Of `hlms_signaal` al de types `uitstel` / `reageert_niet` / `halt` kent.**
   Daarom komt er een signaalcontract-document in plaats van een aanname.
5. **Productie-cijfers voor de audit** (laadtijd, aantal niet-gekoppelde
   gesprekken). Die meet ik in fase 3 op het echte scherm; wat ik hier geef zijn
   code-metingen (regels, `limit`-waarden, aantal klikken uit de opmaak).

---

## 9. Beslissingen die ik zelf genomen heb

**B1 — Iris wordt een shell-view, niet een losse pagina.**
Code in `modules/iris/` zoals gevraagd, maar geregistreerd als
`DFO.VIEWS['iris/']`. Anders bouwen we navigatie, rechten en uiterlijk opnieuw.
Eerst bereikbaar via `?v2preview=iris`, pas in de allowlist als hij staat.

**B2 — Geen eigen IMAP-poller.**
`onboarding@` komt al binnen via `sync-emails.js`. Een tweede poller op dezelfde
mailbox zou dubbele rijen, dubbele UID-boekhouding en een tweede set secrets
opleveren voor precies nul winst. `cron-iris-mail-ophalen` vervalt; Iris leest
uit `email_messages`. **Dit schrapt `IRIS_IMAP_HOST` / `_USER` / `_PASS` /
`IRIS_MAILBOXEN` uit de lijst van wat Maxim moet zetten.**

**B3 — De Joost-pauzehaak wordt een uitbreiding, geen nieuwbouw.**
`lms-hold.js` en `lms-stilte.js` doen dit al. `IRIS_PAUZEERT_JOOST` voegt één
bron toe aan dezelfde poort. Kleine PR, erft bestaande tests, zelfde faalzachte
gedrag.

**B4 — `irisDossierId` gaat in `call_log.meta`, niet in een nieuwe kolom.**
Dat veld is er uitdrukkelijk voor ("vrije context"). Geen migratie op een tabel
die de softphone van iedereen gebruikt.

**B5 — Iris hergebruikt de bestaande verzendfuncties, met één omhulsel.**
`api/_lib/iris/verzend.js` roept `inbox-send` / `send-email` aan zoals ze zijn.
Iris' eigen boekhouding (dat een bericht van Iris kwam, welk concept erachter
zat) staat in `iris_berichten`, gekoppeld via `meta_wamid` en de mail-id. Nul
wijzigingen aan de bestaande verzendweg, dus Joost merkt er niets van.

**B6 — Het 24u-venster krijgt één helper.**
`api/_lib/iris/venster.js`, met dezelfde rekensom als de drie bestaande plekken.
De bestaande plekken blijven ongemoeid; de nieuwe UI gebruikt de helper. Zodra
de nieuwe weg zich bewezen heeft, kunnen de oude erop over — dat is een latere,
losse opruiming, geen onderdeel van deze bouw.

---

## 10. Wat er aan Maxim gevraagd wordt (bijgewerkt)

Gebundeld in sectie 8 van de masterprompt; hier de versie na deze inventaris.
**Nog niets van dit alles is nu nodig** — alles wordt achter vlaggen gebouwd die
uit staan.

| Wat | Waarom | Wanneer |
|---|---|---|
| `ANTHROPIC_API_KEY` | staat er al (Joost, Simone) — niets te doen | — |
| `OPENAI_API_KEY` | spraak naar tekst — **optioneel, en niet gezet** | vervallen; zie hieronder |
| `IRIS_AAN` | hoofdschakelaar, default uit | fase 1 |
| `GESPREKKEN_V2` | nieuwe gesprekken-weergave naast de oude | fase 3 |
| `IRIS_PAUZEERT_JOOST` | belofte laat de aanmaanmotor zwijgen | fase 6 |
| ~~`IRIS_IMAP_*`~~ | **vervallen** — zie B2 | — |
| Migraties draaien | ik heb geen databank-toegang | per fase, ik meld het |
| Templates bij Meta | alleen als er echt geen passende bestaat | fase 10 |
| Autonomie aanzetten | per categorie, pas als hij het vertrouwt | fase 11 |

> **Besluit, 22 september: geen OpenAI.** Maxim gebruikt alleen Anthropic. Dat
> heeft één gevolg dat je moet weten: de Anthropic-API doet **geen spraak naar
> tekst** — Claude kan een opname niet beluisteren. De microfoon loopt daarom
> via de **Web Speech API van de browser** (`nl-BE`, Chrome en Edge). Wat
> daaruit komt gaat daarna gewoon naar Claude.
>
> `api/iris-transcribe.js` blijft staan als optionele weg: is er ooit tóch een
> `OPENAI_API_KEY`, dan wint die (nauwkeuriger bij eigennamen, en hij werkt in
> élke browser). Is hij er niet, dan is dat **een keuze en geen storing**, en
> hoort er dus ook geen foutmelding op het scherm te komen. Het scherm vraagt
> de weg vooraf op met een GET in plaats van een opname te sturen en op een 503
> te stuiten.
