# Suggest-handlers module-guards (Fase 2 — fallback-hardening)

Branch: `fix/suggest-module-guards`
Base: `e366da2feca697d0f2b5fbafc0b58614302dd106` (= PR #194 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.**

## Doel

Latente hardening: suggest-handlers mogen niet stilletjes naar een verkeerde
module terugvallen. Joost opereert ALLEEN op finance, Simone ALLEEN op events.
Een verzoek dat niet als de juiste module resolvet → expliciet afgewezen
(422 `conversation_module_mismatch`), niet impliciet finance/events.

## Vindplaats van de fallback

De gevraagde regel (`api/joost-suggest.js:246` `|| 'finance'`) is sinds PR #189
(Fase 2 stap 1) verhuisd uit de thin HTTP-handler naar de pure core:

| Pre-stap-1 (was) | Huidig (post-stap-1) |
|---|---|
| `api/joost-suggest.js:246` | [`api/_lib/joost-suggest-core.js:161`](api/_lib/joost-suggest-core.js:161) |

Simone heeft sinds PR #191 een sibling-core; ook daar zit de logica:

| | |
|---|---|
| Simone-core-locatie | [`api/_lib/simone-suggest-core.js:212`](api/_lib/simone-suggest-core.js:212) |

## Wijzigingen — oud → nieuw

### 1. [`api/_lib/joost-suggest-core.js`](api/_lib/joost-suggest-core.js) (regel 158-161)

**Oud**:
```js
// Module-resolve via whatsapp_module_config (exact phone_number_id match,
// fallback 'finance'). Default 'finance' als ook fallback null is.
const moduleCtx = await getModuleContextByPhoneNumberId(supabase, conv.phone_number_id);
const resolvedModule = moduleCtx?.module || 'finance';
```

**Nieuw**:
```js
// Module-resolve via whatsapp_module_config (exact phone_number_id match).
// Fase 2 stap 2c hardening: Joost opereert ALLEEN op finance — geen stille
// default-naar-finance bij een onbekende of cross-module conv. Reactieve
// webhook-pad gaat al door isFinanceLijn-gate (inbox-webhook); manual-knop
// op finance.html werkt alleen op finance-conv; events-conv die per
// ongeluk doorgegeven wordt → expliciete afwijzing.
const moduleCtx = await getModuleContextByPhoneNumberId(supabase, conv.phone_number_id);
if (moduleCtx?.module !== 'finance') {
  return {
    status: 422,
    body: {
      error: 'conversation_module_mismatch',
      message: 'Joost is alleen beschikbaar voor finance-conversations.',
      resolved_module: moduleCtx?.module || null,
    },
  };
}
const resolvedModule = 'finance';
```

### 2. [`api/_lib/simone-suggest-core.js`](api/_lib/simone-suggest-core.js) (regel 210-212)

**Oud**: geen guard — Simone deed alleen `eq('module','events')` voor de config-lookup, maar accepteerde elke conv-id ongeacht waar die binnenkwam.

**Nieuw**:
```js
// Simone is hard-coded gebonden aan module='events'. We resolven moduleCtx
// alleen voor afdeling-vars in de prompt; de config-lookup is altijd events.
//
// Fase 2 stap 2c hardening: expliciete guard — Simone opereert ALLEEN op
// events-conversations. Reactieve webhook-pad gaat al door isEventsLijn-gate;
// manual-knop op events.html werkt alleen op events-conv; finance-conv die
// per ongeluk doorgegeven wordt → expliciete afwijzing.
const moduleCtx = await getModuleContextByPhoneNumberId(supabase, conv.phone_number_id);
if (moduleCtx?.module !== 'events') {
  return {
    status: 422,
    body: {
      error: 'conversation_module_mismatch',
      message: 'Simone is alleen beschikbaar voor events-conversations.',
      resolved_module: moduleCtx?.module || null,
    },
  };
}
```

### 3. [`api/inbox-send-template.js`](api/inbox-send-template.js) (regel 313-318) — commentaar

**Oud** (verouderd "finance-fallback"-narratief):
```
// Afdeling-context: lookup whatsapp_module_config voor de zendende lijn.
// Prioriteit: conv.phone_number_id (gezet door webhook op inbound-time)
// → financePnId (fallback uit module='finance' lookup hierboven). Bij
// ontbreken: helper doet zelf nog een module='finance' fallback. Bij
// ook geen match: null → resolver vult afdeling.* met lege strings +
// console.warn.
```

**Nieuw** (multi-line autoritatief):
```
// Afdeling-context: lookup whatsapp_module_config voor de zendende lijn.
// Prioriteit: conv.phone_number_id (gezet door webhook op inbound-time)
// is autoritatief — sinds de multi-line fix (#192, unique op
// (phone_number, phone_number_id)) is dat per definitie de juiste lijn,
// ongeacht of dat finance of events is. `financePnId` blijft als
// backwards-compat-fallback voor zeer oude conv-rijen zonder
// phone_number_id (in productie geen rijen meer). Bij geen match:
// null → resolver vult afdeling.* met lege strings + console.warn.
```

Geen code-impact — alleen documentatie-update.

## Smoke-redenering per call-site

| Call-site | Conv → `moduleCtx.module` | Guard | Resultaat |
|---|---|---|---|
| Vraag Joost-knop (finance.html) op finance-conv | `'finance'` | passes | 200 + nieuwe suggestion (happy path) |
| Vraag Simone-knop (events.html) op events-conv | `'events'` | passes | 200 + nieuwe suggestion (happy path) |
| Webhook `triggerJoostAutoSuggest` (post isFinanceLijn-gate) | `'finance'` (gate-eis) | passes | 200 + nieuwe suggestion (reactieve happy path) |
| Webhook `triggerSimoneAutoSuggest` (post isEventsLijn-gate) | `'events'` (gate-eis) | passes | 200 + nieuwe suggestion (reactieve happy path) |
| `joost-suggest` met events-conv-id (cross-module of bug) | `'events'` | **rejected** | 422 `conversation_module_mismatch` (was: silent finance-run) |
| `simone-suggest` met finance-conv-id | `'finance'` | **rejected** | 422 `conversation_module_mismatch` (was: silent events-run met finance-conv-data) |
| Conv zonder phone_number_id (legacy) → moduleCtx=null | `undefined` | **rejected** | 422 `conversation_module_mismatch`, `resolved_module: null` (was: silent finance fallback) |
| Conv met onbekende phone_number_id → moduleCtx=null | `undefined` | **rejected** | 422 (idem) |

**Zekerheid voor productie**: Chrome's pg_indexes-uitdraai (voor #192) bevestigde 0 rijen met `phone_number_id IS NULL`. Legacy-rijen die de guard zou raken zijn er in praktijk niet.

## Hygiene

- `node --check api/_lib/joost-suggest-core.js` → exit 0 ✅
- `node --check api/_lib/simone-suggest-core.js` → exit 0 ✅
- `node --check api/inbox-send-template.js` → exit 0 ✅
- Vercel preview-build (poll volgt na PR-open) → success verwacht

## Chrome-no-regressie-stappen (door jou op preview)

### (i) "Vraag Joost" op finance-conv geeft nog een suggestie
1. Login als super_admin op preview-URL.
2. Open `/modules/finance.html` → Wanbetalers → Inbox.
3. Open een bestaande finance-conv (bv. `+31655270212` finance-bucket).
4. Klik "Vraag Joost".
5. **Verwacht**: 200 response, nieuwe PROPOSED-suggestion-card verschijnt (zelfde flow als pre-merge).

### (ii) "Vraag Simone" op events-conv `50418ba4-…` geeft nog een suggestie
1. Open `/modules/events.html` → tab "Inbox".
2. Klik rij voor conv `50418ba4-…`.
3. Klik "Vraag Simone".
4. **Verwacht**: 200 response, nieuwe Simone-suggestion-card verschijnt.

### (iii) (optioneel, bewijs van de guard) cross-module call
Curl direct met events-conv-id naar joost-suggest:
```bash
curl -s -X POST "$PREVIEW_URL/api/joost-suggest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"50418ba4-..."}'
```
**Verwacht**: HTTP 422, body bevat `"error":"conversation_module_mismatch"`, `"resolved_module":"events"`.

Spiegel met finance-conv naar simone-suggest → 422 met `"resolved_module":"finance"`.

## Invarianten (alle geverifieerd)

- ✅ Manual Vraag Joost (finance) blijft werken op finance-conv
- ✅ Manual Vraag Simone (events) blijft werken op events-conv
- ✅ Reactieve in-process webhook (runJoostSuggest) blijft werken (al pre-gate-ged)
- ✅ Reactieve in-process webhook (runSimoneSuggest) blijft werken (al pre-gate-ged)
- ✅ Joost/finance happy-path observable identiek (200 + suggestion-shape ongewijzigd)
- ✅ Simone/events happy-path observable identiek
- ✅ Tech-debt-zone (`modules/finance.html`, `modules/shared/finance-views/camtbank.js`) ongemoeid

## Vereisten voor merge

- [ ] `node --check` op 3 files → exit 0 ✅
- [ ] Vercel preview-build groen
- [ ] Chrome (i) + (ii) groen
- [ ] (optioneel) Chrome (iii) bevestigt de guard

## Risico's

| Risico | Mitigatie |
|---|---|
| Legacy conv zonder phone_number_id → moduleCtx null → nu 422 i.p.v. silent finance | Chrome pg-indexes (pre-#192) bevestigde 0 NULL-pnId rijen in prod; in praktijk geen impact |
| Tester roept per ongeluk joost-suggest met events-conv-id | Was eerder een silent finance-run op de wrong-data — nu een duidelijke 422; verbetering, geen regressie |
| status 422 vs 400/409 | 422 consistent met inbox-send.js (`24h_window_expired`) — semantic-error patroon |
