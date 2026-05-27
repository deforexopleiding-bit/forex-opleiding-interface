# TODO — Agency Command Center
> Bijgewerkt: 2026-05-15 (Fase C t/m C7 auth-gate volledig) | Gebaseerd op AUDIT-VOLLEDIG.md
>
> **Strategische context**: zie `docs/sessie-logs/Strategisch-Plan-De-Forex-Opleiding.md` (12 mei 2026) voor 12-maands roadmap en €300K-€700K aan upside-lekken.
> **Follow-up Module plan**: zie `docs/sessie-logs/follow-up-module-plan.md` v2.2.

---

## Klanten-module
> Spec: `docs/specs/01-klanten-module-spec.md` · Overzicht: `docs/klanten-module-overview.md`

### ✅ Afgerond Fase 1 (fundament)
- [x] Migratie 012 — 10 tabellen + RLS + herbruikbare updated_at-trigger
- [x] 24 RBAC feature_keys in FEATURE_REGISTRY (Klanten/WhatsApp/Brieven)
- [x] Placeholder modules/klanten.html + sidebar-entry (gating: customer.module.access)
- [x] Documentatie (overview + CLAUDE.md + deze sectie)

### ✅ Afgerond Fase 2A (klanten-module compleet)
- [x] Klant-overzicht UI (lijst, filters, search) — Fase 2A.1 (preview + prod smoke-test)
- [x] Klant-detailpagina basis (Profiel/Communicatie/Audit) — Fase 2A.2 (preview + prod smoke-test)
- [x] CRUD-endpoints klanten (POST/PATCH + archive/unarchive) — Fase 2A.3 (preview + prod smoke-test)
      (hard delete bewust uitgesteld naar 2C, gekoppeld aan AVG-erasure)
- [x] Tag-toekenning UI (inline edit-mode in Profiel-tab) — Fase 2A.4
- [x] Notitie CRUD UI (inline editor + edit/archive per note) — Fase 2A.4
- [x] Duplicate-check endpoint + confirm-modal in create-flow — Fase 2A.4
- [x] Bulk-acties (archive/unarchive/tag-add/tag-remove) met checkbox-selectie — Fase 2A.4

### 🚀 Klanten-module Fase 2A klaar voor merge naar main

**19 commits totaal** (Fase 1 fundament + Fase 2A.1–2A.4 features):
- 5 commits Fase 1 (DB-schema, RBAC, placeholder) — al gemerged
- 14 commits Fase 2A.1–2A.4 op feature/klanten-module-fase2a (nog open)

