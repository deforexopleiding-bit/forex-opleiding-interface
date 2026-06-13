# Joost reactive waitUntil() — smoke-doc (Fase 2 stap 1b)

Branch: `fix/joost-reactive-waituntil`
Base: `1d33ea478d39fbc8d646511cca998ffc36e9f8c5` (= PR #189 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.**

## Doel

Stap 1 (PR #189) ruilde HTTP-self-call voor in-process `runJoostSuggest`. Op
prod: webhook returnde 200 schoon, geen `fetch failed`, MAAR 0
`joost_suggestions`-rij. Oorzaak: een unawaited `.then().catch()` overleeft
het einde van de HTTP-respons NIET op Vercel Node-runtime — de lambda
freezed direct ná `res.status(200).json(...)`. De Anthropic-call (~3-5s) +
insert raakten halverwege bevroren.

Fix: `waitUntil()` uit `@vercel/functions` registreert de promise als
"background work" zodat de runtime de lambda LEVEND houdt tot het werk
klaar is (binnen function-maxDuration; Pro = 60s default).

## Wat veranderd is

### Nieuwe dependency

- **`@vercel/functions ^3.7.1`** — `package.json` + `package-lock.json`.
  Exports `waitUntil(promise: Promise<unknown>): void`. Supported in zowel
  Edge als Node runtime. Geen runtime-config-wijziging nodig.

### Gewijzigde file

- **`api/inbox-webhook.js`** — `triggerJoostAutoSuggest()`:
  - Import `waitUntil` toegevoegd.
  - `runJoostSuggest(...).then(...).catch(...)` gewrapt in `waitUntil(...)`.
  - Entry-log (`reactive suggest start ...`) vóór de waitUntil-call zodat
    we WETEN dat de gate gepasseerd is, ook als het achtergrondwerk later
    faalt.
  - Done-log (`reactive suggest done id=... module=... intent=...`) na
    succesvolle suggestion-insert.
  - Skip-logs met expliciete reden (`status=...`, `geen suggestion.id`,
    `INTERNAL_API_TOKEN ontbreekt`).
  - Error-log (`reactive suggest threw ...`) bij ongevangen rejection.
  - Nieuwe `module`-arg doorgegeven vanuit call-site voor lees-baar
    log-grep per module (finance/events).

## waitUntil-mechaniek

```js
import { waitUntil } from '@vercel/functions';

waitUntil(
  runJoostSuggest({ ... })
    .then((result) => { /* log done / skip */ })
    .catch((e)     => { /* log threw */ })
);
// Lambda blijft alive tot bovenstaande promise resolve/reject, óók ná
// res.status(200).json(...). Caller awaited niet — Meta-response is direct.
```

**Verified beschikbaar**:
```bash
node -e "import('@vercel/functions').then(m => console.log(Object.keys(m).filter(k => /wait/i.test(k))))"
# → ['waitUntil']
```

**Runtime-context**: Vercel Node 20 runtime (per `package.json` `engines.node >=20`).
Geen runtime-config-override in `vercel.json` voor `inbox-webhook`. Pro-plan
default maxDuration = 60s — ruim voor LLM-call (~3-5s) + insert.

## Scope-limiet (ongewijzigd t.o.v. stap 1)

- E2.1 autonomous chain (`/api/joost-send-autonomous`) blijft HTTP self-call.
  Gated OFF default (`e2_reactive_autonomy=false`); zit nu WEL binnen de
  waitUntil-scope zodat tenminste de poging overleeft. Conversie naar
  in-process in Fase 2 stap 2.
- HTTP-route `/api/joost-suggest` ongewijzigd (handmatige "Vraag Joost"-knop).
- Per-module gate `feature_flags.reactive_suggest_enabled` blijft default UIT
  op finance — observable identiek aan stap 1.

## Scenario 1 — PRE-MERGE preview (handmatige knop regressie-check)

**Doel**: bewijzen dat de HTTP-route nog steeds werkt. (We raken die niet aan,
maar `@vercel/functions` als nieuwe dep mag ook geen breakage geven bij build.)

1. Vercel-build moet groen zijn (preview deploy success).
2. Login als super_admin op preview-URL.
3. Open `/modules/finance.html` → Wanbetalers → Inbox.
4. Selecteer bestaande conversation met gekoppelde klant.
5. Klik "Vraag Joost"-knop in compose-panel.
6. Verwacht: nieuwe PROPOSED-suggestion-card binnen 3-5s.

**Regressie-signaal**: 5xx response, lege card, of suggest-knop reageert niet
→ build of HTTP-route gebroken. STOP, niet mergen.

## Scenario 2 — POST-MERGE prod (waitUntil-bewijs)

**Doel**: bewijzen dat na merge een inbound WhatsApp op finance-lijn een
volledige suggestion-rij oplevert (LLM-call + insert voltooid).

### Stap A — Flag tijdelijk AAN

```sql
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', true)
WHERE module = 'finance'
RETURNING module, feature_flags;
```

### Stap B — Live test-inbound

1. WhatsApp (text, ≥5 chars, niet-trivial) naar finance-lijn `+31655270212`
   vanaf telefoonnummer dat aan klant gekoppeld is (`whatsapp_conversations.
   customer_id IS NOT NULL`).
2. Wacht ~10-15s (LLM-call + insert).
3. Open Vercel logs voor `inbox-webhook` (prod). Verwachte log-volgorde:
   ```
   [inbox-webhook] reactive suggest start module=finance conv=<uuid> autonomy=off
   [inbox-webhook] POST processed {...msgs_new:1...}
   ... (10-15s later, ná de 200-respons, dankzij waitUntil) ...
   [inbox-webhook] reactive suggest done id=<sugg-uuid> module=finance conv=<uuid> intent=<...>
   ```
4. Open Finance > Wanbetalers > Inbox → nieuwe PROPOSED-card op de
   conversation (auto-triggered, "Joost auto-gesuggereerd"-badge).

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
```

## Diagnose-matrix voor de log-regels

| Log-regel | Betekenis |
|---|---|
| `reactive suggest start module=X conv=Y autonomy=on\|off` | Gate gepasseerd; runJoostSuggest is geregistreerd in waitUntil |
| `reactive suggest done id=X module=Y conv=Z intent=W` | Volledige succes: LLM-call + insert klaar, suggestion zichtbaar in UI |
| `reactive suggest skipped: status=N body=...` | runJoostSuggest returnde non-200 (429 rate-limit / 404 conv / 503 disabled / 502 Anthropic) — body laat zien wat |
| `reactive suggest skipped autonomy chain: geen suggestion.id` | Mag eigenlijk niet gebeuren (200 zonder id) |
| `reactive suggest threw module=X conv=Y: <msg>` | Onverwachte fout (DB-fail, etc.) — exception-message in log |

Bij stilte vóór `start`: een precondition (text-length / trivial / anti-loop /
gate-flag / klant-koppeling) heeft gefaald — zie gating-trace in stap 1 docs.

Bij `start` zonder `done` of `skipped` of `threw` (en geen 5xx in Vercel logs):
waitUntil heeft het werk niet voltooid — hoogst onwaarschijnlijk maar zou
wijzen op runtime-limiet (maxDuration-overschrijding) of @vercel/functions
incompatibiliteit. Acceptiecriterium: `done` of `skipped` of `threw` MOET
binnen 60s na `start` verschijnen.

## Vereisten voor merge

- [ ] Scenario 1 groen (PRE-MERGE preview) — handmatige knop produceert
      suggestion (regressie-test op nieuwe dependency).
- [ ] `node --check api/inbox-webhook.js` → exit 0
- [ ] Vercel preview-build groen.
- [ ] Geen wijziging in HTTP-route `/api/joost-suggest` (alleen
      inbox-webhook + package.json + lockfile + smoke-doc).
- [ ] Tech-debt-zone ongemoeid.

## Risico's

| Risico | Mitigatie |
|---|---|
| `@vercel/functions` niet beschikbaar in deze runtime-versie | Pre-verified via `node -e "import('@vercel/functions').then(...)"` → exports `waitUntil`. Pakket support Node ≥18. Onze runtime is Node 20. |
| Lambda crash door waitUntil maxDuration-overschrijding | Anthropic-call ~3-5s + insert ~200ms = ruim binnen Pro 60s default. Geen retry-loop in core, geen tail-risk. |
| Build-failure door nieuwe dependency | Smoke Scenario 1 verifieert build + handmatige knop. Bij rood: package.json/lockfile rollbacken, niet mergen. |
| Andere endpoints die ook self-call doen krijgen dit voordeel niet | Out-of-scope. E2.1 autonomous chain blijft self-call binnen waitUntil-scope (tenminste niet verloren). Volledige conversie in Fase 2 stap 2. |

## Wat NIET in deze PR

- Conversie van `/api/joost-send-autonomous` self-call naar in-process (Fase 2 stap 2).
- maxDuration-config voor `inbox-webhook` in `vercel.json` (default 60s is voldoende).
- Simone / events-module enablement (Fase 2+).
- Admin-UI voor `reactive_suggest_enabled` (volstaat met SQL-toggle).
