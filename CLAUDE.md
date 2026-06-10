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
- ANTHROPIC_API_KEY in env vars (sensitive — server-side only). VEREIST voor
  alle Anthropic-callers: agent-chat, agent-meeting, generate-reply,
  email-agent, en sinds E1.0 ook joost-suggest. Ontbrekende key → endpoint
  returnt 503 "ANTHROPIC_API_KEY niet geconfigureerd" zodat config-issues
  onderscheidbaar zijn van runtime-bugs. Backup in 1Password.
- INTERNAL_API_TOKEN in env vars (sensitive — server-side only). VEREIST
  sinds E1.1 Joost auto-suggest: shared-secret voor server-to-server calls
  binnen het platform (inbox-webhook -> joost-suggest fire-and-forget).
  Endpoint herkent header `X-Internal-Token` en skipt user-JWT + RBAC bij
  exacte match; suggestion-row wordt opgeslagen met
  `requested_by_user_id=NULL` + `auto_triggered=true`. Ontbreken → webhook
  logt warning + skipt auto-trigger (geen runtime-crash). Setup: random
  32+ byte hex/base64 in alle Vercel-environments. Backup in 1Password.
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
- /modules/open-acties.html — Centraal Open Acties-dashboard (F1) voor alle
  handmatige verificaties. Gescheiden van Takenbeheer (taken.html / kanban).
  Toont 2 task-categorieën uit `pending_actions`:
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
- Joost (E1.0) — AI conversational agent voor Finance Inbox in **draft-mode**.
  Genereert suggesties voor antwoorden op klant-WhatsApp's; medewerker bepaalt
  of die 1-op-1 / aangepast / niet verstuurd worden. Tabellen `joost_config`
  (per-module persona + prompt + KB + model) en `joost_suggestions` (log +
  outcome). Endpoints: `joost-config-get` / `joost-config-upsert` /
  `joost-suggest` / `joost-mark-outcome`. RBAC: `finance.joost.use` (use) +
  `admin.joost_config` (config-write). Rate-limit 30s per conversation tegen
  burst-clicks. Inbox compose-panel met 3 acties (Plak / Plak en bewerk /
  Negeer); admin-UI in `/modules/admin.html` voor config. Vereist env-var
  `ANTHROPIC_API_KEY` (503 als ontbrekend). Zie docs/joost-e10-foundation.md
  voor architectuur + roadmap (E1.1 auto-suggest, E1.2 auto-task, E2 autonomous).
- Joost (E1.2) — Intent-to-task. Sluit loop tussen Joost-suggestie en
  operationele actie. Suggestion-card toont contextuele actie-knop bij 3
  intents (`verify_payment` -> verify-task in F1, `arrangement_request` ->
  arrangement-wizard pre-fill, `escalation_needed` -> escalation-flow); de
  andere 3 intents (`payment_promise`, `general_question`, `other`) blijven
  pure tekst-suggestie. Confidence-bands sturen visuele styling
  (high>=0.80 primary / medium 0.50-0.79 secondary / low<0.50 contextuele
  knop verborgen). Schema-uitbreiding op `joost_suggestions`:
  `linked_task_id` (FK pending_actions) + `linked_arrangement_id` (FK
  payment_arrangements) + 2 nieuwe statussen (USED_TASK_CREATED /
  USED_ARRANGEMENT_OPENED). Endpoint
  `/api/joost-create-task-from-suggestion` combineert task-aanmaak +
  mark-outcome atomair (best-effort rollback). Open Acties detail-modal
  toont dossier-link terug naar bron-conversatie via
  `payload.source='joost'` + `payload.joost_suggestion_id`. Zie
  docs/joost-e12-intent-to-task.md voor architectuur + roadmap E2
  (auto-execute).
