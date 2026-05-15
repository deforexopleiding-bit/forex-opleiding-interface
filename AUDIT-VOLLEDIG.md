# Lessons Learned — forex-opleiding-interface

Chronologische verzameling van technische bevindingen en debuglessen opgedaan tijdens de bouw van het dashboard.

---

## 2026-05-14 — Role-architectuur + RLS rollout + Auth-gate volledig

### Wat is gebouwd

Hiërarchische role-based access control met strikte silo's:
- super_admin (Amigo): ziet alles platform-breed
- manager (Jeffrey, Maxim): alleen eigen werk, geen collega-managers, geen onderliggenden
- sales / mentor / administratie / viewer: schema voorbereid
- manager_id FK op profiles voor metadata (geen RLS-impact)
- UI-auth-gate: alle pagina's vereisen login, redirect via `/login.html?returnTo=<pad>`

### Schema-wijzigingen

- profiles_role_check uitgebreid naar 7 rollen
- profiles.manager_id uuid FK + index
- 6 owner-kolommen toegevoegd op 5 data-tabellen:
  - taken_items: owner_id, created_by_id
  - agent_meetings: owner_id
  - agent_conversations: user_id
  - email_replies: sent_by_id
  - undo_history: performed_by_id
- 349 bestaande rijen gebackfilled naar Amigo (super_admin)
- Helper functies: `is_super_admin()`, `is_manager_or_above()`, `is_admin()`

### RLS-rollout (17 tabellen + auth-gate UI)

**D1 batch 1** (cron-endpoints, super only):
- backfill_progress, backfill_body_progress

**C6.1** (5 tabellen) — authenticated read+write:
- kennisbank_items, agent_kennisbank, agent_learnings, learn_examples, email_actions

**C6.2** (5 tabellen) — owner+super:
- taken_items, agent_meetings, agent_conversations, email_replies, undo_history

**C6.3** (7 tabellen):
- email_patterns (authenticated)
- email_sync_log (super)
- email_messages (manager+)
- decisions (via meeting parent)
- agent_approval_queue (manager+)
- agent_audit_log (super)
- team_members (auth read, super write)

**C7 — UI auth-gate:**
- 7 module-pagina's: `requireAuth()` vóór data-fetches
- Pre-auth pagina's overgeslagen: login, auth-callback, reset-password
- Race-condition fix: `await window._authSharedReady` vóór `requireAuth()` (anders TypeError silent swallowed)

### Backend wijzigingen

- `api/supabase.js`: createUserClient(req) + ADMIN_ROLES const + verifyAdmin uitgebreid
- 9 endpoints naar createUserClient (endp-1A): email-actions, email-patterns, sent-replies,
  taken, undo, generate-reply, learn, send-email, kennisbank-sync
- 5 INSERT-handlers schrijven owner_id uit auth.uid() (C5): taken, agent-meeting,
  agent-chat, send-email, undo
- agent-meeting.js read-handlers via createUserClient (C6.2 fix)

### Frontend wijzigingen

- agent-shared.js: apiFetch wrapper + renderUserSection
- 22 call-sites naar apiFetch (endp-1A)
- 14 call-sites in meetings + agents naar apiFetch (C5 fix)
- 7 pagina's: `await _authSharedReady` + `requireAuth()` (C7)

### Validatie

- Anon: redirect naar login op ELKE pagina, 0 data-zichtbaarheid
- Jeffrey (manager): 1 eigen taak, 2 eigen meetings, 2 eigen conversations, 5677 inbox mails
- Amigo (super_admin): 9 taken, 30 meetings, 318 conversations, 5677 mails, 45 decisions
- Cron-jobs: service_role bypasst RLS correct
- ReturnTo flow: na login direct naar oorspronkelijk verzochte pagina

### Commits (2026-05-14)

| Hash | Beschrijving |
|------|-------------|
| f24491f | Pre-D1 refactor: two-client Supabase architectuur |
| bac5bc0 | Endp-1A backend: createUserClient op 9 endpoints |
| 708e8c3 | Endp-1A frontend: apiFetch wrapper + 22 call-sites |
| ba57a3f | C1: role-architecture doc |
| a130e04 | C2b: admin gates voor super_admin + manager |
| 93a7243 | C5: backend schrijft owner_id bij CREATE |
| 1978f00 | C5 fix: Authorization headers meetings + agents |
| bcb821f | C6.2 fix: read-handlers via createUserClient |
| c409033 | C7: auth-gate op alle module-pagina's |
| 4d69ebf | C7 fix: await _authSharedReady voor race-condition |

Plus via Supabase SQL-dashboard (geen commits):
D1 batch 1, C2 profiles-schema, C3 owner-kolommen, C4 backfill 349 rijen,
C6.1, C6.2, C6.3 RLS policies

