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
- /modules/admin.html — Gebruikersbeheer (ADMIN_ROLES: super_admin/admin/manager)
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
