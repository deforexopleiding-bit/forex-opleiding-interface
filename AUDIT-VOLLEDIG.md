# Volledige Systeemanalyse — Agency Command Center
> Gegenereerd: 2026-05-11 | Bijgewerkt: 2026-05-12 (Agents Batch 1 + sessie persistence) | Branch: main

---

## Executive Summary

Het Agency Command Center is een volledig functioneel e-mail management systeem met AI-categorisatie, lerende agent, kennisbank en takenbeheer. Na de fixes van 2026-05-11 zijn alle kritieke persistentiegaten gedicht en werkt de feedback loop volledig.

**Algehele beoordeling: 8.5/10** — Sterk fundament, persistentie volledig op orde

### Gefixte issues (2026-05-11 – 2026-05-12)
| Fix | Status |
|-----|--------|
| [K1] Group C/D propagatie body_snippet gap | ✅ GEFIXED |
| [K2] Kennisbank → Supabase sync | ✅ GEFIXED |
| [K3] Taken → Supabase persistentie | ✅ GEFIXED |
| [H1] actionFlags + overrides persistent via email_actions | ✅ GEFIXED |
| [H4] Dead code api/categorize.js verwijderd | ✅ GEFIXED |
| Dashboard taken-teller toont 0 (sync guard bug) | ✅ GEFIXED |
| Hero stats responsive grid (overflow op smalle schermen) | ✅ GEFIXED |
| Volgorde hero stats: Event Aanmeldingen naast Uitlegsessies | ✅ GEFIXED |
| KPI sparklines (14-daags) vervangen useless 1-dag chart | ✅ GEFIXED |
| db-migrate init call in taken.html (tabel garantie) | ✅ GEFIXED |
| Verzonden mails verdwijnen na refresh (saveToSupabase silent fail) | ✅ GEFIXED |
| Bijlagen ontvangen tonen + downloaden | ✅ NIEUW |
| Bijlagen meesturen in composer | ✅ NIEUW |
| send-email.js insert altijd met attachments:null → PostgREST error | ✅ GEFIXED |
| Bijlagen upload-handler niet actief in Actie tab | ✅ GEFIXED |
| Bijlagen-sectie leeg na async body-load | ✅ GEFIXED |
| Bijlagen niet direct zichtbaar bij Actie tab render (fetchEmailBody race) | ✅ GEFIXED |
| Onderwerp-veld ontbreekt in reply composer | ✅ NIEUW |
| [K2] Kennisbank Supabase-first — 3 gaps opgelost (2026-05-12) | ✅ VOLLEDIG GEFIXED |

---

## 1. Functionaliteiten — Status

### Email module (`modules/email.html`)

| Feature | Status | Details |
|---------|--------|---------|
| IMAP-integratie (4 mailboxen) | ✅ | leads/info/partners/administratie via ImapFlow |
| AI-categorisatie (email-agent) | ✅ | Claude Haiku 4.5, 7 categorieën, confidence score |
| Hard rules (betaling/afmelding) | ✅ | Overschrijven AI correct |
| Whitelist/blacklist domein | ✅ | Persistert in email_patterns |
| Actie vereist / Informatie tabs | ✅ | actionFlags in localStorage |
| Reclame / Overige tab | ✅ | Category = 'Reclame' |
| E-mail body laden (email-body) | ✅ | IMAP fetch on-demand, gecached; attachment metadata inbegrepen |
| Bijlagen ontvangen tonen | ✅ | email-body geeft metadata, email-attachment endpoint streamt download |
| Bijlagen meesturen | ✅ | Composer upload UI, max 5 bestanden / 8 MB raw; nodemailer MIME |
| AI-reply genereren (generate-reply) | ✅ | Claude Sonnet 4.6, kennisbank context |
| Verplaats & Train (VT panel) | ✅ | Inline panel, bevestiging naar /api/learn |
| Universele sectie-verplaatsing | ✅ | `...` menu in alle 3 tabs |
| VT-knop in info/reclame tabs | ✅ | Met sectie-selector en AI-hint |
| Undo systeem (10 stappen, Ctrl+Z) | ✅ | localStorage, Supabase undo NIET verbonden |
| Propagatie banner (Group C bevestiging) | ✅ | Toont na learn-correctie |
| Trainingsmodus | ✅ | Batch reclame/niet-reclame |
| Leerrapport modal | ✅ | Via /api/learning-report |
| Snooze functie | ✅ | localStorage |
| Taak aanmaken | ✅ | Doorsturen naar taken.html |
| Kalenderweek + maand filter | ✅ | |
| E-mail acties (email-actions) | ✅ | Gelogd in Supabase email_actions |
| Group C/D propagatie via body_snippet | ✅ | GEFIXED (2026-05-11) |
| Verzonden mails persisteren | ✅ | supabase-js client, dbSaved flag, amber toast bij failure |

