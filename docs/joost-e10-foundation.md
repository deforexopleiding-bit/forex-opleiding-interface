# Joost AI — E1.0 Foundation

Datum: 2026-06-09
Sprint: E1.0 (config + suggest + outcome + admin UI — draft-mode)
Branch: `feat/joost-e10-foundation`

---

## 1. Wat Joost is

Joost is een AI conversational agent die in de **Finance Inbox** suggesties
genereert voor antwoorden op WhatsApp-berichten van klanten. Joost zit naast
de medewerker, niet ervoor: hij stelt antwoorden voor, classificeert intent
en levert reasoning — de medewerker bepaalt of de tekst 1-op-1, aangepast of
helemaal niet verstuurd wordt.

E1.0 levert het fundament:
- Per-module config (persona, system-prompt, knowledge-base, model, temperature).
- Endpoint dat een suggestie genereert op basis van conversation-context.
- Endpoint dat de uitkomst (used/edited/ignored/dismissed) terug-logt.
- Inbox compose-panel met 3 acties (Plak / Plak en bewerk / Negeer).
- Admin-UI om de config bij te stellen zonder migratie te draaien.

Wat E1.0 expliciet NIET doet: autonoom versturen, auto-trigger bij inbound,
auto-task-creation op basis van intent, leren van outcome. Zie roadmap (§9).

---

## 2. Draft-mode (geen autonomy)

Het hele E1.0-design draait om draft-mode:

1. **Trigger is altijd handmatig** — de medewerker klikt "Vraag Joost" in de
   compose-area. Geen webhook-driven auto-suggest (dat is E1.1).
2. **Output is altijd een voorstel** — `joost_suggestions.status='PROPOSED'`
   bij INSERT. Niets verlaat het platform tot de medewerker op verzenden klikt
   via de bestaande inbox-send-flow.
3. **Outcome wordt expliciet gemarkeerd** — zodra de medewerker plakt /
   bewerkt / negeert wordt `joost-mark-outcome` aangeroepen. Audit-trail blijft
   compleet ook bij "ignored" (data voor latere finetuning).

Deze keuze maakt E1.0 risk-free: een hallucinatie kost een klik om te
dismissen, geen klantvertrouwen. Pas in E2 zetten we de stap naar autonomous
send, mét human-in-the-loop fallback bij low-confidence.

---

## 3. Schema

Twee tabellen in migratie
`docs/sql-migrations/2026-06-09-joost-e10-foundation.sql`:

### `joost_config` — per-module configuratie (1 rij per module)

| Kolom                    | Type            | Doel                                                   |
|---|---|---|
| `module`                 | text PK         | Module-key (lowercase, snake-case). Bv. `finance`.     |
| `persona_name`           | text            | Naam waarmee Joost zichzelf aanduidt. Default `Joost`. |
| `persona_tone`           | text            | Vrije beschrijving van de toon.                        |
| `system_prompt_template` | text            | Template met named placeholders (`{klant_naam}`, ...). |
| `knowledge_base`         | jsonb           | Vrije module-specifieke kennis (IBAN, support-uren).   |
| `model`                  | text            | Anthropic model (default `claude-sonnet-4-6`).         |
| `temperature`            | numeric(3,2)    | 0.00 - 1.00. Default 0.30.                             |
| `context_message_count`  | integer         | Aantal recente WA-messages dat als context meegaat.    |
| `is_enabled`             | boolean         | Feature-flag per module. Default true.                 |
| `updated_by_user_id`     | uuid            | Wie heeft de config laatst aangepast.                  |
| `updated_at`             | timestamptz     | Trigger `joost_config_touch_updated_at` houdt bij.     |

### `joost_suggestions` — log + outcome