- Joost (E1.1) — Auto-suggest bij inbound webhook. `inbox-webhook.js`
  triggert fire-and-forget `/api/joost-suggest` na elke nieuwe inbound
  text-message van een gekoppelde finance-klant. Filter-rules (7 checks):
  nieuwe insert, type=text, body>=5 chars + niet in TRIVIAL_REPLIES set,
  conversation gekoppeld, module=finance + `joost_config.is_enabled`,
  geen outbound binnen 60s (anti-loop). Auth via header
  `X-Internal-Token: <INTERNAL_API_TOKEN>`; `joost-suggest` skipt
  user-JWT + RBAC bij internal-call en zet `requested_by_user_id=NULL` +
  `auto_triggered=true`. Schema-uitbreiding: `joost_suggestions.auto_triggered`
  boolean default false. Frontend toont "auto-gesuggereerd" badge op
  recente PROPOSED-cards via `/api/joost-suggestions-recent`. Vereist
  env-vars `ANTHROPIC_API_KEY` + `INTERNAL_API_TOKEN`. Zie
  docs/joost-e11-and-f3-escalation.md voor flow + roadmap E2 (autonomy).
- Joost (E2) — Autonomy-foundation in 5 fases (E2.0 decision-engine logs /
  E2.1 reactive autonomy / E2.2 outbound scheduler / E2.3 negotiation +
  pauzeer-per-conv / E2.4 prompt-context). Schema-uitbreidingen: jsonb
  `autonomy_config` + `feature_flags` op `joost_config`, 3 nieuwe kolommen
  + 6 nieuwe statussen op `joost_suggestions` (incl. `SENT_AUTONOMOUSLY` +
  BLOCKED_*), nieuwe tabel `joost_conversation_state` (1 rij/conv met
  counters + topics + pauze-state). Decision engine `evaluateAutonomy()`
  is pure function in `api/joost-autonomy-evaluate.js` (8 checks in vaste
  volgorde: validatie / confidence / intent-mode / office-hours /
  rate-limit / paused / mandate / mode). Default feature-flag-state:
  alleen `e2_decision_engine_logs=true` (shadow-mode); rest UIT zodat
  Jeffrey per fase kan opbouwen. Endpoints: `joost-autonomy-evaluate` +
  `joost-autonomy-decisions-list` + `joost-send-autonomous` (E2.1) +
  `joost-outbound-send` + `joost-outbound-scheduler` (E2.2 cron, schedule
  `30 8,11,14,17 * * 1-5`) + `joost-conversation-state` (E2.3
  pauze/hervat). Admin-UI: Autonomy tab + Decision Log tab in Joost AI
  sectie. Inbox-UI: pauze-knop + "Joost actief" + "Autonoom gepauzeerd"
  badges. Open Acties krijgt renderers voor `MANUAL_PROPOSE_ARRANGEMENT`
  en `MANUAL_FOLLOWUP` + Joost-autonoom badges. Mandate-config: 5
  arrangement-types met `enabled` + caps; `abonnement_pauze` /
  `abonnement_stop` / `kwijtschelding` blijven default `enabled=false`
  (hard achter human-approval). Zie docs/joost-e2-autonomy-foundation.md
  voor architectuur + smoke-test scenarios + rollout-checklist.
- F3 escalation — `MANUAL_ESCALATION` action_type op `pending_actions`
  voor escalaties die geen TL-actie en geen verify-payment zijn (boos /
  juridisch / handover naar incasso). Endpoint
  `/api/tasks-create-escalation` (RBAC: `finance.tasks.create` met fallback
  `finance.joost.use`). Payload-shape: severity (low/medium/high, default
  medium) + reason (min 10 chars) + context_summary + source (joost/manual)
  + optionele `joost_suggestion_id` cross-link. Status start op PENDING
  (escalation IS de taak; geen approval). Outcome via
  `pending-actions-mark-executed`: `resolved` / `handed_over` / `ongoing`
  (laatste blijft PENDING + appendt progress_log). `arrangement_id=NULL`
  + `invoice_id=NULL` (klant-brede escalatie). Open Acties krijgt
  filter-pill **Escalaties**. Inbox heeft escalation quick-modal vanuit
  Joost-card (intent=escalation_needed) of conversation-header. Zie
  docs/joost-e11-and-f3-escalation.md voor payload + UX + roadmap F4
  (MANUAL_FOLLOWUP).
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

