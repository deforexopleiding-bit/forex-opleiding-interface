# Lessons Learned — forex-opleiding-interface

Chronologische verzameling van technische bevindingen en debuglessen opgedaan tijdens de bouw van het dashboard.

---

## Sessie 14 mei 2026 — Auth Module Fase A+B

### Wat is gebouwd
- Database foundation auth (commit 1da21f8):
  * profiles tabel met 5 rollen + indexes
  * Trigger on_auth_user_created voor automatische profile creation
  * 4 helper functies: get_user_role, is_admin, has_role, has_any_role
  * 5 RLS policies op profiles (view own, view all admin, update
    admin, insert admin, update own)

- Seed endpoint (commit c8ac9dd):
  * api/admin-seed-users.js (one-time gebruik)
  * SEED_SECRET guard, alleen Jeffrey geseed
  * Cleanup: SEED_SECRET verwijderd uit Vercel na seed

- Login flow (commits faf5fda + 6e9ad91):
  * /login.html met Wachtwoord + Magic Link tabs
  * /reset-password.html
  * /auth-callback.html
  * modules/shared/supabase-client.js + window.AuthShared helper
  * api/config endpoint voor publieke Supabase keys
  * Fix: handleLogoError ReferenceError opgelost (vervangen
    door .brand-mark text div)

### Architectuur-beslissingen
- Supabase Auth (niet Clerk/Auth0): al onderdeel van Pro plan
- Email + wachtwoord + magic link (geen OAuth Google)
- 5 rollen: admin / sales / mentor / administratie / viewer
- Soft launch principe: bestaande modules werken zonder login
  tot Fase D klaar is

### Eerste users
- Jeffrey Biemold (admin) — biemoldjeffrey@gmail.com
- Maxim, Amigo, Dave worden via admin panel toegevoegd in Fase C

### Validatie
- Profile correct aangemaakt via trigger ✅
- Wachtwoord-reset flow getest ✅
- Eerste login succesvol via password ✅
- Bestaande modules ongebroken na deploy ✅

### Lessons Learned tijdens deze sessie

**Les A — handleLogoError ReferenceError op auth-pagina's**
Auth-pagina's (login.html, reset-password.html, auth-callback.html)
laden agent-shared.js NIET (pre-auth context). Een `<img onerror=
"handleLogoError()">` vuurt bovendien vóór het inline script
geparsed is (img staat midden in body, script onderaan). Dubbele
timing-fout. Oplossing: vervang img+onerror door een
`.brand-mark` tekst-div. Geen externe afbeelding, geen ReferenceError.

**Les B — Sensitive env vars niet leesbaar na opslaan in Vercel**
SEED_SECRET was aangemerkt als Sensitive in Vercel. Na opslaan
niet meer leesbaar in dashboard. Tijdens seed-call tijdelijk
geblokkeerd. Oplossing: setup-secrets (eenmalig gebruik) als
niet-Sensitive bewaren, OF waarde direct in 1Password opslaan
voor de setup-periode. Productie-keys (service_role, API keys):
wél Sensitive.

**Les C — Push-discipline: commit ≠ deploy**
Claude Code rapporteerde "commit geslaagd" zonder push. Dit
veroorzaakte meerdere testcycli (ook op 13 mei). CLAUDE.md
bijgewerkt: push-output letterlijk plakken is verplicht bij
elke taak.

**Les D — WhatsApp Coexistence niet beschikbaar voor EU-nummers**
Onderzocht voor Follow-up Module. Meta's Coexistence feature
(zakelijk + persoonlijk op één nummer) is niet beschikbaar voor
+31/+32 nummers. Architectuur bijgesteld: Dave handmatig via
eigen telefoon, module dient als digitaal afvinkpunt.

---

## Sessie 15 mei 2026 — Fase C Admin + Fase E Auth-Aware Sidebar

### Wat is gebouwd
- Admin panel (commits 1cdf138):
  * api/admin-users.js: GET/POST/PATCH/DELETE met verifyAdmin, logAudit, recovery link via Strato SMTP
  * modules/admin.html: user-management UI, self-row guard, resend invite

- Mini Fase E + auth-aware index (commits f06a37f):
  * agent-shared.js: renderUserSection() toegevoegd + geëxporteerd
  * index.html: supabase-client.js + agent-shared.js geladen, footer-user leeg, dynamic name in greeting

- Logo regression fix (commit c8aa3a3):
  * handleLogoError verwijderd uit alle 8 module-pagina's

- Fase E rollout (commit 82cccea):
  * email.html, taken.html, kennisbank.html, agents.html, meetings.html, control-center.html

### Lessons Learned tijdens deze sessie

**Les E — Diagnose vóór fix: verifieer de aanname**
Symptoom: sidebar toonde hardcoded "Jeffrey" i.p.v. ingelogde user. Verkeerde aanname:
getProfile() miste `.eq('id', user.id)` filter. De code was al correct. Werkelijke oorzaak:
index.html laadde supabase-client.js niet → window.AuthShared undefined → hardcoded HTML
bleef staan. Oplossing: scripts laden + footer-user leeg maken.
Regel: Verifieer werkende code vóór je hem "fixt". Lees het bestand eerst.

