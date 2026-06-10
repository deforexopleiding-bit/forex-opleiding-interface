# Joost AI — E2 Autonomy Foundation

Datum: 2026-06-10
Sprint: E2 (autonomy-full — decision engine + reactive + outbound + negotiation + prompt-context)
Branch: `feat/joost-e2-autonomy-full`

---

## 1. Wat E2 toevoegt

E1.0 leverde Joost in **draft-mode**: medewerker triggert handmatig, Joost
stelt voor, mens bepaalt of het tekstje verstuurd wordt. E1.1 + E1.2
voegden auto-suggest (webhook) en intent-aware task-creation toe maar
houden de send-actie nog steeds bij de mens.

E2 zet de stap naar **autonomy**: Joost mag — onder strikt configureerbare
voorwaarden — zelf antwoorden versturen, zelf outbound-templates initiëren
vanuit de dunning-engine, en zelf arrangement-voorstellen doen binnen
mandaat. Het volledige design is **feature-flag-first**: alle gedrag is
default UIT, behalve het loggen van decision-engine output (zodat we
kunnen meekijken zonder iets te doen).

Wat E2 NIET doet:
- Geen reinforcement-learning / fine-tuning op outcomes (E3+).
- Geen multi-conversation context bundeling tussen klanten (E3+).
- Geen autonome stop / pauze / kwijtschelding van abonnementen — die
  vijf arrangement-types blijven hard achter `requires_human_approval`
  staan in de mandate-config.

---

## 2. Vijf fases

E2 is opgesplitst in vijf incrementele fases, elk achter een eigen
feature-flag zodat productie-rollout veilig gefaseerd kan worden.

### E2.0 — Decision engine + logs
- SQL-migratie `2026-06-09-joost-e2-autonomy-full.sql` voegt
  `autonomy_config` + `feature_flags` toe aan `joost_config`, breidt
  `joost_suggestions` uit met `sent_autonomously`, `autonomy_decision`,
  `sent_message_id` + 6 nieuwe statussen, en creëert
  `joost_conversation_state`.
- Endpoint `api/joost-autonomy-evaluate.js` met pure
  `evaluateAutonomy()` function (geen IO, unit-testbaar) + handler voor
  dry-run vanuit admin-UI.
- Endpoint `api/joost-autonomy-decisions-list.js` voor de Decision Log
  tab in Joost admin-UI.
- Flag: `e2_decision_engine_logs` (default **AAN**) — laat de engine
  draaien en log alleen, neemt geen actie.

### E2.1 — Reactive autonomy (inbound webhook self-send)
- Endpoint `api/joost-send-autonomous.js` neemt een PROPOSED suggestie
  + decision en stuurt zelf via de bestaande inbox-send-flow.
- Webhook `api/inbox-webhook.js` triggert na de E1.1 auto-suggest een
  self-call naar `joost-send-autonomous` als `evaluateAutonomy()` →
  `allow_autonomous=true`.
- Updates `joost_conversation_state` (sent counters, last_message_sent_at,
  no_reply_streak_count).
- Flag: `e2_reactive_autonomy` (default **UIT**).

### E2.2 — Outbound autonomy (dunning-engine cron)
- Endpoint `api/joost-outbound-send.js` neemt een dunning-workflow-step
  (template + variables) en verstuurt outbound met dezelfde decision-
  engine gate als E2.1.
- Cron `api/joost-outbound-scheduler.js` (4x/dag, office-hours-aware via
  `30 8,11,14,17 * * 1-5` in vercel.json) leest pending
  `dunning_workflow_runs` en triggert per event de send-endpoint
  intern.
- Defense-in-depth: scheduler-flag `e2_outbound_cron` + send-flag
  `e2_outbound_executor` zijn apart schakelbaar.
- Flag: `e2_outbound_scheduler` + `e2_outbound_executor` (beide default
  **UIT**).

### E2.3 — Negotiation (per-conversation pauzeer/hervat)
- Endpoint `api/joost-conversation-state.js` (GET/POST) voor pauze +
  hervat per conversatie. Manual pause door medewerker (X uur of
  onbepaald) en automatische pause bij `no_reply_streak >= drempel`.
