# Simone-bediening — smoke-doc (Fase 2 stap 2c)

Branch: `feat/simone-ui-config`
Base: `83ee830d13d7873b8c2c22cc59c81df95c4ae47b` (= PR #193 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.** — hergebruikt bestaande tabellen + `feature_flags` jsonb.

## Doel

Simone dagelijks bruikbaar als sibling van Joost: events-inbox interactief
maken (thread + Vraag Simone + suggestie-acties) plus een Simone-config-UI
in admin.html. Finance/Joost-UI én -gedrag **byte-identiek**.

## Recon-map

| Asset | Vindplaats | Hergebruik in stap 2c |
|---|---|---|
| "Vraag Joost"-knop + flow | [modules/finance.html:7286](modules/finance.html:7286) `/api/joost-suggest` | Spiegel: events.html `evAskSimoneBtn` → `/api/simone-suggest` |
| Joost suggestion-cards (PROPOSED) | finance.html via `loadInboxCustomerContext` + `_joostRenderSuggestionCard` | Nieuwe lichte sibling-render `_renderEvSuggestionPanel` in events.html — geen shared component (precedent: minimal events.html aansluitend op Fase 1) |
| Outcome-endpoints | [api/joost-mark-outcome.js](api/joost-mark-outcome.js) (USED_AS_IS / USED_EDITED / DISMISSED) | Geparameteriseerd op `current.module` → events-rows krijgen `events.simone.use` |
| Thread-view (in/out chronologisch) | finance.html `openInboxConv` + `_inboxRenderMessages` (~regel 6585+) | Nieuwe minimal sibling `_renderEvThread` in events.html (geen klant-modal / autonomy-strip / template-knoppen — events-scope) |
| Inbox + thread geparameteriseerd? | [api/inbox-conversations-list.js:34](api/inbox-conversations-list.js:34) ✅ al module-param sinds Fase 1; [api/inbox-messages-list.js](api/inbox-messages-list.js) op `finance.inbox.view` (alleen lezen — geen wijziging nodig: events-RBAC krijgt het via `events.inbox.view` zoals al gepland) | Endpoint zelf ongewijzigd — events.html gebruikt huidige endpoint. (Permission check op finance.inbox.view voorlopig hard-gerouterd; events-user moet die ook hebben — zie risico's hieronder.) |
| Joost-config-UI | [modules/shared/finance-instellingen.js:236-915](modules/shared/finance-instellingen.js:236) — onder Finance > Instellingen, GEEN admin.html | Nieuwe lichte mirror als admin.html-tab "Simone-config" — bewust gescheiden zodat finance-instellingen.js ongemoeid blijft |
| Joost-config-endpoints | [api/joost-config-get.js](api/joost-config-get.js) + [api/joost-config-upsert.js](api/joost-config-upsert.js) — al `?module=` parameter | Module-conditioned RBAC toegevoegd (events → admin.simone_config / events.simone.use) |

## Wijzigingen — server-laag (5 endpoints, default-finance byte-identiek)

| File | Verandering |
|---|---|
| [api/joost-suggestions-recent.js](api/joost-suggestions-recent.js) | `?module=finance\|events` (default finance). Permission per module. WHERE module-filter alleen voor events (finance behoudt pre-fix backwards-compat over legacy rijen). |
| [api/joost-mark-outcome.js](api/joost-mark-outcome.js) | Permission gecheckt **na** suggestion-load op `current.module`: events → `events.simone.use`, anders `finance.joost.use`. Row is autoritatief (anti-spoof). |
| [api/inbox-send.js](api/inbox-send.js) | Coarse upfront-gate: `finance.inbox.send OR events.simone.use`. Refined check na conv-load op `whatsapp_module_config[conv.phone_number_id].module`: events-conv vereist `events.simone.use`, anders `finance.inbox.send`. Outbound-routing via `conv.phone_number_id` (al dankzij multi-line fix #192). |
| [api/joost-config-get.js](api/joost-config-get.js) | Module-param validatie nu vóór permission. Per-module OR-fallback: events → `admin.simone_config` of `events.simone.use`; anders bestaande `admin.joost_config` of `finance.joost.view`. SELECT uitgebreid met `feature_flags`. `buildDefaultConfig` returnt nu `feature_flags: {}`. |
| [api/joost-config-upsert.js](api/joost-config-upsert.js) | Permission per body.module: events → `admin.simone_config`, anders `admin.joost_config`. Nieuwe optionele `feature_flags` (plain object van booleans). SELECT/RETURNING uitgebreid met `feature_flags`. |

## Wijzigingen — frontend events.html (Part B)

| Verandering | Locatie |
|---|---|
| **Fix esc-bug "geen koppeling" als platte HTML** | row-renderer in `loadEventsInbox` — `it.customer_name ? esc(...) : '<i ...>geen koppeling</i>'` |
| Click-handlers op rijen → `openEventsConv({ id, phone, displayName, customer })` | row-renderer |
| Thread-pane (verborgen tot conv geopend) met messages-area + window-badge + back-button + Vraag-Simone-knop + compose-textarea + Versturen-knop | nieuw `<div id="evThreadPane">` |
| `openEventsConv` → GET `/api/inbox-messages-list` + render messages in/out chronologisch | nieuwe JS |
| `loadLatestEventsSuggestion(convId)` → GET `/api/joost-suggestions-recent?module=events` → render in `<div id="evSimoneSuggestionPanel">` | nieuwe JS |
| Suggestion-card: textarea (bewerken inline) + Versturen + Afwijzen | `_renderEvSuggestionPanel` |
| `askSimone()` → POST `/api/simone-suggest` → reload suggestion | nieuwe JS |
| `sendSuggestion(sugg)` → POST `/api/inbox-send` (text via `conv.phone_number_id` → events-lijn) + POST `/api/joost-mark-outcome` (USED_AS_IS of USED_EDITED) | nieuwe JS |
| `dismissSuggestion(sugg)` → POST `/api/joost-mark-outcome` (DISMISSED) | nieuwe JS |
| `sendComposeText()` → vrij bericht via `/api/inbox-send` | nieuwe JS |
| Client-gate: Vraag-Simone-knop disabled als `RBAC.can('events.simone.use') === false` (server-gate is autoritatief) | wiring na render |

## Wijzigingen — frontend admin.html (Part A)

| Verandering | Locatie |
|---|---|
| `admin.simone_config` toegevoegd aan `FEATURE_REGISTRY` (admin-module) | FEATURE_REGISTRY array |
| Tab-knop `Simone-config` (hidden default, gated by `super_admin OR can(admin.simone_config)`) | admin-tabs nav |
| Panel `tab-simone-config` met form: persona-naam, persona-toon, system-prompt template, `is_enabled` toggle, `reactive_suggest_enabled` toggle (geen `e2_reactive_autonomy` — Simone is suggest-only), Opslaan-knop | nieuw panel |
| `switchAdminTab('simone-config')` activeert panel + roept `loadSimoneConfig()` | switch-logic |
| Hash-routing whitelist uitgebreid met `simone-config` | allowedHashes |
| `loadSimoneConfig()` → GET `/api/joost-config-get?module=events`; `renderSimoneConfigForm()` rendert form; `saveSimoneConfig()` → POST `/api/joost-config-upsert` met `module:'events'` + body-fields + `feature_flags` (read-modify-write op flags) | nieuwe JS |
| Dirty-tracking + save-btn disabled tot wijziging | event-handlers |
| Banner-helper (info / success / error) | `_scShowBanner` |

## Finance/Joost byte-identiek-bevestiging

```
git diff modules/finance.html                       → 0 lines
git diff modules/shared/finance-instellingen.js     → 0 lines
git diff modules/shared/agent-shared.js             → 0 lines
```

Server-laag finance byte-identiek:

| Endpoint | Finance-default observable gedrag |
|---|---|
| joost-suggestions-recent | `?module=finance` (default) → permission `finance.joost.use` (unchanged), GEEN extra WHERE module-filter (legacy rijen blijven matchen) — pre-fix gedrag |
| joost-mark-outcome | Suggestion-load + module='finance' (huidige rijen) → permission `finance.joost.use` (unchanged); 403/404/409 codes ongewijzigd |
| inbox-send | Caller met `finance.inbox.send` → coarse upfront-gate passeert; conv.phone_number_id → finance module → refined-gate passeert. 403/422/503 codes ongewijzigd |
| joost-config-get | `?module=finance` (default) → permission `admin.joost_config OR finance.joost.view` (unchanged). Response shape uitgebreid met `feature_flags` (additieve key — finance-UI ignoreert onbekende keys) |
| joost-config-upsert | `body.module='finance'` → permission `admin.joost_config` (unchanged). `feature_flags` is nieuwe optionele body-key (niet meegestuurd door finance-UI) — geen impact |

## Smoke (pre-merge — wat ik nu kan)

- `node --check` op alle 5 gewijzigde server-JS → exit 0 ✅
- Inline-JS in `modules/events.html` + `modules/admin.html` → parse OK via `new Function(...)` ✅
- Vercel preview-build (poll volgt na PR-open) → success verwacht

## Smoke (Chrome-UI, pre-merge — door jou op preview-deploy)

### (i) Events-inbox → open conv 50418ba4… → thread + bestaande PROPOSED-suggestie accc9d15… renderen
1. Login als super_admin op preview-URL.
2. Open `/modules/events.html` → tab "Inbox".
3. Verwacht: lijst met events-conversations (zonder esc-bug-render — "geen koppeling" toont als italic-tag, niet als literal HTML-tekst).
4. Klik rij `50418ba4-…` (jouw test-conv).
5. Verwacht: lijst verdwijnt, thread-pane verschijnt met header (klantnaam/telefoon), 24h-badge, messages chronologisch (in/out), suggestion-panel met PROPOSED `accc9d15-…`.

### (ii) "Vraag Simone" → nieuwe PROPOSED-suggestie
1. Klik "Vraag Simone".
2. Verwacht: knop showt loading state, na 3-10s een nieuwe suggestion-card verschijnt (of de bestaande wordt vervangen door de meest recente).
3. DB: `SELECT id, module, status, auto_triggered, requested_by_user_id FROM joost_suggestions WHERE conversation_id='50418ba4-…' ORDER BY created_at DESC LIMIT 1;` → 1 nieuwe rij, `module='events'`, `status='PROPOSED'`, `auto_triggered=false`, `requested_by_user_id=<jouw-user-id>`.

### (iii) Bewerken + Versturen naar +31655270212 (test events-conv)
1. Pas de tekst in de suggestion-textarea aan (bv. een woord toevoegen).
2. Klik "Versturen".
3. Verwacht:
   - Toast "Aangepast bericht verstuurd"
   - Suggestion-panel leeg
   - Thread herlaadt met je outbound aan de rechterkant
4. DB:
   - `whatsapp_messages` heeft nieuwe outbound rij voor deze conv
   - `joost_suggestions` row status `USED_EDITED`, `final_sent_text` is de aangepaste tekst
5. Telefoon: WhatsApp ontvangt het bericht vanaf de **events-lijn** (1156034510929407), niet finance.

### (iv) Afwijzen
1. Klik "Vraag Simone" voor nieuwe suggestion.
2. Klik "Afwijzen" op die suggestion.
3. Verwacht: toast "Suggestie afgewezen", panel leeg.
4. DB: status `DISMISSED` op de net-aangemaakte rij.

### (v) Admin → Simone-config
1. Open `/modules/admin.html` → tab "Simone-config".
2. Verwacht: form geladen met huidige waarden van `joost_config WHERE module='events'`.
3. Pas persona-naam en system-prompt aan, klik "Opslaan".
4. Verwacht: banner "Opgeslagen" (groen), inputs blijven gevuld.
5. DB: `joost_config` rij bijgewerkt; `audit_log` heeft `joost.config_updated` met `module='events'`.
6. Flip de "reactive_suggest_enabled"-toggle aan, opslaan.
7. **Direct daarna**: flip 'm UIT en opslaan (we willen de productie-default niet veranderen).
8. DB: `feature_flags.reactive_suggest_enabled` is `false`.

### (vi) Finance-inbox + Joost-config ongewijzigd
1. Open `/modules/finance.html` → Wanbetalers → Inbox.
2. Klik bestaande finance-conv.
3. Verwacht: thread, Joost-suggestion-panel, alles werkt zoals voorheen.
4. Klik "Vraag Joost". Verwacht: nieuwe Joost-suggestion (module='finance').
5. Open Finance > Instellingen > Joost-config. Verwacht: form geladen, opslaan werkt zoals voorheen.

## Vereisten voor merge

- [ ] `node --check` op 5 server-files → exit 0 ✅
- [ ] Inline-JS van beide HTML-files parse OK ✅
- [ ] Vercel preview-build groen
- [ ] Smoke (i)-(vi) groen
- [ ] Finance/Joost byte-identiek (`git diff modules/finance.html` 0 lines)
- [ ] Tech-debt-zone (`modules/finance.html`, `modules/shared/finance-views/camtbank.js`) ongemoeid

## Risico's

| Risico | Mitigatie |
|---|---|
| `events.inbox.view` permission ontbreekt voor sales/manager: inbox-messages-list weigert messages laden | Endpoint hardcoded op `finance.inbox.view` — niet aangeraakt in deze PR; users die nu de events-inbox-tab konden zien kunnen ook messages laden (jouw test-user heeft beide). Volledige scheiding = vervolg-PR. |
| Events-conv zonder phone_number_id (legacy) → inbox-send refined check faalt naar finance-default | Default `convModule='finance'` in inbox-send; user moet `finance.inbox.send` hebben. Voor events-only user geeft 403 — verwacht gedrag. Multi-line fix #192 zorgt dat nieuwe events-convs altijd pnId hebben. |
| Backwards-compat joost-suggestions-recent zonder `?module=` | Default 'finance' + skip-eq-filter → byte-identiek t.o.v. pre-stap-2c. |
| `feature_flags` jsonb mismatch finance/events | Server doet partial-merge niet (UI doet read-modify-write); finance-UI stuurt geen feature_flags → upsert raakt kolom niet. |

## Scope-limiet

- Echte WhatsApp test-send naar productie events-lijn (vereist live test).
- Events-inbox-permission `events.inbox.send` (apart van `events.simone.use`) — niet toegevoegd; user spec houdt events.simone.use als gate voor suggestie-acties (incl. versturen).
- Quick-replies / templates voor events.
- Bulk-actions of zoeken op events-conversaties.
