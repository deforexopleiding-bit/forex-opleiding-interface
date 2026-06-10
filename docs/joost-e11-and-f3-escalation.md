# Joost E1.1 auto-suggest + F3 MANUAL_ESCALATION

Datum: 2026-06-10
Sprint: E1.1 (webhook auto-suggest) + F3 (escalation-task fundament)
Branch: `feat/joost-e11-autoSuggest-and-f3-escalation`

---

## 1. Wat deze sprint oplost

Twee parallelle features die elkaar versterken in de Finance Inbox:

- **E1.1 auto-suggest** — een inbound klant-WhatsApp triggert direct een
  Joost-suggestie via `inbox-webhook` (fire-and-forget). Zodra de
  medewerker de conversatie opent staat de suggestie al klaar — geen
  klik op "Vraag Joost" meer nodig voor de meeste gevallen.
- **F3 MANUAL_ESCALATION** — een nieuwe `action_type` voor `pending_actions`
  voor escalaties die geen TL-actie en geen verify-payment zijn maar
  wel een mens vereisen (boos / juridisch / handover naar incasso).
  De escalatie verschijnt als zelfstandige taak in Open Acties met
  een eigen severity en outcome-model.

De twee features delen één migratie
(`docs/sql-migrations/2026-06-10-joost-e11-autosuggest-and-f3-escalation.sql`)
omdat F3 mede getriggerd wordt vanuit een Joost-suggestie met
`detected_intent='escalation_needed'` — `joost-create-task-from-suggestion`
en `tasks-create-escalation` zijn beide entrypoints naar dezelfde
pending_action-row.

---

## 2. E1.1 — auto-suggest webhook flow

```
 Meta WhatsApp Cloud API
        │  POST /api/inbox-webhook  { messages: [...] }
        ▼
 inbox-webhook persisteert message + upsert conversation
        │
        │  (alle filter-checks slagen — zie §3)
        ▼
 triggerJoostAutoSuggest()  [fire-and-forget fetch]
        │
        │  POST /api/joost-suggest
        │  Headers: X-Internal-Token: <INTERNAL_API_TOKEN>
        │  Body:    { conversation_id, triggered_by_message_id, auto_triggered:true }
        ▼
 joost-suggest skipt user-JWT + RBAC (internal-call branch)
   - resolvet module + context-snapshot
   - genereert Anthropic-suggestie via tool-use
   - INSERT joost_suggestions { auto_triggered:true, requested_by_user_id:NULL, status:'PROPOSED' }
        │
        ▼
 Frontend (inbox) laadt recente PROPOSED-suggestie bij conversation-open
 via /api/joost-suggestions-recent en toont badge "auto-gesuggereerd"
```

Belangrijk: de webhook blijft binnen het Meta-budget (200 OK binnen ~5s).
De fetch naar `joost-suggest` is **niet awaited** in de webhook-handler —
de helper retourneert direct na het opzetten van de promise. Het resultaat
landt asynchroon in `joost_suggestions`; de webhook is dan al lang klaar.

---

## 3. Filter-rules (anti-loop + cost-control)

`inbox-webhook.js` doet zeven sequentiele checks vóór auto-trigger. Alle
moeten waar zijn — bij eerste `false` wordt de trigger overgeslagen
zonder error.

| # | Check                                  | Waarom                                                                   |
|---|---|---|
| a | `insRes.inserted === true`             | Geen Meta-retry: skip bij duplicate-message (idempotency op `meta_wamid`).|
| b | `insRes.type === 'text'`               | Skip media / button / interactive / system — alleen platte tekst.        |
| c | `body.trim().length >= 5`              | Skip ultra-korte berichten ("ok", "ja") — niet zinvol voor Joost.        |
| d | `!TRIVIAL_REPLIES.has(body.toLowerCase())` | Hard-list van trivial replies (`ok`, `ja`, `nee`, `top`, `prima`, `thx`…). |
| e | `conv.customerId !== null`             | Skip ongekoppelde conversaties — Joost heeft klant-context nodig.        |
| f | `module === 'finance'` + `joost_config.is_enabled === true` | E1.1 scope: alleen finance. Per-module kill-switch via `joost_config`.   |
| g | `hasNoRecentOutbound(conv.id, 60)`     | Anti-loop: skip als wij binnen 60s een outbound stuurden — klant antwoordt op ons. |