| Kolom                      | Type            | Doel                                                       |
|---|---|---|
| `id`                       | uuid PK         | `gen_random_uuid()`.                                       |
| `conversation_id`          | uuid FK         | `whatsapp_conversations(id)` (CASCADE delete).             |
| `triggered_by_message_id`  | uuid FK         | Inbound message die de suggestie triggerde (SET NULL).     |
| `module`                   | text            | Resolved module (`finance` default).                       |
| `suggested_reply`          | text            | De gegenereerde NL-tekst.                                  |
| `detected_intent`          | text            | Een van 6 enum-waarden (§7).                               |
| `confidence`               | numeric(4,3)    | 0.000 - 1.000.                                             |
| `reasoning`                | text            | 1-2 zinnen waarom dit intent + dit antwoord.               |
| `context_snapshot`         | jsonb           | Volledige input zoals meegegeven aan de LLM (audit).       |
| `status`                   | text CHECK      | `PROPOSED` / `USED_AS_IS` / `USED_EDITED` / `IGNORED` / `DISMISSED`. |
| `final_sent_text`          | text            | De daadwerkelijk verstuurde tekst (kan afwijken).          |
| `outcome_notes`            | text            | Vrije notities bij outcome (optioneel).                    |
| `requested_by_user_id`     | uuid            | Wie heeft de suggestie aangevraagd.                        |
| `used_by_user_id`          | uuid            | Wie heeft de outcome gemarkeerd.                           |
| `created_at`, `used_at`    | timestamptz     | Timeline.                                                  |

Indexen op `(conversation_id, created_at DESC)` en `(status, created_at DESC)`
voor de twee belangrijkste queries (per-conversatie rate-limit + per-status
audit-overzichten).

RLS-pattern conform `whatsapp_module_config`:
- SELECT authenticated (UI moet kunnen lezen).
- Write USING(false) / WITH CHECK(false) — alleen via service-role vanuit de
  endpoints die zelf RBAC enforce-en.

---

## 4. Endpoints + RBAC

| Endpoint                       | Methode | Doel                                         | Permission key         |
|---|---|---|---|
| `/api/joost-config-get`        | GET     | Lees config voor een module.                 | `finance.joost.use`    |
| `/api/joost-config-upsert`     | POST    | Update/insert config (admin-UI).             | `admin.joost_config`   |
| `/api/joost-suggest`           | POST    | Genereer suggestie voor conversation.        | `finance.joost.use`    |
| `/api/joost-mark-outcome`      | POST    | Markeer outcome (USED_*/IGNORED/DISMISSED).  | `finance.joost.use`    |

Geen fallback-keys (strict). `super_admin` krijgt automatisch toegang via de
generieke `user_has_permission` check.

### `joost-suggest` body
```json
{
  "conversation_id": "uuid",
  "triggered_by_message_id": "uuid (optioneel)"
}
```

### `joost-mark-outcome` body
```json
{
  "suggestion_id": "uuid",
  "status": "USED_AS_IS | USED_EDITED | IGNORED | DISMISSED",
  "final_sent_text": "string (verplicht bij USED_*)",
  "outcome_notes": "string (optioneel)"
}
```

Validatie: `final_sent_text` is verplicht bij `USED_AS_IS` (1-op-1 wat
Joost voorstelde) en `USED_EDITED` (aangepaste tekst). `409` als de
suggestion niet meer `PROPOSED` is — outcome kan maar 1x gemarkeerd worden.

---

## 5. Anthropic-client lib + structured output via tool-use

`api/_lib/anthropic-client.js` is de gedeelde client. Twee exports:

- `anthropicMessages({ system, messages, model, max_tokens, temperature, tools, tool_choice })` —
  raw `/v1/messages` call met retry op 429 (1x, 2s backoff) en getypeerde
  errors (`ANTHROPIC_KEY_MISSING`, `ANTHROPIC_RATE_LIMIT`, `ANTHROPIC_API_ERROR`,
  `ANTHROPIC_NETWORK_ERROR`, `ANTHROPIC_TOOL_USE_MISSING`, `ANTHROPIC_INVALID_INPUT`).
- `anthropicStructuredOutput({ tool_name, tool_input_schema, ... })` —
  forceert een tool-call door 1 tool te definiëren en `tool_choice = { type:
  'tool', name: tool_name }` te zetten. Returnt het geparste `input`-object
  van het `tool_use`-block.