## Lessons Learned — E1.0 Joost foundation (9 juni 2026)

Volledige documentatie: [`docs/joost-e10-foundation.md`](docs/joost-e10-foundation.md).

### Lesson learned 22 — Structured output via tool-use + tool_choice forceren
Voor structured JSON-output uit Anthropic-modellen is **tool-use met
geforceerde `tool_choice`** het robuuste pad. Concreet:

1. Definieer exact 1 tool met JSONSchema voor het gewenste output-object
   (required fields, enums, descriptions per veld).
2. Zet `tool_choice = { type: 'tool', name: '<tool_name>' }` zodat het model
   verplicht is die tool aan te roepen — geen "doe wat je wilt"-fallback.
3. Lees `data.content.find(b => b.type === 'tool_use' && b.name === <name>)`
   en gebruik `block.input` direct als geparseerd object.

De helper `anthropicStructuredOutput()` in `api/_lib/anthropic-client.js`
bundelt dit pattern. Callers (Joost-suggest, en later agent-* refactors) hoeven
zich niet bezig te houden met retry / error-mapping / tool_use-extractie.

Anti-pattern dat we hiermee vermijden: prompt-engineering richting "antwoord
alleen in JSON, geen markdown" en daarna `JSON.parse(assistantText)`. Dat is
fragiel — modellen wrappen output regelmatig in ```json``` codeblocks, voegen
"Here is the JSON:" toe, of escapen quotes inconsistent. Met geforceerd
tool-use is het schema contractueel gegarandeerd door de API — geen
post-processing, geen parsing-failures. Bijkomende win: het `tool_use`-block
heeft een eigen `stop_reason='tool_use'` zodat we ook duidelijk kunnen falen
(`ANTHROPIC_TOOL_USE_MISSING`) als het model toch tekst probeert te
returneren.

## Lessons Learned — E1.2 Joost intent-to-task (10 juni 2026)

Volledige documentatie: [`docs/joost-e12-intent-to-task.md`](docs/joost-e12-intent-to-task.md).

### Lesson learned 23 — Intent-to-action mapping als interface tussen LLM en operatie
Een LLM-suggestie wordt pas echt waardevol als hij een operationele taak kan
**initiëren**, niet alleen een tekst kan voorstellen. Het patroon dat we in
E1.2 hanteren: de LLM produceert via geforceerd tool-use een gestructureerd
`detected_intent`-veld (enum), en de UI heeft een **statische intent->actie
mapping** die voor een subset van intents een contextuele knop rendert
(`verify_payment` -> verify-task, `arrangement_request` -> wizard-pre-fill,
`escalation_needed` -> escalation-flow). De andere intents tonen alleen
neutrale tekst-acties (Plak / Bewerken / Negeer).

Drie redenen waarom dit het sweet-spot tussen LLM-flex en operationele
zekerheid is:

1. **Mens blijft in controle voor het irreversibele deel** — task-aanmaak
   en arrangement-wizard openen vereisen een expliciete klik. LLM-output is
   het *signaal* dat de actie zinvol kan zijn; de mens beslist of het in de
   ops-pipeline belandt. Geen hallucination kan een spookafspraak met TL
   maken.
2. **Confidence stuurt visuele weging, niet auto-execute** — band-styling
   (high primary / medium secondary / low verbergen) maakt zichtbaar
   welk vertrouwen Joost heeft, zonder dat een lage confidence stilletjes
   doorklikt naar productie-data. Bij low-confidence verbergt de UI de
   contextuele knop volledig — een grijsgemaakte knop nodigt uit tot
   "toch maar klikken na refresh", verborgen is een hard signaal "kijk
   zelf".
