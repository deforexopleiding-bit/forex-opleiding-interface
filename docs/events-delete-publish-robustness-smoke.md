# Events-delete + publish-robustness — smoke-doc

Branch: `feat/events-delete-publish-robustness`
PR: open (NIET gemerged)
Migratie: **n.v.t.** (geen schema-wijziging; alleen gedragsveranderingen).

Vier scenario's om de 3 fixes uit deze PR te valideren op de preview-URL.
Loop ze sequentieel; elke stap heeft een verwachte uitkomst die past op
de bestaande Vercel-logs + DB-state.

Alle scenario's werken op een WEGWERP-testevent (titel "SMOKE-DELETE-...")
met `status='published'`, `niveau='basis'`, `capaciteit=10`, dat F2 al
heeft gepublisht (`webflow_item_id` IS NOT NULL).

---

## Scenario a — Normale hard-delete

**Doel:** Een normale delete-flow ruimt het Webflow-item op, nult de link
in DB, en publisht de site via de gedebouncede route zodat de event-kaart
binnen ~10s van de overzichtspagina verdwijnt.

**Stappen:**
1. Maak testevent `SMOKE-DELETE-NORMAL` aan en wacht tot F2 publish-sync
   klaar is (`webflow_item_id IS NOT NULL`).
2. POST `/api/events-delete?id=<uuid>` (admin met
   `events.event.delete`-permissie).
3. Verwacht response:
   ```json
   {
     "event": { "id": "...", "status": "archived",
                 "webflow_item_id": null, "webflow_sync_status": "deleted" },
     "archived": true,
     "webflow_cleanup": "done",
     "sync": { "webflow": { "ok": true, "cleanup_status": "done", ... },
                "ghl":     { "ok": true, ... } }
   }
   ```
4. Verifieer Vercel logs (filter op `webflow-client`):
   ```
   [webflow-client] hardDeleteItem (idempotent of success)
   [webflow-client] publishSite (hard-delete-<itemId>): site=..., domainSource=discovery-cached, customDomains=2 (www.deforexopleiding.nl, deforexopleiding.nl), subdomain=true
   [webflow-client] publishSite OK (..., attempt=1): ...
   ```
   NIET `forcePublishSite` of `manual-button` als context.
5. DB-state:
   ```sql
   SELECT status, webflow_item_id, webflow_sync_status
   FROM public.events WHERE title='SMOKE-DELETE-NORMAL';
   -- verwacht: archived | NULL | deleted
   ```
6. Open `www.deforexopleiding.nl` → SMOKE-DELETE-NORMAL is NIET meer
   zichtbaar in de overzichtslijst (binnen ~15s).

**Verwacht:** delete + publish + DOM-verdwijning in één e2e via debounced
maybePublishSite-pad.

---

## Scenario b — Burst van 3 rappe deletes → ≤1 publish

**Doel:** 3 deletes binnen `DEBOUNCE_MS=5s` coalesceren via de
in_progress-lock + trailing-debounce tot ~1 site-publish, geen 429.

**Pre-flight:**
- 3 testevents: `SMOKE-DELETE-BURST-A/B/C`, alle published + Webflow-
  item OK.
- `app_settings.webflow_auto_publish_enabled.enabled = true`.

**Stappen:**
1. Stuur in snelle volgorde (binnen ~3-4 seconden) 3× POST
   `/api/events-delete?id=<A|B|C>`.
2. Verifieer Vercel logs:
   - 3× `hardDeleteItem` + 3× `publishSite (hard-delete-...)` candidates.
   - Maar **maximaal 1-2 echte `publishSite OK` regels**; de andere
     pogingen worden door `maybePublishSite` geskipt met
     `reason='in_progress'` of `'debounced'`.
   - GEEN `[DEGRADED: publish_429_retries_exhausted]` regels.
3. DB-state:
   ```sql
   SELECT id, title, status, webflow_item_id, webflow_sync_status
   FROM public.events WHERE title LIKE 'SMOKE-DELETE-BURST-%';
   -- verwacht: alle 3 rijen status=archived, webflow_item_id=NULL, sync_status=deleted
   ```
4. `app_settings.webflow_publish_state`:
   ```sql
   SELECT value FROM public.app_settings WHERE key='webflow_publish_state';
   -- verwacht: last_publish_at recent, pending kan true zijn tot de
   -- trailing publish landt; binnen ~10s opnieuw checken -> pending=false.
   ```
5. Open `www.deforexopleiding.nl` → alle 3 events zijn verdwenen.

**Verwacht:** debounce werkt; alle deletes geslaagd; geen 429-storm.

---

## Scenario c — Deferred-pad (gesimuleerde Webflow-fout)

