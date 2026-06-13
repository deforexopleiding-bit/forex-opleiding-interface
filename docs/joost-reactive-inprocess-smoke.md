# Joost reactive in-process refactor (Fase 2 stap 1) — smoke-doc

Branch: `fix/joost-reactive-inprocess`
Base: `7661157b…d19b6f` (= PR #187 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.** — `joost_config.feature_flags` is bestaande jsonb-kolom.

## Doel

Reactieve self-call vanuit inbox-webhook naar `/api/joost-suggest` (HTTP `fetch`
via `VERCEL_URL`) vervangen door een **in-process call** van de suggest-logica.
Dat lost de structurele `TypeError: fetch failed` op prod op (Vercel Deployment
Protection / cold-start DNS-race; self-HTTP-calls op Node-runtime zijn een
gedocumenteerd anti-pattern).

Tegelijk: een **per-module gate** toevoegen (`feature_flags.reactive_suggest_enabled`)
zodat reactieve drafts per module aan/uit gezet kunnen worden — default UIT op
finance zodat observable gedrag onveranderd blijft, en straks aan op events
(Simone, Fase 2+).

## Wat veranderd is

### Nieuwe file

- **`api/_lib/joost-suggest-core.js`** — pure functie `runJoostSuggest({
  supabase, conversationId, triggeredByMessageId, autoTriggered,
  requestedByUserId, clientIp })` met **alle** suggest-logica (rate-limit,
  conv-lookup, module-resolve, joost_config, context-build, system-prompt,
  Anthropic-call, save, audit-log). Returnt `{ status, body }` zodat de
  caller alleen `res.status().json()` of een log-regel hoeft te doen.

### Gewijzigde files

- **`api/joost-suggest.js`** — geslankt naar thin HTTP-handler. Doet auth
  (X-Internal-Token of Bearer-JWT + `finance.joost.use`), body-parse,
  UUID-validatie, en delegeert naar `runJoostSuggest`. **Observable
  HTTP-gedrag byte-identiek** voor de handmatige "Vraag Joost"-knop: zelfde
  status-codes, zelfde response-shape, zelfde error-mapping, zelfde
  RBAC-policy, zelfde audit-rij. Lengte: 836 → 113 regels.
- **`api/inbox-webhook.js`** — `triggerJoostAutoSuggest()` doet nu een
  in-process `runJoostSuggest(...)` call i.p.v. `fetch(\`${VERCEL_URL}/api/joost-suggest\`)`.
  Fire-and-forget patroon BLIJFT (`.then().catch()` niet awaited). Per-module
  gate `flags.reactive_suggest_enabled` ingebouwd vóór de trigger-call —
  default UIT op finance dus auto-suggest vuurt niet vanzelf.

## Per-module gate

**Locatie**: `joost_config.feature_flags.reactive_suggest_enabled` (boolean, default `false`/absent).

**Check**: [api/inbox-webhook.js:~1175](api/inbox-webhook.js:1175) — vóór alle
auto-suggest filters (text-length / trivial / anti-loop) en vóór de
`triggerJoostAutoSuggest`-call:

```js
const reactiveEnabled = flags.reactive_suggest_enabled === true;
if (reactiveEnabled) { /* ... bestaande filters + trigger ... */ }
```

**Defaults**:

| Module | `reactive_suggest_enabled` | Gedrag |
|---|---|---|
| finance (nu) | absent → `false` | Geen reactieve suggesties — observable identiek aan pre-PR (waar "fetch failed" elke trigger blokte) |
| events (Simone, Fase 2+) | wordt op `true` gezet zodra Simone live moet | Reactieve drafts vuren in-process |

**Aanzetten / uitzetten** (super_admin SQL, geen UI in deze PR):

```sql
-- AAN voor finance (post-merge smoke):
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', true)
WHERE module = 'finance';

-- UIT voor finance (na smoke):
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', false)
WHERE module = 'finance';
```

## Scope-limiet — E2.1 autonomous chain blijft HTTP self-call

De **tweede** self-call (`/api/joost-send-autonomous`, alleen actief als
`e2_reactive_autonomy=true`) blijft in deze PR een HTTP self-call met
`VERCEL_URL` + `X-Internal-Token`. Reden:
- `e2_reactive_autonomy` is default UIT op finance — chain vuurt niet.
- Converteren vereist extractie van joost-send-autonomous core → scope-creep voor Fase 2 stap 1.
- Wordt opgepakt in Fase 2 stap 2 (zelfde refactor-patroon).

Bij aanzetten van `e2_reactive_autonomy` op prod krijg je dezelfde
`fetch failed`-warning als voorheen. Bewust geaccepteerd voor deze PR;
**niet** flippen tot stap 2 live is.

## Scenario 1 — PRE-MERGE preview-build (handmatige knop, regressie-check)

**Doel**: bewijzen dat de HTTP-route byte-identiek werkt na de extract → handmatige
"Vraag Joost"-knop in finance-inbox UI produceert nog steeds een suggestie zoals
voorheen.

**Stappen** (Claude in Chrome op de preview-URL):

1. Login als super_admin.
2. Open `/modules/finance.html` → Wanbetalers → Inbox.
3. Selecteer een bestaande conversation van een gekoppelde klant met openstaande facturen.
4. Klik op "Vraag Joost" / suggest-knop in het compose-panel.
5. Verwacht: binnen ~3-5s verschijnt een nieuwe PROPOSED-suggestie-card.

**DB-bewijs**:
```sql
SELECT id, conversation_id, module, status, auto_triggered, requested_by_user_id, created_at
FROM joost_suggestions
WHERE conversation_id = '<test-conv-uuid>'
ORDER BY created_at DESC LIMIT 1;
-- verwacht: status='PROPOSED', auto_triggered=false (handmatig),
--           requested_by_user_id=<jouw-user-id>, recent.
```

**Regressie-signaal**: 502/503/lege card → HTTP-route is gebroken door de
refactor. STOP, niet mergen.

**Webhook moet NIET vuren op preview**: omdat Meta webhook-URL alleen naar prod
wijst (vercel.json crons + Meta config), zal `inbox-webhook.js` op preview niet
geraakt worden door een inbound. Daarom is dit scenario "alleen handmatige knop".

## Scenario 2 — POST-MERGE prod (reactieve self-call-fix bewijs)

**Doel**: bewijzen dat na merge een inbound WhatsApp op de finance-lijn de
in-process suggest triggert (geen `fetch failed` meer).

### Stap A — Flag tijdelijk AAN

```sql
-- Voer uit in Supabase SQL editor (Jeffrey klikt Run, na bevestiging):
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', true)
WHERE module = 'finance'
RETURNING module, feature_flags;
-- verwacht: 1 rij, feature_flags bevat "reactive_suggest_enabled": true.
```

### Stap B — Live test-inbound

1. Stuur een WhatsApp (text, ≥5 chars, niet-trivial) naar de finance-lijn
   `+31655270212` vanaf een telefoonnummer dat gekoppeld is aan een bestaande klant.
2. Wacht ~5-10s.
3. Open Vercel logs voor `inbox-webhook` (prod). Verwachte log-volgorde:
   - NIET: `joost auto-trigger fetch fail: fetch failed` (oude regel, mag niet meer)
   - NIET: `joost in-process suggest threw: ...` (zou wijzen op DB/Anthropic-fout)
   - NIET: `joost in-process suggest status=502/503/...` (zou wijzen op Anthropic/config-fout)
   - WEL: `[inbox-webhook] POST processed {...msgs_new:1...}` (normale finish)
4. Open Finance > Wanbetalers > Inbox → nieuwe PROPOSED-suggestie verschijnt op
   de conversation (auto-triggered card met "Joost auto-gesuggereerd"-badge).

**DB-bewijs**:
```sql
SELECT id, conversation_id, module, status, auto_triggered, requested_by_user_id, created_at
FROM joost_suggestions
WHERE conversation_id = (
  SELECT id FROM whatsapp_conversations
  WHERE phone_number LIKE '%<laatste-6-digits-test-nummer>%'
  ORDER BY last_message_at DESC LIMIT 1
)
ORDER BY created_at DESC LIMIT 1;
-- verwacht: status='PROPOSED', auto_triggered=true, requested_by_user_id=NULL,
--           created_at binnen 30s van inbound.
```

### Stap C — Flag direct weer UIT

```sql
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', false)
WHERE module = 'finance'
RETURNING module, feature_flags;
-- verwacht: 1 rij, feature_flags bevat "reactive_suggest_enabled": false.
```

Vanaf nu: geen nieuwe auto-suggesties op finance — observable gedrag = pre-PR.

## Vereisten voor merge

- [ ] Scenario 1 groen (PRE-MERGE preview) — handmatige knop produceert
      suggestion-card, DB-rij correct (auto_triggered=false).
- [ ] `node --check api/_lib/joost-suggest-core.js` → exit 0
- [ ] `node --check api/joost-suggest.js` → exit 0
- [ ] `node --check api/inbox-webhook.js` → exit 0
- [ ] Geen wijziging in observable HTTP-gedrag van `/api/joost-suggest`
      (status-codes + response-shape identiek)
- [ ] Tech-debt-zone (`modules/finance.html`, `modules/shared/finance-views/camtbank.js`) ongemoeid

## Risico's

| Risico | Mitigatie |
|---|---|
| Extract-regressie: subtle gedrag-shift in core vs oude handler | Pure extract — alle 8 stappen 1-op-1 overgenomen, geen logica-wijziging. Body-parse + UUID-validatie blijft in handler. |
| RBAC-bypass via INTERNAL_API_TOKEN niet meer nodig vanuit webhook | Token-pad blijft beschikbaar in handler voor toekomstige service-to-service callers. Niet gebruikt vanuit webhook na deze PR. |
| Webhook latency-impact door synchrone in-process call | Fire-and-forget BLIJFT (`.then().catch()` niet awaited). Webhook returnt 200 OK aan Meta zoals voorheen. In-process call zelfs sneller dan HTTP-hop. |
| Per-module gate uit-zetten voor finance levert "geen suggesties" op | Observable identiek aan huidige `fetch failed`-toestand: pre-PR vuurt joost-suggest ook nooit succesvol op finance. Geen functionaliteit-verlies. |
| Autonomy chain (e2_reactive_autonomy=true) blijft HTTP self-call | Gated OFF default; documenteer voor Fase 2 stap 2. Niet flippen op prod tot stap 2 live is. |

## Wat NIET in deze PR

- Conversie van `/api/joost-send-autonomous` self-call (Fase 2 stap 2).
- Simone-config / simone-suggest endpoint (Fase 2+).
- Events-rij in `joost_config` (kan straks via admin-UI of SQL).
- Admin-UI voor `reactive_suggest_enabled` (volstaat met SQL-toggle voor MVP).
- Wijziging aan `triggerJoostAutoSuggest`'s naam of locatie (refactor-friendly hold).