### Kennisbank module (`modules/kennisbank.html`)

| Feature | Status | Details |
|---------|--------|---------|
| CRUD kennisbank items | ✅ | Toevoegen/bewerken/verwijderen |
| Leermodule (lessen) | ✅ | Volledig |
| Vision/PDF extractie | ✅ | /api/vision-extract, /api/pdf-extract |
| Supabase sync | ✅ | Supabase is nu single source of truth — localStorage volledig uitgefaseerd |
| Items gebruikt in AI-replies | ✅ | generate-reply haalt ze server-side op |

### Taken module (`modules/taken.html`)

| Feature | Status | Details |
|---------|--------|---------|
| Taak aanmaken/voltooien | ✅ | Volledig functioneel |
| Supabase persistentie | ✅ | `/api/taken` + `taken_items` tabel; bi-directionele sync bij init |
| db-migrate init call | ✅ | Éénmalig (db_migrated_v1 flag) voor table garantie |

### Dashboard (`index.html`)

| Feature | Status | Details |
|---------|--------|---------|
| Hero stats (6 KPI-kaarten) | ✅ | Responsive auto-fit grid |
| Volgorde: Leads → Sessies → Events → Conversie → Taken → Onbeantwoord | ✅ | Event Aanmeldingen naast Uitlegsessies |
| Open Taken teller | ✅ | Via `/api/dashboard-stats` → `taken_items` |
| KPI sparklines (14 dagen) | ✅ | Leads + Sessies met min/max markers |
| Taken klikbaar → taken.html?taskId | ✅ | |

---

## 2. AI Feedback Loop — Status

```
Email ontvangen
    → /api/email-agent     (Claude Haiku, categorisatie)          ✅
    → _aiCatCache          (localStorage)                         ✅
    → confidence dot       (visuele indicator)                    ✅
    
Gebruiker corrigeert
    → /api/learn           (Supabase learn_examples)              ✅
    → email_patterns update (times_seen, confidence)              ✅
    → Group A propagatie   (zelfde afzender, auto)                ✅
    → Group B propagatie   (zelfde domein + subject-overlap, auto)✅
    → Group C propagatie   (domein + body-overlap, auto/bevestig) ❌ body_snippet ontbreekt
    → Group D propagatie   (domein-wildcard, bevestiging)         ❌ body_snippet ontbreekt
    → propagatie banner    (bevestigingsverzoek)                  ✅
    → confidence delta     (±20/25, plafond 95/100)               ✅
    
/api/reanalyze-all        (heranalyse na leren)                   ✅
/api/learning-report       (statistieken + accuracy)              ✅
```

**Kritiek gat:** `sendLearningCorrection()` in email.html stuurt `email_list` zonder `body_snippet` per mail. De `computePropagation()` functie in learn.js checkt `e.body_snippet || ''` — zonder dit veld vallen groepen C en D altijd leeg.

---

## 3. API Endpoints — Overzicht

| Endpoint | Methode | Status | Gebruik |
|----------|---------|--------|---------|
| /api/emails | GET | ✅ | 4 IMAP mailboxen parallel |
| /api/email-body | GET | ✅ | Body on-demand + caching |
| /api/email-agent | POST | ✅ | AI categorisatie (Haiku) |
| /api/learn | POST | ✅ | Leerlogica + propagatie |
| /api/learning-report | GET | ✅ | Statistieken dashboard |
| /api/generate-reply | POST | ✅ | AI-reply (Sonnet) |
| /api/reanalyze-all | POST | ✅ | Batch heranalyse |
| /api/kennisbank-sync | GET/POST | ⚠️ | Bestaat, NIET verbonden in frontend |
| /api/db-migrate | GET/POST | ✅ | Schema check + auto-migratie |
| /api/mark-read | POST | ✅ | IMAP mark-as-read |
| /api/email-actions | POST | ✅ | Acties loggen in Supabase |
| /api/undo | POST | ⚠️ | Bestaat, NIET verbonden in frontend |
| /api/agent-conversations | GET/POST | ✅ | History laden + new-session |
| /api/agent-learnings | GET/POST | ✅ | Feedback opslaan + ophalen |
| /api/vision-extract | POST | ✅ | Claude Vision (afbeeldingen) |
| /api/pdf-extract | POST | ✅ | PDF tekst extractie |
| /api/debug-supabase | GET | ✅ | Diagnostics |
| /api/categorize | POST | ⚠️ | Legacy (19KB), NERGENS meer aangeroepen |
| /api/supabase | — | ✅ | Shared Supabase client |