- Inbox-UI: pauze-knop in conversation header, "Autonoom gepauzeerd"
  badge bij paused state, indicator "Joost actief" als autonomy aan
  staat voor de conversatie.
- Decision engine respecteert `autonomy_paused_until` →
  `BLOCKED_PAUSED`.

### E2.4 — Prompt-context (suggest endpoint krijgt scope)
- `api/joost-suggest.js` accepteert/leest `conv_state` + mandate-snippet
  en geeft die mee in de Anthropic prompt. Joost weet daardoor:
  "ik mag maximaal 30 dagen uitstel voorstellen" of "abonnement-pauze
  is buiten mandaat — escaleer".
- Geen nieuwe flag — dit is een prompt-engineering verbetering die altijd
  aan staat zodra E2.0 geseed is.

---

## 3. Feature-flags overzicht

Alle 5 flags zitten in `joost_config.feature_flags` (jsonb) voor `module='finance'`.
Seed-waarden uit de migratie:

| Flag                          | Default | Wat het schakelt                                                                 |
|-------------------------------|---------|----------------------------------------------------------------------------------|
| `e2_decision_engine_logs`     | `true`  | Logt elke decision (zichtbaar in admin Decision Log tab). Side-effect-vrij.      |
| `e2_auto_send_text`           | `false` | Reactive autonomy: webhook mag self-call doen naar `joost-send-autonomous`.      |
| `e2_auto_send_template`       | `false` | Outbound autonomy executor: `joost-outbound-send` mag werkelijk versturen.       |
| `e2_outbound_scheduler`       | `false` | Cron `joost-outbound-scheduler` mag draaien (selecteert pending dunning-events). |
| `e2_arrangement_proposer`     | `false` | Mag zelf payment_arrangement INSERT'en (binnen mandaat). Voor E2.5/E2.6.         |

**Default-state in productie:** alleen `e2_decision_engine_logs=true`. Dit
betekent: zodra de migratie is uitgevoerd draait Joost in **shadow-mode**.
Hij berekent per inbound bericht zijn decision, slaat die op in
`joost_suggestions.autonomy_decision`, maar onderneemt **geen actie**. Jeffrey
kan in de Decision Log tab zien welke beslissingen genomen zouden zijn
en pas wanneer hij vertrouwen heeft de eerste flag (typisch
`e2_auto_send_text`) handmatig op `true` zetten via de admin-UI.

Aanzetten gebeurt via `joost-config-upsert` (RBAC: `admin.joost_config`)
of direct in de Autonomy-tab van `/modules/admin.html`.

---

## 4. Decision engine flow (8 stappen)

`evaluateAutonomy({...})` in `api/joost-autonomy-evaluate.js` is een
**pure function** (geen DB, geen network). Krijgt suggestion +
conversation-state + joost_config + customer_context mee, retourneert
een gestructureerd decision-object. Volgorde is bewust: **eerste hit
wint**, daarna stoppen we direct en loggen `decision_log[]` voor
debugging.

### Stappen

1. **Basisvalidatie** — `suggestion` aanwezig? Anders
   `BLOCKED_NO_SUGGESTION`.
2. **Confidence-check** — `suggestion.confidence < intentCfg.min_confidence`
   (default 0.85)? → `BLOCKED_LOW_CONFIDENCE`.
3. **Intent-mode-check** — Intent disabled (`enabled=false`) of niet
   geconfigureerd in `intents`? → `stop_action='escalation'` +
   `stop_task_type='MANUAL_ESCALATION'`.
4. **Office-hours-check** — Buiten venster
   (`commLimits.office_hours_*`)? TZ-aware via `Intl.DateTimeFormat`,
   default Europe/Amsterdam ma-vr 08:30-18:00. → `BLOCKED_OFFICE_HOURS`.
5. **Rate-limit-checks** — Drie sub-checks:
   - `messages_sent_today >= max_per_day` (default 3) → `BLOCKED_RATE_LIMIT`.
   - `messages_sent_total >= max_total` (default 20) → `BLOCKED_RATE_LIMIT`.
   - `now - last_message_sent_at < cooldown` (default 60 min) → `BLOCKED_RATE_LIMIT`.
