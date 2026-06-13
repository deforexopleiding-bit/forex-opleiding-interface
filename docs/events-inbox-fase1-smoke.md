# Events-inbox (Fase 1) — smoke-doc

Branch: `feat/events-inbox-fase1`
PR: open (NIET gemerged)
Base: `39f40a261e87823a0f1056dfcd1754980fbdbef4` (= PR #186 squash, Fase 0 Joost-gate-hardening)
Migratie: **n.v.t.** — geen schema-wijziging.

## Doel

Events-inbound landt in een eigen, mens-leesbare events-inbox. Volledig gescheiden van Joost's finance-inbox. **Nog geen Simone-AI** — read-only voor menselijke triage.

## Wat gebouwd is

1. **`api/inbox-conversations-list.js`** — geparameteriseerd met `?module=events|finance` (default `'finance'` voor backward-compat). Per-module permissie:
   - `module='finance'` → `finance.inbox.view` (ongewijzigd)
   - `module='events'` → `events.inbox.view` (Fase 1 nieuw)
   - Onbekende modules → 400 met expliciete error
2. **`modules/admin.html`** — `events.inbox.view` toegevoegd aan FEATURE_REGISTRY in de events-sectie zodat 'ie via Rechten-tab te granten is.
3. **`modules/events.html`** — tab-bar boven de filter-strip met 2 tabs:
   - **Overzicht** (default, default-render = bestaande events-tabel; **volledig ongewijzigd gedrag**)
   - **Inbox** (alleen zichtbaar bij `events.inbox.view`-permissie) — read-only lijst van events-conversaties

## Backward-compat (KRITISCH)

### Finance-inbox no-regression
- Bestaande callers van `/api/inbox-conversations-list` (de finance-flow in `modules/finance.html`) sturen **geen** `?module=...` mee.
- Endpoint default = `'finance'` → pakt finance-permissie + finance-phone_number_id-lookup → returnt identieke shape.
- Response-shape uitgebreid met `module` veld; bestaande velden (`items`, `total`, `configured`, `warning`) ongewijzigd.

### Events-tab-zichtbaarheid is opt-in
- Zonder `events.inbox.view`-grant verschijnt de Inbox-tab NIET in `modules/events.html`.
- Bestaande events-gebruikers zonder die permissie zien een ongewijzigde events-pagina.

## Pre-flight (1 keer)

1. **Permission grant**: Admin → Rechten-tab → vink `events.inbox.view` aan voor super_admin/admin/manager (of waar je wilt).
2. **Events-WABA-rij** in `whatsapp_module_config`: admin maakt deze via de Afdeling-UI zodra het events-nummer onder de WABA staat.
   - Voor smoke kan een **tijdelijke test-rij** worden gebruikt met een duidelijk `phone_number_id` (bv. `EVENTS_TEST_<timestamp>`) + `module='events'`, `is_active=true`. Opruimen na smoke.

## Scenario 1 — Events-tab gated op permissie

**Doel:** Zonder `events.inbox.view`-grant is de Inbox-tab onzichtbaar; mét grant verschijnt 'ie.

**Stappen:**
1. Login als gebruiker zonder `events.inbox.view`-permissie.
2. Ga naar `/modules/events.html`.
3. Bevestig: ALLEEN "Overzicht"-tab zichtbaar. Geen "Inbox"-tab.
4. Logout/inswitch naar gebruiker MET die permissie (of grant 'm).
5. Ga naar `/modules/events.html`.
6. Bevestig: zowel "Overzicht" als "Inbox" tab zichtbaar.

## Scenario 2 — Finance-inbox no-regression (KRITISCH)

**Doel:** Finance-inbox is byte-identiek.

**Stappen:**
1. Login als gebruiker met `finance.inbox.view`.
2. Open `/modules/finance.html` → Wanbetalers > Inbox.
3. Lijst van conversaties laadt zoals altijd.
4. DevTools Network: GET request naar `/api/inbox-conversations-list` (zonder `?module=...`) → 200 met dezelfde `items`-shape als vóór deze PR.
5. Klik op een conversatie → werkt zoals altijd.
6. **Geen** nieuwe response-velden veranderen het bestaande gedrag (frontend negeert het nieuwe `module`-veld).

**Regressie-signaal:** als finance-inbox leeg is, een 403 geeft, of een andere lijst toont dan vóór → STOP.

## Scenario 3 — Events-inbox lijst (met test-rij)

**Pre-flight (eenmalig voor smoke; opruimen achteraf):**
```sql
-- Tijdelijke test-rij. Gebruik een unieke fake-phone_number_id zodat het
-- NIET botst met productie-finance-rij.
INSERT INTO whatsapp_module_config
  (module, phone_number_id, business_account_id, display_label, is_active)
VALUES
  ('events', 'EVENTS_TEST_111111111', '<bestaande-waba-id-of-test>',
   'Events (test)', true)
ON CONFLICT (module) DO NOTHING;

-- Tijdelijke test-conversatie aan deze fake-pnId koppelen voor display:
INSERT INTO whatsapp_conversations
  (phone_number, phone_number_id, display_name, status,
   last_message_at, last_message_preview, unread_count, last_inbound_at)
VALUES
  ('+31600000999', 'EVENTS_TEST_111111111', 'Test Event Lead', 'open',
   now(), 'Hoi, kan ik nog meedoen aan de gevorderd workshop zaterdag?',
   1, now());
```

**Stappen:**
1. Login als gebruiker met `events.inbox.view`.
2. `/modules/events.html` → klik "Inbox"-tab.
3. Verwacht: GET `/api/inbox-conversations-list?module=events&limit=100` → 200 met `items: [{ ... }]` (de test-rij).
4. Tabel toont: telefoon `+31600000999`, naam `Test Event Lead`, klant `geen koppeling` (italic), laatste bericht preview, tijd, unread-pill `1`.
5. Klik refresh-knop → lijst herlaadt.

**Verifieer URL-shape:**
```
GET /api/inbox-conversations-list?module=events&limit=100
→ 200 { items: [...], total: 1, configured: true, module: 'events' }
```

**Opruimen na smoke:**
```sql
DELETE FROM whatsapp_conversations WHERE phone_number = '+31600000999';
DELETE FROM whatsapp_module_config WHERE phone_number_id = 'EVENTS_TEST_111111111';
```

## Scenario 4 — Events-config ontbreekt

**Doel:** Vóór de events-WABA-rij bestaat, toont de Inbox-tab een nette config-banner.

**Stappen (NIET de test-rij uit scenario 3 inserten):**
1. `/modules/events.html` → Inbox-tab.
2. Verwacht response: `{ items: [], total: 0, configured: false, module: 'events', warning: 'Geen actieve events-config in whatsapp_module_config — vraag een admin om in te stellen.' }`
3. UI toont empty-state met titel "Events-lijn nog niet geconfigureerd" + de warning-tekst.

## Scenario 5 — Permission-gate server-side

**Doel:** Endpoint weigert ongeautoriseerde events-call met 403, ongeacht UI-state.

**Stappen (DevTools console of curl):**
```js
// Als gebruiker zonder events.inbox.view-permissie:
fetch('/api/inbox-conversations-list?module=events').then(r => r.status).then(console.log);
// verwacht: 403
```

**En bij een onbekende module:**
```js
fetch('/api/inbox-conversations-list?module=ghl').then(r => r.json()).then(console.log);
// verwacht: 400 { error: "module='ghl' niet ondersteund; verwacht finance|events" }
```

## Hygiene

```
$ node --check api/inbox-conversations-list.js  → exit 0
$ # events.html inline JS via extractor:
$ node --check .tmp-events-scripts.mjs           → exit 0
$ # admin.html inline JS via extractor:
$ node --check .tmp-admin-scripts.mjs            → exit 0
```

## Wat NIET in deze PR

- Hard-seed van events-WABA-rij (Jeffrey maakt 'm via Afdeling-UI)
- Send-functionaliteit voor events-inbox (komt in Fase 2 met Simone)
- Volledige chat-thread-view (read-only lijst voor MVP triage)
- Simone-AI / auto-suggest (Fase 2)
- Nieuwe inbox-conversations endpoints per module (1 endpoint blijft, geparameteriseerd)

## Wat in Fase 2 komt

- `api/simone-suggest.js` (sibling van joost-suggest, RBAC `events.simone.use`)
- Simone config-rij in `joost_config WHERE module='events'`
- Inbound-router uitbreiden in `inbox-webhook.js`: `module=events` → Simone-suggest
- Admin-UI tab voor Simone-config