De anti-loop check (g) is de belangrijkste guard tegen het pingpong-scenario
waarin onze eigen outbound een Joost-suggestie zou triggeren omdat de klant
binnen seconden teruggrillt. Combineert met de 30s rate-limit in
`joost-suggest` (§7 in `docs/joost-e10-foundation.md`) als tweede laag —
mocht (g) door een race ooit doorglippen, dan stopt de rate-limit alsnog
het tweede Anthropic-call.

Trivial-replies-set wordt bewust hardcoded gehouden i.p.v. config-driven:
het is een micro-optimalisatie tegen Anthropic-kosten waar tuning per
deploy niet relevant is. Bij toevoeging van nieuwe NL-trivials: edit de
`TRIVIAL_REPLIES`-constante en deploy.

---

## 4. Fire-and-forget pattern + INTERNAL_API_TOKEN

### Fire-and-forget rationale

Vercel Node-runtime heeft **geen** `ctx.waitUntil()` zoals Edge of
Cloudflare Workers. We hebben dus geen formele primitive om een
"background promise" te markeren die nog mag voltooien nadat `res.json()`
is gestuurd. Wat we wel hebben: Vercel houdt de Lambda-context typisch
warm zolang er open promises zijn. Dit is **best-effort**, geen contract.

Het patroon dat we kiezen:

```js
function triggerJoostAutoSuggest({ conversationId, triggeredByMessageId }) {
  // ... env-var checks, base-url-resolve ...
  fetch(url, { /* headers + body */ })
    .then(async (resp) => { if (!resp.ok) console.warn(...); })
    .catch((e) => console.warn('[inbox-webhook] fetch fail:', e?.message));
}
```

Bewuste keuzes:

1. **Geen `await`** in de webhook-caller — als we awaited, dan blokkeerde
   de Meta-response op de Anthropic-call (kan 3s duren). Geen optie:
   Meta retried bij >5s respons.
2. **`.catch()` op de promise** — anders worden rejections unhandled
   en kan de Lambda silenced crashen. Console.warn is voldoende; auto-suggest
   is non-critical.
3. **Geen retry-logica in de caller** — als de fetch faalt, accepteren we
   het. De medewerker kan altijd nog handmatig "Vraag Joost" klikken.
4. **Acceptatie van occasionally-dropped suggestions** — bij Lambda
   cold-shutdown verliezen we soms een suggestie. Acceptabel voor MVP.
   E2 zal naar een queue-based pattern moeten (Inngest / QStash / Vercel cron)
   als autonomous send live gaat — daar is verlies niet acceptabel.

### INTERNAL_API_TOKEN voor service-to-service auth

`joost-suggest` heeft normaal een Bearer-JWT + RBAC nodig
(`finance.joost.use`). Voor de webhook-self-call is geen user-sessie
beschikbaar — Meta is de "user". We introduceren een **service-token
pattern**:

```js
// joost-suggest.js auth-block
const internalTokenHeader   = req.headers['x-internal-token'] || null;
const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
const isInternalCall = !!(
  internalTokenHeader && expectedInternalToken &&
  internalTokenHeader === expectedInternalToken
);

if (isInternalCall) {
  // Skip user-JWT + RBAC. requested_by_user_id wordt NULL.
} else {
  // Normale JWT-flow + permission-check.
}
```

Voordelen boven alternatieven:

- **Geen self-signed JWT nodig** — we hoeven geen "system-user" in
  `auth.users` aan te maken en JWT's te tekenen. Simpel shared secret.
- **Eenvoudig te roteren** — env-var update in Vercel, redeploy. Geen
  user-management.
