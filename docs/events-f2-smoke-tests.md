# Events Module F2 — Smoke-tests (Outbound publish-sync)

Acht scenarios om de F2 outbound publish-sync foundation (Webflow CMS +
GHL custom-field dropdown) te valideren voor merge naar `main`.
Volg ze sequentieel; elke stap heeft een verwachte uitkomst.

Branch: `feat/events-f2-publish-sync`
SQL migratie: `docs/sql-migrations/2026-06-11-events-f2-sync-log.sql`

---

## 1. Pre-flight

**Doel:** Garanderen dat de migratie + env-vars + RBAC op orde zijn voordat
we een sync-flow draaien.

**Stappen:**
1. Open Supabase Dashboard -> SQL Editor.
2. Plak inhoud van `docs/sql-migrations/2026-06-11-events-f2-sync-log.sql`.
3. Run query (verwacht: geen errors, tabel `event_sync_log` + 2 indexes
   aangemaakt).

**Verificatie-queries:**
```sql
-- Tabel-structuur
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='event_sync_log'
ORDER BY ordinal_position;
-- Resultaat: id / event_id / target / action / request_payload /
--            response_payload / status / error_code / error_message /
--            retry_count / attempted_at / next_retry_at

-- Indexes
SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND tablename='event_sync_log';
-- Resultaat: idx_event_sync_log_event_target + idx_event_sync_log_failed_retry

-- RLS aan
SELECT relname, relrowsecurity FROM pg_class WHERE relname='event_sync_log';
-- Resultaat: relrowsecurity = t
```

**Vercel env-vars** (Settings -> Environment Variables):
- `WEBFLOW_API_TOKEN` (sensitive) — aanwezig in Production + Preview
- `WEBFLOW_SITE_ID` = `699062301b8d0a6dc9ec22b6`
- `WEBFLOW_EVENTS_COLLECTION_ID` = `6998472019eb629c85b9c448`
- `GHL_EVENTS_PIT_TOKEN` (sensitive) — aanwezig in Production + Preview
- `CRON_SECRET` — al aanwezig (gebruikt door retry-cron + ghl-next-update-cron)

Niet in code echoen of in commits/logs zetten.

**Verwacht:** alle 5 env-vars vinkje, migratie schoon, Vercel build groen.

---

## 2. Webflow CREATE — status='draft' -> 'published'

**Doel:** Bevestigen dat een nieuw published event een Webflow CMS-item
aanmaakt + dat het `event_sync_log` correct logt.

**Stappen:**
1. Login als super_admin in productie/preview.
2. Open `/modules/events.html` -> klik **Nieuw event** -> wizard:
   - Titel: `F2 Smoke 1 - Webflow Create`
   - Datum: woensdag aanstaande 19:00 - 22:00
   - Locatie: `Online`
   - Niveau: `basis`
   - Capaciteit: 50
   - Beschrijving: korte test-tekst
3. Save als concept -> open detail-page.
4. Klik **Publiceren** -> bevestig.

**Verwachte UI:**
- Toast "Event gepubliceerd"
- Status-badge wordt groen "Gepubliceerd"
- Sync-strip onder header: `Webflow: OK` (groen) +
  `GoHighLevel: OK` of `GoHighLevel: SKIP` (geel)
- Geen retry-knop zichtbaar (alleen bij failure)

**Verificatie:**
```sql
-- Event-row gevuld
SELECT id, status, webflow_item_id, webflow_sync_status,
       webflow_last_synced_at, ghl_sync_status, ghl_last_synced_at
FROM events
WHERE title = 'F2 Smoke 1 - Webflow Create';
-- Resultaat: webflow_item_id NIET NULL, webflow_sync_status='success',
--            ghl_sync_status='success' of 'skipped_graceful'

-- Sync-log rij
SELECT target, action, status, retry_count, attempted_at
FROM event_sync_log
WHERE event_id = (SELECT id FROM events WHERE title='F2 Smoke 1 - Webflow Create')
ORDER BY attempted_at DESC;
-- Resultaat: target='webflow' action='create' status='success' retry_count=0
--           (+ tweede rij target='ghl' action='update' status='success'/skipped)
```

**Webflow browser-check:**
- Open de Webflow CMS-collection in de Webflow Designer of het Editor-paneel
- Verifieer dat het nieuwe item zichtbaar is met de juiste titel + datum
- Optioneel: bekijk de live forex-website om te zien of het event publiek
  zichtbaar is (afhankelijk van publish-staging)

---

## 3. Webflow UPDATE — published event title/datum aanpassen

**Doel:** Bevestigen dat een edit-trigger op een al-published event
de Webflow CMS-item bijwerkt (action=update i.p.v. create).

**Stappen:**
1. Open `/modules/events-detail.html?id=<F2-Smoke-1-event-id>` (uit scenario 2).
2. Klik **Bewerken** -> wijzig:
   - Titel: `F2 Smoke 1 - Webflow Updated`
   - Locatie: `Zoom`
3. Opslaan.

**Verwachte UI:**
- Toast "Event opgeslagen"
- Sync-strip blijft `Webflow: OK` (groen) + `GHL: OK/SKIP`

**Verificatie:**
```sql
-- Nieuwe sync-log rij action=update
SELECT target, action, status, attempted_at
FROM event_sync_log
WHERE event_id = (SELECT id FROM events WHERE title='F2 Smoke 1 - Webflow Updated')
ORDER BY attempted_at DESC
LIMIT 5;
-- Resultaat: bovenste rij target='webflow' action='update' status='success'

-- Webflow item kreeg nieuwe data
SELECT webflow_item_id, webflow_last_synced_at FROM events
WHERE title='F2 Smoke 1 - Webflow Updated';
-- Resultaat: webflow_last_synced_at recenter dan in scenario 2
```