**Schema-status productie:**
- Migratie 012 (Fase 1 schema): al op productie via PR #1 ✓
- Migratie 013 (customer_notes): handmatig via SQL Editor op productie ✓
  (PR #3 stuck-merge — zie leerpunt #6)

**Smoke-test plan na push final 2A bundel-PR:**
1. Insert tijdelijke test-klant via Vercel preview UI (create-flow)
2. Tag-toekenning UI test (add/remove)
3. Notitie CRUD test (create/edit/archive)
4. Duplicate-warning test (create met overlap)
5. Bulk-acties test (selecteer 3 klanten → archive + tag)
6. Regressie 2A.1/2A.2/2A.3 (lijst-filters/detail-tabs/CRUD)
7. Cleanup test-data via SQL Editor
8. Bestaande modules ongebroken (Dashboard/Taken/E-mail/etc.)
9. Console + Network check (geen errors)

**Risico bij merge** (Fase 1 leerpunt #6):
- Branch protection rules op main → PR kan stuck-merge geven
- VÓÓR merge: check GitHub Settings → Branches op rules
- Fallback bij stuck: handmatige merge na groen smoke-test (alleen code, 
  geen DB-migratie nodig — schema al op productie)

### ⏳ Open Fase 2B+
- [ ] TradersLeague OAuth setup (Fase 2B)
- [ ] AVG-functionaliteit (export Art. 15 + anonimiseren Art. 17) (Fase 2C)
- [ ] WhatsApp send-laag (Twilio-integratie, Fase 2C)
- [ ] Admin-matrix: manager-keys aanzetten voor de 24 nieuwe keys (Jeffrey-actie post-merge)

### 🔧 Technical debt

**API-laag granulaire RBAC nog niet wired (Fase 2A.1+)**
- `api/customers.js`, `api/customer-tag-definitions.js`, `api/customer.js`,
  `api/customer-notes.js`, `api/customer-archive.js`, `api/customer-audit.js`
  gebruiken allemaal `verifyAdmin()` = ADMIN_ROLES gate
- `role_permissions`-matrix nog niet afgedwongen op API-laag
- Werkt voor super_admin + manager (huidige usecase)
- Volgt bij role-introductie (sales/mentor/marketing/viewer)
- **Update Fase 2A.3**: `api/_lib/requirePermission.js` BESTAAT (4857 bytes,
  met `requirePermission` / `requirePermissionFailOpen` / `checkPermissionOrDeny`).
  Helper is alleen gewired op 3 email-endpoints. Cleanup-PR na 2A.4 om alle
  customer-endpoints te migreren naar granulaire keys (customer.view, customer.create,
  customer.edit, customer.archive, customer.audit.view).

**Validatie-duplicatie POST vs PATCH in `api/customer.js`** (Fase 2A.3)
- ~30 regels validatie-logica zit in zowel `handlePost` als `handlePatch`
  (required-check, email-regex, ISO-date, empty-string-handling).
- Bewust niet gedeeld omdat POST en PATCH iets andere semantiek hebben rond
  empty-strings (POST: skip, PATCH: NULL).
- Cleanup: extract `cleanAndValidateBody(body, { isCreate })` helper, in 2A.4
  cleanup-commit. Risico bij divergentie: bug-fix vergeten op 1 plek.

**`respondShape()` gedupliceerd in 3 customer-endpoints** (Fase 2A.3)
- Identieke tags+notes-count+audit-count fetch in `api/customer.js` GET/POST/PATCH
  en `api/customer-archive.js`.
- Kandidaat voor extractie naar `api/_lib/customer-shape.js` in 2A.4 cleanup.

**Search op customer-list zoekt per-veld, geen fullname-concat** (Fase 2A.3 smoke-test bevinding)
- `/api/customers?search=X` doet `.or(first_name.ilike, last_name.ilike, email.ilike, phone.ilike)`.
- Zoek-string "Jan Jansen" (met spatie) matched geen rij — geen enkel veld bevat
  de complete string. Werkt wel voor single-word: "Jan", "Jansen", "jansen@", "+316".
- Niet-blokkerend; gebruikers zoeken in praktijk vrijwel altijd single-word.
- Cleanup-opties (2A.4 of later):
  * Frontend splits search op spaties → AND tussen woorden, OR tussen velden;
    vereist API-wijziging om meervoudige terms te accepteren.
  * DB generated column `search_text` (first_name || ' ' || last_name) met
    trigger-onderhoud → single ILIKE. Cleanste oplossing maar migratie nodig.

**AVG-impact: PII in `audit_log` JSONB** (Fase 2A.3 → 2C)
- `audit_log.before_json` en `after_json` bevatten volledige customer-rows
  (email, phone, address). Bij `customer.anonymized` (Art. 17 GDPR) moet
  óók de PII in eerdere audit-entries gehasht of geredigeerd worden — anders
  blijft erasure incompleet.
- Beslissing 2C: scrub-on-anonymize (UPDATE audit_log SET before_json/after_json
  met PII-velden → '\<redacted\>') of separate anonymized_audit_log met
  hash-trail. Niet in scope 2A.

**Master-checkbox indeterminate-state niet geïmplementeerd** (Fase 2A.4 commit 6)
- Bij partiële selectie (0 < selectedIds.size < pageSize) toont master-checkbox
  unchecked i.p.v. indeterminate. Functioneel correct, alleen visueel signaal
  ontbreekt.
- Cleanup: `master.indeterminate = true` wanneer partial in `syncSelectAllCheckbox()`.
- Trivial fix, MVP-OK.

**Contextuele bulk-action-bar (optioneel)** (Fase 2A.4 commit 6)
- Action-bar toont altijd Archiveren + Tag-actie ongeacht selectie-mix
  (active + archived klanten samen).
- Server doet juiste no-ops (archive op already-archived = success no_op).
- Cleaner UX zou: bij alleen-archived selectie → "Heractiveren"-knop ipv
  "Archiveren". Vereist per-row status-check tijdens render of state-tracking.
- Niet kritiek; user ziet bulk-result banner met no-op count.

**Counter-bump inconsistentie** (Fase 2A.4 commit 5)
- `addTag/removeTag` (CHUNK C) updaten counter+badge inline.
- Notes-handlers (CHUNK D) gebruiken `bumpCounter()` helper.
- Functioneel identiek; cleanup: refactor addTag/removeTag → `bumpCounter`
  voor consistentie.

### 🎓 Leerpunten Supabase Branching merge (Fase 1)

1. **Seeds in een migratie-file worden GESKIPT bij merge naar production branch**
   ("Skipping seed data for protected branch"). Voor Fase 2A en verder: seeds in
   `supabase/seed.sql` plaatsen, NIET in de migratie-file. Of: handmatige seed-stap
   onderdeel van merge-runbook houden.

2. **Branch-merge UI kan vasthangen op "Waiting for run to start"** als een follow-up
   step (functions listing) faalt met 502. De DB-migratie kan dan TOCH succesvol zijn —
   altijd via read-only queries verifiëren in plaats van op UI vertrouwen.

3. **`workflow_run_id`** zichtbaar in branches → View Logs → geeft precies aan welke
   stappen draaiden. Eerste plek om te kijken bij stuck merges.

4. **Handmatige data-fixes op productie main na een gefaalde merge zijn veilig**, MITS:
   - Idempotente queries (ON CONFLICT DO NOTHING)
   - Geen UPDATE/DELETE op bestaande rijen
   - Eerst read-only validatie van staat

5. **Branch-creation kopieert SCHEMA, niet DATA**
   - Supabase branching maakt schema-consolidatie snapshot
   - INSERT-statements uit migraties gaan NIET mee bij branch-creation
   - Daarom moet `supabase/seed.sql` self-contained zijn voor ALLE data die
     preview branches nodig hebben — ook tag-definities die eigenlijk in
     migratie 012 staan
   - Verifieerd via `schema_migrations` table die alleen 'remote_schema' +
     'branch_merge' entries toont
   - Implicatie: bij elke nieuwe DB-tabel met seed-data, plaats die seed in
     `seed.sql`, NIET alleen in migratie

6. **Branch protection op main kan onverwacht onmergebaar zijn**
   - PR #3 (mini-migratie 013) bleef hangen op "Checking for the ability to merge
     automatically..."
   - Tooltip toonde "failing merge requirements" maar UI gaf geen details
   - Workaround Fase 2A.2: migratie handmatig via Supabase SQL Editor op productie
     + PR gesloten met comment
   - Actie voor Fase 2A.4: VÓÓR final 2A PR-merge eerst branch protection rules op
     main investigeren in Settings → Branches
   - Vermijd opnieuw stuck-merge op grotere PR

### 🔍 Leerpunten Fase 2A.4 smoke-test diagnose

1. **Static code-review heeft fundamentele limieten zonder live DevTools**
   - BUG 1 (silent-fail first-click) + BUG 2 (ESC bulk-modal) diagnose toonde dat
     pure code-trace zonder Chrome DevTools-data (console-logs, network-tab,
     breakpoint-stepping) geen 100%-zekere root-cause kan aanwijzen.
   - Voor toekomstige UI-bugs: **debug-logging-commit als first response**,
     niet vermoedens. Eén deploy-cycle is goedkoper dan 5 hypothesen.
   - Patroon: tijdelijke `console.log` op kritieke event-paden + push → reproduceer
     in browser → log-trace toont root-cause → echte fix in volgende commit.

2. **Hard-refresh test eerst bij UI-bug-rapport op preview-deploy**
   - Vercel preview-builds cachen aggressively in browser.
   - BUG 2 (ESC bulk-modals niet werkend) bleek false-positive: code-structuur
     was correct, oorzaak waarschijnlijk stale browser-cache van eerdere build.
   - Standaard eerste actie bij elke smoke-test-bevinding: Ctrl+Shift+R + verifieer
     commit-hash in Vercel deploy-info matched verwachte SHA.
   - Vermijd debug-cycles op valse-positieven.

3. **Capture-phase event-handlers als default voor modal-mechanics**
   - ESC-fix in Fase 2A.3 (capture: true op document keydown) loste een hele
     klasse "ESC werkt niet wanneer focus in input zit" bugs op.
   - Generieke regel: voor modal close-via-ESC altijd capture-phase op document,
     niet bubbling-phase op modal-element. Robuust tegen browser-native input
     handling + nested stopPropagation in form-elementen.
   - Eenmaal correct geïmplementeerd, geen herhaling van issue in latere modals.

---

## 📊 Sales-dashboard (2026-05-27)

> Eigen dashboard-variant voor role=sales (Dave Heylen — enige sales-user).
> Branch: `feature/sales-dashboard` (3 feature-commits, smoke-test pending).

### ✅ Afgerond (lokaal, nog geen push)
- [x] `/api/sales-dashboard-stats` aggregator-endpoint (commit ea8c2cf)
      - 8 parallel queries via Promise.all
      - Hergebruikt `computeMetrics()` uit follow-up-metrics voor
        appointments + voicememos (today/week)
      - Eigen queries: leads/events (global, email-categorie),
        open follow-ups, tomorrow appts, overdue top-5, next appointment
      - Auth: ALLOWED_ROLES = super_admin/admin/manager/sales
      - Scoping: sales → owner-scoped (Dave's user_id),
        anderen → globaal (MVP — geen lead-ownership op leads/events)
      - Week = maandag deze week → vandaag-eind (NL-conventie)
- [x] Sidebar redirect + RBAC feature_keys (commit 6224edf)
      - `index.html` redirect role=sales naar /modules/sales-dashboard.html
        (vóór loadDashboard() — voorkomt onnodige queries)
      - `sidebar.js`: applyDashboardRouting() past Dashboard-link href aan
        voor sales-users; highlightActive() laat sales-dashboard onder
        Dashboard-link vallen; MODULE_FEATURE_MAP['sales-dashboard']
      - `admin.html` FEATURE_REGISTRY: dashboard.sales.view toegevoegd
- [x] `modules/sales-dashboard.html` (commit da7bbac)
      - 9-widget layout in 3 blokken: Vandaag (4) / Deze week (4) /
        Werkvoorraad (tomorrow + open follow-ups + Volgende afspraak
        panel met countdown + Achterstallig top-5 panel met deep-link)
      - 5-level countdown: nu / over X min / over Xu / morgen HH:MM /
        weekdag HH:MM / DD MMM HH:MM
      - Page-level RBAC check op dashboard.sales.view (defense-in-depth)
      - XSS-safety: escapeHtml + encodeURIComponent op deep-link param

### ⏳ Open punten (vóór push naar main)
- [ ] **GATE smoke-test**: Vercel preview deployment van branch
      `feature/sales-dashboard`. Loop alle 9 widgets door als Dave
      (role=sales). Verifieer: redirect werkt, KPI's vullen,
      countdown rendert, overdue deep-link opent follow-up tab.
- [ ] role_permissions seeding voor `dashboard.sales.view`:
      één keer "Opslaan" in admin RBAC-tab nadat PR live is →
      upsert maakt rij voor sales=true / overige rollen=false aan.
- [ ] Optioneel: deep-link support in follow-up.html voor
      `?tab=opvolging&appointment=<id>` (3 regels JS in init()).
      Nu valt link plain op /modules/follow-up.html zonder tab-state.

### 📌 Notities
- Dave's profile geverifieerd: role='sales', is_active=true,
  partners@deforexopleiding.nl. Geen DB-aanpassing nodig.
- Geen migraties. Geen schema-wijzigingen. Alleen 3 nieuwe files
  (1 endpoint + 1 module-page) + 3 file-edits (index/sidebar/admin).

---

## ✉️ Email-classifier fix (2026-05-26)

### ✅ Afgerond
- [x] Reclassify-tool slaat geen leerdata op → opgelost via gedeelde
      `applyLearning()` helper in `api/_lib/email-learn.js` (commit 1+3)
- [x] sync-emails geeft lege bodySnippet aan classifier → 3-pass refactor:
      body-fetch vóór categorize (commit 2)
- [x] Backfill-endpoint voor ~2100 historische reclassify-correcties
      (`api/email-reclassify-backfill-learnings.js`, commit 4)

### ⏳ Open punten
- [ ] Backfill draaien op productie (GATE 4 na PR-merge) — POST execute
      in chunks van 50 tot done=true. Verifieer eerst preview-aggregatie.
- [ ] Monitoring 1-2 weken: foutpercentage classifier meten na backfill.
      Welke senders blijven verkeerd geclassificeerd = TODO data voor
      Niveau 2 evaluatie (Train Agent UI heroverwegen?).
- [ ] Train Agent UI evalueren: nog nodig na fix? Als reclassify-tool
      hetzelfde leereffect heeft, is de "Verplaats & Train"-knop in
      modules/email.html mogelijk redundant.

### 🔍 Leerpunten

1. **Refactor naar `_lib` helper-pattern als single source of truth**
   - Wanneer 2+ endpoints dezelfde business-logica gebruiken: extract
     naar `api/_lib/<feature>-<concern>.js` met dependency-injection
     (supabase als parameter, niet module-import).
   - Voorkomt drift tussen callers; bug-fixes raken alle callers tegelijk.
   - Voorbeeld: `api/_lib/email-learn.js` (Train Agent + Reclassify +
     Backfill gebruiken nu dezelfde flow).

2. **Sync-emails volgorde-bug: body-fetch hoort vóór classify**
   - Classifier-input moet altijd compleet zijn bij eerste call.
   - 3-pass aanpak (envelope → body → classify) maakt afhankelijkheden
     expliciet zichtbaar.
   - Try/catch resilience per pass: body-fetch-fail → snippet=null →
     classifier krijgt '' (fallback gedrag, geen crash).

3. **Marker-pattern in `category_reason` voor backfill-detectie**
   - Originele reclassify-tool schreef `[bron: reclassify-2026-05-22] …`
     in `email_messages.category_reason`. Achteraf perfect identificeerbaar
     voor backfill: `WHERE category_reason ILIKE '%reclassify-2026-05-22%'`.
   - Pattern voor toekomstige bulk-operations: altijd een unieke
     timestamp-marker meeschrijven, ook bij no-op writes.

4. **`VALID_CATEGORIES` mogelijk duplicate source**
   - Nu gedefinieerd in `api/_lib/email-learn.js`.
   - Mogelijk ook gehardcoded in `api/email-agent.js` en/of frontend.
   - Cleanup-kandidaat: single-source-of-truth via export/import (later).

5. **Silent-catch in `applyLearning` regel 235-237 maskeert constraint-violations**
   - Bij DB-failure (FK/RLS) blijft `learn_example_id = null`, maar caller
     krijgt `ok: true` ongedaan. Niet kritisch voor productie (DB werkt
     normaal), maar verstorend voor diagnose tijdens smoke-tests met
     fake payloads.
   - Cleanup-optie: throw met `.statusCode = 500`, of return `error_flag`
     in response zodat callers kunnen onderscheiden tussen "geleerd" en
     "leerdata-fail maar mutation OK". Niet voor commit 5 fix.

6. **Smoke-test methodologie: endpoints met FK/RLS niet testen met fake payloads**
   - Endpoints die naar tabellen met foreign-key-constraints of RLS-policies
     schrijven, kunnen NIET getest worden met volledig fictieve payloads
     (bv. random email_id). Silent-catch op DB-errors maskeert dan de
     constraint-violation → test lijkt OK terwijl niets is opgeslagen.
   - Best practice: smoke-test met read-only DB-verifie van recente
     productie-records (`SELECT … ORDER BY corrected_at DESC LIMIT 5`),
     OF realistische payload met bestaande email_id uit dezelfde DB.
   - Bevinding tijdens GATE 1 smoke-test (commit 1 refactor): Chrome
     gebruikte fake email-id, FK-violation werd gevangen door silent-catch,
     `learn_example_id` was null. Bewees dat refactor zelf OK was.

7. **Category-naming mismatch in `applyLearning` (FIX 2026-05-27)**
   - Symptoom: backfill skipt 5 cats (325 unique pairs), Train Agent
     silent 400-fails op nieuwe categorienamen.
   - Root cause: `VALID_CATEGORIES` in `api/_lib/email-learn.js` was
     verouderd (7 cats) vs `api/email-agent.js` regel 4-6 (10 cats).
   - Impact: Train Agent werkte maanden niet voor 5 hoofd-categorieën
     (Klantvragen, Partners, Betaalbevestigingen, Openstaande facturen,
     Aankopen/betalingen) zonder zichtbare error (UI `.catch` swallowed).
   - Bevinding tijdens GATE 4 backfill (PR #5 merged): Chrome rapporteerde
     472 unique pairs in preview, maar slechts 147 verwerkt → 325 silent
     gefaald op categorie-validatie.
   - Fix: `VALID_CATEGORIES` gesynchroniseerd met `email-agent.js`
     (10-items lijst). Sync-comment toegevoegd voor toekomstige consistency.
   - **Cleanup TODO**: gedeelde constants-file om dual-source te elimineren
     (bv. `api/_lib/email-categories.js` met `export const CATEGORIES`,
     import in zowel `email-agent.js` als `email-learn.js`).

---

## ✅ Gerealiseerd 2026-05-14 — Fase C + Role-architectuur + RLS + Auth-gate

- [x] Fase C admin panel (commit 1cdf138): api/admin-users.js GET/POST/PATCH/DELETE, verifyAdmin, logAudit, recovery link via Strato SMTP; modules/admin.html user-management UI
- [x] Mini Fase E — renderUserSection (commit f06a37f): agent-shared.js + auth-aware index.html footer
- [x] Logo regression fix — handleLogoError verwijderd uit alle modules (commit c8aa3a3)
- [x] Fase E rollout — auth-aware sidebar naar 6 modules (commit 82cccea)
- [x] docs sessie-log 14 mei admin+E rollout (commit 291a354)
- [x] Pre-D1 two-client Supabase architectuur (commit f24491f): createUserClient(req), supabaseAdmin gescheiden, verifyAdmin + logAudit
- [x] D1 batch 1 RLS (SQL): backfill_progress + backfill_body_progress super-only policies
- [x] Endp-1A backend — createUserClient op 9 endpoints (commit bac5bc0)
- [x] Endp-1A frontend — apiFetch wrapper + 22 call-sites (commit 708e8c3)
- [x] C1 — role-architecture document (commit ba57a3f): docs/role-architecture.md
- [x] C2 — profiles schema-migratie (SQL): 7-rollen check, manager_id FK + index
- [x] C2b — admin gates voor super_admin + manager (commit a130e04): ADMIN_ROLES, VALID_ROLES, super_admin-grant guard, CSS badges
- [x] C3 — owner-kolommen op 5 tabellen (SQL): 6 kolommen toegevoegd
- [x] C4 — backfill 349 rijen naar Amigo uuid (SQL)
- [x] C5 — backend schrijft owner_id bij CREATE (commit 93a7243): taken (Optie A split), agent-meeting, agent-chat, send-email, undo
- [x] C5 fix — Authorization headers meetings + agents (commit 1978f00): 14 fetch → apiFetch
- [x] C6.1 RLS rollout (SQL): kennisbank_items, agent_kennisbank, agent_learnings, learn_examples, email_actions
- [x] C6.2 RLS rollout (SQL): taken_items, agent_meetings, agent_conversations, email_replies, undo_history
- [x] C6.2 fix — read-handlers agent-meeting via createUserClient (commit bcb821f)
- [x] C6.3 RLS rollout (SQL): email_patterns, email_sync_log, email_messages, decisions, agent_approval_queue, agent_audit_log, team_members
- [x] C7 — auth-gate op 7 module-pagina's (commit c409033): requireAuth() vóór data-fetches
- [x] C7 fix — await _authSharedReady race-condition (commit 4d69ebf): alle 7 init() functies
- Dashboard data + admin nav-link fix (commit a5a4c09): dashboard-stats.js via createUserClient + cache verwijderd voor cross-user veiligheid, admin nav-link in 7 sidebars met role-toggle

---

## 🔧 Polish-items (ontdekt tijdens RLS + auth-gate rollout)

### [polish-3] Taken UI filter mismatch
**Bestand:** `modules/taken.html` — view-selector
**Probleem:** taken.html filtert op pre-existing `colleagues.id` ipv `auth.users.id`. Taken met `toegewezen_aan` = legacy-id verschijnen niet bij default-view.
**Fix:** View-selector koppelen aan ingelogde user's uuid i.p.v. hardcoded colleague-id
**Impact:** Jeffrey ziet eigen taken niet tenzij hij zijn collega-entry selecteert

### [polish-4] Admin inline role-selector incomplete voor super_admin
**Bestand:** `modules/admin.html` — inline role-selector
**Probleem:** In manager-view toont inline role-selector "manager" als hoogste optie. Als super_admin user wordt bekeken, valt select terug op leeg/verkeerd. Read-only fallback nodig voor rollen buiten de eigen selectielijst.
**Fix:** Fallback: als `u.role` niet in opties zit → toon `<span class="role-badge ...">` i.p.v. `<select>`

### [polish-5] Role-badge CSS aanwezig maar niet gebruikt
**Bestand:** `modules/admin.html`
**Probleem:** CSS `.role-badge.super_admin` + `.role-badge.manager` toegevoegd in C2b maar tabel gebruikt inline-selects. Badges alleen zichtbaar als polish-4 fix select vervangt door badge.
**Fix:** Na polish-4: badges activeren voor weergave; CSS opruimen als besloten wordt badges niet te gebruiken

### [polish-6] agent-conversations endpoint soms 0 messages
**Bestand:** `api/agent-conversations.js`
**Probleem:** `/api/agent-conversations` met session_id retourneert soms 0 messages terwijl SQL data toont. Endpoint-logica onduidelijk over RLS-interactie na C6.2.
**Fix:** Endpoint inspecteren op RLS-filtering + createUserClient aanroep; smoke test na fix

### [polish-7] control-center directe fetch inconsistentie
**Bestand:** `modules/control-center.html`
**Probleem:** 1 directe `fetch('/api/agent-meeting?action=get_history')` nog niet via apiFetch. Geen owner-write dus geen RLS-impact; consistency-improvement.
**Fix:** Vervang door `AgentShared.apiFetch(...)` — 5 minuten

### [polish-8] meetings.html first-refresh race condition
**Bestand:** `modules/meetings.html`
**Probleem:** Eerste hard refresh toont soms Geschiedenis: 0; tweede refresh correct. Mogelijke JWT-bootstrap race condition na await _authSharedReady.
**Fix:** Onderzoek of loadAllArchiveData() te vroeg vuurt; mogelijk extra await nodig

### [polish-9] reset-password.html UX verbetering
**Bestand:** `reset-password.html`
**Probleem:** Zonder geldig reset-token redirect naar `/login?error=callback_failed`. Werkt veilig maar user-experience kan beter met inline "voer e-mail in voor nieuw reset-verzoek" UI.
**Fix:** Detecteer ontbrekend token → toon inline reset-formulier i.p.v. redirect

### [polish-11] dashboard open_taken semantiek
**Bestand:** `api/dashboard-stats.js`
**Probleem:** dashboard-stats filtert open_taken op deadline-in-periode, niet status='open'. Resultaat: Amigo ziet 0 open taken op dashboard ondanks 4 actieve in /modules/taken.html.
**Beslissing nodig:** Tonen we "alle open" of "open met deadline in periode"?

### [polish-12] admin-knoppen misleidend voor manager
**Bestand:** `modules/admin.html`
**Probleem:** Jeffrey (manager) ziet "Deactiveer" en "Opnieuw uitnodigen" knoppen voor Amigo's rij. Server-side admin-users.js gate werkt correct (PATCH 403), maar UI toont knoppen die effectief niets doen bij klik.
**Fix:** Hide actie-knoppen voor rijen waar caller geen rechten heeft.

---

## 🔐 Geparkeerde Auth-items (15 mei 2026)

Diagnose recovery-link flow + SMTP-config geparkeerd tijdens scope-discussie Follow-up Module.

- **[auth-1]** Dave + Maxim handmatig wachtwoord setten via Supabase dashboard (tijdelijke unblock zodat ze kunnen inloggen)
- **[auth-2]** Diagnose-flow recovery-link afmaken: verse link genereren via `/api/admin-generate-link` endpoint (live, commit 37366b1), openen in nieuwe tab, observeren of reset-password.html werkt of fallback verschijnt. Bij fallback: frontend-fix nodig in reset-password.html (race-condition vermoeden, vergelijkbaar met C7 fix).
- **[auth-3]** Custom SMTP configureren via Strato `noreply@deforexopleiding.nl` in Supabase Authentication settings. Vereist: Strato mailbox aanmaken, SMTP credentials, SPF/DKIM/DMARC records in DNS. Lost rate limit (2/h → onbeperkt) en deliverability op.
- **[auth-endp]** `/api/admin-generate-link` endpoint hoort bij `endp-2-cleanup` familie voor verwijdering na voltooiing auth-2.

---

## 🟢 NIET-BLOKKEREND — Toekomstige verbeteringen

### [NB1] KPI banner CC uitbreiden met meeting-taken counter
**Bestand:** `modules/control-center.html` — `loadKPIBanner()` + KPI-grid HTML  
**Verzoek:** Voeg een vijfde KPI-kaart toe: "Actieve meeting-taken: N" met klik-door naar Takenbeheer  
**Aanpak:** `GET /api/agent-task?action=list&source=meeting&status=open` → count → `<a href="taken.html">` wrapper om de kaart  
**Prioriteit:** Laag — Takenbeheer-module dekt dit al af, dit is een shortcut

---

## 🔴 KRITIEK — Direct aanpakken

### [K1] Group C/D propagatie body_snippet gap
**Bestand:** `modules/email.html` — `sendLearningCorrection()` ~lijn 1929  
**Probleem:** `emailList` bevat geen `body_snippet` per mail → `computePropagation()` in learn.js kan groepen C/D nooit matchen  
**Fix:** Voeg `body_snippet` toe aan elk item in emailList vanuit `state.bodyCache`  
**Status:** ✅ GEFIXED (2026-05-11)

### [K2] Kennisbank → Supabase sync ✅ VOLLEDIG GEFIXED (2026-05-12)
**Wat opgelost:**
- Gap 1: `loadFromSupabase()` awaited + re-render na load (was: fire-and-forget zonder re-render)
- Gap 2: CRUD writes awaited met proper error handling + toast bij failure (was: `.catch(() => {})`)
- Gap 3: DELETE/UPDATE op Supabase uuid via PUT+DELETE HTTP methoden (was: label-gebaseerde deduplicatie)
- localStorage volledig uitgefaseerd voor items en profiel (one-shot cleanup via `kb_migrated_v2` sessionStorage flag)
- Foutmelding bij laadprobleem: "Kennisbank kon niet geladen worden — refresh de pagina"

### [K3] Taken → Supabase persistentie ✅ GEFIXED
**Bestand:** `modules/taken.html`  
**Oplossing:** `taken_items` tabel + `/api/taken` endpoint; bi-directionele sync bij init; db-migrate éénmalig aangeroepen via `db_migrated_v1` flag

---

## 🟡 HOOG — Aanpakken binnen 1 week

### [H1] actionFlags + overrides Supabase backup
**Bestand:** `modules/email.html`  
**Probleem:** Handmatige categorisaties en actie-flags zijn enkel in localStorage  
**Fix:** Sla wijzigingen ook op in email_patterns (al aanwezig in Supabase)  
**Schatting:** 1-2 uur

### [H2] Undo history persistentie
**Bestand:** `modules/email.html` + `api/undo.js`  
**Probleem:** `/api/undo` endpoint bestaat maar wordt nooit aangeroepen. Frontend undo is puur localStorage.  
**Fix:** Roep `/api/undo` aan bij `undoManager.push()` en `undoManager.executeUndo()`  
**Schatting:** 2 uur

### [H6] Agents tool-gebruik — add_knowledge_base_item schrijft naar kennisbank ✅ GEFIXED
**Bestand:** `api/agent-tools.js` + `api/agent-chat.js`  
**Oplossing:** Tool toegevoegd met validatie (min 20 / max 5000 tekens), write-tag isolatie, bevestigingsworkflow in Simon's prompt. Simon vraagt altijd preview-bevestiging voordat hij opslaat.

### [H5] Agents Batch 2 — scheidslijn tussen sessies
**Bestand:** `modules/agents.html`  
**Probleem:** Geschiedenis van meerdere sessies wordt samengevoegd getoond zonder visuele scheiding  
**Fix:** Groepeer berichten per `conversation_session` in de history-render, toon datum/tijdstip header per sessie  
**Schatting:** 1 uur

### [H3] Authenticatie op API endpoints
**Bestanden:** `api/*.js`  
**Probleem:** Alle endpoints zijn publiek — iedereen kan categoriseren/leren/replies genereren  
**Fix:** Simpel shared secret in header (`X-Api-Key`) of Vercel auth  
**Schatting:** 1-2 uur

### [H4] Dead code opruimen: api/categorize.js
**Bestand:** `api/categorize.js`  
**Probleem:** 19KB legacy code, volledig vervangen door email-agent.js, nergens meer aangeroepen  
**Fix:** Bestand verwijderen  
**Schatting:** 5 minuten

---

## 🟢 MEDIUM — Aanpakken binnen 2 weken

### [M1] Rate limiting op generate-reply
**Bestand:** `api/generate-reply.js`  
**Probleem:** Geen limiet — potentieel kostbaar bij misbruik (Claude Sonnet per request)  
**Fix:** Max X requests per IP per uur (bijv. via Vercel middleware of teller in Supabase)  
**Schatting:** 1 uur

### [M2] AI-replies Supabase sync
**Bestand:** `modules/email.html`  
**Probleem:** Gegenereerde replies staan alleen in `emailAiReplies` localStorage  
**Fix:** Opslaan in bestaande `email_actions` tabel (action='ai_reply', value=reply_text)  
**Schatting:** 30 minuten

### [M3] Server-side IMAP caching
**Bestand:** `api/emails.js`  
**Probleem:** Bij elke page load worden 4 IMAP-verbindingen opgezet  
**Fix:** Cache resultaat 60s in Supabase of Vercel KV  
**Schatting:** 2-3 uur

### [M4] Dashboard statistieken persistentie
**Bestand:** `index.html`  
**Probleem:** Statistieken zijn localStorage-only  
**Fix:** Gebruik learning-report API data als primaire bron  
**Schatting:** 1 uur

---

## 🏗️ ARCHITECTUUR — Tooling foundation

### [A2] Mail-sync naar Supabase ✅ FASE 1+2 VOLLEDIG GEFIXED (2026-05-13)
**Wat opgelost:**
- `email_messages` tabel + `email_sync_log` tabel toegevoegd aan `db-migrate.js`
- `api/sync-emails.js`: cron-endpoint met CRON_SECRET auth, per-mailbox incrementele UID-sync, categorize() integratie, idempotente upsert, 55s abort-guard
- `vercel.json`: cron `*/5 * * * *` op `/api/sync-emails`
- `api/sync-status.js`: monitoring-endpoint met log-history, per-mailbox tellingen, categorie-verdeling
- 12 kolomnaam-mismatches gefixed (2026-05-12): alle Supabase-queries gealigneerd met werkelijk schema
- **Fase 2 (2026-05-13):** body_text + body_html per mail via simpleParser (mailparser). Live-sync haalt body mee bij nieuwe mails. Backfill voor 5613 historische mails via `api/backfill-bodies.js` (cron */5). `get_email_body` tool toegevoegd voor agents. `get_email_detail` toont `body_preview`. `search_emails` ondersteunt `search_in_body:true`.
- **Fase 3 (Fase 3 van tools):** Simon's search_emails, get_unanswered_emails, get_email_stats, get_email_categorization_stats direct op email_messages (2026-05-13)

### [A1] email_categorizations tabel — per-mail categorie-opslag
**Prioriteit:** Hoog (blokkeert eerlijke email-statistieken in Simon)  
**Probleem:** AI-categorisaties worden alleen in `localStorage._aiCatCache` opgeslagen. `get_email_stats` kan daardoor geen actuele "hoeveel Nieuwe Leads vandaag"-vraag beantwoorden via Supabase. De tool retourneert nu historische patronen als benadering, met duidelijke kanttekening.  
**Fix:** Nieuwe tabel aanmaken in db-migrate.js:
```sql
CREATE TABLE IF NOT EXISTS email_categorizations (
  id          bigint generated always as identity primary key,
  email_id    text not null,
  mailbox     text,
  category    text,
  confidence  integer,
  source      text default 'ai',   -- 'ai' | 'manual'
  categorized_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS idx_email_cat_date ON email_categorizations (categorized_at);
```
En in `api/email-agent.js`: bij elke categorisatie een rij invoegen.  
**Impact:** `get_email_stats` kan dan echte per-periode-aantallen teruggeven.  
**Schatting:** 2-3 uur

---

## 🔵 LAAG — Nice to have

### [L1] HTML escape consistentie audit
**Bestanden:** `modules/email.html`  
**Probleem:** Email velden gaan merendeels via `escapeHtml()`, maar audit alle render-functies  
**Fix:** Zoek alle `.innerHTML` assignments zonder `escapeHtml()`  

### [L2] kennisbank_items helpfulness tracking
**Bestand:** `modules/kennisbank.html` + `api/generate-reply.js`  
**Probleem:** `times_used` en `helpfulness_score` worden niet geüpdated bij AI-reply gebruik  
**Fix:** PATCH kennisbank_items na succesvolle reply  

### [L3] Snooze Supabase persistentie
**Bestand:** `modules/email.html`  
**Probleem:** Snooze tijden in localStorage  
**Fix:** Kolom toevoegen aan email_actions  

### [L4] Body cache expiry
**Bestand:** `modules/email.html`  
**Probleem:** Body cache groeit onbeperkt in localStorage  
**Fix:** Oudste entries verwijderen als cache > 50 items  

---

## 🅿️ PARKEER-LIJST — Fase C (niet in scope, bewust uitgesteld)

> Bijgewerkt: 2026-05-13 na Fase C sessie (commits `bf3ff35`, `9adb307`)

### [endp-1] Bearer-only validatie op 9 browser-endpoints ✅ GEDAAN (2026-05-14, commits bac5bc0 + 708e8c3)
**Opgelost:** `createUserClient(req)` helper in `api/supabase.js`; 9 endpoints omgezet; `apiFetch` wrapper in agent-shared.js; email.html + kennisbank.html + taken.html + agents.html bijgewerkt. meetings.html + agents.html gefixed in aparte commit 1978f00.

### [endp-2] Setup/one-time endpoints verwijderen
**Bestanden:** `api/admin-seed-users.js`, `api/db-migrate.js`, `api/db-migrate-batch-meetings.js`, `api/db-migrate-batch-meetings-v2.js`, `api/db-migrate-email-bodies.js`, `api/debug-supabase.js`, `api/test-smtp.js`
**Probleem:** One-time endpoints die al uitgevoerd zijn; blijven deployment-surface vergroten
**Fix:** Verwijderen in losse opschoning-commit
**Schatting:** 30 minuten

### [endp-3] verify-meeting-tasks + daily-quote: dode code check
**Bestanden:** `api/verify-meeting-tasks.js`, `api/daily-quote.js`
**Probleem:** Niet in vercel.json — worden ze überhaupt aangeroepen?
**Fix:** Grep op aanroepen; indien geen → verwijderen (deel van endp-2)
**Schatting:** 15 minuten

### [endp-4] DEP0169 url.parse() deprecation warnings opruimen
**Bestanden:** alle 5 cron-endpoints (zichtbaar in Vercel logs)
**Probleem:** `url.parse()` deprecated in Node.js, stuurt warnings in Vercel logs
**Fix:** Vervang door `new URL(req.url, 'http://localhost')` pattern
**Schatting:** 30 minuten

### [endp-5] backfill-start + backfill-bodies-start: dode code
**Bestanden:** `api/backfill-start.js`, `api/backfill-bodies-start.js`
**Probleem:** Backfill is afgerond (5613 mails), endpoints worden nergens vanuit frontend aangeroepen. Effectief dode code.
**Fix:** Verwijderen (samen met endp-2 setup endpoints) in losse opschoning-commit
**Schatting:** 5 minuten (deel van endp-2)

### [P-C1] reject_reason workflow uitbreiden
**Wat:** Optionele modal bij afkeuren in de approval-inbox — laat Jeffrey een reden invullen die bewaard wordt in `agent_approval_queue.reject_reason` en zichtbaar is in het audit-log.
**Waarom geparkeerd:** Core-flow werkt zonder. Purist refinement.

### [P-C2] Aparte `rejected_by` kolom in approval queue
**Wat:** Aparte `rejected_by` kolom naast `approved_by` voor duidelijkere querying. Nu worden beide gevallen via `approved_by` opgeslagen.
**Waarom geparkeerd:** Functioneel correct, uitbreiding is een schema-migratie.

### [P-C3] Mollie-integratie voor Aron's `draft_payment_reminder`
**Wat:** `identify_payment_concerns` en `draft_payment_reminder` zijn nu gebaseerd op e-mailcategorisering (`Factuurvraag`). Koppeling met Mollie API zou echte openstaande facturen geven.
**Waarom geparkeerd:** Mollie API-key + integratie is apart project. Aron communiceert de disclaimer al.

### [P-C4] Fase 3 mail-sync — Simon's tools naar `email_messages` ✅ GEREED (2026-05-13)
**Opgelost:** Alle Simon-tools bevragen nu direct `email_messages`. Body-fetch (Fase 2) volledig geïmplementeerd. Zie `[A2]`.

### [P-C5] B2 chair-detectie strenger
**Wat:** De chair-agent in de vergaderruimte is soms te chatty — interrupts te vaak. Drempel verhogen of detectie op basis van speaking-time.
**Waarom geparkeerd:** UX-verbetering, geen blocker.

### [P-C6] B5 status-update limit per agent (max 5)
**Wat:** Leon en Aron kunnen `update_task_status` onbeperkt aanroepen in één ronde. Max 5 per tool-round toevoegen als guard.
**Waarom geparkeerd:** Approval-workflow beschermt Jeffrey al; limit is extra veiligheidslaag.

### [P-C7] Instant-add knop tijdens vergadering voor multi-assignee
**Wat:** Snelknop om tijdens een lopende meeting direct een taak toe te voegen met multi-assignee UI (nu enkel via actiepunten-review na afloop).
**Waarom geparkeerd:** Feature-wens, geen blocker voor core-vergaderworkflow.

### [P-C8] Voice input voor vergaderruimte
**Wat:** Spraak-naar-tekst voor agent-berichten tijdens de meeting, zodat Jeffrey hands-free kan chatten.
**Waarom geparkeerd:** Browser Web Speech API instabiel. Toekomst.

---

## Voltooide items ✅

- [x] AI-categorisatie met Claude Haiku (email-agent.js)
- [x] Leerlogica met propagatie groepen A-D (learn.js)
- [x] Verplaats & Train inline panel
- [x] Universele sectie-verplaatsing (alle tabs, `...` menu)
- [x] VT panel in Informatie + Reclame / Overige tabs
- [x] Sectie-selector in VT panel met AI-hint voorinvulling
- [x] Undo systeem (10 stappen, Ctrl+Z, toast)
- [x] Propagatie banner (Group C bevestiging)
- [x] Leerrapport modal
- [x] Trainingsmodus (batch reclame/niet-reclame)
- [x] AI-reply genereren met kennisbank context
- [x] Vision + PDF extractie kennisbank
- [x] db-migrate auto-schema-check
- [x] Email acties loggen in Supabase
- [x] Kalenderweek + maand filter
- [x] "Reclame / Overige" naam doorgevoerd (was: Reclame review)
- [x] Group C/D body_snippet fix (K1)
- [x] Taken → Supabase persistentie (K3): taken_items tabel, bi-directionele sync, db-migrate init
- [x] Dashboard sync guard bug (Open Taken toonde 0): if (taken.length > 0) return verwijderd
- [x] Dashboard hero stats responsive grid (auto-fit minmax)
- [x] Dashboard hero volgorde: Event Aanmeldingen direct na Uitlegsessies
- [x] Dashboard KPI sparklines 14 dagen (Leads + Sessies met min/max markers)
- [x] Taken klikbaar in dashboard → taken.html?taskId
- [x] Verzonden mails persisteren na refresh — supabase-js client in send-email.js, dbSaved flag + amber toast
- [x] Bijlagen ontvangen tonen — email-body geeft metadata, /api/email-attachment endpoint voor download
- [x] Bijlagen meesturen — composer upload UI, max 5 bestanden / 8 MB raw, nodemailer MIME, metadata in email_replies
- [x] Module 1.2 finale fixes (3 bugs na deployment):
  - send-email.js conditionally omits attachments field → PostgREST error bij ontbrekende kolom opgelost
  - attachAttachmentHandlers() geëxtraheerd als gedeelde helper → werkt in Actie tab én body panels
  - updateCardPreview() injecteert bijlagen-sectie na async body-load in alle tabs
- [x] Module 1.3 UX-verbeteringen:
  - Bijlagen direct zichtbaar bij Actie tab render — fetchEmailBody roept updateActieCard aan (volledige re-render met gevulde cache)
  - Onderwerp-veld in reply composer — data-reply-subject input, pre-filled met Re: <origineel>, state.replySubject[] persistent over re-renders
- [x] Auth Fase A — Database foundation (2026-05-14):
  - profiles tabel + indexes + trigger on_auth_user_created
  - 4 RLS helper functies (get_user_role, is_admin, has_role, has_any_role)
  - 5 RLS policies op profiles tabel
  - api/admin-seed-users.js (one-time, Jeffrey geseed, SEED_SECRET verwijderd)
- [x] Auth Fase B — Login flow (2026-05-14):
  - /login.html (wachtwoord + magic link + wachtwoord vergeten inline)
  - /reset-password.html
  - /auth-callback.html
  - modules/shared/supabase-client.js + window.AuthShared helper
  - api/config.js (publieke keys voor browser)
- [x] Auth Fase C — Admin panel (2026-05-15):
  - api/admin-users.js: GET/POST/PATCH/DELETE, verifyAdmin, logAudit, recovery link via Strato SMTP
  - modules/admin.html: user-management UI, self-row guard, resend invite
- [x] Mini Fase E — renderUserSection (2026-05-15):
  - agent-shared.js: renderUserSection() toegevoegd + geëxporteerd
  - index.html: supabase-client.js + agent-shared.js geladen, footer-user leeg, renderUserSection call
- [x] Logo regression fix — handleLogoError verwijderd uit alle 8 modules (2026-05-15, commit c8aa3a3)
- [x] Fase E rollout — auth-aware sidebar naar 6 modules (2026-05-15, commit 82cccea):
  - email.html, taken.html, kennisbank.html, agents.html, meetings.html, control-center.html
- [x] Pre-D1 two-client Supabase architectuur (2026-05-14, commit f24491f):
  - `createUserClient(req)` helper in api/supabase.js (JWT-aware, fallback naar anon)
  - `supabaseAdmin` gescheiden van user-facing client; `verifyAdmin` + `logAudit` shared
- [x] Endp-1A — Bearer-only upgrade 9 browser-endpoints (2026-05-14, commits bac5bc0 + 708e8c3):
  - email-actions, email-patterns, sent-replies, taken, undo, generate-reply, learn, send-email, kennisbank-sync
  - apiFetch wrapper in agent-shared.js; Bearer headers in email.html, kennisbank.html, taken.html, agents.html
- [x] C1 — Rol-architectuur document (2026-05-14, commit ba57a3f):
  - docs/role-architecture.md: hiërarchisch RLS design, 5 rollen, patronen 1-5, beleidsmatrix, implementatievolgorde
- [x] C2b — Admin gates uitgebreid voor super_admin + manager (2026-05-14, commit a130e04):
  - verifyAdmin: ADMIN_ROLES = ['super_admin','admin','manager']
  - admin-users.js: VALID_ROLES uitgebreid + super_admin-grant guard (POST + PATCH)
  - admin.html: requireAuth array, dropdowns, conditional super_admin visibility, CSS badges
- [x] C5 — Backend schrijft owner_id bij CREATE (2026-05-14, commit 93a7243):
  - taken.js: Optie A split (insert met owner_id, update zonder)
  - agent-meeting.js + agent-chat.js: dual import pattern, owner_id/user_id bij insert
  - send-email.js: sent_by_id via auth.uid()
  - undo.js: performed_by_id via auth.uid()
- [x] C5 fix — Authorization headers meetings.html + agents.html (2026-05-14, commit 1978f00):
  - meetings.html: 12 fetch-calls → apiFetch; agents.html: 2 fetch-calls → apiFetch
- [x] C6.2 fix — READ-handlers agent-meeting.js naar createUserClient (2026-05-14, commit bcb821f):
  - 6 SELECT-branches in GET-handler omgezet; smoke test C-1 ✅
- [x] Agents Batch 1 — volledig afgerond (2026-05-12):
  - Sessie persistence via localStorage per agent (agent_active_session_<name>)
  - api/agent-conversations.js: session_id teruggestuurd ook als berichten leeg (verse sessie)
  - Tooltips op 👍 en ✏️ knoppen, hint-tekst onder chat-input
- [x] Agents Batch 1 — memory + learning + shared brain + hygiene (2026-05-12):
  - db-migrate.js: agent_learnings tabel toegevoegd
  - api/agent-conversations.js: NIEUW — history laden (GET) + new-session (POST)
  - api/agent-learnings.js: NIEUW — learnings opslaan (POST) + ophalen (GET)
  - api/agent-chat.js: awaited inserts, directe Supabase stats voor Simon (geen localhost HTTP), learnings in systeem-prompt
  - api/agent-report.js: localhost fix + silent catch fix
  - api/agent-meeting.js: agentRows null-guard
  - api/email-agent.js: buildAiContext + systeem-prompt met Simon's learnings
  - modules/agents.html: history laden bij openChat, "+ Nieuwe sessie" knop met confirm, 👍/✏️ knoppen per assistant-bericht, train textarea (max 3 regels), toast functie
- [x] Module 1.3 Kennisbank Supabase-first:
  - localStorage uitgefaseerd (kennisbank_items + kennisbank_profile), one-shot cleanup via sessionStorage flag
  - kennisbank-sync.js: PUT (update by uuid) + DELETE (by uuid) endpoints toegevoegd, GET 500 bij fout
  - loadFromSupabase(): loading state, error state met bericht, re-render na succes
  - CRUD writes awaited: toast bij failure, save-knop re-enabled bij fout
  - Supabase cleanup SQL: zie hieronder voor handmatige uitvoering

---

## Volgende sessie priority items (status 14 mei — na rol-architectuur + C5)

### [C6.2-smoke] Smoke test C6.2 voltooien — tests C-2 t/m G
**Context:** Chrome extension disconnected na test C-1. Tests C-2 (Amigo ziet eigen meeting) t/m G (decisions filtering) zijn niet uitgevoerd.
**Actie:** Opnieuw opstarten Chrome extension + volledige smoke test matrix doorlopen
**Prioriteit:** Hoog (valideert C6.2 RLS correct voor team-launch)

### [C6.1] RLS rollout D1b1 — 5 authenticated-all tabellen
**Tabellen:** kennisbank_items, agent_kennisbank, agent_learnings, learn_examples, undo_history, email_actions
**Patroon:** Patroon 2 (authenticated read/write — iedereen die ingelogd is)
**Timing:** Na C6.2 smoke test volledig groen
**Prioriteit:** Medium

### [C6.3] RLS rollout C6.3 — 7 admin/super/manager tabellen
**Tabellen:** profiles, email_patterns, email_messages, team_members, agent_approval_queue, agent_audit_log, email_sync_log
**Patroon:** Patroon 3/4/5 (admin-only of via parent FK)
**Timing:** Na C6.1 + C6.2 volledig gevalideerd
**Prioriteit:** Medium

### [E2] Fase E2 — Admin-link conditioneel op ADMIN_ROLES
**Bestand:** `modules/shared/agent-shared.js` — `renderUserSection()`
**Probleem:** Admin-link tonen vereist check op `['super_admin','admin','manager']` — niet alleen `'admin'`
**Fix:** `if (ADMIN_ROLES.includes(profile.role))` of array-includes check
**Prioriteit:** Medium

### [E3] Maxim + Dave aanmaken via admin panel
**Actie:** Jeffrey kan dit zelf doen via /modules/admin.html
- Aanmaken + recovery link sturen + eerste login valideren per user
**Prioriteit:** Hoog (blokkeert team-toegang)

### [endp-2-cleanup] One-time + dead endpoints verwijderen
**Bestanden:** admin-seed-users.js, db-migrate.js, db-migrate-batch-meetings.js, db-migrate-batch-meetings-v2.js, db-migrate-email-bodies.js, debug-supabase.js, test-smtp.js, backfill-start.js, backfill-bodies-start.js, verify-meeting-tasks.js (check first)
**Fix:** Verwijderen in losse opschoning-commit (deel van [endp-2]+[endp-5])
**Schatting:** 30 minuten
**Prioriteit:** Laag

### [D2-RLS] Fase D2 RLS rollout
**Tabellen:** taken_items, taken_assignees, decisions, agent_meetings, agent_conversations, email_replies, email_patterns, email_sync_log
**Timing:** Na C6 volledig afgerond + team-accounts actief
**Prioriteit:** Medium (blokkeert multi-user data-isolatie)

### [P-CC1] Paginatitels inconsistent
**Bestanden:** `modules/*.html`, `index.html`
**Probleem:** Mix van "Naam · De Forex Opleiding" en "Naam | De Forex Opleiding" in `<title>` tags
**Fix:** Standaardiseer naar "Paginanaam · De Forex Opleiding" in alle modules
**Prioriteit:** Laag

### Fase D — RLS op bestaande tabellen (gefaseerd over 3 sub-sprints)
DOE PER SUB-SPRINT: TEST + DEPLOY + VERIFICATIE voor volgende

**D1** (start hier, niet-kritieke tabellen):
- kennisbank_items, agent_kennisbank
- agent_learnings, learn_examples
- undo_history, email_actions
- backfill_progress, backfill_body_progress

**D2** (middel-kritieke tabellen):
- taken_items, taken_assignees, taken
- decisions, agent_meetings, agent_conversations
- email_replies, email_patterns, email_sync_log

**D3** (hoogst-kritieke):
- email_messages (5613+ mails!)
- agent_approval_queue
- agent_audit_log
- team_members
- profiles (policies staan hier al op)

---

## 📞 Follow-up Module — Status 19 mei 2026

Volledig oorspronkelijk plan staat in `docs/sessie-logs/follow-up-module-plan.md` (versie 2.2, commit a6175d4).
Module is live in productie. Dave en Jeffrey gebruiken het actief.

### [PENDING] Acties Jeffrey direct
- [ ] Verifieer profiles syntax-fix productie (owner-filter dropdown bevat Dave)
- [ ] Zoom env vars Vercel: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
- [ ] End-to-end test call-verplaatsen feature

### [PENDING] v1.2 polish (niet kritiek)
- [ ] SHAPE2 webhook parser fix (poll vangt outbound nu)
- [ ] Frontend "Jazeker..." duplicate rendering (DB OK, DOM 2x)
- [ ] Stats-misleading poll-cron messages_upserted (telt skips als upsert)
- [ ] console.error in poll-cron fail-branch (debugging-blind anders)
- [ ] Constraint cleanup polling_sync uit source-check
- [ ] Item 6 datepicker re-verificatie (waarschijnlijk OK)
- [ ] Beoordelen UI-state visueel bewijs (geen test-data > 30 min beschikbaar)
- [ ] Verplaats-feature end-to-end test (Zoom + GHL update)
- [ ] mapGhlError naar shared helper api/_lib/ghl-error.js (staat nu dubbel in outcomes.js + verplaats-call.js)
- [ ] Visuele verificatie card-context label "↳ Vorige call: ..." in productie na eerste echte follow-up call

### [DONE] 20 mei 2026 — Bugfixes + validate-first + follow-up planning
- [x] no_show poll-sync fix: mapGhlStatus noshow → scheduled (commit 4ed1331)
- [x] follow-up-no-show-detect cron uitgeschakeld in vercel.json, file behouden (commit 9b04efd)
- [x] validate-first refactor api/follow-up-verplaats-call.js: GHL blocking-first → 422 op fail (commit 1a2c817)
- [x] inline error div verplaats-modal, alert() verwijderd, mapGhlError NL-messages (commit 1a2c817)
- [x] api/_lib/ghl-appointment.js: err.ghlStatus + err.ghlBody op thrown Error (commit 1a2c817)
- [x] hotfix: showToast → window.AgentShared?.showToast in verplaats submit handler (commit 70ec45b)
- [x] feat: follow-up call inplannen vanuit outcome-modal (intern/agenda, parent-child, card-context) (commit 51b3a8d)
- [x] enrichWithParentOutcome() helper in follow-up-appointments.js — card-context label voor child-rows
- [x] SQL-migratie 1: status-based partial unique ingekrompen (Supabase manueel)
- [x] SQL-migratie 2: notnull_uidx DROP (Supabase manueel)
- [x] SQL-cleanups: BANESA + Jeffrey terug naar scheduled na auto-no_show

### [PENDING] Roadmap follow-up volgende sessies
- [ ] 5 GHL outbound workflows: klant, geen-klant, te-duur, partner, timing
- [ ] Tag-architectuur per workflow
- [ ] Zoom Item 8 trigger code-cleanup (gerevert maar dead-code aanwezig)
- [ ] WhatsApp template verzending vanuit command-center
- [ ] Lead-detail timeline (calls + messages + outcomes + notities chronologisch)

### [DONE] Fase 6.1 — 7 items + Item 7 UNIQUE
- [x] Topbar voor sales bij achterstallig
- [x] WhatsApp outbound zichtbaar (via poll-cron)
- [x] Voicememo dropdown 4 opties + position:fixed
- [x] Zoom-link card + lead-detail
- [x] Screenshot-audit 3 statussen
- [x] Item 6 datepicker code-correct
- [x] Item 7 outcome UPSERT + UNIQUE constraint
- [x] Marc no-show handmatig via UI

### [DONE] Fase 6.1 deel 2 — 11 items
- [x] Klantgegevens email+phone GHL sync (26/26)
- [x] Klantgegevens display lead-detail
- [x] Notities-tab functioneel
- [x] Open acties cards reden-strip
- [x] Voicememo-knop tekst-label
- [x] Samuel has_outcome refresh-bug
- [x] Zoom auto-track gerevert
- [x] Jelmer no-show cron-loop fix
- [x] Lead-detail eerdere calls sectie
- [x] Topbar sales-rol
- [x] Lead-detail .catch chain crash hotfix

### [DONE] Fase 6.2 — 6 punten
- [x] Zoom-knop altijd zichtbaar fallback URL
- [x] polling_sync -> poll naming
- [x] Inbound UNIQUE ghl_message_id (bestond al)
- [x] Beoordelen UI-state frontend-only
- [x] Opvolging max 7 + paginering + sort + zoek
- [x] Recent afgerond vandaag+gisteren

### [DONE] Fase 6.3 — 4 features
- [x] Achterstallig voicememo cancelled-filter
- [x] Card-datum format "19 mei - 09:00"
- [x] Call-verplaatsen feature (Zoom + GHL + parent_appointment_id)
- [x] Maandkalender-view (maand/week/dag + owner-filter)

### [DONE] Bug-fixes en hotfixes
- [x] Lead-detail .catch chain crash
- [x] Live email/phone sync appointment-create
- [x] Poll-cron CHECK constraint incident (3,5u stilstand)
- [x] Zoom velden in API-response (5 SELECT-statements)
- [x] Recent afgerond bovengrens
- [x] has_outcome enrichment alle secties
- [x] profiles.full_name kolom-rename
- [x] Maand-view off-by-one rendering
- [x] PostgREST alias syntax profiles

### [DONE] Infrastructuur
- [x] conversations.readonly scope GHL PIT-token
- [x] Audit-log entries voor data-cleanups
- [x] follow_up_notities tabel + endpoint
- [x] parent_appointment_id kolom
- [x] zoom_join_url kolom
- [x] status 'verplaatst' aan CHECK constraint
- [x] api/_lib/zoom-meeting.js + api/_lib/ghl-appointment.js helpers

---

## 🧹 Geparkeerd voor cleanup (volgende sessie)

- **[todo-clean-1]** Sectie "Voltooide items" en "Volgende sessie priority items" saneren — items uit 14-15 mei (C6.1/2/3, E2, E3, etc.) zijn voltooid maar staan nog als open in sectie 12. Verplaatsen naar Voltooide items met datum.
- **[todo-clean-2]** Polish-items 3-9 zijn voltooid (commit f235696), markeren als ✅ in sectie.
- **[todo-clean-3]** Strategisch Plan bestand toevoegen aan `docs/sessie-logs/Strategisch-Plan-De-Forex-Opleiding.md` (12 mei 2026, momenteel alleen in chat-context geüpload).
- **[todo-clean-4]** Volledig consistent format toepassen op TODO-VOLLEDIG.md (alle items met dezelfde tags, dezelfde status-emojis).
