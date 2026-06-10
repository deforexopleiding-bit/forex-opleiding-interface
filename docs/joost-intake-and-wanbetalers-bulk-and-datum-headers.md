# Joost intake-flow + Wanbetalers bulk-start + Inbox datum-headers

Datum: 2026-06-10
Sprint: post-E2 polish-batch (E2 intake + D-module bulk + inbox UX)
Branch: `feat/batch-intake-bulk-datum`

---

## 1. Wat deze batch toevoegt

Drie kleine, onafhankelijke features die in één PR-batch landen omdat ze
elk een afgeronde slice raken en geen gedeelde state-changes hebben:

1. **Joost autonomous intake-flow (E2 intake)** — wanneer er een nieuwe
   inbound WhatsApp binnenkomt op een conversation *zonder gekoppelde
   klant*, kan Joost zelfstandig om een e-mailadres vragen en de klant
   koppelen op basis van een unieke match. Achter feature-flag
   `e2_autonomous_intake` (default UIT).
2. **Wanbetalers bulk-start-workflow** — selectie van meerdere openstaande
   facturen in `modules/wanbetalers.html` en in één klik een
   dunning-workflow starten per unieke klant. Endpoint
   `/api/wanbetalers-bulk-start-workflow.js` + UI-balk + confirm-modal.
3. **WhatsApp-stijl datum-separators in inbox** — visuele chips tussen
   message-groepen wanneer de dag-grens overschreden wordt
   (Vandaag / Gisteren / weekdag / "15 maart" / "15 maart 2025").

Geen overlap qua endpoints / RBAC / migraties, dus per-feature
deploybaar zonder volgorde-afhankelijkheid.

---

## 2. Joost autonomous intake-flow

### Flow-overzicht

`joost_conversation_state.intake_status` is de state-machine:

- `NULL`              — nog geen intake getriggerd (default).
- `asked`             — Joost heeft mail-vraag gestuurd, wacht op antwoord.
- `matched`           — klant gevonden via email-lookup en gekoppeld.
- `failed_no_match`   — mail ontvangen maar 0 of >1 hits in `customers`,
                        MANUAL_FOLLOWUP-taak aangemaakt.
- `failed_no_response`— gereserveerd voor cron (nog niet geïmplementeerd).

### Gate-check (volgorde in `api/inbox-webhook.js`)

De intake-flow draait alleen als:

1. Inbound message is text-type én net ingevoegd (geen Meta-retry).
2. `conv.customerId IS NULL` (geen phone-match in upsert-stap).
3. `getModuleContextByPhoneNumberId` resolveert naar `'finance'`.
4. `joost_config.is_enabled = true` voor module `finance`.
5. `joost_config.feature_flags.e2_autonomous_intake = true`.

Als één van deze faalt: skip intake, draai eventueel normale E1.1
auto-suggest pipeline (alleen als klant *wel* gekoppeld is).

### Vaste teksten (geen LLM-call)

Hardcoded in `inbox-webhook.js`:

- **Ask**:     `"Hi, om je goed te kunnen helpen — met welk e-mailadres ben je bij ons bekend?"`
- **Retry**:   `"Sorry, ik heb geen e-mailadres in je bericht herkend. Kun je het nogmaals opgeven?"`
- **Matched**: `"Top, ik heb je gevonden! Hoe kan ik je helpen?"`
- **Failed**:  `"Bedankt, een collega kijkt ernaar."`

Bewust geen Anthropic-call voor deze 4 zinnen — voorspelbaar, geen
kosten, geen hallucinatie-risico bij de eerste indruk. De LLM komt pas
in beeld zodra de klant gekoppeld is en de normale E1.1 Joost-suggest
flow draait.

### Email-extractie + customer-lookup

Helper-module `api/_lib/email-extractor.js`:

- `extractEmail(text)` — eenvoudige regex `[A-Za-z0-9._%+-]+@...` →
  lowercase + trim. Bewust geen RFC5322-volledigheid: dekt 99% van
  reële WhatsApp-replies en voorkomt false-positives op losse `@`.