**Les F — Hardcoded fallbacks zijn tijdbommen**
`<div class="footer-user"><div class="footer-avatar">JB</div><span>Jeffrey</span>…</div>`
stond in elke module. Werkt prima zonder auth, maar blokkeert dynamische rendering zodra
auth beschikbaar is. De hardcoded tekst is altijd "winnen" van de async auth-check.
Regel: Hardcoded user-data in HTML is altijd tijdelijk. Maak het leeg bij implementatie
van de auth-laag — wacht niet op een aparte "opruim-sprint".

**Les G — Site-wide grep bij timing-bugs in gedeelde patronen**
handleLogoError was gefixed op auth-pagina's (Fase B, 14 mei), maar het identieke
`<img onerror="handleLogoError()">` patroon stond in 8 module-pagina's. Alleen ontdekt
door expliciete `grep -r "handleLogoError"` na de Fase B fix.
Regel: Bij een timing-bug in één bestand: voer altijd een site-wide grep uit op het patroon.
Partiële fixes creëren valse zekerheid — het systeem lijkt gerepareerd maar andere
instanties falen nog steeds.

**Les H — Cross-tool werkwijze: regie versus uitvoering**
Chat-Claude (web/app) = regie, planning, prompts schrijven.
Claude Code (terminal) = file-operaties, git, commits.
Claude in Chrome (extensie) = browser-acties, live validatie.
Regel: Elke tool heeft één rol. Claude Code voert nooit browser-tests uit. Claude in Chrome
schrijft nooit code. Chat-Claude schrijft kant-en-klare prompts voor elke overdracht —
geen halve instructies waarbij de andere tool zelf moet invullen.

**Les I — Scope creep detectie in planfase**
Een plan file bevatte onbedoeld vier onderwerpen tegelijk: vergaderruimte redesign,
agents.html splitting, Fase E rollout, én infrastructuur-updates. Jeffrey herkende het
direct en verwierp het plan.
Regel: Een plan-bestand heeft één onderwerp. Als het plan meer dan één "## Commit"-sectie
bevat, of meer dan drie bestanden aanraakt die geen directe samenhang hebben, is de scope
te breed. Schrijf het plan opnieuw.

---

## Fase C sessie — 2026-05-13

### Les 1 — Silent INSERT failures: controleer kolomtypes (commit `2c5385b`)

**Symptoom:** `POST /api/agent-meeting` met 3 action points → response `{ ok: true, tasks_created: 0 }`. Geen foutmelding, loop loopt gewoon door.

**Oorzaak:** Kolom `taken_items.assigned_to_id` heeft type `uuid`. De code stuurde de agent-naam `'Simon'` als string. Postgres gooit een `invalid input syntax for type uuid: "Simon"` error. Deze werd gevangen door de try/catch in de loop — maar de task werd niet geteld, resultaat: 0 taken aangemaakt met een misleidende `ok: true`.

**Oplossing:** `toUuidOrNull()` helper die een waarde alleen doorlaat als het een geldig UUID-patroon heeft, anders `null`:
```js
function toUuidOrNull(id) {
  if (!id) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}
```
Agents krijgen `assigned_to_id: null`; teamleden krijgen hun echte UUID.

**Algemene regel:** Verifieer altijd het werkelijke Supabase-schema vóór INSERT-queries. Postgres valideert kolomtypes strikt. Silent failures zijn extra moeilijk te debuggen als try/catch te breed is — overweeg de error message altijd mee te retourneren in de response.

---

### Les 2 — HTML-attribuut afgeknot door dubbele JSON.stringify (commit `c26588f`)

**Symptoom:** Dropdown-optie verschijnt correct, maar `onmousedown` vuurt niet. Drie verschillende klik-methoden geprobeerd — geen werkt. `getBoundingClientRect` geeft `{w:0, h:0}`.

**Oorzaak:** Template string gebruikte `JSON.stringify(JSON.stringify(o))`. De binnenste stringify geeft `'{"id":"...","name":"..."}'`, de buitenste geeft `'"{\\"id\\":\\"...\\"}"'`. Het resultaat begint met `"` (aanhalingsteken). De HTML-parser ziet dit als het *einde* van het attribuut — de rest van de handler wordt weggegooid. Functie wordt nooit geregistreerd.

**Oplossing:** Gebruik integer-indices in onclick/onmousedown-handlers i.p.v. geserialiseerde objecten:
```js
// FOUT — HTML-parser knipt af bij de tweede quote:
html += `<div onmousedown="selectAssignee(${idx}, ${JSON.stringify(JSON.stringify(o))})">`;

// GOED — integer-index is altijd veilig in HTML-attribuut:
html += `<div onmousedown="selectAssignee(${idx}, ${reviewAssigneeOpts.indexOf(o)})">`;
function selectAssignee(idx, optIdx) {
  const o = reviewAssigneeOpts[optIdx]; // opzoeken via gedeelde module-array
}
```

