# Simone reactieve events-tak — smoke-doc (Fase 2 stap 2b)

Branch: `feat/simone-reactive-events`
Base: `2e1945f2b57657dcc08f29ba6c34aa3a8aedd793` (= PR #192 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.** — feature_flags is bestaande jsonb-kolom (Simone-rij is in stap 2a geseed met `reactive_suggest_enabled=false`).

## Doel

In `api/inbox-webhook.js` een **parallelle events-tak** inpluggen die
`runSimoneSuggest` in-process aanroept naast de bestaande finance/Joost-tak.
Mutually exclusive op `moduleCtx.module`: een events-inbound raakt Joost
nooit, en finance-inbound Simone nooit.

## Wat veranderd is

`api/inbox-webhook.js` (+133 / −13, allemaal additief op de events-laag):

1. **Import**: `runSimoneSuggest` uit `./_lib/simone-suggest-core.js`.
2. **Nieuwe helper `triggerSimoneAutoSuggest()`** direct na `triggerJoostAutoSuggest()`. Zelfde shape:
   - Entry-log: `[inbox-webhook] reactive suggest start module=events conv=Y agent=simone`
   - `waitUntil(runSimoneSuggest(...).then().catch())` zodat de lambda het werk afmaakt ná de 200-response.
   - Done-log: `reactive suggest done id=... module=events conv=... agent=simone intent=...`
   - Skip-log: `reactive suggest skipped: status=N module=events conv=Y agent=simone body=...`
   - Throw-log: `reactive suggest threw module=events conv=Y agent=simone: <msg>`
   - **Geen autonomy-chain** — Simone heeft (nog) geen autonomous-send endpoint.
3. **Nieuwe events-branch** na `if (isFinanceLijn) {...}` (binnen dezelfde `try {}` en zelfde outer `if (insRes.inserted && insRes.messageId && insRes.type === 'text')`):
   - Gate: `moduleCtx.module === 'events' && moduleCtx.is_active === true`
   - Lookup `joost_config WHERE module='events'`
   - Sub-gate: `scfg.is_enabled === true`
   - Sub-gate: `scfg.feature_flags.reactive_suggest_enabled === true`
   - Pre-filters: identiek aan finance-Pad (ii) — body ≥5 chars + niet in `TRIVIAL_REPLIES` + `hasNoRecentOutbound(conv.id, 60)`
   - **Geen customer_id-precondititie** (event-leads zijn prospects; `runSimoneSuggest` matcht zelf phone→`event_attendees`)
   - Wanneer flag UIT: `console.log('[inbox-webhook] reactive suggest skipped (events): reactive_suggest_enabled=false conv=...')`
4. **Comment-block boven `try {}`** herschreven naar agent-routing-narratief (Joost+Simone+null) i.p.v. Joost-only.

## Finance-tak byte-identiek

| Verificatie | Status |
|---|---|
| `git diff` hunks binnen `if (isFinanceLijn) {...}` body | **0 wijzigingen** |
| `triggerJoostAutoSuggest` helper body | ongewijzigd |
| `runJoostSuggest`-aanroep + autonomy-chain | ongewijzigd |
| Joost intake-flow (Pad i) | ongewijzigd |
| Outer `if (insRes.inserted && insRes.messageId && insRes.type === 'text')` | ongewijzigd |
| `moduleCtx`-lookup + unrouted-warn-log | ongewijzigd |

De enige niet-code wijziging in de finance-regio is het **comment-block** boven
`try {}` dat nu Joost+Simone+null beschrijft i.p.v. Joost-only. Geen
gedragsverandering.

## Gate-redenering — events default UIT na merge

Bij merge geldt voor finance-conv (`+31655270212` → finance-pnId `1194351613761790`):
- `moduleCtx.module === 'finance'` → `isFinanceLijn=true`, `isEventsLijn=false`
- Joost-tak runt zoals voorheen
- Events-tak geskipt: `isEventsLijn=false`, geen log (mutually exclusive, geen zorg)

Bij events-inbound op events-conv (events-pnId `1156034510929407`):
- `moduleCtx.module === 'events'` → `isFinanceLijn=false`, `isEventsLijn=true`
- `joost_config(events).is_enabled === true` (seed stap 2a)
- `joost_config(events).feature_flags.reactive_suggest_enabled === false` (seed default)
- → log: `'[inbox-webhook] reactive suggest skipped (events): reactive_suggest_enabled=false conv=<uuid>'`
- → géén `runSimoneSuggest`-aanroep, géén `joost_suggestions`-rij
- Finance/Joost-tak ongemoeid (mutually exclusive)

**Conclusie**: post-merge default-state is identiek aan pre-merge default-state
(behalve dat events-inbound nu een gerichte skip-log produceert i.p.v. niets).
Geen suggesties uitgeschreven tot Jeffrey de flag flipt.

## Pre-merge smoke

| Probe | Verwacht |
|---|---|
| `node --check api/inbox-webhook.js` | exit 0 ✅ |
| Vercel preview-build (commit-status) | success |
| `GET $PREVIEW_URL/api/inbox-webhook` | 401 (Vercel SSO-wall) — bekende limiet voor preview-deploys; build-success is het pre-merge laad-bewijs |

## Post-merge smoke (na jouw flag-flip)

### Stap A — Verifieer default-OFF gedrag (zonder flag te flippen)

1. Stuur events-WhatsApp van een attendee-phone naar events-lijn `1156034510929407`.
2. Vercel logs `inbox-webhook` (prod) verwacht:
   - `[inbox-webhook] reactive suggest skipped (events): reactive_suggest_enabled=false conv=<uuid>`
   - `[inbox-webhook] POST processed {...msgs_new:1...}`
   - NIET: `reactive suggest start ... agent=simone` (gate dichthouden)
3. SQL: `SELECT count(*) FROM joost_suggestions WHERE module='events' AND created_at > now() - interval '5 minutes';` → 0

### Stap B — Flip events-flag AAN, test, flip UIT

```sql
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', true)
WHERE module = 'events'
RETURNING module, feature_flags;
```

1. Tweede events-inbound vanaf gekoppelde attendee.
2. Vercel logs verwacht:
   - `reactive suggest start module=events conv=<uuid> agent=simone`
   - 10-15s later: `reactive suggest done id=<sugg-uuid> module=events conv=<uuid> agent=simone intent=<...>`
3. SQL: `SELECT id, module, status, auto_triggered, detected_intent FROM joost_suggestions WHERE module='events' ORDER BY created_at DESC LIMIT 1;`
   → 1 nieuwe rij met `module='events'`, `auto_triggered=true`, `status='PROPOSED'`.

Direct flag UIT na bewijs:
```sql
UPDATE joost_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('reactive_suggest_enabled', false)
WHERE module = 'events';
```

### Stap C — Bevestig finance ongemoeid

1. Finance-inbound vanaf `+31655270212` naar finance-lijn `1194351613761790`.
2. Vercel logs verwacht: exact zelfde patroon als pre-merge — geen extra events-logs verschijnen voor de finance-conv.
3. SQL: `SELECT count(*) FROM joost_suggestions WHERE module='events' AND conversation_id=(SELECT id FROM whatsapp_conversations WHERE phone_number_id='1194351613761790' AND phone_number='+31655270212');` → 0 (events nooit voor finance-conv).

## Vereisten voor merge

- [ ] `node --check api/inbox-webhook.js` → exit 0
- [ ] Vercel preview-build → success
- [ ] Finance-tak byte-identiek (zie sectie hierboven)
- [ ] Tech-debt-zone (`modules/finance.html`, `modules/shared/finance-views/camtbank.js`) ongemoeid

## Risico's

| Risico | Mitigatie |
|---|---|
| Events-tak triggert per ongeluk Joost door fout in gate | Mutually exclusive via `moduleCtx.module === 'finance'` XOR `=== 'events'`; één moduleCtx kan niet beide zijn. Bij module=null → unrouted, beide false. |
| Per-inbound DB-overhead door 2e `joost_config`-lookup | Niet relevant: `isFinanceLijn` en `isEventsLijn` zijn mutually exclusive, slechts één tak doet de lookup per inbound. |
| `runSimoneSuggest` faalt op missende ANTHROPIC_API_KEY | 503-status uit core; trigger-helper logt `skipped: status=503 ... agent=simone` zichtbaar; geen webhook-crash (waitUntil-catch). |
| Echte events-attendee niet gevonden door phone-mismatch | `runSimoneSuggest` valt elegant terug op general-purpose events-assistant; CTX-block vermeldt expliciet "GEEN attendee-match" (stap 2a no-match-flow). |

## Scope-limiet

- Events-inbox UI met "Vraag Simone"-knop (= Fase 2 stap 3 / 2c).
- Simone autonomous-send endpoint (Fase 3, niet eens in roadmap).
- Verbinden van Joost-mandate / E2.1-autonomy aan Simone — Simone is voorlopig draft-only.