---

## 4. Supabase Database — Schema

| Tabel | Kolommen | RLS | Gebruik |
|-------|----------|-----|---------|
| email_patterns | id, sender_domain, category, times_seen, last_corrected_at, source, body_keywords, requires_action, reason | Uit | ✅ Actief |
| learn_examples | id, email_id, sender_domain, body_snippet, correction_type, old_category, corrected_by, reason, body_keywords, requires_action_corrected | Uit | ✅ Actief |
| kennisbank_items | id, type, direction, title, category, content, question, answer, label, note, times_used, times_helpful, helpfulness_score, auto_generated, source_email_id | Uit | ⚠️ Aangemaakt, sync niet verbonden |
| undo_history | id, action_type, action_data, label, performed_by, performed_at, undone_at, is_undone | Uit | ⚠️ Aangemaakt, NIET gevuld |
| agent_learnings | id, agent_id, agent_name, trigger_text, ideal_response, created_at, updated_at | Uit | ✅ Aangemaakt (Batch 1) |
| email_actions | id, email_id, action, value, created_at | Uit | ✅ Actief |

---

## 5. Data Persistentie — LocalStorage keys

| Key | Module | Inhoud | Supabase backup? |
|-----|--------|--------|-----------------|
| emailActionFlags | email.html | requires_action overrides | ❌ |
| emailOverrides | email.html | Categorie overrides | ❌ |
| aiCategories | email.html | AI cat cache | ❌ |
| aiConfidence | email.html | Confidence scores | ❌ |
| emailSnooze | email.html | Snooze timestamps | ❌ |
| emailBodyCache | email.html | Body text cache | ❌ |
| emailAiReplies | email.html | Gegenereerde replies | ❌ |
| undoHistory | email.html | Undo stack (10 items) | ❌ |
| reclamePatterns | email.html | Lokale reclame whitelist | ❌ |
| kennisbankItems | kennisbank.html | Alle kennisbank items | ✅ Verwijderd — Supabase is nu primary |
| kennisbankProfile | kennisbank.html | Bedrijfsprofiel | ✅ Verwijderd — Supabase is nu primary |
| takenItems | taken.html | Alle taken | ✅ (Supabase taken_items) |
| dashboardStats | index.html | Statistieken | ⚠️ (KPI via email query, taken via API) |
| bedrijfsprofiel | index.html | Profiel | ❌ |

**Risico:** Alle user-data gaat verloren bij een browser cache clear. Alleen email_patterns, learn_examples en email_actions zijn duurzaam opgeslagen.

---

## 6. Beveiligingsanalyse