- `findCustomerByEmail(db, email)` — `.ilike('email', target)` met
  filters `archived_at IS NULL` + `anonymized_at IS NULL`, limit 2 zodat
  we ambiguïteit (>1 hit) kunnen detecteren zonder over-fetch. Bij 0 of
  >1 hits → returnt `null`, caller stuurt failed-tekst + maakt
  MANUAL_FOLLOWUP-taak.

### Audit-events

Per stap exact 1 entry in `audit_log` via `logInboxAudit`:

- `joost.intake.message_sent` — elke outbound intake-tekst.
- `joost.intake.asked`        — eerste vraag verstuurd, state=asked.
- `joost.intake.retry`        — geen email in body, opnieuw gevraagd.
- `joost.intake.matched`      — klant gekoppeld via email.
- `joost.intake.failed_no_match` — MANUAL_FOLLOWUP-taak aangemaakt.

### Feature-flag default UIT

Migratie zet `feature_flags.e2_autonomous_intake = false` op de
finance-row. Aanzetten via admin-UI of direct SQL UPDATE op
`joost_config`. Defense-in-depth: webhook-handler checkt flag bij elke
inbound (geen module-state-caching).

---

## 3. Wanbetalers bulk-start-workflow

### Endpoint shape

`POST /api/wanbetalers-bulk-start-workflow.js`:

```json
{ "invoice_ids": ["<uuid>", ...] }   // 1..100 per call
```

Response (HTTP 200 ok / 207 multi-status / 400 / 403):

```json
{
  "total": 12,
  "added":   [{ "customer_id": "...", "run_id": "...", "invoice_count": 2 }],
  "skipped": [{ "invoice_id": "...", "customer_id": "...", "reason": "already_active_run" }],
  "errors":  [{ "invoice_id": "...", "reason": "no_workflow_match" }]
}
```

### Idempotency + dedupe-semantiek

- Sequentieel per invoice (try/catch per item — Lessons Learned #3, geen
  early-return op één faal).
- Server-side aggregeren per `customer_id`: meerdere geselecteerde
  facturen voor dezelfde klant resulteren in **1 dunning_workflow_run**
  met `trigger_invoice_count = aantal-voor-die-klant`.
- Hard gate: klant heeft al een `status='active'`-run → alle invoices
  van die klant naar `skipped[]` met `reason='already_active_run'`.
- `min_days_overdue` + `min_total_amount` in workflow-trigger-conditions
  worden **bewust genegeerd** bij handmatige bulk-start (medewerker heeft
  expliciet geselecteerd).

### RBAC

`finance.dunning.execute` (zelfde permission als de single-start-knop).
Endpoint vereist Bearer-JWT via `createUserClient`; `requirePermission`
returnt 403 bij gebrek.

### Audit

- 1 aggregate `audit_log` entry per call: `finance_dunning_run.bulk_start`
  met `after_json` = counts + invoice_ids[].
- Per gestarte run extra `dunning_log` entry met
  `event_type='started'` + `payload.trigger='manual_bulk'` +
  `triggered_by_user_id` + `workflow_id` + `invoice_ids[]`.

### UI

`modules/wanbetalers.html`:

- Checkbox-kolom + actie-balk die verschijnt zodra ≥1 rij geselecteerd
  is (sticky top, brand-soft achtergrond).