**Webflow browser-check:** item heeft nu nieuwe titel + nieuwe locatie.

---

## 4. Webflow UNPUBLISH — 'Annuleren' (status='cancelled')

**Doel:** Bevestigen dat cancel niet HARD-delete in Webflow, maar `isDraft=true`
zet (item blijft bestaan voor history + niet zichtbaar publiek). Lesson G
uit prep-correctie.

**Stappen:**
1. Open detail-page van F2-Smoke-1 event.
2. Klik **Annuleren** -> bevestig.

**Verwachte UI:**
- Toast "Event geannuleerd"
- Status-badge wordt rood "Geannuleerd"
- Sync-strip: `Webflow: UNPUB` (grijs)

**Verificatie:**
```sql
-- Event-status + sync-status
SELECT status, webflow_sync_status FROM events
WHERE title LIKE 'F2 Smoke 1%';
-- Resultaat: status='cancelled' webflow_sync_status='unpublished'

-- Sync-log action=unpublish
SELECT target, action, status FROM event_sync_log
WHERE event_id = (SELECT id FROM events WHERE title LIKE 'F2 Smoke 1%')
  AND action='unpublish'
ORDER BY attempted_at DESC LIMIT 1;
-- Resultaat: target='webflow' action='unpublish' status='success'
```

**Webflow browser-check:** het item bestaat nog in de Webflow CMS-lijst,
maar heeft draft-badge (verborgen voor publieke website).

---

## 5. GHL options-update bij elke publish trigger

**Doel:** Bevestigen dat GHL custom-field dropdown-opties bijgewerkt worden
bij publish (label toevoegen) en bij unpublish (label verwijderen).

**Stappen:**
1. Maak een nieuw event aan met titel `F2 Smoke 5 - GHL Sync` op woensdag
   18 juni 2026 19:00-22:00.
2. Publish event -> kijk in GHL admin naar custom field met
   slug `single_dropdown_12e8o` (of internal-id in `api/_lib/ghl-custom-field.js`).
3. Verwacht: opties bevatten label in format
   `Woensdag 18 jun 2026 | 19:00 - 22:00` (of vergelijkbaar; exacte format
   wordt door event-sync-orchestrator bepaald).
4. Klik **Annuleren** op event -> herlaad GHL admin.
5. Verwacht: label is verdwenen uit de opties-array.

**Graceful-fail subscenario:**
- Als `GHL_EVENTS_PIT_TOKEN` ontbreekt of scope mist, krijgt het event
  `ghl_sync_status='skipped_graceful'`.
- Webflow-sync moet onafhankelijk GEWOON doorgaan (`webflow_sync_status='success'`).
- Sync-strip toont `Webflow: OK` (groen) + `GoHighLevel: SKIP` (geel) -
  geen rood, geen retry-knop voor SKIP-state.

**Verificatie:**
```sql
SELECT title, webflow_sync_status, ghl_sync_status
FROM events WHERE title='F2 Smoke 5 - GHL Sync';
-- Verwacht: ('success', 'success') of ('success', 'skipped_graceful')

SELECT target, action, status, error_code FROM event_sync_log
WHERE event_id = (SELECT id FROM events WHERE title='F2 Smoke 5 - GHL Sync')
ORDER BY attempted_at DESC;
```

---

## 6. Manual retry — simuleer failure + retry-knop

**Doel:** Bevestigen dat de retry-knop werkt + dat `event_sync_log` history
toont van failure -> retry -> success met opgehoogde `retry_count`.

**Stappen (op preview-deploy):**
1. Maak in Vercel preview env-var `WEBFLOW_API_TOKEN` tijdelijk ongeldig
   (bv. waarde aanpassen naar `invalid_token_xxxxx`). Redeploy preview.
2. Maak nieuw event `F2 Smoke 6 - Retry Test` -> publish.
3. Verwacht: Webflow fail, badge rood `Webflow: FAIL`, retry-knop zichtbaar.
4. Herstel env-var `WEBFLOW_API_TOKEN` -> redeploy preview.
5. Open detail-page F2-Smoke-6 -> klik **Retry sync**.
6. Verwacht: toast "Retry gestart", na ~3s reload sync-status,
   badge wordt groen `Webflow: OK`, retry-knop verdwijnt.

**Verificatie:**
```sql
SELECT target, action, status, retry_count, error_code, attempted_at
FROM event_sync_log
WHERE event_id = (SELECT id FROM events WHERE title='F2 Smoke 6 - Retry Test')
ORDER BY attempted_at ASC;
-- Resultaat: eerst status='failure' retry_count=0 met error_code,
--            daarna status='success' retry_count>=1
```

---

## 7. Retry-cron — automatische retry-strategie

**Doel:** Bevestigen dat de retry-cron `api/cron-events-sync-retry`
gefaalde rijen opnieuw probeert volgens de retry-strategie en stopt na
5 pogingen (`next_retry_at=NULL`).

**Stappen:**
1. Zorg voor minimaal 1 `event_sync_log` rij met `status='failure'` en
   `next_retry_at <= now()` (gebruik scenario 6 of insert handmatig
   met `next_retry_at = now() - interval '1 hour'`).
2. Trigger cron handmatig via curl met `CRON_SECRET`:
   ```bash
   curl -X POST "https://<preview-url>/api/cron-events-sync-retry" \
     -H "Authorization: Bearer <CRON_SECRET>"
   ```
3. Verifieer respons: `{ processed: N, success: X, failure: Y }`.

