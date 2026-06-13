# Sync re-creëert archived events — fix-smoke

Branch: `fix/sync-recreates-archived-events`
PR: open (NIET gemerged)
Migratie: **n.v.t.** — gebruikt alleen bestaande kolommen.

## Root cause (samenvatting)

`/api/cron-events-sync-retry` (`*/15`) selecteert kandidaten uit
`event_sync_log` waar `status='failure' AND next_retry_at <= now()`. De
query filtert NIET op event-status. Wanneer een event ná de oorspronkelijke
failure-rij is gearchiveerd (`status='archived'`, `webflow_item_id=NULL`,
`webflow_sync_status='deleted'`), pakt de cron de oude failure-rij toch op
en roept `syncEventToOutbound`. Die doet `syncWebflow` met
`action = event.webflow_item_id ? 'update' : 'create'` → NULL ⇒ **create**
⇒ nieuw CMS-item voor een gearchiveerd event ✗.

## Fix-lagen

1. **Selection-level guard** in `api/cron-events-sync-retry.js`:
   batch-fetch events voor de gekozen rijen en sla `event_id`'s waar
   `status='archived'` OR `webflow_sync_status='deleted'` over. Markeer
   tegelijk de stale `event_sync_log`-rijen door `next_retry_at = NULL`
   te zetten — zo komt de cron ze niet elke 15min opnieuw tegen.
2. **Defense-in-depth in `syncEventToOutbound`** (orchestrator):
   early-return bij dezelfde condities zodat ook handmatige debug-calls
   of toekomstige callers (admin-retry-knop, andere crons) geen
   gearchiveerd event door de sync kunnen krijgen.
3. **Defense-in-depth in `syncWebflow`** (deeper-in): zelfde guard direct
   vóór de `action = ... ? 'update' : 'create'` beslissing, zodat geen
   enkel pad een `createLiveItem` voor een archived event kan triggeren.

Geen schema-wijziging. Geen event_sync_log-write voor skips (geen
schema-pollutie + houdt event_sync_log_action_check uit Blok 1 ongemoeid).

## Selectie-query vóór / ná

| | Vóór | Ná |
|---|---|---|
| Event_sync_log filter | `status='failure' AND next_retry_at IS NOT NULL AND next_retry_at <= now()` | identiek |
| Event-status filter | **niets** | per row in JS: skip als `events.status='archived'` OR `events.webflow_sync_status='deleted'` (na batch-fetch) |
| Stale-row cleanup | **geen** | `UPDATE event_sync_log SET next_retry_at=NULL WHERE id IN (...)` voor de skip-rijen |

## Create-fallback writeback check

`syncWebflow` regel 206-208 (vóór en ná deze fix):
```js
if (action === 'create' && result.itemId) {
  patch.webflow_item_id = result.itemId;
}
```
**Was al correct.** Bij een succesvolle create wordt de nieuwe item-id
teruggeschreven, zodat de volgende sync-cyclus `action='update'` kiest.
Geen latente duplicaten-bug voor legitieme creates.

## Scenarios

### a) Archived event wordt overgeslagen

**Pre-flight:**
- Eén event in DB met:
  ```sql
  status='archived',
  webflow_item_id IS NULL,
  webflow_sync_status='deleted'
  ```
- Eén oude failure-rij in `event_sync_log` voor dat event:
  ```sql
  SELECT id, status, next_retry_at
  FROM event_sync_log
  WHERE event_id = '<archived-event-id>'
  ORDER BY attempted_at DESC LIMIT 1;
  -- verwacht: status='failure', next_retry_at <= now()
  ```

**Stappen:**
1. Trigger de retry-cron handmatig:
   ```bash
   curl -X POST "$BASE_URL/api/cron-events-sync-retry" \
     -H "Authorization: Bearer $CRON_SECRET"
   ```
2. Response-summary moet bevatten:
   ```json
   {
     "candidates": N,
     "skipped_archived": >=1,
     "stale_rows_cleared": >=1,
     "unique_events_retried": 0,
     ...
   }
   ```
3. Vercel logs moeten `[event-sync-orchestrator] syncEventToOutbound
   SKIPPED archived/deleted event <uuid>` bevatten (defense-in-depth pad
   wordt niet bereikt omdat de cron al skipt; deze regel komt enkel als
   iemand de orchestrator handmatig aanroept met een archived event).
4. Verifieer dat `event_sync_log.next_retry_at` van de stale rij nu NULL is:
   ```sql
   SELECT id, status, next_retry_at
   FROM event_sync_log
   WHERE event_id = '<archived-event-id>'
   ORDER BY attempted_at DESC LIMIT 1;
   -- verwacht: status='failure', next_retry_at IS NULL
   ```
5. Verifieer dat het event op productie NIET een nieuw Webflow-item heeft
   gekregen:
   ```sql
   SELECT status, webflow_item_id, webflow_sync_status, webflow_last_synced_at
   FROM events WHERE id = '<archived-event-id>';
   -- verwacht: status=archived, webflow_item_id=NULL, sync_status=deleted
   ```
6. Hertrigger de cron. Verwacht: `candidates: 0` voor deze rij (next_retry_at
   is nu NULL, valt buiten de selectie). Andere stale rijen worden gewoon
   nog opgehaald + geskipt + cleared totdat alle stale rijen opgeruimd zijn.

### b) Normaal published event synct nog wél

**Pre-flight:**
- Een event met `status='published'`, niet `'archived'`, en een failure-
  rij in `event_sync_log` met `next_retry_at <= now()`.

**Stappen:**
1. Trigger de retry-cron handmatig (zoals scenario a stap 1).
2. Response-summary moet voor dit event in `unique_events_retried` zitten
   (NIET in `skipped_archived`).
3. Bij geslaagde sync: `success` counter +1 en `events.webflow_sync_status`
   wordt op `'success'` gezet.
4. Bij Webflow-fail: `failure` counter +1, nieuwe rij in event_sync_log
   met opgehoogde `retry_count`. Normaal retry-gedrag.

### c) Defense-in-depth: directe orchestrator-aanroep met archived event

**Doel:** Bevestig dat zelfs als een toekomstige caller `syncEventToOutbound`
direct aanroept met een archived event_id (handmatige admin-knop, andere
cron, etc.), de guard binnen de orchestrator faliekant skipt.

**Stappen (in DevTools van een ingelogde super_admin tab, of een SQL
console waar je een ad-hoc-trigger schrijft):**
- Geen publieke admin-endpoint bestaat hiervoor, dus dit is alleen een
  code-review-bevestiging: lees `event-sync-orchestrator.js`
  `syncEventToOutbound` regel ±486-505 en bevestig de `if
  (event.status === 'archived' || event.webflow_sync_status ===
  'deleted')` early-return. Idem in `syncWebflow` regel ±177-194.

### Verwachting na merge

- Eerstvolgende `:15` of `:30`-tick op productie pakt eventuele resterende
  stale rijen op (filter `next_retry_at <= now`), skipt ze, en zet hun
  `next_retry_at = NULL`. Vanaf dan stille runs.
- Geen nieuwe Webflow-items meer voor archived events.
- Reeds-recreated CMS-items voor archived events blijven op Webflow staan;
  die moeten handmatig (Chrome / Webflow UI) of via `events-delete`
  herhaal-aanroep opgeruimd worden — uit scope voor deze fix.
