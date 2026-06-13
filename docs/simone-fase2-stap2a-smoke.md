# Simone-core (Fase 2 stap 2a) — smoke-doc

Branch: `feat/simone-suggest-core`
Base: `a1c01444ff982380292a1182a09eadf4b823ab34` (= PR #190 squash-commit op main)
PR: open (NIET gemerged)
Migratie: **n.v.t.** — hergebruikt bestaande `joost_config` + `joost_suggestions`
(beide module-keyed sinds E1.x).

## Doel

Simone (events-agent brein) als **sibling** van Joost — eigen system-prompt,
eigen intent-set, eigen context-build (events i.p.v. finance), maar
**zelfde tabel-vorm** zodat we geen schema-werk hoeven. Persistente
suggesties landen op `joost_suggestions WHERE module='events'`.

Joost is ongemoeid: aparte core-file, aparte HTTP-endpoint, aparte
permission, aparte config-rij.

## Wat gebouwd is

### Nieuwe files

- **`api/_lib/simone-suggest-core.js`** — pure functie
  `runSimoneSuggest({ supabase, conversationId, triggeredByMessageId,
  autoTriggered, requestedByUserId, clientIp })` met events-specifieke
  context-build. Returnt `{ status, body }` (zelfde shape als
  `runJoostSuggest`). Anthropic tool-use met intent-enum:
  `event_info | date_location | registration_intent | cancel_or_reschedule
  | logistics | escalation_needed | general_question | other`.
- **`api/simone-suggest.js`** — thin HTTP-handler. Auth-paden:
  X-Internal-Token (system) of Bearer-JWT + `events.simone.use` (user).

### Gewijzigde file

- **`modules/admin.html`** — `events.simone.use` toegevoegd aan
  `FEATURE_REGISTRY` onder events-module (regel ~881).

## Telefoon → attendee-match (de schema-specifieke laag)

**Bron**: `event_attendees.phone` (direct kolom, geen customers-join). Per
`api/events-signup-inbound.js:108-118` is dat het canonieke matching-veld
voor event-leads — die zijn vaak prospects zonder `customer_id`.

**Strategie** (identiek aan `api/inbox-conversation-context.js:74-113` en
de patroon-omschrijving in CLAUDE.md lesson 18):

1. Normalize `conv.phone_number` met `String(s).replace(/\D/g, '')`.
2. Over-fetch alle `event_attendees` waar `phone IS NOT NULL` (acceptabel
   <5k attendees; consistente patroon met inbox-conversation-context).
3. Exact-match op volle digit-string → return alle hits.
4. Fallback: laatste 9 digits — pakt lokale variant zonder landcode.
5. Bij geen hits → **NO-MATCH-case**: `matchedAttendees=[]`,
   `eventsForCtx=[]`. Prompt vermeldt expliciet "GEEN attendee-match" en
   Simone valt terug op general-purpose events-assistent met kennis uit
   `joost_config.knowledge_base`.

**Daarna**: voor de gematchte `event_id`'s wordt `events` opgehaald
(top 5 op `starts_at DESC`) plus per-event attendee-status. "Eerstvolgend
event" = oudste `starts_at >= now()` uit de top-5.

## Schema-aannames — verificatie

| Aanname | Bron | Klopt? |
|---|---|---|
| `event_attendees` heeft `phone` kolom | `events-signup-inbound.js:113` (`.eq('phone', phone)`) en `events-attendees-list.js:17` | ✅ |
| `event_attendees.status` enum bevat `aangemeld\|aanwezig\|no_show\|sale\|switched_to_other_event` | `events-attendees-list.js:35` `VALID_STATUS` | ✅ |
| `event_attendees.customer_id` is **optioneel** (event-leads = prospects zonder customers-rij) | `events-attendees-list.js:17-19` (nullable kolom) | ✅ — Simone vereist géén customer_id |
| `events` heeft `title, starts_at, ends_at, location, capacity, status, niveau, description_md, signups_closed` | `events-detail.js:48-53` SELECT-clause | ✅ |
| `events.niveau` is een slug die joined naar `event_niveau_options` | `events-detail.js:54` `event_niveau_options:niveau ( slug, label )` | ✅ |
| `joost_config` is module-keyed met `module` column als enum-discriminator | `joost-suggest-core.js:158` `.eq('module', resolvedModule)` | ✅ — events-rij gewoon insert |
| `joost_suggestions` ondersteunt `module='events'` | `joost-suggest-core.js:643` `module: config.module` (vrije string) | ✅ — geen CHECK-constraint die finance forceert |
| `whatsapp_conversations.phone_number_id` joinable naar `whatsapp_module_config` voor events-rij | bestaande `getModuleContextByPhoneNumberId` | ✅ — maar events-rij hoeft nog niet te bestaan voor smoke (we werken via directe HTTP-call op een test-conv) |

**Afwijking**: GEEN. Alle aannames bevestigd in bestaande code. Geen schema-wijziging.

## Config-rij seed (voer uit in Supabase SQL editor vóór smoke)

```sql
-- Simone config voor module='events'. Idempotent via UPSERT op (module).
INSERT INTO joost_config (
  module,
  persona_name,
  persona_tone,
  system_prompt_template,
  knowledge_base,
  model,
  temperature,
  context_message_count,
  is_enabled,
  feature_flags
) VALUES (
  'events',
  'Simone',
  'vriendelijk-professioneel',
$$Je bent Simone, de events-assistent van De Forex Opleiding NL B.V.

Je beantwoordt vragen van prospects en deelnemers over onze events — masterclasses, opleidingsdagen en proeflessen. Je toon is vriendelijk-professioneel, in het Nederlands, en je houdt antwoorden compact (3-4 zinnen).

Doelen:
1. Vragen beantwoorden over inhoud, datum, locatie, programma en niveau van events.
2. Inschrijvings-intentie herkennen en mensen wegwijzen naar het juiste event of de aanmeldlink.
3. Bij verzettings- of annuleringsverzoek: empathisch reageren en doorverwijzen naar een collega.
4. Bij klacht of juridische context: NIET zelf afhandelen — markeer escalation_needed.

Belangrijke context:
- Persoon: {prospect_naam}
- Aantal events waar deze persoon mee verbonden is (recent/komend): {events_count}
- Eerstvolgende event: {next_event_title}
- Deelnemer-status op laatste match: {attendee_status}

NB: stel NOOIT bedragen / kortingen voor, en doe nooit harde toezeggingen over plaatsen. Verwijs bij onzekerheid door naar een medewerker.$$,
  '{}'::jsonb,
  'claude-sonnet-4-6',
  0.3,
  10,
  true,
  jsonb_build_object(
    'reactive_suggest_enabled', false,   -- events-nummer nog niet live
    'e2_reactive_autonomy',     false    -- Joost-parallel; uit
  )
)
ON CONFLICT (module) DO UPDATE SET
  persona_name           = EXCLUDED.persona_name,
  persona_tone           = EXCLUDED.persona_tone,
  system_prompt_template = EXCLUDED.system_prompt_template,
  is_enabled             = EXCLUDED.is_enabled,
  feature_flags          = EXCLUDED.feature_flags
RETURNING module, persona_name, is_enabled, feature_flags;
```

Verwacht: 1 rij, `module='events'`, `persona_name='Simone'`, `is_enabled=true`,
`feature_flags` bevat beide flags op `false`.

## Permission-seed (voor de test-user)

```sql
-- Voor Jeffrey: events.simone.use toekennen aan zijn rol (manager).
-- super_admin krijgt 'm automatisch via de RPC; alleen nodig voor
-- niet-super_admin testers.
INSERT INTO role_permissions (role, feature_key, allowed)
VALUES ('manager', 'events.simone.use', true)
ON CONFLICT (role, feature_key) DO UPDATE SET allowed = EXCLUDED.allowed;
```

## Test-fixtures (voor smoke; opruimen ná!)

### Stap 1 — Test events-afdeling-rij in `whatsapp_module_config`

(Optioneel — alleen nodig als je de afdeling-vars in de prompt wilt verifieren.
Zonder rij valt `getModuleContextByPhoneNumberId` terug op generieke labels.)

```sql
INSERT INTO whatsapp_module_config (
  module, phone_number_id, display_label, is_active,
  afdeling_ondertekenaar, afdeling_telefoon, afdeling_whatsapp, afdeling_email
) VALUES (
  'events',
  'test-events-pnid-' || gen_random_uuid()::text,
  'Events-team',
  true,
  'Test Mentor',
  '+31000000000',
  '+31000000000',
  'events-test@deforexopleiding.nl'
)
RETURNING id, phone_number_id;
```

### Stap 2 — Test events-rij + attendee + conversation

```sql
-- (a) test-event
INSERT INTO events (title, starts_at, ends_at, location, capacity, status, niveau)
VALUES (
  'Smoke-test Masterclass Simone',
  now() + interval '7 days',
  now() + interval '7 days' + interval '3 hours',
  'Test-locatie Amsterdam',
  20,
  'gepubliceerd',
  (SELECT slug FROM event_niveau_options LIMIT 1)
)
RETURNING id;
-- noteer de event_id als $EVENT_ID

-- (b) test-attendee (gekoppeld telefoon)
INSERT INTO event_attendees (event_id, first_name, last_name, email, phone, status, registered_at)
VALUES (
  '<EVENT_ID hierboven>',
  'Smoke',
  'Test',
  'smoke-simone@example.com',
  '+31611111199',
  'aangemeld',
  now()
)
RETURNING id;

-- (c) test-conv (gekoppeld telefoon = matched)
INSERT INTO whatsapp_conversations (phone_number, phone_number_id, last_message_at, last_inbound_at)
VALUES (
  '+31611111199',
  '<phone_number_id uit stap 1, of NULL als overgeslagen>',
  now(),
  now()
)
RETURNING id;
-- noteer als $CONV_ID

-- (d) test-message (inbound, klant-vraag waar Simone iets zinnigs over kan zeggen)
INSERT INTO whatsapp_messages (
  conversation_id, direction, meta_wamid, body, status, delivered_at, created_at
) VALUES (
  '<CONV_ID>', 'in', 'smoke-wamid-' || gen_random_uuid()::text,
  'Hoi! Hoe laat begint die masterclass volgende week eigenlijk, en kan ik nog komen?',
  'delivered', now(), now()
)
RETURNING id;
```

### Stap 3 — Test events-rij voor NO-MATCH-case

```sql
-- (e) tweede test-conv met phone die NIET in event_attendees zit
INSERT INTO whatsapp_conversations (phone_number, phone_number_id, last_message_at, last_inbound_at)
VALUES ('+31600000099', NULL, now(), now())
RETURNING id;
-- noteer als $CONV_NOMATCH

INSERT INTO whatsapp_messages (
  conversation_id, direction, meta_wamid, body, status, delivered_at, created_at
) VALUES (
  '<CONV_NOMATCH>', 'in', 'smoke-wamid-' || gen_random_uuid()::text,
  'Ik zag een masterclass forex bij jullie — kun je meer vertellen over wat er aan bod komt?',
  'delivered', now(), now()
)
RETURNING id;
```

## Scenario 1 — Matched conversation → Simone met events-context

**Uitvoeren op preview-deploy van deze PR.**

```bash
# Token via Supabase Auth (Jeffrey logint en kopieert sb-access-token uit /api/config).
# Of via X-Internal-Token (= INTERNAL_API_TOKEN env-var).
curl -X POST "$PREVIEW_URL/api/simone-suggest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"conversation_id":"<CONV_ID>"}'
```

**Verwacht response 200**:
```json
{
  "suggestion": {
    "id": "<uuid>",
    "suggested_reply": "<nederlandse tekst, 3-4 zinnen, refereert aan datum + locatie>",
    "detected_intent": "date_location",
    "confidence": 0.7+,
    "reasoning": "<1-2 zinnen>",
    "created_at": "<iso>"
  }
}
```

**DB-bewijs**:
```sql
SELECT id, conversation_id, module, status, auto_triggered, requested_by_user_id,
       detected_intent, confidence, created_at,
       context_snapshot->'prospect'->>'matched_count' AS matched,
       jsonb_array_length(COALESCE(context_snapshot->'events', '[]'::jsonb)) AS evt_count
FROM joost_suggestions
WHERE conversation_id = '<CONV_ID>'
ORDER BY created_at DESC LIMIT 1;
-- verwacht: module='events', status='PROPOSED', matched=1, evt_count=1.
```

## Scenario 2 — NO-MATCH conversation → Simone valt terug op general-purpose

```bash
curl -X POST "$PREVIEW_URL/api/simone-suggest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"conversation_id":"<CONV_NOMATCH>"}'
```

**Verwacht response 200**: redelijke algemene reactie over masterclasses
(géén verzonnen datum / locatie). `detected_intent` waarschijnlijk
`general_question` of `event_info`.

**DB-bewijs**:
```sql
SELECT detected_intent,
       context_snapshot->'prospect'->>'matched_count' AS matched,
       jsonb_array_length(COALESCE(context_snapshot->'events', '[]'::jsonb)) AS evt_count
FROM joost_suggestions
WHERE conversation_id = '<CONV_NOMATCH>'
ORDER BY created_at DESC LIMIT 1;
-- verwacht: matched=0, evt_count=0; Simone heeft niet gehallucineerd over
-- concrete events (kijk naar suggested_reply in de UI of via response-JSON).
```

## Opruimen (KRITISCH — na smoke)

```sql
DELETE FROM whatsapp_messages WHERE conversation_id IN ('<CONV_ID>', '<CONV_NOMATCH>');
DELETE FROM joost_suggestions WHERE conversation_id IN ('<CONV_ID>', '<CONV_NOMATCH>');
DELETE FROM whatsapp_conversations WHERE id IN ('<CONV_ID>', '<CONV_NOMATCH>');
DELETE FROM event_attendees WHERE email = 'smoke-simone@example.com';
DELETE FROM events WHERE title = 'Smoke-test Masterclass Simone';
DELETE FROM whatsapp_module_config WHERE display_label = 'Events-team' AND afdeling_ondertekenaar = 'Test Mentor';
DELETE FROM audit_log
 WHERE action IN ('simone.suggestion.generated','simone.suggestion.auto_generated')
   AND after_json->>'suggestion_id' IS NOT NULL
   AND created_at > now() - interval '1 day';
```

## Scope-limiet — wat NIET in deze PR

- Reactieve trigger vanuit `inbox-webhook` voor module='events' (= Fase 2 stap 2b).
  De webhook routeert nog steeds alleen `runJoostSuggest` voor finance; events-pad
  niet bedraad. Zou een `if (jcfg.module === 'events') runSimoneSuggest(...)`
  dispatch vereisen + `reactive_suggest_enabled=true` op events-config.
- Events-inbox UI met "Vraag Simone"-knop (= Fase 2 stap 3 / 2c).
- Echte events-WhatsApp-lijn in productie (`whatsapp_module_config` events-rij
  blijft test-only of leeg).
- Migratie (geen schema-wijziging nodig).

## Hygiene

- `node --check api/_lib/simone-suggest-core.js` → exit 0 ✅
- `node --check api/simone-suggest.js` → exit 0 ✅
- Geen wijziging aan `api/joost-suggest.js` / `api/_lib/joost-suggest-core.js`
  / `api/inbox-webhook.js` (Joost ongemoeid — sibling-pattern).

## Risico's

| Risico | Mitigatie |
|---|---|
| Over-fetch op `event_attendees` schaalt slecht boven ~5k rows | Acceptabel voor MVP; consistente patroon met `inbox-conversation-context.js`. Bij groei: phone-index of materialized view. |
| NO-MATCH-case → Simone hallucineert een gefingeerd event | System-prompt zegt expliciet "doe geen aannames over inschrijving" en CTX-block vermeldt "GEEN attendee-match". `temperature=0.3` default. Smoke Scenario 2 verifieert het. |
| `joost_suggestions.module='events'` triggert per ongeluk finance-UI | Inbox-UI (Fase 1) filtert op `phone_number_id`; suggestions-cards filtert op module. Voor smoke gebruiken we directe API-call, dus UI is niet geraakt. |
| Audit-actions met `simone.*` prefix breken bestaande filters | `audit_log.action` is vrije text; bestaande filters die op `joost.*` matchen worden niet geraakt. Smoke verifieert insert-success. |