6. **Paused-check** — `autonomy_paused_until > now`? → `BLOCKED_PAUSED`.
7. **Mandate-check** (alleen voor arrangement-intents
   `tegenvoorstel_termijn` / `gespreid_betalen`):
   - `open_amount < min_total_amount_to_negotiate_eur` →
     `stop_action='task_create'` + `MANUAL_PROPOSE_ARRANGEMENT`.
   - `open_amount > max_total_amount_to_auto_propose_eur` →
     `stop_action='task_create'` + `MANUAL_PROPOSE_ARRANGEMENT`.
   - Voorstel-type niet in `allowed_types` → `BLOCKED_OUT_OF_MANDATE`.
   - Uitstel-dagen / termijnen boven cap → `BLOCKED_OUT_OF_MANDATE`.
8. **Mode-check** — Alle checks gepasseerd. `mode='autonomous'` →
   `allow_autonomous=true`. Anders → `allow_autonomous=false` (mens
   beslist via draft-flow).

### Blocked-reasons (status-discriminators)

Mappen 1-op-1 op `joost_suggestions.status`:

- `BLOCKED_LOW_CONFIDENCE`
- `BLOCKED_INTENT_DISABLED` (uit oudere variant — nu via stop_action='escalation')
- `BLOCKED_COMMUNICATION_LIMIT` (kapstok voor cooldown + day + total caps)
- `BLOCKED_MANDATE_EXCEEDED`
- `BLOCKED_AUTONOMY_PAUSED`
- `BLOCKED_OFFICE_HOURS` (engine-only, niet in CHECK — wordt gemapt op
  `BLOCKED_COMMUNICATION_LIMIT` bij opslag)
- `BLOCKED_OUT_OF_MANDATE` (engine-only, idem → `BLOCKED_MANDATE_EXCEEDED`)
- `BLOCKED_PAUSED` → opgeslagen als `BLOCKED_AUTONOMY_PAUSED`

### Stop-actions

In plaats van stilletjes blokkeren kan de engine ook een follow-up actie
voorstellen die de webhook-laag uitvoert:

| `stop_action`    | `stop_task_type`              | Wanneer                                                              |
|------------------|-------------------------------|----------------------------------------------------------------------|
| `escalation`     | `MANUAL_ESCALATION`           | Intent disabled / boos-of-klacht / kan-niet-betalen                  |
| `task_create`    | `MANUAL_PROPOSE_ARRANGEMENT`  | Arrangement-intent maar buiten mandaat (bedrag, type, dagen, termijnen) |
| `task_create`    | `MANUAL_VERIFY_PAYMENT`       | Intent = `al_betaald_claim` (F1 verify-payment task)                 |
| `task_create`    | `MANUAL_FOLLOWUP`             | Na N-de outbound zonder reply (no_reply_streak overschreden)         |

De engine wijst alleen het type aan; de **taakaanmaak** gebeurt in
`api/joost-create-task-from-suggestion.js` (E1.2). Cascade is dus:
engine → discriminator → bestaande task-creator → `pending_actions`-row.

---

## 5. Mandate-config overzicht

`joost_config.autonomy_config.arrangement_mandate` (jsonb) bepaalt wat
Joost autonoom mag voorstellen. Seed-waarden:

```json
{
  "uitstel": {
    "enabled": true,
    "max_dagen_zonder_approval": 14,
    "max_dagen_total": 30,
    "auto_approve_if_within": true
  },
  "splitsing": {
    "enabled": true,
    "max_termijnen_zonder_approval": 2,
    "max_termijnen_total": 3,
    "min_eerste_termijn_pct": 0.30,
    "auto_approve_if_within": false
  },
  "abonnement_pauze":  { "enabled": false, "requires_human_approval": true },
  "abonnement_stop":   { "enabled": false, "requires_human_approval": true },
  "kwijtschelding":    { "enabled": false, "requires_human_approval": true }
}
```

**Drie regels (lees: belangrijke contract-grenzen):**

1. **`enabled=false` = hard nee.** Drie types staan default uit
   (`abonnement_pauze` / `abonnement_stop` / `kwijtschelding`) — die zijn
   te impactvol voor autonome flow en moeten altijd door een mens.
2. **`zonder_approval` vs `total` cap.** `zonder_approval` = wat Joost
   zelf mag voorstellen + auto-approven. `total` = wat sowieso de hard
   ceiling is, ook met admin-approval. Boven `total` → arrangement kan
   niet, klant moet escaleren.