| Issue | Ernst | Details |
|-------|-------|---------|
| Geen authenticatie op API endpoints | 🔴 HOOG | Alle /api/* zijn publiek toegankelijk — iedereen met de URL kan leren/categoriseren/replies genereren |
| Supabase RLS uitgeschakeld op alle tabellen | 🔴 HOOG | Direct database toegang zonder row-level beveiliging |
| IMAP wachtwoorden in .env plaintext | 🟡 MEDIUM | Bestand niet in git, maar risico bij server-toegang |
| Anthropic API key in .env | 🟡 MEDIUM | Zelfde als boven |
| Geen rate limiting op /api/generate-reply | 🟡 MEDIUM | Potentieel kostbaar misbruik |
| HTML escape onvolledig (enkele plekken) | 🟡 MEDIUM | Sommige email velden gaan via escapeHtml(), maar niet overal consistent |

*Opmerking: Voor een single-user intern tool (Jeffrey only) is dit acceptabel, maar bij uitbreiding moet auth toegevoegd worden.*

---

## 7. Dead Code / Technische Schuld

| Bestand | Type | Status |
|---------|------|--------|
| api/categorize.js | Legacy (19KB) — vervangen door email-agent.js | ✅ VERWIJDERD |
| sendLearningCorrection body_snippet gap | Bug in email.html | ✅ GEFIXED |
| /api/kennisbank-sync | Niet verbonden in frontend | ✅ VERBONDEN |
| /api/taken | Nieuw endpoint voor taken persistentie | ✅ AANGEMAAKT |
| /api/undo endpoint | Nooit verbonden aan frontend | Open |

---

## 8. Performance

| Observatie | Impact | Suggestie |
|------------|--------|-----------|
| 4 IMAP verbindingen parallel bij elke page load | Medium | Cache result 60s server-side |
| email-agent per mail sequentieel (Promise.allSettled) | Laag | Al parallel — OK |
| localStorage reads bij elke render | Laag | Al gecached in state — OK |
| kennisbank_items opgehaald bij elke reply-generatie | Medium | Server-side cache 5 min |

---

## 9. Top 10 Prioriteiten

| # | Prioriteit | Issue | Module | Status |
|---|-----------|-------|--------|--------|
| 1 | 🔴 KRITIEK | `emailList` mist `body_snippet` → Group C/D propagatie kapot | email.html | ✅ GEFIXED |
| 2 | 🔴 KRITIEK | Kennisbank niet gesynchroniseerd met Supabase | kennisbank.html | ✅ GEFIXED |
| 3 | 🔴 KRITIEK | Taken verloren bij cache clear | taken.html | ✅ GEFIXED (+ db-migrate init) |
| 4 | 🟡 HOOG | actionFlags/overrides verloren bij cache clear | email.html | ✅ GEFIXED |
| 5 | 🟡 HOOG | api/categorize.js — 19KB dead code | api/ | ✅ VERWIJDERD |
| 6 | 🟡 HOOG | Undo history niet persistent (Supabase undo ontkoppeld) | email.html | Open |
| 7 | 🟡 HOOG | Geen authenticatie op API | api/*.js | Open |
| 8 | 🟡 MEDIUM | Geen rate limiting op generate-reply | api/generate-reply.js | Open |
| 9 | 🟢 LAAG | AI-replies niet gesynced naar Supabase | email.html | Open |
| 10 | 🟢 LAAG | Dashboard statistieken niet persistent | index.html | Open |

---

## 10. Recente Commits (laatste 10)

```
[bijgewerkt na audit 2026-05-12 — zie git log voor actuele commits]
186a322  feat: mail-sync Fase 1 -- cron + email_messages tabel + sync endpoint
bf41289  fix: get_unanswered_emails eerlijke transparantie + feat: add_knowledge_base_item
bbd1b43  fix: get_unanswered_emails action-waarde + search_emails eerlijke melding
12403b7  fix: tools-completering + email_stats nuance + task details
1b77667  feat: tool-use architectuur fase 2+3 -- Simon krijgt volledige toolkit
bd21e9a  feat: tool-use architectuur Fase 1 — framework + 2 tools voor Simon
```

---

## 11. Lessons Learned — Terugkerende patronen om te voorkomen

### Kolomnamen altijd letterlijk cross-checken met schema

**Patroon:** Code schrijft Supabase-queries met aangenomen kolomnamen die niet overeenkomen met het werkelijke schema → runtime-fouten na deployment.

**Voorbeelden uit dit project:**
- `synced_at` → bestond niet op `email_sync_log` (correct: `completed_at`)
- `new_count` → bestond niet op `email_sync_log` (correct: `mails_new`)
- `error_msg` → bestond niet (correct: `error_message`)
- `received_at`, `body_snippet`, `confidence`, `ai_source`, `raw_flags` → bestonden niet op `email_messages`

**Regel:** Bij elke nieuwe Supabase-query — insert, select, update of order — de gebruikte kolomnamen letterlijk cross-checken tegen het werkelijke schema. Gebruik `db-migrate.js` (TABLES_TO_CREATE) of de tabel-definitie die de gebruiker opgeeft als bron. **Nooit aannames doen over kolomnamen.** Dit geldt ook voor kolomnamen in `.order()`, `.eq()` en `.select()` calls — niet alleen inserts.

### Supabase queries: altijd `const { data, error } = await ...` — nooit `.catch()` chaining

**Patroon:** `supabase.from(...).insert({...}).catch(e => ...)` crasht met TypeError in productie.

**Reden:** `PostgrestBuilder` in supabase-js is een *lazy thenable* — de query wordt pas uitgevoerd wanneer `.then()` aangeroepen wordt. `.catch()` is niet gegarandeerd beschikbaar als standalone methode. Geen enkel ander bestand in het project gebruikt dit patroon.

**Regel:** Gebruik **altijd** het standaard patroon:
```js
const { data, error } = await supabase.from('tabel').insert({ ... });
if (error) console.error('[module] insert fout:', error.message);
```
Nooit `.catch()` chaining op een `PostgrestBuilder`. Gebruik een `try/catch` blok als je fouten wilt onderdrukken.