**Algemene regel:** Zet nooit geserialiseerde objecten in HTML-attribuut-waarden. Gebruik altijd primitieve waarden (integers, IDs). Sla objecten op in een gedeelde JS-array of in een `data-`-attribuut via `dataset` (dat escaped automatisch).

---

### Les 3 — Schema-first bij grote batches: vertrouw het werkelijke schema, niet de prompt

**Context:** De Fase C spec gebruikte kolomnamen die niet overeenkwamen met het werkelijke Supabase-schema:

| Spec-term | Werkelijke kolom |
|-----------|-----------------|
| `action_type` | `action` |
| `title` (aparte kolom) | opgeslagen in `payload.title` (jsonb) |
| `category_confidence` | `confidence` (integer 0-100) |
| `sender` | `from_address` / `from_name` |

**Aanpak:** Vóór het schrijven van queries: lees het werkelijke schema uit de migration-bestanden of een korte Supabase-query. Schrijf een overzichtstabel (spec-term → werkelijke kolom) vóórdat je aan de implementatie begint.

Genormaliseerde keuzes zijn vaak beter dan de originele spec:
- `action` i.p.v. `action_type` (kortere kolomnaam, consistenter met REST-conventies)
- `payload jsonb` i.p.v. aparte `title`-kolom (flexibeler voor uitbreidingen zonder migraties)
- FK via uuid i.p.v. duplicatie van gerelateerde data

**Algemene regel:** Bij batches van meerdere bestanden: begin altijd met een schema-verificatiestap als eerste actie. Schrijf geen queries op basis van spec-aannames.

---

### Les 4 — Geautomatiseerde browser-tests: gebruik ref_id en form_input, geen coordinate-clicks

**Context:** Bij browser-automatisering via Claude in Chrome zijn coordinate-clicks onbetrouwbaar — elementen kunnen buiten de viewport vallen of de positie kan verschuiven bij rendering.

**Regels:**
1. Gebruik altijd `ref_id` van `read_page` om elementen te identificeren, nooit absolute pixel-coördinaten.
2. Gebruik `form_input` voor tekstvelden — dit voorkomt de submit-bug waarbij een `Enter`-keypress na tekst direct het formulier indient.
3. Stuur single-line tekst i.p.v. multi-line om onbedoelde newlines en vroege submits te voorkomen.

---

## Fase 2 sessie — 2026-05-13

### Les 5 — IMAP body-fetch met ImapFlow + mailparser

**Context:** Body-fetch toegevoegd aan live-sync en backfill. Twee keuzes werken goed samen:

**Techniek:**
```js
const bodyMsg = await client.fetchOne(uid, { source: true }, { uid: true });
const parsed  = await simpleParser(bodyMsg.source, { skipImageLinks: true });
// parsed.text = plain-text, parsed.html = HTML
```
- `fetchOne` met `{ source: true }` geeft het volledige RFC822 bericht terug als Buffer
- `simpleParser` (mailparser) handelt MIME-parsing, charset-conversie en multipart af
- `skipImageLinks: true` voorkomt dat embedded images als grote base64-blobs worden geparsed

**Garantie:** Altijd try/catch per mail — een body-fout mag nooit de envelope-sync breken:
```js
try {
  // body fetch + update
} catch (bodyErr) {
  row.body_fetch_error = bodyErr.message.slice(0, 200);
  // Geen body_fetched_at → backfill pakt dit niet opnieuw op
}
```

**Storage-beslissing:** Supabase Pro (8GB) geeft voldoende ruimte voor text + HTML beide op te slaan. Bij 5613 mails × ~10KB gemiddeld = ~55MB. Groei van 1-2 jaar is comfortabel binnen de limieten. Geen compressie of pruning nodig.

---

### Les 6 — Verouderde kolomnamen in parallelle bestanden

**Symptoom:** `executeIdentifyPaymentConcerns` en `executeDraftPaymentReminder` in `agent-tool-executor.js` gebruikten `received_at`, `confidence`, `body_snippet` — terwijl de live tabel `date_received`, `category_confidence`, `snippet` heeft.

**Oorzaak:** `agent-tool-executor.js` was geschreven vóór de Fase 3-correcties in `agent-tools.js`. Twee bestanden querien dezelfde tabel onafhankelijk, waardoor de schema-fix niet automatisch doorwerkte.

**Algemene regel:** Bij schema-wijzigingen of schema-correcties: altijd een grep doen op de gewijzigde kolomnamen (`grep -r "received_at" api/`) om alle bestanden te vinden die de tabel bevragen. Schema-correcties in één bestand verbergen fouten in parallelle bestanden.

---

## Eerdere sessies

*(Fase A, B, C — zie commits tot en met 9adb307)*