- Confirm-modal met preview ("Start dunning-workflow voor N facturen
  (M unieke klanten)?") en error-render bij 207-response.
- Filter-pills bovenaan voor `open`/`overdue`/`partially_paid` met
  default `open` (meest-gebruikte).

---

## 4. WhatsApp-stijl datum-separators in inbox

### Format-rules

`_inboxFormatDateHeader(iso, refDate)` in `modules/finance.html`:

- `dayDiff = 0`       → `"Vandaag"`
- `dayDiff = 1`       → `"Gisteren"`
- `1 < dayDiff < 7`   → Nederlandse weekdag (`"Maandag"` ... `"Zondag"`)
- `dayDiff >= 7`,
  zelfde jaar          → `"15 maart"`
- ander jaar          → `"15 maart 2025"`

### Day-grouping key

`_inboxLocalDayKey(iso)` returnt `YYYY-MM-DD` op basis van
`getFullYear/Month/Date` — **niet** `toISOString().split('T')[0]`. Dat
laatste introduceert UTC off-by-one bij timezone-grens (Lessons Learned
19 mei 2026: WhatsApp om 23:30 NL-tijd zou bij UTC-conversie de volgende
dag landen).

### Same-sender reset

Bij elke day-grens reset `sameSender` naar `false`, zodat de eerste
bubble onder de chip altijd zijn tail-corner krijgt — consistent met
WhatsApp's visuele scheiding.

### Render-pad

In `renderInboxMessages()`:
1. `_lastDayKey` cursor over `_inboxMessages` array.
2. Per message: bereken `curDayKey`; als `!== _lastDayKey` → prepend
   `<div class="inbox-c-date-separator">` chip.
3. Update `_lastDayKey`.

Geen extra DB-call of payload-shape — puur rendering op bestaande
`sent_at` / `created_at` velden.

---

## 5. SQL post-merge stappen

1. Run `docs/sql-migrations/2026-06-10-joost-intake-and-wanbetalers-bulk.sql`
   in Supabase SQL Editor.
2. Verify-queries onderaan migratie:
   ```sql
   SELECT module, feature_flags->'e2_autonomous_intake' AS intake_flag
     FROM joost_config WHERE module = 'finance';
   -- verwacht: false (flag staat default UIT)

   SELECT column_name, data_type, column_default
     FROM information_schema.columns
    WHERE table_name = 'joost_conversation_state'
      AND column_name IN ('intake_status', 'intake_asked_at');
   -- verwacht: 2 rijen (text + timestamptz, beide DEFAULT NULL)
   ```
3. Geen wijziging nodig voor wanbetalers-bulk — endpoint gebruikt
   bestaande `dunning_workflow_runs` + `dunning_log` + `audit_log`.
4. Geen wijziging nodig voor datum-separators — frontend-only.

---

## 6. Smoke checklist per feature

### Joost intake-flow (vereist flag AAN)

- [ ] Zet `feature_flags.e2_autonomous_intake = true` op finance-row.
- [ ] Stuur WhatsApp vanaf onbekend nummer naar finance-lijn (geen
      bestaande klant met die `phone`).
- [ ] Verifieer ask-tekst arriveert + `intake_status='asked'` in
      `joost_conversation_state`.
- [ ] Antwoord met `"Mijn e-mail is test@klant.nl"` waar `test@klant.nl`
      precies 1 actieve klant matched.
- [ ] Verifieer matched-tekst + `conversation.customer_id` gevuld +
      `intake_status='matched'` + `audit_log.joost.intake.matched`.
- [ ] Herhaal met email die 0 hits geeft → failed-tekst +
      MANUAL_FOLLOWUP in `pending_actions` + `intake_status='failed_no_match'`.
- [ ] Herhaal met flag UIT → geen intake, normale unmatched-flow.

### Wanbetalers bulk-start

- [ ] Open `/modules/wanbetalers.html`, filter op `overdue`.
- [ ] Vink 3 facturen aan waarvan 2 dezelfde klant zijn → balk toont "3
      facturen geselecteerd (2 klanten)".
- [ ] Klik "Start workflow" → confirm-modal preview correct.
- [ ] Confirm → toast `added=2 / skipped=0 / errors=0`; verifieer 2
      nieuwe rijen in `dunning_workflow_runs` (status `active`) +
      `dunning_log` entries met `trigger='manual_bulk'`.
- [ ] Vink een 4e factuur van klant met al actieve run → response
      `skipped[].reason='already_active_run'`.
- [ ] Test 403: gebruiker zonder `finance.dunning.execute` → 403 +
      knop verborgen / disabled in UI.

### Inbox datum-separators

- [ ] Open conversation met messages over meerdere dagen heen.
- [ ] Verifieer chips: nieuwste groep → "Vandaag"; vorige dag →
      "Gisteren"; binnen 7 dagen → weekdag-naam NL.
- [ ] Verifieer chip > 7 dagen geleden → "15 maart" (zonder jaar als
      zelfde jaar) of "15 maart 2025" (ander jaar).
- [ ] Verifieer eerste bubble na chip krijgt tail-corner (geen
      `same-sender` styling) ook al was vorige bubble dezelfde direction.
- [ ] Test timezone-grens: message om 23:45 NL-tijd → chip Vandaag,
      message 5 min later om 00:10 → nieuwe chip "Vandaag" (volgende
      dag), niet één gemerged blok.