3. **Traceability blijft compleet door FK-koppeling** — `linked_task_id` +
   `linked_arrangement_id` op `joost_suggestions` + `payload.source='joost'`
   + `payload.joost_suggestion_id` op `pending_actions` maakt dat we
   bidirectioneel terug kunnen kijken: vanuit Open Acties zien welke
   suggestie de task triggerde, vanuit Joost-eval zien welke suggesties
   tot operationele actie leidden. ON DELETE SET NULL behoudt de
   audit-rijen ook als de afgeleide entiteit weg is.

Anti-pattern dat we hiermee vermijden: een free-text `next_action`-veld
van de LLM (bv. "ik denk dat je een verify-task moet maken") en de UI laten
parseren wat de bedoeling is. Dat is fragiel, taal-afhankelijk en koppelt
de UI direct aan model-versies. Met een enum + statische mapping zit de
business-logica in code (één plek, testbaar) en blijft de LLM-output
contractueel gegarandeerd.

Patroon is herbruikbaar voor toekomstige agents (Aron, Simon, Leon): zodra
een intent-classificatie betrouwbaar is, hang er een statische mapping aan
naar de juiste operationele actie. De agent wordt zo een interface tussen
ongestructureerd klant-signaal en gestructureerde ops-flow — precies de
brug die ontbreekt zonder zo'n laag.

## Lessons Learned — E1.1 auto-suggest + F3 escalation (10 juni 2026)

Volledige documentatie: [`docs/joost-e11-and-f3-escalation.md`](docs/joost-e11-and-f3-escalation.md).

### Lesson learned 24 — Webhook fire-and-forget pattern voor non-critical async work
Vercel Node-runtime heeft **geen** `ctx.waitUntil()` zoals Edge of Cloudflare
Workers — er is geen formele primitive om een "background promise" te
markeren die nog mag voltooien nadat `res.json()` is gestuurd. Voor
non-critical follow-up werk (Joost auto-suggest, analytics-ping, log-flush)
is het patroon dat we hanteren:

```js
fetch(url, { method: 'POST', headers, body })
  .then(async (resp) => { if (!resp.ok) console.warn(...); })
  .catch((e) => console.warn('fetch fail:', e?.message));
// NIET awaited — caller returnt direct, response gaat naar Meta binnen budget.
```

Vier bewuste keuzes:

1. **Geen `await`** in de caller — anders blokkeert de outbound HTTP-response
   op de async-call (Anthropic kan 3s duren, Meta retried bij >5s).
2. **`.catch()` op de promise** — unhandled rejections kunnen de Lambda
   silenced doen crashen. Console.warn is voldoende voor non-critical werk.
3. **Geen retry-logica** — als de fire-and-forget faalt, accepteer het.
   De gebruiker heeft een handmatige fallback (knop in UI).
4. **Acceptatie van occasionally-dropped work** — bij Lambda cold-shutdown
   verliezen we soms een call. Acceptabel voor MVP-features met fallback.
   Voor mission-critical async werk: queue (Inngest / QStash / Vercel cron).

Anti-pattern dat we hiermee vermijden: synchroon awaiten op de async-call
en hopen dat de outer caller (Meta-webhook, frontend) genoeg tijd-budget
heeft. Bij Anthropic-calls (3s+) is dat een **gegarandeerde timeout** bij
elke piekbelasting. Beter expliciet kiezen: "deze call is best-effort, niet
contractueel" en de uitvoering loskoppelen van de respons-deadline.

Wanneer NIET dit pattern: betalingen, mail-send, irreversibele state-mutaties.
Daar moet de outer caller weten of het gelukt is — die zijn niet "non-critical".