- **Duidelijk audit-spoor** — `requested_by_user_id IS NULL` +
  `auto_triggered=true` markeert system-triggered rijen.

Risico's en mitigaties:

- **Token-leak via logs** — `INTERNAL_API_TOKEN` mag NOOIT in
  console.log of error-text verschijnen. Defensive: log alleen
  `INTERNAL_API_TOKEN ontbreekt` (sentinel), nooit de waarde.
- **Token-leak via request-replay** — server-only env-var, alleen
  bekend op Vercel-runtime. Niet bereikbaar vanuit browser of Meta.
- **Verwarring met user-tokens** — header-name `X-Internal-Token`
  duidelijk anders dan `Authorization: Bearer`.

Setup in Vercel: voeg `INTERNAL_API_TOKEN` toe als **Sensitive** env-var
in alle environments. Waarde: random 32+ byte hex/base64. Backup in
1Password. Bij ontbreken: webhook logt warning + skipt auto-trigger
(geen runtime-crash).

---

## 5. F3 MANUAL_ESCALATION — payload + severity

### Action-type registry

`api/_lib/task-types.js`:

```js
TASK_ACTION_TYPES = {
  // ...
  MANUAL_ESCALATION: 'escalation',
};
TASK_CATEGORY = {
  // ...
  escalation: 'Escalaties',
};
```

Open Acties krijgt een nieuwe filter-pill **Escalaties** naast Regelingen
en Betalingsclaims. `tasks-list` discrimineert automatisch via de
`category`-param zonder extra UI-code (zie Lesson learned 21).

### Endpoint + body

`POST /api/tasks-create-escalation` — body:

```json
{
  "conversation_id":         "uuid (verplicht)",
  "reason":                  "string (verplicht, min 10 chars)",
  "triggered_by_message_id": "uuid (optioneel)",
  "joost_suggestion_id":     "uuid (optioneel — als via Joost-card)",
  "severity":                "low | medium | high (default medium)",
  "context_summary":         "string (optioneel, max 2000 chars)"
}
```

Permission: `finance.tasks.create` met fallback `finance.joost.use` (zodat
de meest voorkomende trigger — een Joost-suggestie met
`detected_intent='escalation_needed'` — werkt zonder extra rol-config).

Customer-resolutie via `conversation.customer_id` — verplicht gevuld.
Niet-gekoppelde conversaties moeten eerst handmatig aan een klant
gekoppeld via `inbox-link-conversation` (zie F1 polish).

### Payload-shape (jsonb)

```json
{
  "reason":                  "klant dreigt met advocaat en weigert te betalen",
  "conversation_id":         "uuid",
  "triggered_by_message_id": "uuid | null",
  "joost_suggestion_id":     "uuid | null",
  "severity":                "high",
  "context_summary":         "Klant blijft volhouden dat de factuur niet klopt — al 3x toegelicht.",
  "source":                  "joost | manual",
  "escalated_at":            "ISO-timestamp",
  "rationale":               "escalatie aangevraagd vanuit Finance Inbox - handmatige opvolging nodig"
}
```

`source` discrimineert tussen Joost-card-trigger (`joost`) en handmatige
admin-klik op de escaleer-knop in de inbox header (`manual`). Frontend
gebruikt dit om in de detail-modal een dossier-link terug naar de
Joost-suggestie te tonen (analoog aan E1.2 verify-payment dossier-link).

### Severity-levels

| Severity | Wanneer                                                                  | Default UI-styling                          |
|---|---|---|
| `low`    | Lichte irritatie, geen juridisch risico — sentiment-check voor manager.  | Neutrale pill grijs.                        |
| `medium` | Default — duidelijke escalatie maar nog geen acute juridische dreiging. | Amber pill.                                 |
| `high`   | Bedreiging, advocaat, incasso, dreiging publiek negatieve review.        | Rode pill — bovenaan Open Acties geprior.   |

Validatie server-side: alleen lowercase enum-waarden geaccepteerd; ongeldige
waarden krijgen 400. Default `medium` bij ontbreken.