3. **`auto_approve_if_within=true` voor UITSTEL, `false` voor SPLITSING.**
   Reden: uitstel binnen 14 dagen is laag-risico (1 factuur,
   beperkt bedrag); splitsing raakt 3 facturen + line-items per termijn
   en verdient een tweede paar ogen voor het TL-rondje.

### Intent-modes

Per intent zit een `intents.<key>` blok in autonomy_config met:

- `enabled` boolean — globaal aan/uit voor deze intent.
- `min_confidence` numeric — Joost moet hier overheen om door te gaan.
- `mode` enum `draft|autonomous|disabled` — override van de globale
  `e2_auto_send_text` flag. Niet geseed in E2.0 (default → globale flag
  bepaalt), gepland voor E2.5.
- `action` string — symbolische naam van de uitvoer-actie (gebruikt voor
  documentatie + logging, geen runtime-dispatch).

De 7 default-intents (zie SQL §1 voor seed): `ja_op_uitstel`,
`tegenvoorstel_termijn`, `gespreid_betalen`, `kan_niet_betalen`,
`al_betaald_claim`, `boos_of_klacht`, `vraag_om_kopie_factuur`.

---

## 6. Outbound scheduler + cron

Een aparte loop voor het pro-actief versturen van dunning-templates.

### Endpoint `api/joost-outbound-send.js`

- Input: `{ conversation_id, template_id, variables, dunning_run_id?, dunning_step_id? }`.
- Stappen:
  1. Auth (Bearer Joost-service-token of CRON_SECRET voor self-call).
  2. Flag-check `e2_outbound_executor`. Uit → 503.
  3. Laad `joost_config` + `joost_conversation_state` +
     `customer_context`.
  4. Bouw faux-suggestion uit template (intent = `outbound_template`,
     confidence = 1.0).
  5. `evaluateAutonomy()` → blocked? Log + 200 met `blocked_reason`.
  6. Versturen via bestaande `inbox-send-template`-helper.
  7. Update conv-state counters + `last_outbound_template_sent_at` +
     `last_outbound_workflow_step`.
  8. Insert audit + insert `joost_suggestions` met
     `status='SENT_AUTONOMOUSLY'` + `sent_message_id` FK.

### Cron `api/joost-outbound-scheduler.js`

- Schedule: `30 8,11,14,17 * * 1-5` → 4x per werkdag (08:30 / 11:30 /
  14:30 / 17:30). Vercel cron draait UTC; office-hours-check zit
  binnen `evaluateAutonomy` zodat zomer/winter geen schedule-shifts
  nodig hebben in vercel.json.
- Auth: `CRON_SECRET` via `checkCronAuth`.
- Flag-check: `e2_outbound_cron`. Uit → 503.
- Loop:
  - Selecteer `dunning_workflow_runs` met `status='active'` +
    `next_action_at <= now()` + `step_type='whatsapp'`. Max 50 per run.
  - Per event: self-call naar `joost-outbound-send` met conv +
    template + variables.
  - Throttle 200 ms tussen calls (Meta WABA-limit 80 msg/sec is ruim
    boven onze 5 msg/sec).
  - Abort-budget 50 s; rest van events wordt door volgende tick
    opgepakt.
- Response: `{ processed_count, sent_count, blocked_count,
  skipped_count, errors[], duration_ms }`.

---

## 7. Conversation-state lifecycle

`joost_conversation_state` is 1 rij per `whatsapp_conversations.id` (PK
FK). Geboorte: lazy bij eerste autonomy-evaluatie of eerste manual
pauze. Geen migratie-seed (rij ontstaat on-demand).

### State-transities

```
[ creation ]                         lazy INSERT bij eerste
   |                                 evaluate / pauze
   v
[ active autonomy ]   <----------+
   |   |                         |
   |   | klant antwoordt         | klant antwoordt
   |   v                         |
   |  reset no_reply_streak=0    |
   |                             |
   | autonomy sends bericht      |
   v                             |
[ counters incremented ]         |
   | sent_today, sent_total,     |
   | last_message_sent_at,       |
   | no_reply_streak += 1        |
   |                             |
   | streak >= threshold?        |
   v                             |
[ auto-paused ]  ----------------+
   autonomy_paused_until = now + 48h
   autonomy_paused_reason = 'no_reply_streak'

[ manual-paused ] (orthogonaal — kan vanuit elke state)
   autonomy_paused_until = expliciet door medewerker
   autonomy_paused_reason = 'manual_pause'
```

