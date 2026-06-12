# Events Blok 1 - Item 6 diagnose: events-delete Webflow-fail

**Datum:** 2026-06-12
**Branch:** `feat/events-blok1-lifecycle`
**Scope:** archive-pad van `api/events-delete.js`, hoe dat aanlandt in Webflow,
en waarom de smoke-fail rondom delete optreedt.

---

## 1. Huidige flow van `api/events-delete.js`

POST `/api/events-delete?id=<uuid>` voert achter elkaar uit:

1. `requirePermission('events.event.delete')` -> 403 als geen rechten.
2. SELECT `id, status` van event -> 404 als niet gevonden.
3. Guard: als `status='archived'` al staat -> 409 (al gearchiveerd).
4. UPDATE `events SET status='archived'` -> select-back voor returnvelden.
5. AWAITED call naar `unpublishEventOutbound(ev.id)` uit
   `api/_lib/event-sync-orchestrator.js`. Faalt 1 target -> de andere blijft
   draaien (try/catch per target binnen orchestrator). Endpoint-level try/catch
   eromheen zodat sync-exception niet de archive-mutatie terugdraait.
6. Refetch met sync-metadata, response `{ event, sync }`.

`unpublishEventOutbound(eventId)` zelf doet:

- `fetchEvent(eventId)` (incl. `webflow_item_id`).
- `unpublishWebflow(event)` -> `unpublishItem({ webflowItemId })` =
  **DELETE `/collections/{coll}/items/{webflowItemId}/live`**. Daarna wordt de
  events-row gepatcht met `webflow_sync_status='unpublished'`.
- `syncGhl(event)` -> `computeUpcomingLabels()` (filtert `status='published'`
  + `starts_at>now()`, dus archived event valt automatisch uit) + PUT options
  naar GHL custom-field.

## 2. Wat de delete in Webflow daadwerkelijk doet

`DELETE /collections/{coll}/items/{itemId}/live` is een **unpublish van de
live-publicatie**. Per Webflow v2 docs blijft het item als **staged record**
bestaan in de collection. Het is van de live-site af, maar bestaat nog (kan
later hergepubliceerd worden).

Tegelijk is de intent van `events-delete` met `status='archived'`: het event
gaat uit het CMS. We willen het record **permanent weg** uit Webflow, niet
"in draft geparkeerd". Dat is de **mismatch**:

| Wat we doen           | Wat we bedoelen                           |
|-----------------------|-------------------------------------------|
| unpublish (item staged blijft) | **archive** = permanent uit CMS  |

## 3. Vermoedelijke smoke-fail-oorzaak

Twee plausibele faal-paden uit de huidige code:

### 3.1 Herhaalde DELETE op `/items/{id}/live` -> 404
Bij een event waar archive al eerder geprobeerd is (bv. retry-cron of dubbele
admin-klik), is de Webflow live-publicatie al opgeruimd. Een tweede DELETE op
`/items/{id}/live` returnt **404 NOT_FOUND** van Webflow. `webflowFetch()`
mapt status 404 via `classifyStatus()` op `WebflowError.code='NOT_FOUND'` en
gooit hem omhoog -> `unpublishWebflow()` catched hem, log't `status='failure'`
in `event_sync_log`, en zet `webflow_sync_status='failure'` op de events-row.

Voor een ARCHIVE-flow is dit semantisch onjuist: het item is al weg (precies
wat we wilden), dus dit zou een SUCCESS moeten zijn, niet een failure.

### 3.2 Staged item blijft achter, geen permanente cleanup
Ook bij een succesvolle eerste DELETE staat het item nog in de Webflow CMS
collection als staged-record. Smoke checkt mogelijk of het item daar niet meer
voorkomt -> ziet hem er nog staan -> assertion-fail. Geen runtime-error,
maar wel een gefaalde gedraging-check.

Beide paden wijzen naar dezelfde structurele tekortkoming: **archive en
unpublish moeten verschillende HTTP-paden gebruiken**.

## 4. Fix-plan

### 4.1 Nieuwe helper `hardDeleteItem(itemId)` in `api/_lib/webflow-client.js`

Path: `DELETE /collections/{coll}/items/{itemId}` (zonder `/live` suffix).
Per Webflow v2 docs verwijdert dit het item permanent uit de collection (zowel
live publicatie als staged record). Idempotent: een tweede call op een al
opgeruimd item returnt 404 -> we mappen die op **success** (return-shape
met `deleted:false, reason:'404 already gone'`).

### 4.2 `unpublishItem(itemId)` ook 404-as-success maken

Voor de **reopen-signups** flow + alle bestaande unpublish-callers: een DELETE
op `/items/{id}/live` waar de live-publicatie al weg is, mag NIET als failure
in `event_sync_log` belanden. Dezelfde 404-as-success treatment.

Concreet: wrap de fetch-call in try/catch, vang `WebflowError.code='NOT_FOUND'`
af, return `{ deleted:false, reason:'404 already gone' }` ipv re-throw.

### 4.3 `events-delete.js` switcht van unpublish naar hard-delete

Inplaats van `unpublishEventOutbound(ev.id)` roepen we een nieuwe orchestrator-
export `hardDeleteEventOutbound(ev.id)` aan. Die:

1. Leest event (incl. `webflow_item_id`).
2. Calls `hardDeleteItem({ webflowItemId: event.webflow_item_id })`.
3. Patch events-row: `webflow_item_id=NULL`, `webflow_sync_status='archived'`,
   `webflow_last_synced_at=now()`.
4. Log in `event_sync_log` met `action='hard_delete'`,
   `status='success'` (ook bij 404-already-gone, want dat IS success).
5. GHL pad ongewijzigd: `syncGhl(event)` herrekent labels, event valt
   automatisch uit `computeUpcomingLabels()` omdat status nu `'archived'` is.

### 4.4 Code-pad herbruikbaar voor cleanup-cron (item 5 uit plan)

De >7d cleanup-cron (`cron-events-cleanup-old.js` straks) bouwt geen aparte
delete-pipeline maar roept `hardDeleteEventOutbound(eventId)` aan voor elk
event dat aan de cleanup-criteria voldoet. Eén pad voor "permanent uit CMS",
geen drift tussen admin-trigger en cron-trigger.

## 5. Niet-doel van Blok 1 item 6

- We pakken **geen** publish-retry hier op (al gedekt door
  `cron-events-sync-retry`).
- We veranderen **niets** aan het GHL-pad: `computeUpcomingLabels` filtert
  archived events al uit -> één extra GHL PUT bij delete is genoeg.
- We **migreren oude events niet** (bestaande `webflow_item_id`-waarden van
  voor de fix blijven; eerste hard-delete na deploy ruimt ze op zoals
  verwacht).