**Verificatie-strategie:**
```sql
-- Na 1e retry-cron-run met persistent fail (token nog steeds invalide):
--   retry_count = 1, next_retry_at = +15min (1e backoff)
-- Na 2e: retry_count = 2, next_retry_at = +1h
-- Na 5e: retry_count = 5, next_retry_at IS NULL (alarm-state)
SELECT event_id, retry_count, next_retry_at, status
FROM event_sync_log
WHERE status='failure'
ORDER BY attempted_at DESC LIMIT 10;
```

**Verwacht:**
- Na 5 fails: `next_retry_at IS NULL` -> cron skipt deze rij voortaan.
- UI in events-detail.html toont retry-knop nog steeds (handmatige
  override mogelijk).

---

## 8. GHL daily-cron — idempotent options-resync

**Doel:** Bevestigen dat de daily `api/cron-events-ghl-next-update` de
GHL dropdown-opties idempotent vult met alle upcoming events in volgorde
van `starts_at`.

**Stappen:**
1. Zorg voor minimaal 2 published events met `starts_at` in de toekomst.
2. Trigger cron handmatig:
   ```bash
   curl -X POST "https://<preview-url>/api/cron-events-ghl-next-update" \
     -H "Authorization: Bearer <CRON_SECRET>"
   ```
3. Verifieer respons: `{ ok: true, options_count: N }`.

**Verificatie:**
- Open GHL admin -> custom field `single_dropdown_12e8o`.
- Verwacht: opties bevatten alle upcoming published events, gesorteerd op
  `starts_at` ASC.
- Run cron NOGMAALS direct erna -> opties moeten identiek blijven
  (idempotent, geen duplicaten).

---

# Events Module Blok 1 — Smoke-tests (signups_closed lifecycle + cleanup)

Zes scenarios om de Blok 1 lifecycle-foundation (auto-close T-1 dag /
manual close / reopen-guard / CMS-cleanup / item-6 hard-delete fix) te
valideren voor merge naar `main`.

Branch: `feat/events-blok1-lifecycle`
SQL migratie: `docs/sql-migrations/2026-06-12-events-signups-closed.sql`

Locks toegepast (uit plan-gate):
- **OQ1**: 3-veld `signups_closed` model (bool + _at + _reason +
  _by_user_id), met `auto_full` in CHECK voor forward-compat (geen cron-write).
- **OQ2**: auto-close cron hourly (`0 * * * *`), idempotent (eenmaal
  gesloten wordt overgeslagen).
- **OQ6**: reopen na deadline -> `409 REOPEN_TOO_LATE`.

---

## Pre-flight Blok 1

**Doel:** Garanderen dat de migratie + cron-entries + RBAC + env-vars
op orde zijn voordat we de close/reopen/cleanup-flows draaien.

**Stappen:**
1. Open Supabase Dashboard -> SQL Editor.
2. Plak inhoud van `docs/sql-migrations/2026-06-12-events-signups-closed.sql`.
3. Run query (verwacht: geen errors, 4 kolommen toegevoegd aan `events`).

**Verificatie-queries:**
```sql
-- 1. 4 nieuwe kolommen aanwezig op events
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='events'
  AND column_name IN (
    'signups_closed',
    'signups_closed_at',
    'signups_closed_reason',
    'signups_closed_by_user_id'
  )
ORDER BY column_name;
-- Resultaat: 4 rows; signups_closed bool default false, rest nullable.

-- 2. CHECK-constraint op signups_closed_reason
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid='public.events'::regclass
  AND contype='c'
  AND conname LIKE '%signups_closed_reason%';
-- Resultaat: 1 row met CHECK (... IN ('manual','auto_time','auto_full','auto_deadline'))

-- 3. FK constraint op signups_closed_by_user_id -> auth.users(id)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid='public.events'::regclass
  AND contype='f'
  AND conname LIKE '%signups_closed_by_user_id%';
-- Resultaat: 1 row met FOREIGN KEY ... REFERENCES auth.users(id)
```

**Env-vars-check (Vercel Production + Preview):**
- `CRON_SECRET` (Sensitive) - voor handmatige cron-trigger via curl
- `WEBFLOW_API_TOKEN` + `WEBFLOW_SITE_ID` + `WEBFLOW_EVENTS_COLLECTION_ID`
- `GHL_EVENTS_PIT_TOKEN`

**vercel.json check (lokaal):**
```bash
grep -E 'cron-events-(signups-auto-close|cms-cleanup)' vercel.json
```
- Resultaat: 2 entries; signups-auto-close `0 * * * *` + cms-cleanup
  (eens per dag, zie vercel.json voor exact schema).

---

## Scenario 9 — Manual close

**Doel:** Bevestigen dat de "Aanmelding sluiten"-knop de DB-flip
correct uitvoert + Webflow unpublished + GHL-dropdown bijgewerkt.

**Stappen:**
1. Login als admin (super_admin/admin/manager), open een gepubliceerd
   upcoming event (starts_at minimaal 2 dagen in de toekomst zodat
   reopen-guard later niet bijt).
2. Klik op de header-knop "Aanmelding sluiten" -> bevestig dialog.
3. Verifieer in Supabase `events` row:
   - `signups_closed = true`
   - `signups_closed_at` gevuld met huidige timestamp
   - `signups_closed_reason = 'manual'`
   - `signups_closed_by_user_id =` jouw `auth.users.id`
4. Verifieer Webflow CMS-item naar draft (staged record blijft bestaan
   maar is niet meer publiek zichtbaar).
5. Verifieer GHL dropdown (`single_dropdown_12e8o`): label van dit event
   is verdwenen uit de options-lijst.
6. Verifieer `event_sync_log` row: target=`webflow`, action=
   close/unpublish, status=`success`.
7. UI: badge "Aanmelding GESLOTEN" zichtbaar in header van events-detail
   + chip "Aanmelding gesloten" zichtbaar in events-lijst.

---

## Scenario 10 — Manual reopen (vroeg genoeg)