### Belangrijke lessen geleerd

1. **Schema-veronderstellingen verifiëren vóór SQL.** Beleidsmatrix ging uit van uuid-owner
   kolommen, bestaande data was text. Schema-onderzoek vóór migratie voorkwam verkeerde policies.

2. **Frontend Bearer-header is fundamenteel voor RLS-keten.** Backend kan createUserClient
   correct gebruiken maar als frontend geen Authorization meestuurt, valt het terug op anon
   → RLS = 0 rows. Module-specifiek auditeren noodzakelijk.

3. **READ-handlers in dual-import endpoints zijn blinde vlek.** C5 INSERT-fix lijkt compleet
   maar RLS faalt bij SELECT als reads nog op anon supabase staan.

4. **UI-filters kunnen RLS-correctheid verbergen.** Taken-pagina filtert op
   pre-existing colleagues.id, niet auth.users.id. UI toont 0 terwijl API correct 1
   retourneert. API-laag altijd eerst verifiëren.

5. **Gefaseerd uitrollen redt project.** Eén grote SQL-batch had meerdere bugs tegelijk
   veroorzaakt. Sub-batches (C6.1/2/3) met smoke test tussen elk hielden diagnose simpel.

6. **Owner-text-data is fragiel voor RLS.** Velden zoals created_by = "Jeffrey" (text) niet
   bruikbaar voor auth.uid() matching. Schema-migratie naar uuid is essentieel.

7. **Anon-fallback is feature, geen bug.** Uitgelogde user ziet 0 rows via RLS; UI moet
   dit gracefully aan: redirect of CTA.

8. **Async race-conditions in init() zijn silent killers.** AuthShared was nog niet ready
   toen module init() draaide → TypeError door fire-and-forget gesloopt → silent gate bypass.
   Werkte "per ongeluk" op index.html door HTML-buffer tussen scripts.
   Fix: `await window._authSharedReady` vóór gate.

### Geparkeerde aandachtspunten

Zie TODO-VOLLEDIG.md polish sectie.

### Aanvulling — Post-RLS regressie-fix (commit a5a4c09)

Twee regressies ontdekt na sprint-afsluiting:

- **Dashboard zeros:** /api/dashboard-stats gebruikte anon supabase client + had in-memory cache. Na C6.2 RLS rollout: anon = 0 rows. Fix: createUserClient(req) + cache weg (voorkomt cross-user data-leak).

- **Admin-link sidebar template drift:** /index.html sidebar miste Admin-link, /modules/admin.html had het wel. Twee verschillende hardcoded sidebars in codebase. Fix: admin-link in 7 sidebars toegevoegd met role-toggle (display='' if ADMIN_ROLES.includes(profile.role)).

Smoke test: 8/8 groen. Per-user dashboard data correct geïsoleerd via RLS (Jeffrey ziet 2 eigen meetings, Amigo 30).

Polish-11, polish-12 geparkeerd voor latere sprint.

---

## Sessie 14 mei 2026 — Rol-architectuur + Endp-1A + C5 owner_id + C6.2 RLS prep

### Wat is gebouwd

- **Pre-D1 two-client refactor** (commit f24491f):
  * `createUserClient(req)` helper toegevoegd aan `api/supabase.js`
  * Per-request JWT-aware Supabase client; fallback naar anon bij geen Bearer token
  * `supabaseAdmin` (service_role) gescheiden van user-facing client
  * `verifyAdmin` + `logAudit` als shared auth helpers

- **Endp-1A: Bearer-only upgrade** (commits bac5bc0 + 708e8c3):
  * 9 browser-endpoints omgezet naar `createUserClient(req)`: email-actions, email-patterns,
    sent-replies, taken, undo, generate-reply, learn, send-email, kennisbank-sync
  * Frontend: `apiFetch` wrapper in `agent-shared.js` injecteert Authorization header
  * email.html (9 aanroepen), kennisbank.html, taken.html, agents.html bijgewerkt

- **C1 — Rol-architectuur document** (commit ba57a3f):
  * `docs/role-architecture.md` aangemaakt met volledig hiërarchisch RLS design
  * 5 rollen: super_admin → manager → admin → sales/mentor/administratie/viewer
  * RLS-policy patronen 1-5 gedocumenteerd + beleidsmatrix (21 tabellen × 3 operaties)
  * Implementatievolgorde C1–C6 vastgelegd als referentie-document

