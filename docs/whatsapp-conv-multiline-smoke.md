# WhatsApp multi-nummer conversatie-fix — smoke-doc

Branch: `fix/whatsapp-conv-multiline`
Base: `2126b67bbf4ad2bd42c608c42e038f0c980b920f` (= PR #191 squash-commit op main)
PR: open (NIET gemerged — wachten op DB-constraint-swap)

## Doel

Multi-line correctness voor `whatsapp_conversations`: dezelfde afzender op
twee bedrijfsnummers (finance + events) krijgt nu **aparte** conversations
i.p.v. één gedeelde rij. Voorheen werd events-inbound voor `+31655270212`
geappended op de bestaande finance-conv vanwege phone-only matching in
`upsertConversation`.

## Wat veranderd is

### Gewijzigd

- **`api/inbox-webhook.js`** — `upsertConversation()`:
  1. **SELECT** is nu lijn-specifiek (tuple `(phone_number, phone_number_id)`).
     Bij `phoneNumberId` aanwezig: `.eq('phone_number', X).eq('phone_number_id', Y).maybeSingle()`.
     Bij `phoneNumberId` null/leeg (ongebruikelijk): phone-only fallback met
     `.order('created_at', { ascending: true }).limit(1)` + warn-log
     "upsertConversation: geen pnId, phone-only fallback voor <phone>".
  2. **CREATE** ongewijzigd — stamp `phone_number_id = phoneNumberId || null`
     blijft (regel ~223).
  3. **Sticky-preserve-guard** vervangen door **veilige heal**: alleen
     `phone_number_id` zetten als de gematchte rij hem nog niet had (legacy /
     phone-only-fallback-create). Comment bijgewerkt: geen "eerste lijn
     leidend" meer — tuple-SELECT garandeert al lijn-specificiteit.
  4. **Race-condition re-select** (23505) consistent gemaakt met de nieuwe
     match-strategie: tuple bij `phoneNumberId`, phone-only-fallback anders.
     Voorkomt `.maybeSingle()`-explosie post-migratie wanneer meerdere rijen
     met dezelfde phone bestaan.

### Geen wijziging

- CREATE-payload (`insertPayload`).
- Caller-signature (positional args, return-shape `{ id, created, customerId }`).
- Outbound / template / status / Joost-flows (regel 1192 e.v.).
- Customer-match (`findCustomerByPhone`) ongewijzigd.

## Caller-audit (alle callers van `upsertConversation`)

| File / regel | Phase | phoneNumberId-bron | Pre-fix-gedrag | Post-fix-gedrag |
|---|---|---|---|---|
| [`api/inbox-webhook.js:1114`](api/inbox-webhook.js:1114) | inbound message-handler | `recvPhoneNumberId` uit `entry[].changes[].value.metadata.phone_number_id` (regel 1090-1092) | events-inbound landt op bestaande finance-conv (shared-row bug) | events-inbound krijgt eigen events-conv naast bestaande finance-conv |

**Grand-total**: 1 caller. De flow rond regel 1192 gaat over
`handleJoostIntakeFlow` (sendText + outbound-write), niet over
`upsertConversation`.

**Niet-callers die ik geverifieerd heb**:
- `api/inbox-send-template.js`, `api/inbox-send-text.js` — schrijven outbound
  messages, gebruiken bestaande `conversation_id`. Geen upsert.
- Cron-jobs (`api/cron-events-*.js`, `api/cron-dunning-engine.js`, etc.) —
  geen WA-inbound routing.
- E1.2/F1/F3 endpoints (`api/joost-*`, `api/tasks-*`, `api/arrangements-*`)
  — geen WA-inbound routing.

## DB-migratie (te leveren door Jeffrey vóór merge)

```sql
-- 1) Drop oude phone-only UNIQUE
ALTER TABLE whatsapp_conversations DROP CONSTRAINT IF EXISTS whatsapp_conversations_phone_number_key;
-- (constraint-naam kan afwijken; check via \d whatsapp_conversations)

-- 2) Add nieuwe tuple UNIQUE.
-- Partial index: alleen waar phone_number_id NOT NULL (anders breekt fallback-rij-create).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_conversations_phone_pnid_unique
  ON whatsapp_conversations (phone_number, phone_number_id)
  WHERE phone_number_id IS NOT NULL;

-- 3) Optioneel: index op phone_number alléén voor sneller phone-only fallback-pad.
CREATE INDEX IF NOT EXISTS whatsapp_conversations_phone_idx
  ON whatsapp_conversations (phone_number);
```

**Backfill-check**: bestaande conversations hebben al een `phone_number_id`
gezet (eerste-lijn-leidend behavior). De partial UNIQUE-index breekt dus niet
bij ALTER. Verifieer met:
```sql
SELECT count(*) FILTER (WHERE phone_number_id IS NULL) AS without_pnid,
       count(*)                                       AS total
FROM whatsapp_conversations;
```
Verwacht: `without_pnid` is klein/0 voor de fase-1+ historie.

## Smoke (pre-merge, beperkt)

Inbound is alleen op prod echt testbaar (Meta webhook-URL wijst alleen naar
prod). Op preview kunnen we wel:

1. **Module-load verifieren**: `GET $PREVIEW_URL/api/inbox-webhook` →
   verwacht 405 (Method Not Allowed) of 400, **NIET** 500/module-error.
   Bevestigt dat de gewijzigde JS schoon laadt op de Vercel-runtime.
2. **`node --check api/inbox-webhook.js`** → exit 0 ✅.

## Smoke (post-merge, na constraint-swap)

### Stap A — Backup huidige conv (voor rollback-mogelijkheid)

```sql
SELECT id, phone_number, phone_number_id, customer_id, last_message_at
FROM whatsapp_conversations
WHERE phone_number = '+31655270212';
-- Verwacht: 1 rij, phone_number_id = '1194351613761790' (finance).
```

### Stap B — Inbound op events-lijn

1. Stuur WhatsApp van `+31655270212` naar events-lijn `+316???` (events-WABA).
2. Vercel logs `inbox-webhook` verwacht:
   - NIET: `upsertConversation: geen pnId, phone-only fallback` (events-payload heeft pnId)
   - WEL: `[inbox-webhook] POST processed {...msgs_new:1...}`

### Stap C — Verifieer aparte conv

```sql
SELECT id, phone_number, phone_number_id, customer_id, last_message_at
FROM whatsapp_conversations
WHERE phone_number = '+31655270212'
ORDER BY created_at;
-- Verwacht: 2 rijen — finance-conv (oud, last_message_at ongewijzigd)
--                    + events-conv (nieuw, pnId='1156034510929407')
```

### Stap D — Verifieer finance ongemoeid

1. Stuur volgend WhatsApp van `+31655270212` naar finance-lijn.
2. Vercel logs: `POST processed {...msgs_new:1...}`.
3. Verifieer:
```sql
SELECT c.id, c.phone_number_id, c.last_message_at,
       (SELECT count(*) FROM whatsapp_messages WHERE conversation_id = c.id) AS msg_count
FROM whatsapp_conversations c
WHERE c.phone_number = '+31655270212'
ORDER BY c.created_at;
-- Verwacht: finance-conv last_message_at bumped + msg_count groeit op finance-rij.
--          Events-conv blijft ongemoeid.
```

## Vereisten voor merge

- [ ] Smoke pre-merge: `GET /api/inbox-webhook` op preview returnt 405 (niet 500).
- [ ] `node --check api/inbox-webhook.js` → exit 0.
- [ ] DB-migratie hierboven uitgevoerd op productie-DB **vóór** prod-merge
      (volgorde: PR mergen → main fast-forward → Vercel auto-deploy →
      constraint-swap). Andersom: constraint-swap eerst en pre-fix-code blijft
      werken (phone-only SELECT ziet 1 rij; nieuwe pnId-mismatch krijgt INSERT
      die op nieuwe UNIQUE doorgaat). Geen unsafe window.
- [ ] Tech-debt-zone (`modules/finance.html`, `modules/shared/finance-views/camtbank.js`) ongemoeid.

## Risico's

| Risico | Mitigatie |
|---|---|
| Bestaande conv met `phone_number_id IS NULL` (legacy) — tuple-SELECT mist hem | Phone-only fallback met warn-log dekt dit; partial UNIQUE op `WHERE phone_number_id IS NOT NULL` voorkomt dat de fallback-INSERT struikelt. |
| Backwards-compat finance-inbox: shared-conv historische messages blijven onder finance-conv hangen | Bewust: historische berichten bewegen niet; alleen nieuwe inbound op events-lijn krijgt nieuwe events-conv. Geen data-verlies. |
| Race tussen twee gelijktijdige events-inbounds vóór tuple-UNIQUE live is | Constraint-swap moet **vlot** na merge gebeuren; tijdens het window is de 23505-race-re-select consistent gemaakt (tuple bij pnId aanwezig) zodat we niet de verkeerde conv terugkrijgen. |
| Outbound routing breekt door switch-of-line | Outbound gebruikt `conv.phone_number_id` van de conv waar de outbound vandaan komt (bv. send-template). Met aparte conv per lijn klopt dat per definitie — events-outbound gaat over events-lijn. |

## Niet in deze PR

- DB-migratie zelf (separaat door Jeffrey in Supabase).
- Reactieve trigger-dispatch voor module='events' in webhook (= Fase 2 stap 2c — vereist if-branch + `runSimoneSuggest`).
- Events-inbox UI met "Vraag Simone"-knop (= Fase 2 stap 3).
