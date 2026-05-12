# TODO — Agency Command Center
> Bijgewerkt: 2026-05-12 | Gebaseerd op AUDIT-VOLLEDIG.md

---

## 🔴 KRITIEK — Direct aanpakken

### [K1] Group C/D propagatie body_snippet gap
**Bestand:** `modules/email.html` — `sendLearningCorrection()` ~lijn 1929  
**Probleem:** `emailList` bevat geen `body_snippet` per mail → `computePropagation()` in learn.js kan groepen C/D nooit matchen  
**Fix:** Voeg `body_snippet` toe aan elk item in emailList vanuit `state.bodyCache`  
**Status:** ✅ GEFIXED (2026-05-11)

### [K2] Kennisbank → Supabase sync
**Bestand:** `modules/kennisbank.html`  
**Probleem:** Alle kennisbank items staan alleen in localStorage. `/api/kennisbank-sync` bestaat maar wordt nooit aangeroepen.  
**Fix:** Voeg sync toe bij: startup (laad van Supabase), na item-wijziging (push naar Supabase)  
**Schatting:** 2-3 uur

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
