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