### Counter-resets

- `messages_sent_today` resetten op datum-flip: vergelijk
  `messages_sent_today_date` met `today`; bij mismatch → teller 0 +
  datum updaten.
- `messages_sent_total` reset NIET — bewust lifetime cap.
- `no_reply_streak_count` reset zodra inbound-message binnenkomt van
  klant in deze conversatie.

### Audit-trail

Elke state-mutatie schrijft een audit-log entry:

```
action: 'joost.conv_state.update'
payload: { conversation_id, before: {...}, after: {...}, trigger: 'autonomy_send' | 'manual_pause' | 'inbound_reply' | 'cron_reset' }
```

Plus per autonomy-send een entry `action: 'joost.autonomy.send'` met
de decision + sent_message_id.

---

## 8. Audit-trail (cross-cutting)

Drie audit-streams die samen het volledige autonomy-verhaal vertellen:

1. **`joost_suggestions` rows** — primary source-of-truth. Elke
   evaluatie krijgt een rij met:
   - `status` = PROPOSED / SENT_AUTONOMOUSLY / BLOCKED_* / USED_* /
     IGNORED / DISMISSED.
   - `autonomy_decision jsonb` = volledig decision-object inclusief
     `decision_log[]` voor menselijke leesbaarheid.
   - `sent_message_id` FK naar `whatsapp_messages` als verzonden.
2. **`agent_audit_log` rows** — cross-module audit. Pattern hetzelfde
   als E1.0 (`action='joost.suggest'`). Nieuwe actions in E2:
   `joost.autonomy.evaluate`, `joost.autonomy.send`,
   `joost.outbound.send`, `joost.conv_state.update`.
3. **Decision Log tab in admin-UI** — leest via
   `joost-autonomy-decisions-list.js` de laatste N
   `joost_suggestions`-rijen met `autonomy_decision IS NOT NULL`,
   gefilterd op blocked_reason / intent / conversation. Voor Jeffrey's
   shadow-mode review.

---

## 9. Smoke-test scenarios per fase

Na elke fase-rollout (= flag op true zetten) moet minimaal één scenario
groen testen.

### E2.0 — shadow-mode
- Stuur testbericht "kan ik 2 weken uitstel krijgen?" vanaf test-WA.
- Verwacht: `joost_suggestions` rij met `autonomy_decision.intent = 'arrangement_request'`,
  `allow_autonomous=true` (mode=autonomous na flag-flip) of `=false`
  (mode=draft default). Geen outbound bericht.
- Check Decision Log tab — entry zichtbaar met `decision_log[]`.

### E2.1 — reactive autonomy
- Flag `e2_auto_send_text=true` + intent `ja_op_uitstel.mode='autonomous'`.
- Stuur testbericht "ja prima dat uitstel".
- Verwacht: WhatsApp-bevestigingsbericht binnen ~5 sec.
  `joost_suggestions.status='SENT_AUTONOMOUSLY'`, `sent_message_id`
  ingevuld, conv-state counters +1.
- Negatief scenario: 4e bericht op één dag → `BLOCKED_RATE_LIMIT`.

### E2.2 — outbound autonomy
- Flag `e2_outbound_cron=true` + `e2_outbound_executor=true`.
- Seed `allowed_templates` met 1 dunning-template ID.
- Trigger cron manual via curl met CRON_SECRET.
- Verwacht: `processed_count >= 1`, `sent_count >= 1` voor één
  pending dunning-run die binnen office-hours valt.
- Buiten office-hours: `blocked_count` hoger, `sent_count = 0`.

### E2.3 — pauzeer/hervat
- Open conversatie in Inbox, klik "Pauzeer Joost 24u".
- Verwacht: `joost_conversation_state.autonomy_paused_until` ingevuld,
  "Autonoom gepauzeerd" badge zichtbaar.
