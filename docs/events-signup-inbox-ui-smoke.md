# Inschrijvingen-inbox review-UI — smoke-doc (Stap 1)

Branch: `feat/events-signup-inbox-ui`
Base: `70706a244442955d1083f4720b731d41f7d171b5` (= PR #196 squash op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.** — ingest-stack staat al, dit is alleen UI.

## Doel

Sluiting van de ingest-laag aan de admin-zijde: GHL-form-submissions die niet
automatisch aan een event gekoppeld konden worden (no_match / ambiguous /
invalid_payload) worden nu via `modules/events.html` zichtbaar voor review.
Per rij kan een admin handmatig het juiste event kiezen → POST naar
`events-signup-inbox-resolve` → attendee wordt alsnog aangemaakt + seat-fill
cascade (zit al in endpoint).

## Wijzigingen

Eén file: `modules/events.html` (+322 / −6).

| # | Verandering |
|---|---|
| 1 | `init()` haalt `events.attendee.create` op + geeft door als 3e arg aan `renderPage`. |
| 2 | `renderPage(canCreate, canViewInbox, canManageSignupInbox)` — 3e arg additief. |
| 3 | Nieuwe tab-knop `<button data-evtab="signup-inbox">` met badge voor te-reviewen count. Alleen gerenderd als `canManageSignupInbox === true`. |
| 4 | Nieuwe pane `#ev-pane-signup-inbox`: header-uitleg + refresh-knop + filter-pills (`todo` = no_match+ambiguous, `no_match`, `ambiguous`, `matched`, `invalid_payload`, `all`) met counts + tabel-container. |
| 5 | Nieuwe resolve-modal `#evSignupResolveModal`: context-uitleg + event-picker (gepubliceerde events, chronologisch) + optionele notitie + error-area + Annuleer/Koppel-knoppen. |
| 6 | Tab-switch wiring uitgebreid voor `signup-inbox`. |
| 7 | Nieuwe JS-functies: `loadSignupInbox`, `_siFetchList`, `_siRenderCounts`, `_siUpdateBadge`, `_siStatusBadge`, `_siRenderRows`, `openSignupResolveModal`, `closeSignupResolveModal`, `_siLoadEventOptions`, `submitSignupResolve`. State in `_siState`. |

## Endpoints gebruikt

| Endpoint | Wanneer |
|---|---|
| `GET /api/events-signup-inbox-list?status=<x>&limit=200` | Tab open + filter wissel. Bij `todo`: 2 parallelle calls (no_match + ambiguous) + merge. |
| `GET /api/events-list?status=published&limit=200` | Modal open → event-picker (gecached in `_siState.eventsCache`). |
| `POST /api/events-signup-inbox-resolve` body `{inbox_id, event_id, notes?}` | Submit modal. |

## Bestaande events.html-tabs byte-identiek

`git diff` over de bestaande tabs:

| Asset | Wijziging |
|---|---|
| Overzicht-tab (filters, segments, tabel) | **0 functionele wijzigingen** (alleen `paneOverview`-const whitespace alignment) |
| Inbox-tab (events.html WhatsApp-thread + Simone) | **0 wijzigingen** (alle WhatsApp/Simone-code ongemoeid; tab-switch behoudt dezelfde flow voor `data-evtab="inbox"`) |
| Assessment-tab | n.v.t. — geen aanwezig in events.html |
| `renderPage` 1e + 2e arg | byte-identiek (additieve 3e arg) |
| `loadEventsInbox` + thread-functies | onveranderd |

## Hygiene

- Inline-JS parse via `new Function(...)` → **OK** (1 script, ~52.9k chars).
- Geen wijziging in `modules/finance.html` / `modules/shared/` / `api/*` → finance-zijde geen raakvlak.

## **BELANGRIJKE smoke-kanttekening — 13-juni resolve geeft 409**

De resolve-endpoint heeft een hard event-gate ([api/events-signup-inbox-resolve.js:121-126](api/events-signup-inbox-resolve.js:121)):

```js
if (event.status !== 'published') {
  return res.status(409).json({ error: 'Event is niet gepubliceerd.', code: 'EVENT_NOT_OPEN' });
}
if (event.signups_closed === true) {
  return res.status(409).json({ error: 'Inschrijvingen zijn gesloten.', code: 'EVENT_CLOSED' });
}
```

→ Resolve naar het **gearchiveerde** 13-juni event geeft **HTTP 409 EVENT_NOT_OPEN**. De UI toont die error netjes in de modal (error-area onder de event-picker). Dat verifieert tegelijk de error-handling.

Voor een echte happy-path-resolve **zonder Webflow/GHL-impact**: kies een gepubliceerd event waar de seat-fill cascade no-op is op zichtbaar niveau, bijvoorbeeld een event met genoeg vrije plekken zodat `autoCloseIfFull` niet vuurt en de `syncGastenlijstWebflow` alleen een "X / Y"-tekst-update doet (geen create/delete). Of bouw een eenmalig draft-event, publiceer 'm even, doe de smoke, archive 'm weer.

## Chrome-smoke-stappen (op preview)

### Stap A — Test no_match inbox-rij inserten

```sql
INSERT INTO event_signup_inbox (
  source, raw_payload, event_date_label,
  first_name, last_name, email, phone,
  match_status, received_at
) VALUES (
  'smoke',
  jsonb_build_object('smoke', true, 'note', 'review-UI test'),
  'Smoke 14 juni 2026 | 99:99 - 99:99 | Onbekend',
  'Smoke',
  'Test',
  'smoke-review@example.com',
  '+31600000099',
  'no_match',
  now()
)
RETURNING id;
```

Noteer de teruggegeven `id` als `$INBOX_ID`.

### Stap B — Open de tab + verifieer rendering

1. Login als super_admin op preview-URL.
2. Open `/modules/events.html` → tab "Inschrijvingen-inbox" (badge boven tabel toont count).
3. Filter staat default op "Te reviewen" — verwacht: jouw rij (`Smoke Test`, email/phone, label `Smoke 14 juni 2026 | …`, status `no_match`).
4. Klik filter "Alle" — rij staat erbij.
5. Klik filter "Matched" — rij verdwijnt (correct, want status='no_match').
6. Klik filter "No match" — rij staat erbij.
7. Klik filter "Te reviewen" → klik `Koppel`-knop op de rij.

### Stap C — Resolve (twee opties)

**Optie C1 — error-pad: resolve naar gearchiveerd 13-juni event** (verifieert error-handling, geen attendee aangemaakt):

1. In de modal, kies "13 juni 2026 …" uit de picker — *let op: archived events staan NIET in de picker omdat we filteren op `status=published`*. Voor het verifiëren van het 409-pad: kies een random gepubliceerd event waar je 'm achteraf van wegmaakt, of doe een direct curl-test:

```bash
curl -X POST "$PREVIEW_URL/api/events-signup-inbox-resolve" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inbox_id":"<INBOX_ID>","event_id":"7434236c-..."}'
# Verwacht: HTTP 409, {"error":"Event is niet gepubliceerd.","code":"EVENT_NOT_OPEN"}
```

**Optie C2 — happy path: resolve naar een gepubliceerd test-event** (verifieert volledige loop):

1. Maak een draft-event met titel `Smoke-test review-UI`, datum ver in de toekomst, capaciteit 10.
2. Publiceer 'm.
3. Open de resolve-modal voor de inbox-rij, kies dit event uit de picker, optioneel notitie "smoke C2", klik "Koppel + maak deelnemer".
4. Verwacht: toast `Gekoppeld + deelnemer aangemaakt`, modal sluit, rij verdwijnt uit de te-reviewen lijst, badge daalt.
5. Verifieer in DB:

```sql
SELECT id, event_id, first_name, last_name, email, status, follow_up_flagged, follow_up_reason
FROM event_attendees
WHERE email = 'smoke-review@example.com'
ORDER BY created_at DESC LIMIT 1;
-- verwacht: status='aangemeld', follow_up_flagged=true, follow_up_reason='RESOLVED_FROM_INBOX'.

SELECT id, match_status, matched_event_id, matched_attendee_id, resolved_at, resolved_by_user_id, notes
FROM event_signup_inbox WHERE id = '<INBOX_ID>';
-- verwacht: match_status='matched', matched_event_id/attendee_id gezet, resolved_at recent, notes='smoke C2'.
```

### Stap D — Cleanup

```sql
DELETE FROM event_attendees WHERE email = 'smoke-review@example.com';
DELETE FROM event_signup_inbox WHERE id = '<INBOX_ID>';
-- Bij optie C2: archiveer of verwijder ook het test-event:
DELETE FROM events WHERE title = 'Smoke-test review-UI';
```

### Stap E — Bevestig andere events-tabs onveranderd

1. Tab "Overzicht" — filters/segments/tabel werken zoals voorheen.
2. Tab "Inbox" — WhatsApp-conversaties + Simone-flow ongemoeid.

## Vereisten voor merge

- [ ] Vercel preview-build groen
- [ ] Chrome (B) renderen + filteren werkt
- [ ] Chrome (C2) happy-path of (C1) 409-error-pad bevestigd
- [ ] Geen wijziging aan andere events.html-tabs
- [ ] Cleanup uitgevoerd

## Risico's

| Risico | Mitigatie |
|---|---|
| Resolve naar archived/cancelled event blokt | Endpoint returnt 409 met code; UI toont in modal-error-area. Picker filtert op `status=published` zodat dit niet per ongeluk gebeurt. |
| 92 backfill-rijen zwellen de UI op | `limit=200` per call; filter `todo` toont alleen actionable items. Backfill is Stap 2 — separate PR. |
| Bestaande attendee dedup race | Endpoint heeft 23505-fallback (`deduplicated=true`); UI toast toont "(bestaande deelnemer hergebruikt)". |
| RBAC mismatch | Tab + endpoints beide op `events.attendee.create`. Super_admin krijgt automatisch via `user_has_permission` RPC. |

## Niet in deze PR

- Backfill van ~92 GHL-contacten (Stap 2 / separate PR).
- Comms (bevestiging/reminder, Stap 4).
- Wijziging aan de webhook of matcher (allebei al compleet).
