# Agency Command Center — De Forex Opleiding

Permanent geheugen voor Claude Code. Lees dit aan begin van elke sessie.

## Project
Agency Command Center voor De Forex Opleiding NL B.V. — eigen 
operationeel AI agent platform met 3 agents (Simon voor mail, Leon 
voor administratie, Aron voor financieel). Multi-agent vergaderruimte, 
approval-flow, audit logging, mail-sync infrastructuur.

Live op: https://forex-opleiding-interface.vercel.app
Repo: https://github.com/deforexopleiding-bit/forex-opleiding-interface
Lokaal: C:/Users/jeffr/forex-opleiding-interface

## Stack
- Frontend: Vercel + HTML/CSS/JS (vanilla, geen framework)
- Backend: Vercel serverless functions (Node.js, ES modules)
- Database: Supabase Pro (8GB plan, eu-central-1)
- AI: Anthropic Claude (Sonnet 4.6 voor agents, Haiku 4.5 voor 
  classificatie)
- Mail: IMAP Strato — 4 mailboxen: leads, info, partners, 
  administratie
- Auth: Supabase Auth (email/wachtwoord + magic link, 7 rollen: super_admin/admin/manager/sales/mentor/administratie/viewer)

## Auth & secrets
- CRON_SECRET in environment variables (Vercel + 1Password)
- SUPABASE_URL + SUPABASE_ANON_KEY in env vars (publiek — ook browser-side via /api/config)
- SUPABASE_SERVICE_ROLE_KEY in env vars (sensitive — alleen server-side)
- ANTHROPIC_API_KEY in env vars
- Strato IMAP credentials per mailbox in env vars

## Productie-users
- Jeffrey Biemold — biemoldjeffrey@gmail.com — rol: manager
- Amigo — super_admin (systeem-account, ziet alles platform-breed)
- Maxim, Dave: nog aan te maken via /modules/admin.html

## RLS-status (2026-05-15)
- 17 tabellen met actieve RLS-policies (volledig live na C6.1/6.2/6.3)
- Auth-gate actief op alle 7 module-pagina's (requireAuth vóór data-fetches)
- Pattern: alle module init() doen await window._authSharedReady + requireAuth()
- dashboard-stats.js gebruikt createUserClient(req) — RLS-aware

## Bekende Beperkingen
- Klanten-module RLS: authenticated-read-all op customers (PII) — pattern consistent met
  migratie 003. Fijnmazige toegangscontrole (eigen vs alle klanten, AVG-acties) wordt
  afgedwongen op API-laag via requirePermissionFailOpen in Fase 2.

## Architectuur — Role-Based Access Control
- ADMIN_ROLES = ['super_admin', 'admin', 'manager'] — in api/supabase.js
- createUserClient(req): per-request JWT-aware Supabase client (api/supabase.js)
- apiFetch: frontend wrapper die Bearer-token injecteert (modules/shared/agent-shared.js)
- window._authSharedReady: Promise van async IIFE in supabase-client.js; ALTIJD awaiten vóór AuthShared
- requireAuth(roles?): checkt sessie + profiel.is_active + rol; redirect naar /login.html?returnTo=...
- Sidebar admin-link: zichtbaar als ADMIN_ROLES.includes(profile.role), standaard display:none

## Open polish-items (2026-05-15)
- polish-11: dashboard open_taken semantiek (deadline-filter vs status='open')
- polish-12: admin UI knoppen misleidend voor manager (server-side 403 werkt, UI niet)
- Zie TODO-VOLLEDIG.md ## 🔧 Polish-items voor volledige lijst

## Volgende prioriteiten
1. Maxim + Dave aanmaken via /modules/admin.html
2. polish-11 / polish-12 oppakken
3. endp-2-cleanup: one-time endpoints verwijderen (admin-seed, db-migrate, debug-*, test-*)

