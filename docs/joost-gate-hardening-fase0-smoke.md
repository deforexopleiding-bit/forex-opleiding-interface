# Joost-gate-hardening (Fase 0) — smoke-doc

Branch: `fix/joost-gate-hardening`
PR: open (NIET gemerged)
Base: `87dfd24b…f9757` (= PR #185 squash-commit op main)
Migratie: **n.v.t.**

## Doel

No-regression-foundation **vóór** Simone gebouwd wordt. Maakt het onmogelijk dat Joost reageert op een ongeconfigureerd of niet-finance WhatsApp-nummer.

## Wat veranderd is

1. **`api/_lib/module-context.js`** — `getModuleContextByPhoneNumberId` doet alleen nog een **exacte** `(phone_number_id, is_active=true)` lookup. De silent-failover naar `module='finance'` bij no-match is **verwijderd**. Bij geen match → returnt `null`. SELECT-clause uitgebreid met `is_active` zodat callers kunnen valideren.
2. **`api/inbox-webhook.js`** Joost-trigger gate (regel ~1131): expliciet `if (moduleCtx && moduleCtx.module === 'finance' && moduleCtx.is_active === true)`. Null / unknown / non-finance / inactive → Joost wordt NOOIT getriggerd.
3. **Logging** voor unrouted inbound: `console.warn('[inbox-webhook] inbound van ongekoppeld nummer phone_number_id=… - conversation persisted als unrouted, Joost-trigger geskipt')` — verschijnt in Vercel logs zodra een onbekend nummer binnenkomt.

**Geen wijziging aan persist-flow** — inbound van een onbekend nummer landt zoals altijd in `whatsapp_conversations` (upsert in `inbox-webhook.js:137-219` is module-agnostic). Geen dataverlies; `inbox-conversations-list.js` filtert hardcoded op de finance-phone_number_id, dus unrouted conversaties verschijnen niet in de finance-inbox (correct gedrag — events-inbox komt in Fase 1).

## Caller-audit (alle 4 callers van `getModuleContextByPhoneNumberId`)

| File / regel | Null-veilig? | Behavior-shift voor unconfigured number |
|---|---|---|
| `inbox-send-template.js:319-333` | ✅ — `if (!moduleContext) push warning` | Voorheen kreeg een conv met onbekend phone_number_id finance-afdeling-vars; nu lege strings met warning. Voor finance-WABA-nummer onveranderd (exacte match werkt). |
| `joost-suggest.js:246-247` | ✅ — eigen `?? 'finance'` fallback aanwezig | Auto-trigger pad bereikt joost-suggest nooit meer met een unconfigured-conv (nieuwe gate hierboven). Handmatige "Vraag Joost"-knop is alleen binnen de finance-inbox UI bruikbaar (die filtert hardcoded op finance-phone_number_id), dus conv is per definitie finance-WABA → exact match → moduleCtx OK. Geen regressie. |
| `inbox-webhook.js:1114` | ✅ — gate-hardening hierboven | Zelfde call-site; uitkomst nu strict-gegated. |
| `_lib/dunning-step-executors.js:187` | n.v.t. — code-comment, geen actual call | Geen impact. |

## Scenario 1 — Finance no-regression (KRITISCH)

**Doel:** inbound op de bestaande finance-WABA-lijn → Joost-suggestie verschijnt **exact** zoals vóór deze fix.

**Live-test (Chrome):**
1. Stuur een WhatsApp-bericht (5+ chars, geen trivial-reply, gekoppeld aan een bestaande klant) naar de finance-lijn — bv. `+31655270212`.
2. Wacht ~2-5s.
3. Open Vercel logs voor `inbox-webhook`. Verwacht (alles na elkaar):
   - NIET: `'inbound van ongekoppeld nummer'` (deze warn hoort niet te vuren voor finance-nummer)
   - WEL: succesvolle trigger naar `/api/joost-suggest`
4. Open Finance > Wanbetalers > Inbox → suggestie verschijnt op de conversatie.

**DB-bewijs:**
```sql
SELECT id, conversation_id, module, status, created_at
FROM joost_suggestions
ORDER BY created_at DESC LIMIT 1;
-- verwacht: module='finance', status='PROPOSED', recent.
```

**Regressie-signaal:** als de warn-regel `inbound van ongekoppeld nummer` voor de finance-test-conv verschijnt, of als er **geen** nieuwe joost_suggestions-rij verschijnt voor de finance-conv → STOP, gate is verkeerd geconfigureerd.

## Scenario 2 — Ongeconfigureerd nummer → geen Joost + persisted als unrouted

**Doel:** een inbound bericht op een phone_number_id die **niet** in `whatsapp_module_config` staat triggert geen Joost, maar gaat niet verloren.

**Test-opties** (kies één):

### Optie A — Gesimuleerde webhook payload (lokaal of via curl naar preview)

```bash
# Pak een willekeurige niet-bestaande phone_number_id (niet de finance-pnId).
# Verify-pad: GET met de Meta-verify-token, dan POST met faux payload.

curl -X POST "$BASE_URL/api/inbox-webhook" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=..." \  # zie meta-whatsapp.js verifyWebhookSignature
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "id": "<waba-id>",
      "changes": [{
        "field": "messages",
        "value": {
          "messaging_product": "whatsapp",
          "metadata": { "display_phone_number": "31600000000", "phone_number_id": "999999999999999" },
          "contacts": [{ "profile": { "name": "Test" }, "wa_id": "31611111111" }],
          "messages": [{
            "from": "31611111111",
            "id": "wamid.FAKE_'$(date +%s)'",
            "timestamp": "'$(date +%s)'",
            "type": "text",
            "text": { "body": "Test inbound op ongekoppeld nummer" }
          }]
        }
      }]
    }]
  }'
```

### Optie B — Logisch bewijs via de gate-conditie (geen curl nodig)

Trace door de code:
1. `getModuleContextByPhoneNumberId(supabaseAdmin, '999999999999999')` →
   - SELECT WHERE phone_number_id='999999999999999' AND is_active=true → 0 rijen
   - returns `null` (geen finance-fallback meer)
2. In `inbox-webhook.js:1114-1131`:
   - `moduleCtx = null`
   - `if (!moduleCtx)` → console.warn `inbound van ongekoppeld nummer ...`
   - `isFinanceLijn = !!(null && ... )` → `false`
   - `if (isFinanceLijn)` → skipped
   - **Geen `triggerJoostAutoSuggest`-call gemaakt**
3. Conversation is wel persisted door `upsertConversation` (regel 137-219) want die check geen module.
4. `inbox-conversations-list` filtert op `phone_number_id = financePnId` → unrouted conv niet zichtbaar in finance-inbox.

**Verifieer in DB (na een echte test-inzending):**
```sql
SELECT c.id, c.phone_number, c.phone_number_id, c.last_message_at
FROM whatsapp_conversations c
WHERE c.phone_number_id = '999999999999999';
-- verwacht: 1 rij (de test-conv), persisted ongeacht ongekoppeld
```

```sql
SELECT count(*)
FROM joost_suggestions js
JOIN whatsapp_conversations c ON c.id = js.conversation_id
WHERE c.phone_number_id = '999999999999999';
-- verwacht: 0 (Joost is nooit getriggerd)
```

Vercel logs check:
```
[inbox-webhook] inbound van ongekoppeld nummer phone_number_id=999999999999999 - conversation persisted als unrouted, Joost-trigger geskipt
```

## Wat NIET in deze PR

- Events-inbox UI (Fase 1)
- Events-rij seed in `whatsapp_module_config` (Fase 1; admin doet dat via Afdeling-UI)
- `events.inbox.view` permission (Fase 1)
- Simone-config / simone-suggest endpoint (Fase 2)
- `joost-suggest.js` interne mutaties — uit scope; auto-trigger gate-hardening voldoende voor Fase 0

## Vereisten voor merge

- [ ] Scenario 1 groen — finance-test geeft Joost-suggestie zoals vóór (BYTE-IDENTIEK in observable gedrag)
- [ ] Scenario 2 groen — unrouted phone_number_id triggert geen Joost, conv blijft persisted
- [ ] `node --check api/_lib/module-context.js` → exit 0
- [ ] `node --check api/inbox-webhook.js` → exit 0
- [ ] Tech-debt-zone ongemoeid

## Risico's

| Risico | Mitigatie |
|---|---|
| Een legacy conversation zonder `phone_number_id` zou voorheen via failover finance-context krijgen; nu null | Lookup-pad in `inbox-send-template.js:324` levert `conv.phone_number_id || financePnId || null` — voor finance-conv valt 'ie nog steeds terug op `financePnId` die wel matched. Pas bij echt onbekend nummer leeg. |
| Manual joost-suggest call (Vraag Joost knop) op een non-finance conv | Knop bestaat alleen in finance-inbox UI; UI filtert op finance phone_number_id; conv is per definitie finance-WABA. |
| Een tijdelijke is_active=false op de finance-rij zou Joost stilzetten | Bewust gedrag — als admin de finance-WABA inactive zet wil hij Joost ook uit. |