**Doel:** Bij een mislukte item-delete (429/5xx/netwerk) blijft de
`webflow_item_id`-link staan, `sync_status='failure'`, en de response
markeert `webflow_cleanup='deferred'`. Een herdraai ruimt de boel
alsnog op.

**Setup voor de simulatie:** Geen ingebouwde fault-injection - 2
praktische opties:
1. **Tijdelijk verkeerd WEBFLOW_API_TOKEN** in Vercel preview-env, doe
   1 delete-call, herstel daarna de token. Webflow returnt 401
   AUTH_FAIL → niet retryable → response geeft `cleanup_status='deferred'`
   met `retryable: false`.
2. **Wacht op natuurlijke 429** (zeldzaam): publish vele keer kort na
   elkaar tot 429; gebruik de zelfde rate-limit window voor een
   hard-delete. Retryable: true.

**Stappen:**
1. Maak testevent `SMOKE-DELETE-DEFERRED` aan, wacht tot F2-publish OK.
2. Triggert de fout-modus (zie setup hierboven).
3. POST `/api/events-delete?id=<uuid>`.
4. Verwacht response:
   ```json
   {
     "event": { "status": "archived",
                 "webflow_item_id": "<UNCHANGED>",
                 "webflow_sync_status": "failure" },
     "archived": true,
     "webflow_cleanup": "deferred",
     "retryable": <true|false afhankelijk van error>,
     "message": "Webflow-cleanup uitgesteld; herdraai dit endpoint om het opnieuw te proberen."
   }
   ```
5. Verifieer DB:
   ```sql
   SELECT status, webflow_item_id, webflow_sync_status
   FROM public.events WHERE title='SMOKE-DELETE-DEFERRED';
   -- verwacht: archived | <uuid-of-webflow-item> | failure
   ```
6. **Herstel de fout-modus** (token terug, of wacht uit de 429-window).
7. POST `/api/events-delete?id=<uuid>` opnieuw.
8. Verwacht response: `webflow_cleanup: "done"`, `webflow_item_id`
   nu NULL, `sync_status='deleted'`. Geen 409.

**Verwacht:** failure laat link intact + duidelijk uitgesteld signaal;
herdraai pakt de cleanup op zonder nieuwe permissies.

---

## Scenario d — Idempotentie op already-archived

**Doel:** Twee gevallen testen:
  (i) already archived + webflow_item_id IS NULL → 200 noop, geen 409.
  (ii) already archived + lingering webflow_item_id (na deferred) → cleanup
       opnieuw + 200 `webflow_cleanup: 'done'`.

**Stappen voor (i):**
1. Gebruik een event uit scenario a (na success) - `archived` +
   `webflow_item_id IS NULL`.
2. POST `/api/events-delete?id=<uuid>` opnieuw.
3. Verwacht response:
   ```json
   { "archived": true,
     "noop": true,
     "code": "already_deleted",
     "webflow_cleanup": "none" }
   ```
   HTTP 200, niet 409.

**Stappen voor (ii):**
1. Maak SMOKE-DELETE-DEFERRED-2 aan, voer scenario c uit tot stap 5
   (DB-state archived + lingering webflow_item_id + sync_status=failure).
2. Herstel de fout-modus.
3. POST `/api/events-delete?id=<uuid>` opnieuw.
4. Verwacht response:
   ```json
   {
     "event": { "status": "archived",
                 "webflow_item_id": null,
                 "webflow_sync_status": "deleted" },
     "archived": true,
     "webflow_cleanup": "done"
   }
   ```
5. Herdraai een 3e keer -> 200 `noop: true` (we zitten nu in geval (i)).

**Verwacht:** geen 409 op een already-archived event; herdraaien is
veilig + ruimt vlot lingering Webflow-items op zodra het kan.

---

## Bonus — 429-retry-pad verifieren (optioneel)

Als je toch een echte 429 op `POST /sites/{id}/publish` weet uit te
lokken (bv. door binnen ~30s 5+ deletes te doen op een nieuw plan met
strenge rate-limit): verifieer de logs:

```
[webflow-client] publishSite RATE_LIMIT attempt=1 (retryAfterSec=<n>), waiting <ms>ms before retry
[webflow-client] publishSite RATE_LIMIT attempt=2 (retryAfterSec=<n>), waiting <ms>ms before retry
[webflow-client] publishSite [DEGRADED: publish_429_retries_exhausted] (..., attempt=3): ...
```

`app_settings.webflow_publish_state.pending` moet daarna `true` zijn;
de volgende debounced mutatie of admin "Publish nu" knop publisht alsnog
binnen seconden. Geen exception naar buiten - de delete zelf bleef succesvol.