---

## 6. Outcome-model: resolved / handed_over / ongoing

`MANUAL_ESCALATION`-rijen starten in `status='PENDING'` (geen
approval-stap — een escalation IS de taak). De uitkomst wordt vastgelegd
via `pending-actions-mark-executed` met een aangepast `execution_result`-shape:

```json
{
  "id": "<pending_action_id>",
  "execution_result": {
    "outcome":         "resolved | handed_over | ongoing (verplicht)",
    "handed_over_to":  "string (optioneel, max 200 — naam/email van overdracht)",
    "manual_notes":    "string (min 10 chars, verplicht)"
  }
}
```

| Outcome       | Status-transitie       | Wanneer kiezen                                                           |
|---|---|---|
| `resolved`    | PENDING -> EXECUTED    | Escalation opgelost binnen het team (de-escalatie gelukt, klant tevreden).|
| `handed_over` | PENDING -> EXECUTED    | Doorgegeven aan extern persoon (advocaat / incassobureau / Jeffrey 1-op-1). |
| `ongoing`    | **Blijft PENDING**     | Voortgang loggen zonder de taak af te sluiten. `execution_result.progress_log[]` krijgt een append-entry. |

De `ongoing`-flow is bewust een mark-executed-call met blijvende PENDING-status:
het hergebruikt de bestaande mark-executed RBAC + audit-trail zonder een
nieuw endpoint te vereisen. De UI toont voor een PENDING-escalation met
`execution_result.progress_log` de log-entries chronologisch in de
detail-modal.

`mark-not-executed` blijft ook beschikbaar voor het zeldzame geval dat een
escalation onterecht is aangemaakt en gewoon weg moet (`FAILED` met reden).

Cascade-semantiek: `arrangement_id IS NULL` voor MANUAL_ESCALATION (geen
arrangement gekoppeld). De arrangement-cascade in `mark-executed` wordt
automatisch overgeslagen — geen extra guard nodig (zie F1 §5).

---

## 7. UX — auto-suggested badge + escalation quick-modal

### Auto-suggested badge (inbox)

Wanneer een conversation wordt geopend, fetcht het Joost-panel via
`/api/joost-suggestions-recent` de meest recente PROPOSED-suggestie binnen
het rate-window. Als die `auto_triggered=true` heeft, toont de
suggestion-card een extra badge:

> [auto-gesuggereerd] · 2 min geleden

Bedoeling: de medewerker ziet direct dat Joost al heeft meegekeken zonder
expliciete actie. Geen extra klik, geen wachttijd op een Anthropic-call.

De badge is informatief, niet functioneel — alle 3 standaard-acties
(Plak / Plak en bewerk / Negeer) blijven werken zoals bij handmatige
suggesties. De E1.2 contextuele actie-knoppen (verify-task /
arrangement-wizard / escaleer) verschijnen ook bij auto-suggested
cards — dezelfde intent-based routing.

### Escalation quick-modal

Vanuit de Joost suggestion-card bij `detected_intent='escalation_needed'`:
**Escaleer**-knop opent een modal met:

- Voorgevulde `reason` = Joost's `reasoning` veld (medewerker kan editen).
- `severity` dropdown (default `medium`).
- Optionele `context_summary` (vrije tekst).
- Confirmatie + POST naar `tasks-create-escalation` met
  `joost_suggestion_id` mee.
- Bij succes: joost_suggestion krijgt `USED_TASK_CREATED` +
  `linked_task_id`, suggestion-card sluit, toast "Escalation aangemaakt
  in Open Acties".

Zonder Joost-card: de inbox conversation-header heeft een aparte
**Escaleer**-knop die dezelfde modal opent maar zonder
`joost_suggestion_id` (source = `manual`).

### Open Acties Escalaties-filter + detail-modal

`/modules/open-acties.html` krijgt een filter-pill **Escalaties** naast
de bestaande. De detail-modal voor een MANUAL_ESCALATION-row toont:

- Klant + conversation-link (dossier-link).
- Severity-pill kleur-gecodeerd.
- `reason` + `context_summary` als read-only blokken.
- Progress-log (als `ongoing`-outcomes geregistreerd zijn).
- Outcome-keuze: resolved / handed_over / ongoing.
- Bij `handed_over`: extra veld `handed_over_to` (optioneel).
- Manual notes (min 10 chars, verplicht).

Als de escalation uit een Joost-suggestie komt: extra blok met
`detected_intent` + `confidence` + originele suggestie-tekst (analoog aan
E1.2 verify-payment dossier).

---

## 8. Roadmap: E2 autonomy + F4 MANUAL_FOLLOWUP

| Sprint | Scope | Status |
|---|---|---|
| **E1.0** | Joost foundation (config + suggest + outcome + admin UI, handmatige trigger) | live |
| **E1.1** | Auto-suggest bij inbound webhook, fire-and-forget pattern, INTERNAL_API_TOKEN | **deze sprint** |
| **E1.2** | Intent-to-task linking (verify_payment / arrangement_request / escalation_needed) | live |
| **E2**   | Autonomous send + auto-task — Joost mag bij `confidence>=0.90` + intent in safe-list zelfstandig een actie uitvoeren (versturen of pending_action aanmaken) zonder mens-in-de-loop. Per-module kill-switch + hard cap + outcome-tracking binnen 24u. | TODO |
| **F1**   | Centraal Open Acties + MANUAL_VERIFY_PAYMENT | live |
| **F2**   | MANUAL_PROPOSE_ARRANGEMENT — Joost detecteert wanbetaler-pattern + stelt arrangement voor | TODO |
| **F3**   | MANUAL_ESCALATION — standalone escalation-task | **deze sprint** |
| **F4**   | MANUAL_FOLLOWUP — generieke follow-up met `due_at` + `assignee_user_id`. Komt uit agent-prompts ("vraag Jeffrey of...") + handmatige knop in klant-detail. Vereist eerste assignee-routing logica + reminder-cron. | TODO |

Belangrijke randvoorwaarden voor E2:
- `joost_send_outcomes` log-tabel met klant-respons binnen 24u als signal.
- Per-module hard cap (max 10 autonomous acts per uur platform-breed).
- Kill-switch via `joost_config.is_enabled = false` blijft hoogste prioriteit.
- Opt-in per intent-type via `joost_config.autonomous_intents` jsonb-array.

Belangrijke randvoorwaarden voor F4:
- Schema-uitbreiding `pending_actions.assignee_user_id` (FK profiles) +
  `due_at` (timestamptz, optioneel) + index op `(assignee_user_id, status)`.
- Reminder-cron die 24u voor `due_at` een notificatie/badge geeft aan de
  assignee.
- Generieke create-endpoint `tasks-create-followup` met validatie op
  due-date in toekomst.

---

## 9. Bekende beperkingen E1.1 + F3

- **Lambda cold-shutdown verliest suggesties** — fire-and-forget biedt geen
  garanties. Bij verlies kan de medewerker altijd handmatig "Vraag Joost"
  klikken. Pas in E2 vervangen door queue-based als autonomous live gaat.
- **E1.1 alleen finance-module** — auto-suggest skipt non-finance lijnen
  (e-mail, andere WhatsApp-bedrijven) tot per-module config-uitbreiding.
- **Geen severity-auto-detect uit Joost** — escalation-knop opent met
  default `medium`; Joost beoordeelt geen severity zelf. Toekomstige
  uitbreiding kan `detected_severity` toevoegen aan het structured-output
  schema.
- **Progress-log heeft geen UI-edit** — `ongoing`-entries verschijnen
  read-only in de detail-modal. Per-entry verwijderen of bewerken vereist
  raw DB-toegang. Voor F3 acceptabel; F4 herziet als nodig.
- **Geen email-inbox escalation-knop** — F3 levert alleen WhatsApp-flow.
  E-mail krijgt dezelfde knop in F4.