## Module-architectuur
- /index.html — Dashboard
- /modules/klanten.html — Klantenbeheer (🚧 Fase 1 fundament: DB + RBAC + placeholder)
- /modules/email.html — E-mail beheer
- /modules/taken.html — Takenbeheer
- /modules/kennisbank.html — Kennisbank
- /modules/agents.html — 1-op-1 chat met agents
- /modules/meetings.html — Vergaderruimte
- /modules/control-center.html — Approvals + Audit log
- /modules/admin.html — Gebruikersbeheer (ADMIN_ROLES: super_admin/admin/manager) +
  Approval-queue tab (#approval-queue) voor D-module payment-arrangements
- /modules/taken.html — Centraal taken-dashboard (F1) voor alle handmatige
  verificaties. Toont 2 task-categorieën uit `pending_actions`:
  * `arrangement` — alle TL_* action_types uit D1 (TL_INVOICE_UPDATE_DUE,
    TL_INVOICE_SPLIT, TL_SUBSCRIPTION_PAUSE, TL_SUBSCRIPTION_STOP,
    TL_INVOICE_WRITEOFF)
  * `verify_payment` — MANUAL_VERIFY_PAYMENT (klant claimt al betaald,
    aangemaakt vanuit WhatsApp-inbox via tasks-create-verify-payment).
    arrangement_id=NULL, dus mark-executed skipt de arrangement-cascade.
  Endpoints: tasks-list / tasks-create-verify-payment. RBAC: finance.tasks.view
  / finance.tasks.create met fallback naar finance.arrangements.view/propose.
  Zie docs/tasks-f1-foundation.md voor roadmap F2-F4.
- D-module (payment-arrangements) — DB-fundament + approval-queue + propose-wizard
  in /modules/finance.html (Wanbetalers-tab). Hoofdnav-badge op Admin-link toont
  PENDING-count; klik → /modules/admin.html#approval-queue. Zie
  docs/payment-arrangements-d1-foundation.md voor architectuur + roadmap (D2-D6).
- /modules/shared/agent-shared.js — cross-modulaire functies 
  (showToast, esc, formatMd, relTime, showReport, approval-helpers,
   getAvatarUrl, renderUserSection, initAuth)
- /modules/shared/agent-shared.css — gedeelde styling
- /modules/shared/supabase-client.js — browser Supabase client +
  window.AuthShared (getSession, getUser, getProfile, signOut,
  requireAuth, getAccessToken)

Auth-pagina's (pre-login, laden agent-shared.js NIET):
- /login.html — Login (wachtwoord + magic link)
- /reset-password.html — Wachtwoord instellen
- /auth-callback.html — Magic link exchange
- /api/config.js — publieke Supabase keys voor browser

## Database schema waarheid
KRITIEK: db-migrate.js kan VEROUDERD zijn. Lees autoritatieve 
sync-bestanden voor werkelijke kolomnamen.

Werkelijke kolomnamen email_messages (bron: sync-emails.js):
- id = uuid (NIET bigint)
- date_received (NIET received_at)
- snippet (NIET body_snippet)
- category_confidence (NIET confidence)
- category_reason (NIET ai_source)
- from_address, from_name (correct)
- mailbox, imap_uid, subject, category (correct)
- body_text, body_html, body_fetched_at, body_truncated, 
  body_fetch_error (Fase 4)

Werkelijke kolomnamen agent_approval_queue:
- action (NIET action_type)
- payload jsonb (geen aparte title/preview_data kolommen)
- approved_by, approved_at, rejected_at, reject_reason
- meeting_id (uuid)
- created_at, expires_at

Werkelijke kolomnamen agent_audit_log:
- action (NIET action_type)
- payload + result jsonb
- status (text, NIET success boolean)
- approval_id (uuid FK)
- triggered_by

Werkelijke kolomnamen profiles (auth — aangemaakt 14 mei 2026):
- id uuid REFERENCES auth.users(id) PRIMARY KEY
- email text UNIQUE NOT NULL
- full_name text
- role text CHECK (super_admin/admin/manager/sales/mentor/administratie/viewer)
- manager_id uuid REFERENCES profiles(id) (FK voor hiërarchie)
- is_active boolean DEFAULT true
- team_member_id uuid REFERENCES team_members
- avatar_url text
- created_at, updated_at, last_login_at timestamptz
- created_by uuid REFERENCES auth.users

Werkelijke kolomnamen team_members:
- id uuid
- name text
- role text
- type text (medewerker / mentor / etc)
- email text
- avatar_emoji, avatar_color text
- is_active boolean
- created_at timestamptz

## Werkwijze
1. ALTIJD eerst plan voor non-triviale taken (3+ stappen of nieuwe 
   architectuur). Plan rapporteren, wachten op groen licht, dan pas 
   bouwen.
2. Eén logische commit per task. Geen mix van features.
3. Commit messages: type prefix (feat:, fix:, refactor:, docs:)
4. Push naar main (--no-verify om husky-hooks te skippen indien nodig)
5. Test-instructies geven NA elke push, in stappenformaat
6. Bij twijfel: stop en vraag, niet blind doorgaan

## Cross-tool werkwijze (chat ↔ Claude Code ↔ Claude in Chrome)

Bij elke taak waar tools nodig zijn, voorziet de chat-Claude (Anthropic 
web interface) Jeffrey direct van kant-en-klare prompts. Geen 
uitzonderingen, geen excuses. Jeffrey hoeft nooit "maak een prompt" 
te vragen — die zit altijd al in het antwoord verwerkt.

Tool-verdeling:
- Chat-Claude (web/app): regie, planning, review, prompts schrijven, 
  lessons learned bewaken, sparren over aanpak
- Claude Code (terminal): file lezen/schrijven, git, commits, lokale 
  scripts, package installs
- Claude in Chrome (extensie): browser-acties — Supabase dashboard, 
  Vercel dashboard, frontend live testen, screenshots maken, DevTools 
  inspectie

Wanneer welke prompt:
- Code aanraken, commit, push → Claude Code prompt
- Browser interactie, dashboard check, live test → Claude in Chrome prompt
- Allebei nodig → twee prompts in volgorde (eerst Code, dan Chrome 
  voor validatie)

Format prompts:
- Altijd in een ```...``` code block
- Begin met context (1-3 zinnen wat de taak is)
- Daarna stappen
- Eindigen met "wat NIET doen" + "wanneer stoppen"
- Bij Claude Code: anti-patterns + push-discipline expliciet
- Bij Claude in Chrome: "geen wijzigingen, alleen rapporteren" tenzij 
  expliciet anders

Als chat-Claude per ongeluk een antwoord geeft zonder prompt waar er 
een hoort: Jeffrey herinnert hem, en chat-Claude voegt de prompt direct 
toe aan het bericht. Dat is een fout, niet een normaal patroon.

## VERPLICHTE COMMIT-WORKFLOW

Een commit zonder bewezen push is GEEN voltooide taak.

Bij elke logische taak:
1. Maak commit met logische message
2. Run: git push origin main
3. Plak de letterlijke output van git push in het rapport
   (bv. "63f03e4..907a8f1 main -> main")
4. Wacht 30 sec voor Vercel auto-deploy
5. Bij kritieke wijzigingen: verifieer met curl/HTTP dat
   live URL bijgewerkt is
6. PAS DAN melden "klaar"

Bij conflicten of "rejected" errors: STOP, geen --force,
rapporteer en wacht op instructie.

ANTI-PATTERN: rapporteren "Commit X geslaagd" zonder push-output.
Dit veroorzaakte op 13-14 mei 2026 meerdere testcycli omdat commits
nooit gepusht waren (vergaderruimte fixes 907a8f1 en auth foundation).

## Code-stijl
- Nederlandse strings in UI, Engelse code/comments
- Async/await > callbacks of .then-chains
- Try/catch per loop-iteratie (geen silent failures)
- Awaited inserts (geen fire-and-forget met .catch)
- Bij UUID kolommen: NULL als sentinel, geen 0 of "0"
- Bij Supabase queries: ALTIJD letterlijke kolomnamen verifiëren
- Geen JSON.stringify(JSON.stringify()) in HTML-attributen
- React-style state: vermijd; gebruik plain JS objecten

## Lessons Learned
Bij sessie-start lees AUDIT-VOLLEDIG.md. Voorkomt herhaling van 
deze fouten:

1. Fire-and-forget .catch() patroon werkt niet (lazy thenable). 
   Gebruik const {error} = await pattern.
2. HTML-parser breekt op JSON.stringify(JSON.stringify(o)) in 
   attributen — gebruik integer indices.
3. Loops over arrays: try/catch per item, nooit early-return op 
   één faal-item.
4. UUID cursor mismatches in backfill-jobs: gebruik status-flags 
   als impliciete cursor in plaats van last_processed_id.
5. Vercel functions hard timeout: 60s. Lange runs: checkpoint 
   mechanisme.
6. React re-render bij disabled→enabled buttons: ref kan stale 
   worden. Bij browser-tests: refresh after form_input.
7. Schema-conflict bij migraties: db-migrate.js soms verouderd, 
   sync-bestanden zijn autoritatief.
8. Bij grote refactoring: oude kolomnamen kunnen in parallelle 
   bestanden blijven hangen. Periodieke grep helpt.
9. Bij storage-keuzes: Pro plan geeft 8GB headroom voor 1-2 jaar 
   groei zonder zorgen.
10. Push verifiëren NOOIT overslaan. Claude Code rapporteert
    soms "commit X gemaakt" terwijl push niet is gebeurd.
    Dit kostte op 13-14 mei meerdere testcycli. Push-output
    letterlijk plakken is verplicht.
11. Auth-pagina's (pre-auth) laden NIET agent-shared.js.
    Bij kopiëren van sidebar-templates: verwijder
    onerror="handleLogoError()" — functie bestaat alleen in
    agent-shared.js dat hier niet beschikbaar is.
12. Sensitive env vars in Vercel zijn niet meer leesbaar na
    opslaan. Voor setup-secrets (zoals SEED_SECRET): Sensitive
    UIT houden, of waarde direct in 1Password bewaren. Voor
    productie-keys (service_role, API keys): wel Sensitive.
13. WhatsApp Coexistence werkt NIET voor EU-nummers (NL +31,
    BE +32). Bij Follow-up Module: Dave handmatig vanaf eigen
    telefoon, geen Business API + telefoon-coexistence.
14. Auth foundation soft launch principe: bouw login + admin
    panel WITHOUT verplichte auth op bestaande modules.
    Pas in Fase D voorzichtig RLS toepassen, gefaseerd over
    3 sub-sprints om data-zichtbaarheid niet te breken.

## Geheugen-bestanden
- AUDIT-VOLLEDIG.md: Lessons Learned + architectuur-historie
- TODO-VOLLEDIG.md: parkeer-lijst features + bugs + roadmap
- CLAUDE.md (dit bestand): permanente instructies

## Claude Code instructies
1. Lees AUDIT-VOLLEDIG.md aan start sessie voor Lessons Learned
2. Verifieer werkelijk database-schema voor je queries schrijft 
   (information_schema query of read sync-bestanden)
3. Bij bug-fix: check TODO-VOLLEDIG.md of het bekend probleem is
4. Verification before done: test mentaal voor je commit
5. Self-improvement loop: na correcties, update AUDIT-VOLLEDIG.md 
   met geleerde les
6. Bij context-window risico: stop op natuurlijk punt, geef status 
   zodat volgende sessie kan doorgaan
7. Subagent strategie: voor grote refactoring overweeg splitsing 
   in losse sessies (Plan → Code → Test)
8. Demand elegance: bij non-triviale changes vraag jezelf "is er 
   een elegantere oplossing?". Niet over-engineeren voor simpele 
   fixes.
9. Pause-momenten respecteren bij grote batches
10. Soft-launch principe bij auth: bouw login + admin foundation
    voor je RLS toepast op bestaande tabellen.
11. Bij MCP/external API integraties: eerst onderzoek wat
    technisch kan (web search, documentatie lezen) VOOR plan
    schrijven. Voorkomt plannen voor onhaalbare features.

## Cron jobs
Lopend op Vercel:
- /api/sync-emails (*/5 min) — live mail sync
- /api/backfill-emails (*/5 min) — metadata backfill
- /api/backfill-bodies (*/5 min) — body content backfill
- /api/agent-expire-approvals (0 * * * *) — verloop approvals
- /api/standup-weekly (maandag 08:00) — wekelijkse standup

## Bekende externe systemen (nog niet geïntegreerd)
- Mollie API — voor betalingen (Aron's payment tools wachten hierop)
- Teamleader — CRM data
- Bubble LMS — student management
- e-boekhouden — boekhouding (Rogier extern)
- GoHighLevel — marketing automation
- Discord — community
- Trustpilot — reviews (4.8, 85+ reviews)

## Lessons Learned — 19 mei 2026 sessie

### SQL & Database
- Voor toekomstige migraties: ALTIJD eerst Claude in Chrome pre-flight schema-check voordat we ALTER/INSERT/UPDATE schrijven. Schema-aannames (naam vs full_name, warmte vs warmte_score) hebben meerdere uren werk gekost.
- PostgREST alias-syntax in supabase-js: gebruik `alias:column` ipv SQL `column AS alias`. SQL-style is foutgevoelig (typo "full_nameASnaam" zonder spaties veroorzaakt runtime error).
- CHECK constraints na rename-operaties: code wijzigingen die nieuwe enum-values introduceren MOETEN gepaard gaan met ALTER constraint EERST, anders falen alle inserts stilletjes.

### Vercel Functions debugging
- ALTIJD console.error in fail-branches van API-handlers. `errors++` counter zonder console.error maakt debugging onmogelijk (3,5 uur stilstand niet zichtbaar in Vercel logs zonder error-text).
- Function-level summary-logs zoals `[handler] done: { errors: 395 }` zijn nutteloos zonder individuele error-text — laat altijd minstens de eerste 3 errors per invocation door.

### Frontend rendering
- Voor date-vergelijking in UI: gebruik NOOIT `toISOString().split('T')[0]` voor day-matching. UTC-conversie veroorzaakt off-by-one bij timezone-grens. Gebruik `getFullYear/Month/Date` van Date-objecten in lokale tijd.
- Position:fixed dropdowns vereisen handmatige positioning via getBoundingClientRect + scroll-listener om te sluiten bij scroll.

### GHL integratie
- Custom Conversation Provider config zit op agency-niveau. Location-admin (onze toegang) kan webhook-URLs niet beheren. Voor outbound message visibility: poll-cron uitbreiden via API is praktischer dan workflow-trigger zoeken.
- conversations.readonly scope is vereist voor /conversations/search endpoint. /conversations/message.readonly geeft alleen losse messages.

### Werkstroom
- Drie-rol-pattern (chat-Claude regie / Claude Code filesystem / Claude in Chrome browser) werkt goed voor complexe productie-wijzigingen.
- Voor destructive SQL (DELETE/ALTER): Claude in Chrome bereidt voor, Jeffrey klikt Run. Pattern succesvol in 4 SQL-incidenten deze sessie.
- Mini-fix commits direct na grote commit zijn beter dan grote commit later corrigeren — toont bug-fix transparant in git-history.

## Lessons Learned — 20 mei 2026 sessie

### Diagnose & debugging
- Stop-and-diagnose spaart uren: bij "no_show wordt onverwacht gezet" waren er 4 mogelijke paden
  (poll-cron mapGhlStatus, no-show-detect cron PAD A, PAD B, outcomes endpoint). Eerst alle paden
  lezen met grep vóór je iets wijzigt — voorkwam 3 verkeerde fixes.
- Partial unique index kan GEEN ON CONFLICT arbiter zijn in PostgREST/supabase-js.
  Oplossing: 2-step SELECT → UPDATE/INSERT pattern (zie follow-up-ghl-appointment-poll.js commit 4ed1331).

### API & sync
- Validate-first > try-then-recover voor sync-kritieke flows: bij GHL/DB sync moet externe API-call
  ALTIJD blocking-first zijn. Als GHL faalt → 422 teruggeven, geen DB-mutaties. Undo na gedeeltelijke
  schrijf is complex en foutgevoelig.
- Duplicate helper-functies vermijden: mapGhlError() staat nu in zowel follow-up-outcomes.js als
  follow-up-verplaats-call.js. Refactor naar api/_lib/ghl-error.js staat in TODO.
- Disabled crons: bestand bewaren (niet deleten), entry verwijderen uit vercel.json. Bestand blijft
  bereikbaar via HTTP (auth-gate beschermt), maar wordt niet meer automatisch getriggerd.

### Werkstroom & tooling
- Cursor git diff UI rendert soms niet. Workaround: `git diff file > /tmp/d.txt && cat /tmp/d.txt`.
  Pas toepassen als diff in chat niet zichtbaar is. Niet standaard gebruiken (trager).
- Productie-testing vereist data-prep voorzichtigheid: geen outcomes registreren op toekomstige
  scheduled calls van echte leads. Gebruik leads die al test-rommel hebben of prep test-data via
  SQL eerst.

## Sessie 3 juni 2026 — Sales-redesign + TL-integratie + Finance prep

### Wat is gebouwd vandaag
- PR #79 sales-redesign LIVE (commit ef773ee): Dashboard / Klanten / Offertes /
  Abonnementen / Retentie / Aanbod / Rapporten + klant-detail 6 sub-tabs + Wizards +
  Onboarding eigen module
- PR #80 TL-integratie LIVE (commit 8b6c6f2): retentie-fix + TL-sync delete/cancel +
  TL-import (bulk import endpoint + admin UI) + MRR-overzicht
- Direct-op-main updates: filter defaults / retentie per klant / MRR bug-fix /
  entity-filter / periode-filter / inkomende omzet KPI / admin import-link

### Architectuur patronen (geleerd in deze sessie)
- Sales = modules/sales.html met 7 tabs (geen sub-modules)
- Klant-detail = modules/klanten.html?id=X&tab=Y met 6 sub-tabs
- Tabel-patroon: status-strip kolom 4px links + caret-expand + 3-dots met
  position:fixed + getBoundingClientRect + flip-up + close-on-scroll
- Filter pills bovenaan tabs met meest-gebruikte status als default
  (bv. Abonnementen → Actief)
- KPI-strip met 4 cells (grid template repeat(4, 1fr))
- Status-conditionele acties per row (Bevestigd→Omzetten, Verzonden→Opnieuw, etc)

### TL API findings
- quotations.delete BESTAAT (gebruikt door offerte-delete TL-sync)
- subscriptions.deactivate met {id} — geen .delete
- subscriptions.list returnt grouped_lines LEEG → call subscriptions.info per sub
  voor line_items
- tax_id zit in li.tax.id met type='taxRate' (NIET li.tax_rate.id of li.tax_rate_id)
- Rate-limit: 100 req/min → throttle 200ms + 429 exp-backoff
- Ghost-deals voor TL-imports (source='tl_import') om NOT NULL deal_id constraint te
  omzeilen, uitgefilterd in Offertes-tab

### Vercel context
- 60s function timeout = max ~80 subs per TL-import run (3 calls/sub × throttle)
- Geen aparte staging Supabase — preview frontend schrijft naar productie DB

### Conventies bevestigd
- TL-sync TL-first met rollback bij fout + force-option voor lokale override
- Audit log per actie (subscription_audit_log etc)
- Imports idempotent (skip_existing op TL-ID match)
- super_admin gate via verifyAdmin() + profile.role==='super_admin'
- MRR formule: amount_per_termijn ÷ billing_cycle_in_months
  (per_month/1, per_quarter/3, per_year/12)

### Bekende risico's vandaag ontdekt
- Activity-feed dashboard is afgeleid van stats (geen events-endpoint)
- Sub-subtitle "vanuit #OFF-XX" niet beschikbaar voor TL-imports
- Wizard-subs zetten billing_cycle niet → behandeld als per_month
- MRR-trend telt subs op start/eind-window (indicatief, niet 100% historisch correct)
- Retentie "Verlopen"-pill toont alle historische cases zonder tijdsvenster
  (kan later begrensd)

## WhatsApp template-variabelen (C4 — 9 juni 2026)

Sinds C4 ondersteunen WhatsApp-templates **named placeholders** (`{{klant.naam}}`,
`{{factuur.bedrag_open}}`, `{{bedrijf.naam}}`, …). Volledige documentatie:
[`docs/whatsapp-templates-c4-named-variables.md`](docs/whatsapp-templates-c4-named-variables.md).

### Architectuur in één alinea
- Registry + parsers + resolvers in `api/_lib/template-variables.js` (`AVAILABLE_VARIABLES`).
- Bij submit (`api/admin-meta-templates-submit.js`) worden named keys vertaald naar
  positioneel (`{{1}}`, `{{2}}`, …) en bewaard in
  `whatsapp_meta_templates.meta_param_mapping` (jsonb).
- Bij send (`api/inbox-send-template.js`) wordt de mapping toegepast: customer +
  invoice + open-invoices opgezocht, waarden geresolved, Meta-components gebouwd.
- Backward-compat: legacy positionele templates blijven werken (mapping = NULL).

### Vereiste env-vars voor `bedrijf.*`
Voeg toe in Vercel (alle environments, NIET sensitive):
```
COMPANY_NAME=De Forex Opleiding NL B.V.
COMPANY_ADDRESS=<adres + postcode + plaats>
COMPANY_KVK=<8-cijferig>
COMPANY_BTW=NL<9-cijferig>B01
COMPANY_PHONE=+31<rest>
COMPANY_EMAIL=info@deforexopleiding.nl
```
`COMPANY_NAME` heeft fallback; rest resolved naar lege string als ontbrekend.

### TL-factuurlink
`factuur.betaal_link` gebruikt `api/_lib/teamleader-invoice-link.js` — real-time
TL-fetch met 24u lazy cache in `invoices.payment_url` + `payment_url_fetched_at`.
Geen nieuwe env-vars: gebruikt bestaande `TEAMLEADER_*` OAuth.

### Lesson learned 15
Named-placeholders patroon werkt: editor blijft simpel (gewoon `{{categorie.veld}}`
typen), submit-conversie is transparent en send-time resolution is automatisch.
Belangrijk pattern hierbij: **mixed templates weigeren** (named én positioneel in
één body) — dat is ambigu voor mapping-bouw. Admin-editor checkt
`isMixedTemplateBody()` client-side; server-side niet expliciet maar
`buildPositionalMapping()` mapt alleen named en laat positionele staan, dus
resultaat zou inconsistent zijn → houd de check client-side hard.

## Lessons Learned — C4.5 TL payment-link + inbox (9 juni 2026)

Volledige documentatie: [`docs/finance-c45-tl-payment-link.md`](docs/finance-c45-tl-payment-link.md).

### Lesson learned 16 — Lazy-fetch + cache TTL voor externe API-resources
Voor externe resources die langzaam veranderen (TL payment_url, invoice-link, etc.):
sla het resultaat op in de row zelf met een `*_fetched_at`-kolom en hang een
**env-gedreven TTL** ervoor (`FINANCE_PAYMENT_LINK_CACHE_TTL_DAYS`, default 7). Cache
wordt automatisch warm bij eerste use; `?force=true` of `{ force: true }` als bypass.
Voorkomt N+1 TL-calls bij UI-refresh + WA-send binnen dezelfde minuut. Skip persist
voor signed/expiring URLs (TL `invoices.download` PDF) — die zijn te kortlevend om
zinnig te cachen.

### Lesson learned 17 — Lib + endpoint splitsing (cron + inbox + UI = één helper)
Voorkom dubbele fetch+cache+error-mapping code in cron-jobs, send-endpoints en UI-
endpoints door een **`_lib/`-helper** te maken (`api/_lib/invoice-payment-link.js`)
met de pure logica + typed `Error.code`, en daarnaast een **thin HTTP-endpoint** dat
alleen auth + code→HTTP-mapping doet (`api/finance-invoice-payment-link.js`). Drie
callers gebruiken nu één pad:
1. UI-knop in invoice-detail modal (`modules/finance.html` →
   `apiFetch('/api/finance-invoice-payment-link')`).
2. Inbox template-send lazy resolve van `{{factuur.betaal_link}}`
   (`api/inbox-send-template.js` → `ensureInvoicePaymentLink(invoice.id)`).
3. Dunning engine pre-warm (TODO in `api/_lib/dunning-step-executors.js`, wacht op
   Meta-credentials PR A2).

Zelfde patroon eerder toegepast bij `register-payment-internal.js` — werkt
consistent en bespaart 2-3 plekken onderhoud bij elke TL/Meta API-shape wijziging.

### Lesson learned 18 — Phone-normalize: `/\D/g` strip + last-9 fallback
Klant-telefoonnummers staan inconsistent in DB (met of zonder `+`, met/zonder
landcode, soms met spaties). Voor lookup-by-phone (inbox webhook, conversation
context): strip alle non-digits via `String(s).replace(/\D/g, '')` en match
**eerst exact** op het volle digit-string, **dan fallback** op `slice(-9)` voor de
lokale variant zonder landcode. Match alleen toepassen als er precies 1 hit is —
ambiguïteit (2+ klanten met laatste 9 digits gelijk) is een unmatched-conversation
case, geen "kies de eerste". Zie `api/inbox-conversation-context.js` regel 45-79
(uit recente PR #132 fix).

## Lessons Learned — D1 Payment Arrangements (9 juni 2026)

Volledige documentatie: [`docs/payment-arrangements-d1-foundation.md`](docs/payment-arrangements-d1-foundation.md).

### Lesson learned 19 — Dual-table pattern voor arrangement + pending_actions
Voor approval-flows met **één semantische actie maar meerdere uitvoer-stappen**
(bv. een `gespreid`-arrangement op 3 facturen → 3 TL-mutaties): splits in twee
tabellen — `payment_arrangements` (1 rij = 1 voorstel met klant + invoice_ids[] +
type + details jsonb) en `pending_actions` (N rijen = N uitvoer-stappen per
arrangement, elk met eigen `action_type` + `payload` + `status`).

Voordelen die we in D1 al concreet ervaren:
1. **Approval blijft atomic per actie** — admin kan in de queue per regel
   approve/reject (bv. wel uitstel op factuur A, niet op B), zonder dat een
   gedeeltelijke approval het arrangement zelf in een wankele staat zet.
2. **Executor flexibel per stap** — D2 executor leest `pending_actions` waar
   `status='approved'`, voert TL-call uit per rij, en zet status individueel op
   `executed` of `failed` met error-text in `execution_result` jsonb. Eén
   gefaalde stap blokkeert de andere niet.
3. **Audit-trail per stap** — `execution_result jsonb` per pending_action bevat
   TL-IDs, timestamps, error-codes; geen aggregate-blob op arrangement-niveau
   die je moet uitparseren.
4. **Cancel-semantiek schoon** — `arrangements-cancel` zet zowel arrangement
   `status='GEANNULEERD'` als alle bijbehorende pending_actions op `cancelled`.
   Eén SQL UPDATE per tabel, geen complexe state-machine.

Anti-pattern dat we hiermee vermijden: één tabel met `actions jsonb[]` of
`sub_action_results jsonb` waarin je per element status moet bijhouden. Dat
maakt selecties zoals "alle openstaande TL-stappen platform-breed" (D2 cron-
executor) onmogelijk zonder volledige jsonb-scan.

### Lesson learned 20 — Hoofdnav-badge met setInterval-cleanup
Pattern voor sidebar-badge-polling (taken/tickets/approvals): bewaar
`setInterval`-handle in module-scope `_xBadgeTimer`, **clear bij elke (her)mount
vóór het opnieuw starten**, en clear ook op `beforeunload`. Voorkomt
double-polling bij SPA-achtige flows en spaart API-calls bij snelle navigatie.
Polling-interval 60s is veilige default voor approval-counts (real-time genoeg,
ruim binnen Supabase Free-tier budget bij 5-10 actieve users). Permission-cache
(`_approvalsBadgeAllowed`) zorgt dat we maar 1x `RBAC.ensurePermissionsLoaded()`
hoeven na te slaan per page-load.

## Payment Arrangements naming convention
Sinds D1 polish (migratie `2026-06-09-payment-arrangements-d1-spec-naming.sql`):

- **Uppercase enum-keys voor types**: `UITSTEL`, `SPLITSING`,
  `ABONNEMENT_PAUZE`, `ABONNEMENT_STOP`, `KWIJTSCHELDING`.
  (Geen `gespreid` of `overig` meer — `SPLITSING` is de naam voor termijn-
  splits, en abonnement-pauze en abonnement-stop zijn 2 aparte types.)
- **Uppercase enum-keys voor arrangement-status**: `VOORGESTELD`, `ACTIEF`,
  `NAGEKOMEN`, `VERBROKEN`, `GEANNULEERD`.
- **Strict scheiding van statussen**:
  - `payment_arrangements.status` = lifecycle (VOORGESTELD → ACTIEF →
    NAGEKOMEN/VERBROKEN/GEANNULEERD).
  - `pending_actions.status` = approval + execution flow
    (pending → approved/rejected → executed/failed/cancelled). Lowercase
    blijft hier intact — DB-CHECK is niet aangeraakt.
- **`pending_actions.action_type` prefix `TL_`** voor TeamLeader-mappable
  acties: `TL_INVOICE_UPDATE_DUE`, `TL_INVOICE_SPLIT`,
  `TL_SUBSCRIPTION_PAUSE`, `TL_SUBSCRIPTION_STOP`, `TL_INVOICE_WRITEOFF`.
  D2-executor herkent acties via die prefix.
- Lowercase legacy waarden worden in `arrangements-list` + `arrangements-propose`
  geaccepteerd als alias voor backward-compat (oude bookmarks / agents).

## Lessons Learned — F1 Taken-foundation (9 juni 2026)

Volledige documentatie: [`docs/tasks-f1-foundation.md`](docs/tasks-f1-foundation.md).

### Lesson learned 21 — Centraal taken-dashboard via tasks-list met joins
Voor een centraal taken-bakje dat meerdere actie-categorieën dekt (D1 TL_-
arrangements + F1 MANUAL_VERIFY_PAYMENT + later F2-F4 MANUAL_PROPOSE/
ESCALATION/FOLLOWUP), bouw één **`tasks-list` endpoint** met embedded joins
op `customers + payment_arrangements + invoices` in plaats van een aparte
UI-tab per type. Voordelen die we in F1 al concreet zien:

1. **Flexibele filtering zonder UI-duplicatie** — `category` + `action_type`
   + `status` + `customer_id` + `invoice_id` + `search` zijn allemaal
   query-params op één endpoint. Frontend hoeft maar één tabel-component te
   onderhouden; nieuwe action_types verschijnen automatisch zodra ze in
   `pending_actions` staan.
2. **Counts per status én per category in één call** — `counts.byStatus`
   en `counts.byCategory` worden parallel berekend en mee-geserialiseerd.
   Pill-badges in de UI tonen real-time aantallen zonder extra round-trips.
3. **Joins één plek** — `customer.name` (via `customerDisplayName`) en
   `invoice.invoice_number` worden server-side opgelost. F2-F4 nieuwe types
   krijgen die joins gratis mee zodra ze in dezelfde tabel landen.
4. **first-class `invoice_id` FK** boven jsonb-payload-only — F1 verplaatste
   `invoice_id` naar een eigen kolom op `pending_actions`. Daarmee zijn
   queries als "alle open verify-taken voor factuur X" direct indexeerbaar
   zonder jsonb-scan.

Anti-pattern dat we hiermee vermijden: een aparte `verify_payments`-tabel
of `escalations`-tabel per actie-type. Dat zou per type een nieuwe
list/detail/approve/reject endpoint vereisen en de UI dwingen om N tabbladen
te onderhouden met grotendeels overlappende kolommen. Eén tabel +
`action_type` discriminator + helper-prefix (`TL_` vs `MANUAL_`) is de
elegantere route, vooral omdat de mark-executed cascade automatisch goed
gaat zodra `arrangement_id` NULL is voor standalone taken.
