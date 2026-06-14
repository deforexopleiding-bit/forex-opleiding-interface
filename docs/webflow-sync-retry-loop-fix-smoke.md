# Webflow publish-keten + retry-loop fix — smoke-doc

Branch: `fix/webflow-sync-retry-loop`
Base: `e8fc76865e261728feee09fcc6d7e349b9bc7ac9` (= PR #195 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.**

## Doel

Drie gerelateerde defects fixen die samen het 13-juni event in een 186-retry
loop hielden:

| Deel | Wat |
|---|---|
| (a) | Bij `updateItem` PATCH `/items/{id}/live` → 409 CONFLICT op nooit-gepubliceerd item → fallback naar `republishItem` (POST `/items/publish`). |
| (b) | Retry-cron + orchestrator-guards skippen voortaan ook **cancelled** events én events met **`starts_at < now()`** (verleden). Stale rijen krijgen `next_retry_at=NULL`. |
| (c) | Algemene loop-terminatie: zodra een nieuwere attempt voor `(event_id, target)` is gelogd, krijgen alle oudere failure-rijen `next_retry_at=NULL`. De cap (retry_count≥4 → NULL) werkt nu effectief omdat de cron alleen nog de nieuwste rij ziet. |

(c) blijft binnen scope — kleine wijziging op `logSyncAttempt` (return id + één UPDATE-query). Geen herstructurering van de retry-row-lifecycle nodig.

## Wijzigingen — per deel

### (a) 409 → republish fallback in `syncWebflow`

[`api/_lib/event-sync-orchestrator.js`](api/_lib/event-sync-orchestrator.js) `syncWebflow` (~regel 201-211).

Pre-fix:
```js
result = await updateItem({ webflowItemId, event, descriptionHtml });
```

Post-fix:
```js
try {
  result = await updateItem({ webflowItemId, event, descriptionHtml });
} catch (e) {
  if (e instanceof WebflowError && e.code === 'CONFLICT') {
    console.warn(`syncWebflow updateItem 409 → fallback naar republishItem`);
    result = await republishItem({ webflowItemId, event, descriptionHtml });
    usedRepublishFallback = true;
  } else {
    throw e;
  }
}
```

- `republishItem` doet PATCH staged + POST `/items/publish` — al bestaand pad
  voor reopen-signups (smoke-bevestigd 2026-06-12), werkt OOK voor
  never-published items.
- Andere errors (RATE_LIMIT 429, WEBFLOW_DOWN 5xx, NOT_FOUND 404, etc.)
  worden ongewijzigd door de outer try/catch behandeld → blijven dezelfde
  retry-strategie volgen.
- Audit-trace: bij fallback bevat `event_sync_log.response_payload` de flag
  `used_republish_fallback_after_409: true` + `strategy` zodat het
  observable is zonder nieuwe action-enum.

### (b) Skip verleden/cancelled events

**Orchestrator-niveau** (defense-in-depth):

[`event-sync-orchestrator.js`](api/_lib/event-sync-orchestrator.js) `syncWebflow` (~177-200) en `syncEventToOutbound` (~510-540): guard uitgebreid van alleen `archived/deleted` naar:

```js
const isPast       = !!event.starts_at && new Date(event.starts_at).getTime() < Date.now();
const isCancelled  = event.status === 'cancelled';
const isArchived   = event.status === 'archived' || event.webflow_sync_status === 'deleted';
if (isArchived || isCancelled || isPast) {
  // return skip met status='skipped_archived' | 'skipped_cancelled' | 'skipped_past'
}
```

**Cron-niveau** (primaire stop):

[`api/cron-events-sync-retry.js`](api/cron-events-sync-retry.js) (~108-127): selection-level skip uitgebreid, `events.starts_at` toegevoegd aan batch-fetch SELECT, stale rijen worden geclear'd op next_retry_at=NULL zodat ze niet meer geselecteerd worden in volgende runs. Summary krijgt aparte tellers `skipped_cancelled` en `skipped_past` (toegevoegd aan bestaande `skipped_archived`).

### (c) Loop-terminatie — clear oudere failure-pointers bij elke nieuwe attempt

[`event-sync-orchestrator.js`](api/_lib/event-sync-orchestrator.js) `logSyncAttempt` (~116-143): de helper returnt nu de zojuist-geïnserteerde `id`, en doet daarna ÉÉN extra UPDATE-query:

```sql
UPDATE event_sync_log
   SET next_retry_at = NULL
 WHERE event_id = $1 AND target = $2 AND status = 'failure'
   AND id != $new_inserted_id
   AND next_retry_at IS NOT NULL;
```

- Wordt aangeroepen na **elke** logSyncAttempt-insert (success én failure).
- Effect: per `(event_id, target)` is na deze fix maximaal **één** failure-rij
  met `next_retry_at IS NOT NULL` op enig moment — alle eerdere rijen krijgen
  NULL en vallen uit de cron-selectie. De backoff-cap (retry_count≥4 → NULL)
  termineert nu effectief.
- No-op voor events zonder eerdere failure-rijen (UPDATE matcht 0 rijen). De
  4 OPEN events worden niet geraakt.
- Defensive: alleen lopen als de INSERT een id terugkreeg. Bij DB-fout op
  insert wordt de UPDATE geskipt (consistent met fail-soft semantiek).

## Smoke-redenering per deel

### (a) — 409 → republish fallback

| Scenario | Pre-fix | Post-fix |
|---|---|---|
| Normaal `updateItem` op LIVE item | PATCH /live → 200 → success | **identiek** (try-tak slaagt) |
| `updateItem` op never-published item (13-juni) | PATCH /live → 409 → failure-rij | catch CONFLICT → `republishItem` POST /items/publish → success |
| `updateItem` RATE_LIMIT 429 | throws RATE_LIMIT → failure-rij + retry | **identiek** (`e.code !== 'CONFLICT'` → re-throw) |
| `updateItem` WEBFLOW_DOWN 5xx | throws WEBFLOW_DOWN → failure-rij + retry | **identiek** |
| `updateItem` NOT_FOUND 404 | throws NOT_FOUND → failure-rij | **identiek** |

### (b) — skip verleden/cancelled

| Scenario | Pre-fix | Post-fix |
|---|---|---|
| 4 OPEN events (status='published', toekomstig) | sync runs normaal | **identiek** (`isArchived` + `isCancelled` + `isPast` allen false → normaal sync-pad) |
| 13-juni (status='published', starts_at=13-06, today=14-06) | retry-cron pakt 'm 4×/uur | cron skipt + clear next_retry_at op stale rij → uit selectie |
| cancelled event waar oude failure-rij voor bestaat | retry-cron pakt 'm | cron skipt + clear |
| archived event | bestaande skipped_archived pad | identiek (bestaande pad ongewijzigd) |

### (c) — loop-terminatie

Concreet voorbeeld 13-juni vóór fix:
```
event_sync_log (event=13-juni, target=webflow):
  R1: status=failure, retry_count=0, next_retry_at='2026-06-12 15:00' (verleden)
  R2: status=failure, retry_count=1, next_retry_at='2026-06-12 16:00' (verleden)
  ...
  R186: status=failure, retry_count=4, next_retry_at=NULL
Cron query "next_retry_at IS NOT NULL AND <= now()" → R1..R185 = 185 hits
```

Na deel (c) — bij elke nieuwe insert (R187, R188, ...) krijgen R1..R(n-1) `next_retry_at=NULL`. Na 1 cron-run is `event_sync_log` voor (13-juni, webflow):
```
R1..R186: next_retry_at=NULL
R187 (de net-toegevoegde failure of skipped_past row): next_retry_at=NULL (cap) of NULL (skipped)
Cron query → 0 hits voor dit event.
```

Bij elke nieuwe failure: alleen de allernieuwste rij heeft een geldige `next_retry_at`; alle eerdere rijen zijn terminal. Cap (retry_count≥4 → NULL) termineert nu daadwerkelijk.

**Effect op OPEN events**: zonder eerdere failure-rijen matcht de UPDATE 0 rijen → no-op. Geen gedragsverandering.

## Hygiene

- `node --check api/_lib/event-sync-orchestrator.js` → exit 0 ✅
- `node --check api/cron-events-sync-retry.js` → exit 0 ✅
- Vercel preview-build (poll volgt na PR-open) → success verwacht

## Chrome-prod-stappen (door jou, voor smoke)

### (i) 4 OPEN events ongemoeid op preview-deploy

```sql
-- Identificeer ze (op preview én prod identiek; voer op prod-DB):
SELECT id, title, starts_at, status, webflow_item_id, webflow_sync_status, webflow_last_synced_at
FROM events
WHERE status='published'
  AND starts_at > now()
ORDER BY starts_at ASC;
-- Verwacht: 4 rijen, allemaal webflow_sync_status='success' (anders melden).
```

Pre-fix snapshot bewaren. Na merge & 1 cron-run (15min):
```sql
SELECT id, webflow_sync_status, webflow_last_synced_at FROM events
WHERE id IN (<4 OPEN event-ids>);
```
**Verwacht**: `webflow_last_synced_at` ongewijzigd t.o.v. pre-merge snapshot
(of bumped door een legitieme sync — maar `webflow_sync_status='success'`
blijft). **Geen** nieuwe failure-rijen voor deze events in
`event_sync_log` na merge.

### (ii) 13-juni stopt looping

```sql
-- Telling failure-rijen voor 13-juni met actieve retry-pointer:
SELECT count(*) FILTER (WHERE next_retry_at IS NOT NULL) AS active_retries,
       count(*) AS total_failures,
       max(attempted_at) AS latest_attempt
FROM event_sync_log
WHERE event_id = (SELECT id FROM events WHERE starts_at::date = '2026-06-13' LIMIT 1)
  AND target = 'webflow' AND status = 'failure';
```

Pre-merge: `active_retries` is een hoog getal (~185 rijen met next_retry_at < now()).
Na merge + 1 cron-run: `active_retries = 0` (alle stale rijen geclear'd door deel (c) + (b)). `total_failures` blijft staan als historie (correct gedrag).

### (iii) Event met meerdere oude failure-rijen na fix — slechts 1 actieve retry-rij

Generaliseert (c) over alle events:
```sql
SELECT event_id, target, count(*) FILTER (WHERE next_retry_at IS NOT NULL) AS active
FROM event_sync_log
WHERE status='failure'
GROUP BY event_id, target
HAVING count(*) FILTER (WHERE next_retry_at IS NOT NULL) > 1;
```
Pre-merge: typisch meerdere rijen per (event_id, target). Na 1 cron-run: **0 rijen** in result (geen enkel (event_id, target) heeft meer dan 1 actieve retry-rij). Bewijs dat (c) generaliseert.

### (iv) Cron-summary inspectie

Na de eerste cron-run post-merge in Vercel logs:
```
[cron-events-sync-retry] {"candidates":N,"unique_events_retried":...,
  "skipped_archived":...,"skipped_cancelled":...,"skipped_past":...,
  "stale_rows_cleared":...}
```
**Verwacht**: `skipped_past >= 1` (13-juni), `stale_rows_cleared >= skipped_past`.

## Vereisten voor merge

- [ ] `node --check` op 2 files → exit 0 ✅
- [ ] Vercel preview-build groen
- [ ] (na merge) Cron-summary toont skipped_past + stale_rows_cleared
- [ ] (na merge) 4 OPEN events ongemoeid (preserve webflow_sync_status='success')
- [ ] (na merge) 13-juni `active_retries = 0`
- [ ] (na merge) ∀ (event_id, target): max 1 actieve retry-rij

## Invarianten

- ✅ 4 OPEN events (toekomstig, status='published') syncen byte-identiek
- ✅ `republishItem` blijft canonical voor reopen/close-signups — ongewijzigd
- ✅ Backoff-schema `nextRetryDelayMs(retry_count)` ongewijzigd (cap blijft 4)
- ✅ Bestaande `skipped_archived` pad onaangetast
- ✅ Bestaande sync-flows (events-publish, events-update, events-reopen-signups,
  events-close-signups, events-delete) ongewijzigd
- ✅ Tech-debt-zone (modules/finance.html, modules/shared/finance-views/camtbank.js) ongemoeid

## Risico's

| Risico | Mitigatie |
|---|---|
| `republishItem` 409't ook op het 13-juni item | Onwaarschijnlijk: `republishItem` gebruikt POST `/items/publish` — gedocumenteerde Webflow API voor never-published items, smoke-bewezen 12 juni. Bij wel-falen: normale retry-strategie + de fout-code wordt in event_sync_log gelogd. |
| Past-event guard misst events met null `starts_at` | `!!event.starts_at` voorkomt null-deref. Events zonder starts_at zijn data-anomalie; vallen door alle skip-guards heen → normaal sync-pad (geen regressie). |
| UPDATE-query in `logSyncAttempt` raakt onverwacht rijen | Filter: `event_id` + `target` + `status='failure'` + `id != insertedId` + `next_retry_at IS NOT NULL`. Geen valid edge-case waarin we OUDERE rijen willen behouden met actieve retry-pointer — de nieuwste is per definitie autoritatief. |
| Insert van logSyncAttempt geeft geen id terug (DB-fout) | UPDATE geskipt (defensive `if (insertedId)`) — fail-soft, geen crash. Volgende run pakt 'm op via cron-pad. |
