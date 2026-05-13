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
- Auth: geen (interne tool, single-user)

## Auth & secrets
- CRON_SECRET in environment variables (Vercel + 1Password)
- Supabase service role key in env vars
- ANTHROPIC_API_KEY in env vars
- Strato IMAP credentials per mailbox in env vars

## Module-architectuur
- /index.html — Dashboard
- /modules/email.html — E-mail beheer
- /modules/taken.html — Takenbeheer
- /modules/kennisbank.html — Kennisbank
- /modules/agents.html — 1-op-1 chat met agents
- /modules/meetings.html — Vergaderruimte
- /modules/control-center.html — Approvals + Audit log
- /modules/shared/agent-shared.js — cross-modulaire functies 
  (showToast, esc, formatMd, relTime, showReport, approval-helpers)
- /modules/shared/agent-shared.css — gedeelde styling

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

## Werkwijze
1. ALTIJD eerst plan voor non-triviale taken (3+ stappen of nieuwe 
   architectuur). Plan rapporteren, wachten op groen licht, dan pas 
   bouwen.
2. Eén logische commit per task. Geen mix van features.
3. Commit messages: type prefix (feat:, fix:, refactor:, docs:)
4. Push naar main (--no-verify om husky-hooks te skippen indien nodig)
5. Test-instructies geven NA elke push, in stappenformaat
6. Bij twijfel: stop en vraag, niet blind doorgaan

## VERPLICHTE COMMIT-WORKFLOW

Een commit zonder bewezen push is GEEN voltooide taak.

Bij elke logische taak:
1. Maak commit met logische message
2. Run: git push origin main
3. Plak de letterlijke output van git push in het rapport
   (bv. "63f03e4..907a8f1 main -> main")
4. Wacht 30 sec voor Vercel auto-deploy
5. Verifieer met curl of HTTP request dat live URL bijgewerkt is
6. PAS DAN melden "klaar"

Bij conflicten of "rejected" errors: STOP, geen --force,
rapporteer en wacht op instructie.

ANTI-PATTERN: rapporteren "Commit X geslaagd" zonder push-output.
Dit veroorzaakte op 13 mei 2026 drie testcycli omdat commits
nooit gepusht waren.

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