`joost-suggest` definieert de tool `joost_response` met required fields
`suggested_reply` / `detected_intent` (enum) / `confidence` (number) /
`reasoning`. Het model is verplicht via `tool_choice` om die tool aan te
roepen — geen vrije tekst, geen parsing-risico. Dit is een robuust pad voor
structured JSON uit Anthropic (zie Lesson learned 22 in CLAUDE.md).

Anti-pattern dat we hiermee vermijden: prompt-engineering van "antwoord
alleen in JSON" en daarna `JSON.parse()` van de assistant-text. Dat faalt
zodra het model bijvoorbeeld een ```json``` codeblock eromheen zet of een
extra inleidende zin schrijft. Met geforceerd tool-use is het schema
contractueel gegarandeerd door de API zelf.

---

## 6. Rate-limit: 30s per conversation

Per conversation maximaal **1 `PROPOSED` suggestie per 30 seconden**.
Implementatie in `joost-suggest`:

```js
const rateCutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
const { data: recentSugg } = await supabaseAdmin
  .from('joost_suggestions')
  .select('id, created_at')
  .eq('conversation_id', convId)
  .eq('status', 'PROPOSED')
  .gte('created_at', rateCutoff)
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();
if (recentSugg) return res.status(429).json({ ... });
```

Doel: voorkomen dat een per-ongeluk dubbele klik / impatient gedrag een
tweede Anthropic-call triggert binnen 30s. De UI toont de bestaande
suggestion uit response payload (`previous_suggestion_id` +
`previous_created_at`) zodat de medewerker er direct mee verder kan.

Soft-fail bij DB-glitch: als de rate-limit-query zelf faalt loggen we de
error maar laten we de hoofdflow doorgaan. Liever 1 dubbele call dan de
medewerker blokkeren.

---

## 7. Intent-types + confidence-bands

De zes intent-enum-waarden (uit `joost-suggest`):

| Intent                  | Wanneer Joost dit kiest                                        |
|---|---|
| `payment_promise`       | Klant belooft te betalen ("Ik betaal vrijdag").                |
| `verify_payment`        | Klant zegt al betaald te hebben.                               |
| `arrangement_request`   | Klant vraagt om betalingsregeling / uitstel.                   |
| `general_question`      | Inhoudelijke vraag zonder duidelijke financiele intent.        |
| `escalation_needed`     | Vereist menselijke / juridische aandacht.                      |
| `other`                 | Anders — fallback als niets past.                              |

Confidence-bands die we hanteren bij UI-rendering (E1.0 toont alleen het
getal; E1.2 gebruikt de banding voor auto-task-creation):

| Band            | Range          | Betekenis                                      |
|---|---|---|
| **High**        | `>= 0.80`      | Joost weet vrij zeker waar het over gaat.      |
| **Medium**      | `0.50 - 0.79`  | Plausibel, maar mens kijkt na voor verzending. |
| **Low**         | `< 0.50`       | Zwak signaal — niet auto-acteren in E2+.       |

De `confidence` wordt server-side geclampt tussen 0 en 1
(`clamp01(toolInput.confidence)`) zodat het model nooit een out-of-range
waarde kan doorgeven.

---

## 8. Audit-trail voor learning later

Elke suggestion bewaart `context_snapshot` (jsonb) met de volledige input die
de LLM gezien heeft:

```json
{
  "conversation": { "id", "phone_number", "last_inbound_at", "window_open", "last_inbound_body" },
  "customer": { "id", "name", "email", "phone", "is_company", "created_at" },
  "open_facturen": { "totaal_open_bedrag", "aantal", "items": [ ... ] },
  "actieve_afspraken": [ { "id", "type", "status", "details", "created_at" } ],
  "afdeling": { "naam", "ondertekenaar", "telefoon", "whatsapp", "email" },
  "bedrijf": { "naam", "kvk", "btw" },
  "recent_messages": [ { "direction", "body", "created_at" } ],
  "generated_at": "ISO"
}
```

Daarnaast schrijven we naar `audit_log` (entity-driven stijl):
- Bij generatie: `action='joost.suggestion.generated'`,
  `entity_type='whatsapp_conversation'`, `after_json` met intent +
  confidence + model + temperature + `messages_in_ctx`.
