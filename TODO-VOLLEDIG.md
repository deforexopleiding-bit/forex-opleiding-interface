# TODO — Agency Command Center
> Bijgewerkt: 2026-05-12 (Tool-use Fase 2+3 + fixes) | Gebaseerd op AUDIT-VOLLEDIG.md

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