**Doel:** Bevestigen dat reopen werkt zolang we niet voorbij T-1 dag
00:00 NL zijn, inclusief Webflow republish + GHL-recompute.

**Stappen:**
1. Gebruik het event uit scenario 9 (starts_at nog > 1 dag in toekomst).
2. Klik op de header-knop "Aanmelding heropen" -> bevestig dialog.
3. Verifieer in Supabase `events` row:
   - `signups_closed = false`
   - `signups_closed_at IS NULL`
   - `signups_closed_reason IS NULL`
   - `signups_closed_by_user_id IS NULL`
4. Verifieer Webflow republish: item terug live (`PATCH /items/{id}/live`
   primair, fallback via `POST /items/{id}/publish` indien primair faalt).
5. Bekijk Vercel function-logs voor `events-reopen-signups` -> zie welk
   strategy-pad de orchestrator heeft genomen (`patch_live` of
   `post_publish`).
6. Verifieer GHL dropdown: label van dit event staat weer in de
   options-lijst.

---

## Scenario 11 — Reopen guard (te laat)

**Doel:** Bevestigen dat `409 REOPEN_TOO_LATE` correct teruggegeven
wordt zodra we voorbij de T-1 dag 00:00 NL deadline zijn.

**Stappen:**
1. Maak een event met `starts_at` over 12 uur (= binnen de deadline,
   want de T-1 dag deadline is vandaag 00:00 NL en die is al gepasseerd).
2. Sluit het event handmatig (Scenario 9 mini-versie of via SQL):
   ```sql
   UPDATE events
   SET signups_closed = true,
       signups_closed_at = now(),
       signups_closed_reason = 'manual',
       signups_closed_by_user_id = '<jouw_user_id>'
   WHERE id = '<event_id>';
   ```
3. Probeer reopen via UI-knop of curl:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer <SESSION_TOKEN>" \
     "https://forex-opleiding-interface.vercel.app/api/events-reopen-signups?id=<event_id>"
   ```
4. Verwacht response: HTTP 409 met body:
   ```json
   {
     "error": "Reopen-deadline (middernacht Europe/Amsterdam op dag voor event) is verstreken",
     "code": "REOPEN_TOO_LATE",
     "deadline_iso": "...",
     "now_iso": "..."
   }
   ```
5. Verifieer `events` row ongewijzigd (`signups_closed` blijft `true`,
   timestamp niet aangeraakt).
6. UI: toast "Te laat om opnieuw te openen - cron zou direct weer
   sluiten" verschijnt.

---

## Scenario 12 — Auto-close cron (handmatige trigger)

**Doel:** Bevestigen dat de hourly auto-close-cron events waarvan de
T-1 dag deadline is gepasseerd automatisch sluit met
`reason='auto_time'`, en bij hertrigger idempotent skipt.

**Stappen:**
1. Maak een event met `starts_at` = morgen 10:00 NL. Deadline = vandaag
   00:00 NL = al gepasseerd, dus dit event moet door de cron worden
   opgepakt.
2. Verifieer initieel `signups_closed = false` in Supabase.
3. Trigger cron handmatig:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $CRON_SECRET" \
     "https://forex-opleiding-interface.vercel.app/api/cron-events-signups-auto-close"
   ```
4. Verwacht response JSON: `{ candidates, closed, skipped, errors,
   duration_ms }`.
5. Verifieer `events` row:
   - `signups_closed = true`
   - `signups_closed_reason = 'auto_time'`
   - `signups_closed_by_user_id IS NULL` (geen user-actor)
6. Verifieer Webflow item unpublished + GHL dropdown geupdated (geen
   label meer).
7. Hertrigger dezelfde cron-URL direct -> `skipped` counter +1
   (idempotent, geen dubbele close-event).

---

## Scenario 13 — Hard-delete via events-delete (item-6 fix)

**Doel:** Bevestigen dat de item-6 diagnose-fix in `events-delete`
(commit `1bb21c0`) zorgt dat archive-pad het Webflow-item permanent
verwijdert, niet alleen unpublished.

**Stappen:**
1. Maak en publish een nieuw event (genereert
   `events.webflow_item_id`).
2. Verifieer dat het event als CMS-item zichtbaar is in Webflow CMS
   (gepubliceerd).
3. Klik op de header-knop "Annuleren" op events-detail (of trigger
   `events-delete` via curl met `?id=<event_id>`).
4. Verifieer response: HTTP 200 zonder Webflow-failure-error in body
   (= item-6 fix).
5. Verifieer `events` row:
   - `status = 'archived'`
   - `webflow_item_id IS NULL`
   - `webflow_sync_status = 'archived'`
6. Verifieer Webflow CMS: het item is PERMANENT weg (niet alleen op
   draft / unpublished). Dit was het item-6 verschil: vóór de fix bleef
   het item bestaan; na de fix is het echt verwijderd.
7. Verifieer `event_sync_log` row: target=`webflow`,
   action=`hard_delete`, status=`success`.

---

## Scenario 14 — CMS-cleanup cron (>7d post-event)

**Doel:** Bevestigen dat de daily cms-cleanup cron oude Webflow CMS-
items (events waarvan `starts_at` >7 dagen geleden was) permanent
opruimt zonder de events-row te verliezen (record + bonus +
assessment blijven beschikbaar voor historische rapportage).

**Stappen:**
1. Maak en publish een nieuw event (`starts_at` initieel op
   morgen of zo, gewoon zodat Webflow-publish werkt).
2. Forceer `starts_at` 10 dagen terug via SQL nadat de publish-sync
   gelukt is:
   ```sql
   UPDATE events
   SET starts_at = now() - interval '10 days',
       ends_at   = now() - interval '10 days' + interval '2 hours'
   WHERE id = '<event_id>';
   ```