- Bij outcome: `action='joost.outcome_marked'`,
  `entity_type='joost_suggestion'`, `after_json` met de nieuwe status.

Doel: bij latere finetuning of evaluator-builds (E2+) kunnen we exact
reproduceren wat Joost zag, wat hij voorstelde en wat de medewerker
uiteindelijk deed. `IGNORED` en `DISMISSED` zijn even waardevol als
`USED_AS_IS` — ze tonen waar het model overshootte.

---

## 9. Env-var: `ANTHROPIC_API_KEY` (vereist)

`joost-suggest` returnt **503** als `process.env.ANTHROPIC_API_KEY`
ontbreekt — geen 500, want het is een config-probleem, niet een runtime-bug.
De foutmelding in de response noemt expliciet "Vraag aan super_admin" zodat
support weet welk pad ze in moeten.

Configuratie: Vercel env vars (alle environments), markeer **Sensitive**
(productie-key niet meer leesbaar na opslaan). Backup in 1Password.

`anthropic-client.js` gooit ook bij ontbrekende key een
`ANTHROPIC_KEY_MISSING`-error met expliciete logging — voorkomt cryptische
401's bij de Anthropic-call zelf.

Voor de `bedrijf.*`-variabelen die in de system-prompt context terechtkomen
gebruiken we de bestaande C4-env-vars (`COMPANY_NAME`, `COMPANY_KVK`,
`COMPANY_BTW`); zie `docs/whatsapp-templates-c4-named-variables.md`.

---

## 10. Roadmap

| Sprint | Scope | Status |
|---|---|---|
| **E1.0** | Config + suggest + mark-outcome + inbox-panel + admin-UI (draft-mode, handmatige trigger) | ✅ live |
| **E1.1** | Auto-suggest bij inbound webhook — `inbox-webhook.js` triggert `joost-suggest` direct bij nieuwe klant-message. Suggestie staat klaar zodra medewerker de conversatie opent. Rate-limit 30s blijft de guard tegen burst-inbound. | TODO |
| **E1.2** | Intent -> auto task-creation — bij `detected_intent='verify_payment'` met `confidence>=0.80` automatisch `MANUAL_VERIFY_PAYMENT` pending_action aanmaken (cross-link met F1 taken-dashboard). Bij `arrangement_request` similar trigger naar D-module propose-wizard pre-fill. | TODO |
| **E2** | Autonomous send — Joost mag bij `confidence>=0.90` + intent in safe-list (`general_question`, `payment_promise` acknowledgement) zelfstandig versturen via een nieuwe `joost-send` endpoint, met audit-trail en opt-out per module. Human-in-the-loop fallback bij low-confidence. | TODO |

Belangrijke randvoorwaarden voor E2:
- `joost_send_outcomes` log-tabel met klant-respons binnen 24u als signal.
- Per-module hard cap (bv. max 10 autonomous sends per uur platform-breed).
- Kill-switch via `joost_config.is_enabled` blijft hoogste prioriteit.

---

## 11. Bekende beperkingen E1.0

- **Geen streaming** — `joost-suggest` wacht synchroon op de volledige
  response (max ~3s). Acceptabel voor 1024-token outputs; bij langere
  prompts overwegen we SSE in E1.1.
- **Geen knowledge-base RAG** — `joost_config.knowledge_base` is een platte
  jsonb-blob die volledig in de system-prompt belandt. Voor grote KB's
  (>5KB) is dat inefficient; embedding-search staat op de wishlist na E2.
- **Geen multi-turn correctie binnen 1 suggestie** — als de medewerker iets
  wil aanpassen via een vervolg-prompt aan Joost ("maak het korter") moet
  hij `joost-suggest` opnieuw triggeren. Conversational correctie is E2-werk.
- **Module-resolve via phone_number_id only** — als een conversatie geen
  `phone_number_id` heeft (oudere rijen) valt Joost terug op
  `module='finance'`. Geen issue zolang het finance-only blijft.