### Lesson learned 25 — INTERNAL_API_TOKEN voor service-to-service auth
Voor server-to-server calls **binnen** het platform (webhook -> ander
endpoint, cron -> shared helper-endpoint) hebben we geen user-sessie. We
kunnen daar geen Bearer-JWT voor opzetten zonder een "system-user" in
`auth.users` aan te maken en JWT's te tekenen — over-engineered voor het
doel. Het patroon dat we hanteren: een **shared secret** in env-var
`INTERNAL_API_TOKEN`, doorgegeven als header `X-Internal-Token`. Endpoints
herkennen de header en skippen user-JWT + RBAC bij exacte match.

Implementatie (zie `api/joost-suggest.js` auth-block):

```js
const internalTokenHeader   = req.headers['x-internal-token'] || null;
const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
const isInternalCall = !!(
  internalTokenHeader && expectedInternalToken &&
  internalTokenHeader === expectedInternalToken
);
if (isInternalCall) {
  // Skip user-JWT + RBAC. requested_by_user_id = NULL, auto_triggered = true.
} else {
  // Normale Bearer-JWT + permission-check.
}
```

Voordelen boven alternatieven:

- **Geen self-signed JWT nodig** — geen "system-user" in `auth.users`, geen
  signing-key voor JWT's. Simpel shared secret.
- **Eenvoudig te roteren** — env-var update in Vercel + redeploy. Geen
  user-management.
- **Duidelijk audit-spoor** — `requested_by_user_id IS NULL` markeert
  system-triggered rijen. Discriminator-flag (`auto_triggered`) onderscheidt
  bron-systeem als er meerdere internal callers zijn.

Risico's en mitigaties:

- **Token-leak via logs** — `INTERNAL_API_TOKEN` mag NOOIT in
  `console.log` of error-text verschijnen. Defensive: log alleen sentinel
  ("INTERNAL_API_TOKEN ontbreekt"), nooit de waarde.
- **Token-leak via request-replay** — server-only env-var, alleen bekend
  op Vercel-runtime. Niet bereikbaar vanuit browser of Meta. CSRF is niet
  relevant want er is geen browser-session.
- **Verwarring met user-tokens** — header-name `X-Internal-Token` is
  duidelijk anders dan `Authorization: Bearer ...` zodat een log-grep
  per-token-type onderscheid maakt.

Setup: `INTERNAL_API_TOKEN` als **Sensitive** env-var in alle Vercel
environments. Waarde: random 32+ byte hex/base64 (`openssl rand -hex 32`).
Backup in 1Password. Bij ontbreken: caller logt warning + skipt
(geen runtime-crash); endpoint valt terug op normale JWT-flow.

Pattern is herbruikbaar voor toekomstige service-to-service calls:
cron -> helper-endpoint, dunning-executor -> Meta-template-send, agent ->
agent meeting-trigger. Eén shared secret voor alle internal traffic; zodra
we meerdere bron-systemen krijgen kan een `X-Internal-Source`-header
(`webhook` / `cron` / `agent`) discriminator-flag bieden zonder extra
secrets.

## Lessons Learned — E2 Joost autonomy-foundation (10 juni 2026)

Volledige documentatie:
[`docs/joost-e2-autonomy-foundation.md`](docs/joost-e2-autonomy-foundation.md).

### Lesson learned 23 — Feature-flag-first deployment voor risico-volle autonomy
Bij autonomy-features (waar code zelfstandig namens het bedrijf naar
klanten communiceert) is **feature-flag-first deployment** geen optie maar
verplicht. Concreet pattern dat we in E2 hanteren:

1. **Migratie zet alle gedrag default UIT** — alleen het loggen van
   beslissingen (`e2_decision_engine_logs=true`) staat aan. Reactive send,
   outbound cron, scheduler, executor: allemaal `false`.
2. **Engine draait sowieso in shadow-mode** — zodra de migratie loopt
   berekent `evaluateAutonomy()` per inbound bericht zijn decision en
   slaat die op in `joost_suggestions.autonomy_decision`. Geen
   side-effects, alleen audit-data. Jeffrey kan 24-48u meekijken
   "wat zou Joost doen?" voordat hij ook maar één flag omhoog zet.
