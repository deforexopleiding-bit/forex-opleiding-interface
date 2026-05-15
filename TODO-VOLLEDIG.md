# TODO — Agency Command Center
> Bijgewerkt: 2026-05-14 (Fase C t/m C7 auth-gate volledig) | Gebaseerd op AUDIT-VOLLEDIG.md

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

## Follow-up Module (Sales Call Tracking)

### Architectuur-beslissingen (definitief 13-14 mei)
- Voicememo strategie: Dave handmatig vanaf eigen telefoon — module is verplicht afvinkpunt + steekproef screenshots
- Geen automation vanaf Dave's persoonlijke WhatsApp (ban-risico)
- WhatsApp Coexistence werkt NIET voor NL/EU nummers (verified via Meta docs)
- No-show + 24u opvolging via Business API (geverifieerd bedrijfsnummer)
- Email reminders via bestaande GHL automation (geen wijziging)
- Screenshot review: D-optie (AI Haiku eerste check + Jeffrey alleen verdachte)
- Dagelijkse notificatie via eigen module (niet GHL), 09:00
- Post-call invul: zacht geadviseerd (B), niet hard verplicht
- Open taken: dashboard wordt aanleiding om systeem actief te gebruiken
- Klantwaarde gemiddelde: €4000 (2880-12000 range)
- 50-100 calls/maand verwacht

### Stack bevestigd
- GHL: Agency Pro account (V2 API + OAuth beschikbaar)
- Zoom: Pro account (webhooks mogelijk)
- WhatsApp Business API: via GHL relatie
- Voicememo via Dave eigen telefoon (handmatig, geen API)

### Fase planning
- **Fase 1** (1 week, ~5-7 uur Claude Code): Detectie + Visibiliteit
- **Fase 2** (3-5 dagen): No-show automation
- **Fase 3** (3-5 dagen): Post-call invul-flow + screenshot upload
- **Fase 4** (1 week): Follow-up drip-campagnes niet-kopers