- **C2b — Admin gates uitbreiden** (commit a130e04):
  * `api/supabase.js`: `ADMIN_ROLES = ['super_admin','admin','manager']` in `verifyAdmin`
  * `api/admin-users.js`: VALID_ROLES uitgebreid + super_admin-grant guard (POST + PATCH)
  * `modules/admin.html`: `requireAuth` accepteert array van 3 rollen; dropdown + conditional
    super_admin visibility via JS; CSS badges voor super_admin (paars) en manager (cyaan)

- **C5 — Backend schrijft owner_id bij CREATE** (commit 93a7243):
  * `api/taken.js`: Optie A split — existence-check → INSERT met owner_id voor nieuwe taken,
    upsert zonder owner_id voor bestaande (voorkomt overschrijven)
  * `api/agent-meeting.js`: dual import pattern; `owner_id` bij `action === 'start'`
  * `api/agent-chat.js`: `user_id` op beide rijen via `createUserClient` insert
  * `api/send-email.js`: `sent_by_id` via `auth.uid()`
  * `api/undo.js`: `performed_by_id` via `auth.uid()`

- **C5 fix — Authorization headers voor meetings + agents** (commit 1978f00):
  * `modules/meetings.html`: 12 fetch-calls omgezet naar `AgentShared.apiFetch`
  * `modules/agents.html`: 2 fetch-calls omgezet naar `AgentShared.apiFetch`
  * Root cause: modules buiten endp-1A scope → geen Bearer → `auth.uid()` = null → owner_id NULL

- **C6.2 fix — READ-handlers in agent-meeting** (commit bcb821f):
  * 6 SELECT-branches in GET-handler omgezet naar `userClient` (i.p.v. anon `supabase`)
  * Root cause: C5 fixte alleen INSERT-branch; GET-branches bleven op module-scope anon client
  * Smoke test C-1 ✅ — Jeffrey ziet 1 eigen meeting, niet Amigo's 29

### Architectuur-beslissingen

- **Two-client model**: `supabase` (anon) voor niet-RLS tabellen (agents, agent_learnings);
  `createUserClient(req)` voor alle tabellen met RLS
- **Dual-import patroon**: `import { supabase, createUserClient }` — beide clients in hetzelfde
  endpoint voor gemengde tabellen (RLS + niet-RLS in één handler)
- **Optie A split (taken.js)**: existence-check vóór elke write — owner_id alleen bij INSERT,
  nooit bij UPDATE (prevents ownership hijack op bestaande taken)
- **ADMIN_ROLES constante**: single source of truth voor alle admin-gate checks in backend + frontend
- **Backward compat**: legacy text-velden (`created_by`, `performed_by`) behouden naast
  nieuwe UUID-kolommen (`owner_id`, `performed_by_id`) voor zachte migratie

### Lessons Learned tijdens deze sessie

**Les J — RLS-keten heeft vier schakels — elke schakel kan breken**
Een lege response-array (geen error, geen status 500) kan op vier plaatsen falen:
(1) Frontend stuurt geen Bearer header,
(2) Backend gebruikt geen `createUserClient`,
(3) `auth.uid()` evalueert als NULL,
(4) RLS-policy filtert de row weg.
Elk symptoom ziet er identiek uit. Diagnostisch protocol: (a) log `auth.uid()` server-side,
(b) check Authorization header in request-headers, (c) controleer of RLS al actief is op de tabel.

**Les K — Dual-import: module-scope is niet request-scope**
`agent-meeting.js` importeerde `supabase` op module-niveau (anon client, éénmalig aangemaakt bij
startup). Bij C5 werd de INSERT-branch gefixed, maar de vijf GET-branches bleven op de module-scope
anon client. Na C6.2 RLS go-live: alle GETs retourneerden leeg — geen error. Module-level singletons
zijn request-agnostisch. Alle RLS-queries moeten per-request een `userClient` aanmaken, ook in GET-branches.

**Les L — RLS fix scope strekt zich uit over alle branches**
Bij het upgraden van een endpoint naar `createUserClient`: maak eerst een lijst van alle
`.from()` calls in het bestand. `agent-meeting.js` had 6 SELECT-branches — alleen de INSERT-branch
werd in C5 gefixed. De overige 5 faalden na RLS go-live. Regel: Check het volledige bestand vóór
commit, niet alleen de branch die de bug vertoont.

**Les M — Frontend scope-grenzen zijn geen garantie voor volledigheid**
endp-1A had een expliciete scope van 9 endpoints. `meetings.html` viel buiten die scope en stuurde
nooit een Bearer token. `owner_id` bleef NULL voor alle nieuwe meetings na C5 deploy.
Regel: Na elke Bearer-upgrade op backend-endpoints — grep alle `fetch(` aanroepen die die endpoints
targeten en vervang door `apiFetch`. Een scope-grens in een plan beschermt niet tegen impliciete
aannames bij de caller.

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