3. **Per-fase rollout, één flag tegelijk** — E2.1 (`e2_auto_send_text`)
   gaat als eerste live, blijft 24u draaien, dan E2.2 scheduler, dan
   executor, dan E2.3 etc. Bij regressie: flag terug op `false` en
   probleem stopt direct — geen rollback van schema nodig.
4. **Defense-in-depth tussen schedule + execute** — scheduler-flag
   (`e2_outbound_cron`) en send-flag (`e2_outbound_executor`) zijn apart
   schakelbaar. Cron kan dus pending-events selecteren en loggen ("had ik
   willen sturen") zonder dat de send-endpoint er ook maar één daadwerkelijk
   verstuurt. Twee laagjes om door te breken voordat een klant iets ziet.

Anti-pattern dat we hiermee vermijden: één big-bang feature die "klaar" is
en bij merge live gaat. Bij autonomy is dat onverantwoord — een hallucinatie
in shadow-mode is een log-regel, in productie-autonomy is het een verkeerd
bericht naar een klant met factuur-issue. Het feature-flag-first patroon
geeft Jeffrey de regie om elk autonomy-pad pas aan te zetten als hij in de
Decision Log heeft gezien dat het zinvol redeneert.

### Lesson learned 24 — Gemandateerde scope-checks voor LLM-acties
Bij autonomous arrangement-voorstellen (waar het LLM een bedrag / aantal
dagen / aantal termijnen voorstelt) zijn **mandate-checks essentieel als
hard contract om het LLM heen**. We vertrouwen het model NIET om binnen de
business rules te blijven — we **dwingen het af in code**, los van wat het
genereert:

1. **`allowed_types` enum als hard whitelist** — als
   `arrangement_mandate.allowed_types = ['UITSTEL','SPLITSING']`, dan
   wordt een LLM-voorstel met type `KWIJTSCHELDING` direct
   `BLOCKED_OUT_OF_MANDATE`, ongeacht hoe overtuigend de reasoning is.
   Engine-side, niet prompt-side.
2. **Min/max bedragen** — `min_total_amount_to_negotiate_eur` (geen
   onderhandeling onder X euro — gewoon betalen) en
   `max_total_amount_to_auto_propose_eur` (boven Y euro altijd door
   mens). Beide bedragen zijn cap-checks op `customer_context.open_amount`
   die de engine doet vóór hij ook maar overweegt door te sturen.
3. **Max termijnen + max dagen uitstel** — voor splitsing en uitstel
   afzonderlijk: `mandate.uitstel.max_dagen_zonder_approval` (default 14)
   en `mandate.splitsing.max_termijnen_zonder_approval` (default 2). Het
   LLM mag voorstellen wat het wil; voorstel boven cap → engine zet
   `stop_action='task_create'` + `MANUAL_PROPOSE_ARRANGEMENT` zodat een
   mens de afweging maakt.
4. **Sub-mandate-flags als laatste deur** — per arrangement-type een
   `auto_approve_if_within` boolean. UITSTEL binnen 14 dagen mag self-
   approve (laag risico, één factuur); SPLITSING binnen 2 termijnen niet
   (raakt N facturen + TL line-items per termijn, verdient tweede paar
   ogen).

Anti-pattern dat we hiermee vermijden: vertrouwen op "we hebben het in de
system-prompt gezegd dat Joost geen kwijtscheldingen mag voorstellen". Een
voldoende creatieve klant praat het model er alsnog toe; een hallucinatie
kan een random voorstel uit het niets genereren. Door **code-side
scope-checks na de LLM-output** is het onmogelijk om buiten mandaat te
treden, ongeacht prompt-engineering of model-keuze. Dezelfde redenering
geldt voor `communication_limits` (max berichten per dag / cooldown /
office-hours): het LLM weet er niets van — engine handhaaft het.