3. Verifieer dat `events.webflow_item_id` nog gevuld is (publish-sync
   heeft het gezet).
4. Trigger cleanup-cron handmatig:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $CRON_SECRET" \
     "https://forex-opleiding-interface.vercel.app/api/cron-events-cms-cleanup"
   ```
5. Verwacht response JSON: `{ candidates, hard_deleted, already_gone,
   errors, duration_ms }`.
6. Verifieer Webflow CMS: het item is permanent weg.
7. Verifieer `events` row blijft staan (record + bonus + assessment
   intact in DB), maar `webflow_item_id IS NULL` na de cleanup.
8. Hertrigger cleanup-cron -> `already_gone` counter +1 voor dit
   event (idempotent).

---

## Scenario 15 — Assessment-pagina rendert vragen uit config (Blok 2 PR 1)

**Doel:** Bevestigen dat `/modules/assessment.html` de actieve vragen uit
`assessment_questions` haalt via `/api/assessment-questions` en correct
rendert per sectie + type.

**Pre-flight:**
- SQL migratie `2026-06-12-blok2-assessment-foundation.sql` gerund (2
  tabellen + 12 seeds + FK + RLS).
- Verifieer seeds:
  ```sql
  SELECT section, count(*) FROM public.assessment_questions
  WHERE active=true GROUP BY section ORDER BY section;
  -- verwacht: doel=1, engagement=3, identiteit=3, routing=5
  ```

**Stappen:**
1. Open `https://<preview-url>/modules/assessment.html` in een
   anonymous/incognito tab (geen Supabase-sessie nodig — publieke pagina).
2. Open DevTools -> Network en bevestig:
   - `GET /api/assessment-questions` -> 200 met `{ questions: [...] }`
     (12 entries).
   - Response bevat GEEN `routing_weights` en GEEN `is_routing` (server-only
     velden uitgesneden via `sanitizeQuestionsForPublic`).
3. Visueel: 4 secties zichtbaar in volgorde Wie ben je / Je ervaring /
   Wat zoek je / Je doel. Elke vraag toont label + verplicht-asterisk
   waar `required=true`.
4. Veldtypes:
   - voornaam/achternaam = text input;
   - email = email input;
   - ervaring/handelen/tradeplan_risico/winstgevend/uitspraak/doel = radio
     list met de exacte NL labels;
   - kennis = 5-cell scale (1..5);
   - motivatie = 10-cell scale (1..10);
   - grootste_uitdaging = textarea + woord-counter "0 / 30 woorden".
5. Tik in textarea: counter werkt en kleurt groen bij >=30 woorden.

**Verwacht:** alle controls renderen, geen console-errors, network-response
bevat exact 12 questions zonder routing-config.

---

## Scenario 16 — Validation blokkeert lege/te korte inzending (Blok 2 PR 1)

**Doel:** Required-checks + min-words op `open_text` werken server-side
(client mag faciliteren maar mag niet alleen waarheid zijn).

**Stappen:**
1. Open assessment-pagina (zoals scenario 15).
2. Klik direct op "Inzenden" zonder iets in te vullen.
3. Verwacht: HTTP 400 van `/api/assessment-submit` met body
   `{ error: 'Validatie mislukt.', errors: [...] }`. Elke required-veld
   verschijnt als `{ key, code: 'REQUIRED', message }`. Foutbox
   bovenaan toont de lijst.
4. Vul voornaam/achternaam/email + alle radio's + de scales + doel in,
   maar laat `grootste_uitdaging` op 5 woorden hangen.
5. Klik "Inzenden". Verwacht: 400 met 1 fout `{ key:'grootste_uitdaging',
   code:'MIN_WORDS', message: 'Veld "grootste_uitdaging" moet minstens
   30 woorden bevatten (nu 5).' }`.
6. Test een ongeldige radio-waarde via DevTools console:
   ```js
   fetch('/api/assessment-submit', {
     method:'POST',
     headers:{'Content-Type':'application/json'},
     body: JSON.stringify({ answers: { voornaam:'X', achternaam:'Y',
       email:'a@b.cd', ervaring:'fake', handelen:'demo',
       tradeplan_risico:'nee', winstgevend:'nog_niet', kennis:3,
       motivatie:5, uitspraak:'eerst_leren',
       grootste_uitdaging:('woord '.repeat(35)), doel:'anders' } })
   }).then(r => r.json()).then(console.log);
   ```
   Verwacht: 400 met `{ key:'ervaring', code:'OPTION', message:'...' }`.

**Verwacht:** Server side validatie weigert elke vorm van incomplete of
ongeldige input; geen rij in `assessment_responses` voor deze pogingen.

---

## Scenario 17 — Geldige inzending wordt opgeslagen (Blok 2 PR 1)

**Doel:** Een volledig + geldig formulier landt als rij in
`assessment_responses` met `status='submitted'`, `routing_result=NULL` en
`score=NULL` (geen routing in deze PR).

**Stappen:**
1. Open assessment-pagina; vul alle 12 velden correct in. Gebruik een
   uniek e-mailadres (bv. `smoke+blok2pr1@deforexopleiding.nl`).