- Stuur testbericht binnen 24u → decision `BLOCKED_PAUSED`.
- Klik "Hervat" → `autonomy_paused_until=NULL`, volgende inbound
  weer normaal verwerkt.

### E2.4 — prompt-context
- Conv-state heeft `last_proposal_made.type='UITSTEL'`.
- Klant stuurt: "kan ik nog langer uitstel?".
- Verwacht: Joost-suggestie refereert aan vorig voorstel ("we hadden
  al afgesproken …") in plaats van blanco te beginnen.
- Verwacht: Joost stelt geen voorstel boven mandaat-cap voor (zelfs
  als klant er expliciet om vraagt).

---

## 10. Roadmap niet-in-PR items

Items die expliciet buiten deze E2-foundation vallen en in latere
sprints landen:

- **E2.5 — Per-intent mode override** in admin-UI (`mode` veld bewerken
  per intent zonder JSON te typen). Schema staat al klaar in E2.0; UI
  + validatie ontbreekt.
- **E2.6 — Arrangement-proposer auto-INSERT.** Nu maakt de engine
  alleen tasks. E2.6 laat Joost zelf `payment_arrangements` +
  `pending_actions` rijen INSERT'en als binnen mandaat én
  `auto_approve_if_within=true`. Flag `e2_arrangement_proposer` ligt
  klaar.
- **E2.7 — Multi-conversation context.** Wanneer dezelfde klant via 2+
  conversaties bezig is (info@ + administratie@), bundel state en
  zorg dat caps cumulatief gelden.
- **E2.8 — Dry-run preview in admin-UI.** Test-tool waar admin een
  fictief bericht intypt en de decision-output ziet zonder iets te
  versturen.
- **E3.0 — Outcome-driven prompt-tuning.** Op basis van
  used_as_is / used_edited / ignored ratios automatisch
  prompt-snippets aanpassen (a/b test + nightly aggregation).
- **E3.1 — Reinforcement signals.** Klant-tevredenheid /
  conversion-rate per intent meten en in confidence-drempels
  doorvoeren.

---

## 11. Bestanden in deze foundation-PR

### SQL
- `docs/sql-migrations/2026-06-09-joost-e2-autonomy-full.sql`

### API
- `api/joost-autonomy-evaluate.js` — pure evaluateAutonomy + handler
- `api/joost-autonomy-decisions-list.js` — admin Decision Log feed
- `api/joost-send-autonomous.js` — reactive send-endpoint (E2.1)
- `api/joost-outbound-send.js` — outbound template-send (E2.2)
- `api/joost-outbound-scheduler.js` — cron (E2.2)
- `api/joost-conversation-state.js` — pauze/hervat per conv (E2.3)
- `api/joost-suggest.js` — prompt-context update (E2.4)
- `api/inbox-webhook.js` — self-call hook (E2.1)

### UI
- `modules/admin.html` — Autonomy tab + Decision Log tab
- `modules/inbox.html` (of equivalent) — pauze/hervat-knop + "Joost
  actief" + "Autonoom gepauzeerd" badges
- `modules/open-acties.html` — renderers voor
  `MANUAL_PROPOSE_ARRANGEMENT` + `MANUAL_FOLLOWUP` + Joost-autonoom
  badges

### Cron (vercel.json)
- `30 8,11,14,17 * * 1-5` → `/api/joost-outbound-scheduler`

### Env-vars
- Geen nieuwe env-vars. Hergebruikt `CRON_SECRET` + `ANTHROPIC_API_KEY`
  + `SUPABASE_SERVICE_ROLE_KEY`.

---

## 12. Productie-rollout checklist

1. SQL-migratie draaien in Supabase prod (idempotent, BEGIN/COMMIT).
2. PR mergen naar main → Vercel auto-deploy.
3. Verifieer in admin-UI Joost AI → Autonomy tab dat seed-config
   zichtbaar is.
4. Verifieer dat `e2_decision_engine_logs=true` en rest `false`
   staat (shadow-mode).
5. 24-48u meekijken in Decision Log tab.
6. Per fase: één flag tegelijk omhoog zetten, smoke-test draaien,
   24u observeren, dan volgende.
7. Bij regression: flag direct terug op false; geen rollback van
   schema nodig (schema is forward-compatible).