2. Klik "Inzenden". Verwacht: HTTP 200 + success-card "Bedankt voor je
   inzending!". Network response body: `{ ok:true, id:<uuid>,
   status:'submitted', routing_result:null, submitted_at:... }`.
3. Verifieer in Supabase:
   ```sql
   SELECT id, email, first_name, last_name, status, routing_result,
          score, event_id, submitted_at,
          answers ? 'voornaam'  AS has_voornaam,
          answers ? 'doel'      AS has_doel
   FROM public.assessment_responses
   WHERE email = 'smoke+blok2pr1@deforexopleiding.nl'
   ORDER BY submitted_at DESC LIMIT 1;
   ```
   Verwacht: 1 rij, `status='submitted'`, `routing_result=NULL`,
   `score=NULL`, beide `has_*` velden `true`, `event_id` NULL als
   geen `?event=` querystring meegegeven was.
4. Herhaal met `/modules/assessment.html?event=<uuid van bestaand event>`
   en verifieer dat `event_id` nu gevuld is met die uuid.

**Verwacht:** capture-only is volledig; geen routing/scoring/side-effects
in deze PR.

---

## Scenario 18 — Honeypot + IP-rate-limit (Blok 2 PR 1)

**Doel:** Anti-abuse maatregelen werken: honeypot weigert bot-achtige
inzendingen, en zelfde IP-hash kan max 1 inzending per 30 seconden doen.

**Stappen (honeypot):**
1. Open DevTools console op de assessment-pagina.
2. Verstuur via fetch een payload waarin `hp_company` gevuld is:
   ```js
   fetch('/api/assessment-submit', {
     method:'POST',
     headers:{'Content-Type':'application/json'},
     body: JSON.stringify({
       hp_company: 'Acme BV',
       answers: { voornaam:'Bot', achternaam:'Test',
         email:'bot@example.com', ervaring:'<3mnd', handelen:'nog_niet',
         tradeplan_risico:'nee', winstgevend:'nog_niet', kennis:1,
         motivatie:1, uitspraak:'gratis_info',
         grootste_uitdaging:('woord '.repeat(35)), doel:'anders' }
     })
   }).then(r => r.status).then(console.log);
   ```
   Verwacht: HTTP 422 met body `{ error: 'Inzending kon niet worden
   verwerkt.' }`. Geen rij in `assessment_responses` voor dit e-mailadres.

**Stappen (rate-limit):**
1. Stuur een geldige inzending in (zoals scenario 17, met een nieuw,
   uniek e-mailadres).
2. Stuur direct daarna een tweede geldige inzending (ander e-mailadres,
   binnen 30 sec).
3. Verwacht 2e response: HTTP 429 met body
   `{ error: 'Te veel inzendingen vanaf dit IP. Probeer het over 30
   seconden opnieuw.', latest_at: <iso> }`.
4. Verifieer: maar 1 rij toegevoegd in `assessment_responses` voor deze
   2 pogingen.
5. Wacht 30 sec; herhaal tweede inzending; verwacht 200.

**Verifieer raw IP NIET in DB:**
```sql
SELECT submitter_ip_hash, length(submitter_ip_hash) AS hashlen
FROM public.assessment_responses
ORDER BY submitted_at DESC LIMIT 3;
-- verwacht: hashlen=32 (SHA-256 truncated), GEEN 4 oktet IPv4 of IPv6
```

**Verwacht:** honeypot return 422, rate-limit return 429, IP zelf nooit
in raw vorm opgeslagen.

---

## Scenario 19 — High-profiel routing: gevorderd + tier high (Blok 2 PR 2)

**Doel:** Een ervaren + gemotiveerde deelnemer landt in `routing_result='gevorderd'`
met `copy_tier='high'` en krijgt de Trading Deep Dive copy.

**Verwachte skill_score:** 3 (`>5jr`) + 2 (`live`) + 2 (`allebei`) + 2
(`consistent`) + 2 (kennis 5) = **11**. Engagement: motivatie 8 ≥ 5 ✓,
uitspraak `actief_begeleiding` ≠ gratis_info ✓.

**Stappen:**
1. Open `/modules/assessment.html` op de preview-URL (geen `?event=` nodig).
2. Vul in:
   - voornaam = Senior, achternaam = Test, email = `smoke+high@deforexopleiding.nl`
   - ervaring = "Meer dan 5 jaar" (`>5jr`)
   - handelen = "Live (met echt geld)" (`live`)
   - tradeplan_risico = "Allebei" (`allebei`)
   - winstgevend = "Consistent winstgevend" (`consistent`)
   - kennis = 5
   - motivatie = 8
   - uitspraak = "Ik wil actief begeleid worden" (`actief_begeleiding`)
   - grootste_uitdaging = 35+ woorden over jouw uitdaging
   - doel = elk geldig doel
3. Klik "Inzenden".
4. Verwacht response (DevTools Network):
   ```json
   { "ok": true, "id": "<uuid>", "status": "submitted",
     "routing_result": "gevorderd", "copy_tier": "high",
     "copy_text": "Op basis van jouw antwoorden kom je in aanmerking voor onze exclusieve Trading Deep Dive...",
     "skill_score": 11, "engagement_ok": true }
   ```
5. Visueel: result-card met groene "Match: gevorderd" badge + Trading Deep
   Dive title + copy. Geen formulier meer zichtbaar.

---

## Scenario 20 — Mid-profiel routing: basis + tier mid (Blok 2 PR 2)

**Doel:** Een deelnemer met middenniveau-skill landt in `routing_result='basis'`
met `copy_tier='mid'` en krijgt de Forex Kickstart Live copy.

**Verwachte skill_score:** 1 (`3-12mnd`) + 1 (`demo`) + 1 (`een`) + 1
(`af_en_toe`) + 1 (kennis 3) = **5**. Score in [LOW_MID_THRESHOLD 4,
GEVORDERD_THRESHOLD-1 = 6] → mid. Engagement: motivatie 7 ≥ 5 ✓ (engagement
maakt niet uit bij mid-band, maar zorgt dat het niet als incomplete
gemarkeerd wordt).

**Stappen:**
1. Open `/modules/assessment.html` (uniek e-mail bv. `smoke+mid@...`).
2. Vul in: ervaring=`3-12mnd`, handelen=`demo`, tradeplan_risico=`een`,
   winstgevend=`af_en_toe`, kennis=3, motivatie=7, uitspraak=`eerst_leren`,
   open_text 35+ woorden, doel willekeurig.
3. Verwacht response:
   ```json
   { "routing_result": "basis", "copy_tier": "mid",
     "copy_text": "Je hebt duidelijk interesse in trading...",
     "skill_score": 5, "engagement_ok": true }
   ```
4. Visueel: blauwe "Match: basis" badge + Kickstart Live copy.

---

## Scenario 21 — Low-profiel routing: basis + tier low (Blok 2 PR 2)

**Doel:** Beginnend deelnemer (skill_score < LOW_MID_THRESHOLD 4) landt in
`routing_result='basis'` met `copy_tier='low'`.

**Verwachte skill_score:** 0 (`<3mnd`) + 0 (`nog_niet`) + 0 (`nee`) + 0
(`nog_niet`) + 0 (kennis 1) = **0**. Onder LOW_MID_THRESHOLD = low.

**Stappen:**
1. Open `/modules/assessment.html` (uniek e-mail `smoke+low@...`).
2. Vul in: ervaring=`<3mnd`, handelen=`nog_niet`, tradeplan_risico=`nee`,
   winstgevend=`nog_niet`, kennis=1, motivatie=6, uitspraak=`eerst_leren`,
   open_text 35+ woorden, doel willekeurig.
3. Verwacht response:
   ```json
   { "routing_result": "basis", "copy_tier": "low",
     "copy_text": "Bedankt voor jouw interesse. Op basis van jouw antwoorden...",
     "skill_score": 0, "engagement_ok": true }
   ```
4. Visueel: amber "Aanbeveling: bouw je fundering" badge + low-copy.

---

## Scenario 22 — Engagement-gate capt high naar mid (Blok 2 PR 2)

**Doel:** Hoge skill maar lage engagement (uitspraak=gratis_info OF
motivatie < MOTIVATIE_FLOOR) wordt gecapt: `routing_result='basis'` met
`copy_tier='mid'` i.p.v. `gevorderd/high`.

**Stappen (cap via uitspraak):**
1. Open `/modules/assessment.html` (uniek e-mail `smoke+cap-uitspraak@...`).
2. Gebruik EXACT dezelfde antwoorden als scenario 19 (skill_score=11), MAAR
   zet `uitspraak = "Ik ben op zoek naar gratis info"` (`gratis_info`).
3. Verwacht response:
   ```json
   { "routing_result": "basis", "copy_tier": "mid",
     "skill_score": 11, "engagement_ok": false }
   ```
   De `score.reason` in DB-row bevat "engagement-gate gecapt
   (uitspraak=gratis_info)".

**Stappen (cap via motivatie):**
1. Nieuw e-mail `smoke+cap-motivatie@...`.
2. Gebruik antwoorden uit scenario 19, MAAR zet motivatie = 2.
3. Verwacht response: `routing_result='basis'`, `copy_tier='mid'`,
   `engagement_ok=false`. `score.reason` bevat "motivatie 2 <
   MOTIVATIE_FLOOR 5".

**Verifieer beide rijen:**
```sql
SELECT email, routing_result, score->>'copy_tier' AS tier,
       (score->>'skill_score')::int AS skill,
       (score->>'engagement_ok')::bool AS engaged,
       score->>'reason' AS why
FROM public.assessment_responses
WHERE email LIKE 'smoke+cap-%'
ORDER BY submitted_at DESC LIMIT 2;
-- verwacht: 2 rijen, beide tier='mid', engaged=false, skill=11,
-- why begint met "skill_score 11 >= 7 maar engagement-gate gecapt"
```

---

## Scenario 23 — Score-jsonb + routing_result persisted op de rij (Blok 2 PR 2)

**Doel:** Na een succesvolle inzending bevat de rij in `assessment_responses`
zowel de `routing_result`-kolom als een gevulde `score`-jsonb met breakdown,
thresholds en scored_at.

**Stappen:**
1. Stuur 1 willekeurige geldige inzending (bv. uit scenario 20).
2. Run in Supabase:
   ```sql
   SELECT
     id, email, routing_result,
     score->>'copy_tier'      AS copy_tier,
     (score->>'skill_score')::int AS skill_score,
     score->'skill_breakdown' AS breakdown,
     (score->>'engagement_ok')::bool AS engaged,
     (score->>'motivatie')::int     AS motivatie,
     score->'thresholds'      AS thresholds,
     score->>'reason'         AS reason,
     score->>'scored_at'      AS scored_at
   FROM public.assessment_responses
   ORDER BY submitted_at DESC LIMIT 1;
   ```
3. Verwacht:
   - `routing_result` IN ('gevorderd','basis','incomplete').
   - `copy_tier` IN ('high','mid','low','incomplete').
   - `breakdown` is object met sleutels: ervaring, handelen,
     tradeplan_risico, winstgevend, kennis (elk getal).
   - `thresholds` is object: `{ GEVORDERD_THRESHOLD, MOTIVATIE_FLOOR,
     LOW_MID_THRESHOLD }` met de actuele env- of default-waardes.
   - `scored_at` is ISO-timestamp, dichtbij `submitted_at`.
4. Verifieer dat capture-only-rijen uit PR 1 nu NIET retroactief gescoord
   zijn (alleen nieuwe inzendingen sinds PR 2 hebben gevulde `score`):
   ```sql
   SELECT count(*) FILTER (WHERE score IS NULL)  AS pr1_rows,
          count(*) FILTER (WHERE score IS NOT NULL) AS pr2_rows
   FROM public.assessment_responses;
   ```

**Verwacht:** elke PR 2-inzending heeft `routing_result IS NOT NULL` en
`score IS NOT NULL` met de volledige breakdown.

---

## Pre-merge checklist Blok 1

- [ ] SQL migratie `2026-06-12-events-signups-closed.sql` gerund in
      productie-Supabase (4 kolommen + CHECK + FK aanwezig - zie
      verificatie-queries Pre-flight Blok 1)
- [ ] Env-vars `CRON_SECRET`, `WEBFLOW_API_TOKEN`, `WEBFLOW_SITE_ID`,
      `WEBFLOW_EVENTS_COLLECTION_ID`, `GHL_EVENTS_PIT_TOKEN`
      aanwezig in Vercel (Production + Preview)
- [ ] `vercel.json` bevat 2 nieuwe cron-entries:
      `cron-events-signups-auto-close` (`0 * * * *`) +
      `cron-events-cms-cleanup` (daily)
- [ ] Vercel preview-build groen voor de Blok 1-branch (geen syntax-/
      import-errors in nieuwe `api/_lib/event-sync-orchestrator.js`
      helpers, `api/events-close-signups.js`,
      `api/events-reopen-signups.js`, of beide nieuwe crons)
- [ ] Smoke-scenarios 9-14 OK doorlopen (output gerapporteerd in
      PR-comment of in chat)
- [ ] Beide crons handmatig triggerbaar verklaard (curl met
      `Authorization: Bearer $CRON_SECRET` -> 200 + JSON-payload)
- [ ] Item-6 hard-delete fix gevalideerd via scenario 13 (CMS-item
      permanent weg, niet alleen unpublished)
- [ ] Geen tech-debt in PR-diff (geen wijzigingen aan
      `modules/finance.html`, `modules/shared/finance-views/*`)

---

## Merge-instructie Blok 1 (STRICT lesson #148)

**USER doet de merge zelf** - geen agent merget deze PR.

Squash-merge alleen bij `{ merged: true }` response van GitHub API.
Branch-delete alleen na succesvolle strict-assertion.

Voorbeeld-prompt voor user:
```
Squash-merge PR #<nr> via GitHub API. Verifieer dat de response
{ merged: true } returnt. Pas daarna mag origin/feat/events-blok1-lifecycle
verwijderd worden.
```

**Niet vergeten na merge:**
1. Pull `main` lokaal -> verifieer dat Blok 1-commits in history zitten.
2. Run SQL migratie `2026-06-12-events-signups-closed.sql` op productie-
   Supabase (indien nog niet gedaan in Pre-flight Blok 1).
3. Bevestig in Vercel productie-deploy dat de 2 nieuwe Blok 1-crons
   (`cron-events-signups-auto-close` + `cron-events-cms-cleanup`)
   gelist staan onder Settings -> Crons (naast de bestaande F2-crons).
4. Productie-smoketest: 1 event sluiten via UI + verifieren dat Webflow
   item naar draft gaat + GHL-dropdown bijgewerkt wordt.
5. 24u later: check dat de hourly auto-close cron heeft gedraaid
   (Vercel logs `cron-events-signups-auto-close` met candidates/closed
   counts >0).

---

## Pre-merge checklist

- [ ] SQL migratie `2026-06-11-events-f2-sync-log.sql` gerund in productie-Supabase
- [ ] Env-vars `WEBFLOW_API_TOKEN`, `WEBFLOW_SITE_ID`,
      `WEBFLOW_EVENTS_COLLECTION_ID`, `GHL_EVENTS_PIT_TOKEN`,
      `CRON_SECRET` gecontroleerd in Vercel (Production + Preview)
- [ ] Vercel preview-build groen voor de F2-branch (geen syntax-/import-
      errors in nieuwe `api/_lib/*.js` of `api/events-*.js`)
- [ ] Smoke-scenarios 1-8 OK doorlopen (output gerapporteerd in
      PR-comment of in chat)
- [ ] GHL recon-spike output validate-against: na user-aanroep van
      `/api/diag-f2-recon` (PR #170) bevestig je dat:
      - de gedetecteerde Webflow veld-slugs matchen wat onze
        `webflow-client.js` schema-discovery vindt
      - de gedetecteerde GHL options-key (options vs picklistOptions vs
        choices vs textBoxList) matcht wat `ghl-custom-field.js` heuristic detecteert
      - de Event Type-niveau-mapping (basis/gevorderd) klopt met
        live Webflow CMS-structuur
- [ ] Indien recon-output afwijkt: kleine fix-commit op deze branch
      vooraf aan merge
- [ ] Geen tech-debt in PR-diff (geen wijzigingen aan
      `modules/finance.html`, `modules/shared/finance-views/*`)

---

## Merge-instructie (STRICT lesson #148)

**USER doet de merge zelf** — geen agent merget deze PR.

Squash-merge alleen bij `{ merged: true }` response van GitHub API.
Branch-delete alleen na succesvolle strict-assertion.

Voorbeeld-prompt voor user:
```
Squash-merge PR #<nr> via GitHub API. Verifieer dat de response
{ merged: true } returnt. Pas daarna mag origin/feat/events-f2-publish-sync
verwijderd worden.
```

**Niet vergeten na merge:**
1. Pull `main` lokaal -> verifieer dat F2-commits in history zitten.
2. Run SQL migratie `2026-06-11-events-f2-sync-log.sql` op productie-Supabase
   (indien nog niet gedaan in scenario 1).
3. Bevestig in Vercel productie-deploy dat de 2 nieuwe crons
   (`events-sync-retry` + `events-ghl-next-update`) gelist staan onder Settings -> Crons.
4. Productie-smoketest: 1 nieuw event aanmaken + publishen +
   verifieren dat Webflow live item krijgt + dropdown-optie zichtbaar
   wordt voor klanten in GHL workflows.
