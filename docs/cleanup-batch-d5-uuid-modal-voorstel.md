# Cleanup-batch — D5 + UUID-relax + Cancel-modal + VOORSTEL-preview (10 juni 2026)

Vier samenhangende fixes op de payment-arrangements / approval-queue / verify-
payment flow. Geen feature-PR; pure polish + één feature-toevoeging (D5
breach-detection cron). Branch: `fix/cleanup-batch-d5-uuid-modal-voorstel`.

## Overzicht van de 4 fixes

| # | Commit    | Type    | Wat                                                                              |
|---|-----------|---------|----------------------------------------------------------------------------------|
| 1 | `1f08bea` | fix     | `matched_transaction_id` accepteert non-UUID handmatige TL-referenties           |
| 2 | `b0f5f23` | feat    | D5 breach-detection cron + dunning auto-pause bij ACTIEF arrangement             |
| 3 | `b793f21` | fix     | DOM-modal voor "Annuleer arrangement" ipv `window.confirm` + `window.prompt`     |
| 4 | `528114e` | fix     | Approval-queue VOORSTEL-kolom toont type-specifieke preview ipv "(geen payload)" |

## 1. D5 breach-detection — type-specifieke logic per arrangement-type

Volledige docs voor het D-spoor: [`payment-arrangements-d1-foundation.md`](payment-arrangements-d1-foundation.md).
Toegevoegd in deze batch: `api/cron-arrangements-breach-check.js` + dagelijkse
cron `0 6 * * *` (Vercel UTC, dus 07:00/08:00 NL-tijd afhankelijk van DST).

### Logic per type

| type                | deadline-bron (jsonb path)                  | NAGEKOMEN als …                              | VERBROKEN als …                            |
|---------------------|---------------------------------------------|----------------------------------------------|--------------------------------------------|
| `UITSTEL`           | `details.ends_on` (legacy `new_due_date`)   | deadline verstreken + alle invoices `paid`   | deadline verstreken + >=1 invoice open     |
| `SPLITSING`         | `details.parts[].due_date` (per termijn)    | alle invoices `paid`                         | oudste verstreken `part.due_date` + niet alles paid |
| `ABONNEMENT_PAUZE`  | `details.pause_until`                       | `pause_until` verstreken                     | n.v.t. (pauze = lopend tot afloop)         |
| `ABONNEMENT_STOP`   | n.v.t. (final action)                       | n.v.t. — mark-executed cascade zet status    | n.v.t.                                     |
| `KWIJTSCHELDING`    | n.v.t. (final action)                       | n.v.t. — mark-executed cascade zet status    | n.v.t.                                     |

Belangrijke ontwerp-keuze: **de deadline-bron verschilt per type**, dus er is
geen generieke `details.deadline_at`-kolom waarop één query kan filteren. De
cron moet per arrangement in JS de juiste path uit `details` lezen. Zie
Lesson Learned 25 in CLAUDE.md.

### Schedule + auth

- Cron path: `/api/cron-arrangements-breach-check`
- Schedule: `0 6 * * *` (dagelijks 06:00 UTC, ~08:00 NL zomertijd)
- Auth: `Authorization: Bearer $CRON_SECRET` via `checkCronAuth()` (zelfde
  pattern als `cron-dunning-engine` en `cron-finance-sync`).
- Time-budget: 50 sec abort (Vercel hard timeout 60 sec).
- Per state-change één audit-log row (`finance.arrangement.breach_check_state_change`)
  + één summary-row aan het eind (`cron.arrangements_breach_check_run`).
- Handmatige trigger mogelijk via POST (debug).

### Workflow auto-pause regel

Toegevoegd in `api/_lib/dunning-engine.js`. Invoices die in een ACTIEF
arrangement (UPPERCASE of legacy lowercase) zitten worden uit `fetchOpenInvoices()`
gefilterd vóór de engine ze in een dunning-step laat lopen. Fail-soft: bij DB-
issue logt de helper en valt terug op de ongefilterde set (geen complete
cron-stop wegens één hick-up).

Rationale: zolang een klant een goedgekeurde betaalafspraak heeft mag de
dunning-engine geen reminders, escalaties of WhatsApp-templates op die
factuur sturen. Bij `VERBROKEN` / `NAGEKOMEN` / `GEANNULEERD` valt de invoice
vanzelf weer in scope.

## 2. UUID-relax — `matched_transaction_id`

Smoke-test van de verify-payment flow vond op 10 juni dat een TL-referentie
als `TL-12345` of `BANK_REF_2026_001` werd geweigerd door een strikte UUID-
regex check in `pending-actions-mark-executed.js`. Dat blokkeerde verifiers
die handmatig (zonder bank-koppeling) een transactie-ID willen vastleggen.

Fix: vervang `UUID_RE.test(txId)` door `txId.length <= 64 && /^[A-Za-z0-9_-]+$/`.
Beperking: max 64 chars + alphanumerieke + `_` / `-`. Bestaande UUID-waarden
matchen vanzelf (geen backfill nodig). Foutmelding aangepast naar het nieuwe
contract.

## 3. Cancel-modal — DOM ipv native `confirm` + `prompt`

Tot deze cleanup gebruikte `/modules/finance.html` voor "Annuleer
arrangement" een combinatie van `window.confirm()` (alle browsers) +
`window.prompt()` voor de reden. Twee UX-problemen:

1. **Geen styling** — de native modals breken het dashboard-thema.
2. **Geen min-length validatie op de reden** — een lege of "x" reden
   verdween in de audit-trail.

Vervangen door een DOM-modal `#cancelArrangementModal` met:
- Klant + arrangement-context in de header (read-only block).
- Reden-textarea met live-validatie (≥ 5 chars → confirm-button enabled).
- Error-box voor 4xx-responses van `arrangements-cancel`.
- Esc / overlay-click / X-knop sluiten allemaal de modal.

## 4. VOORSTEL-kolom — type-specifieke preview

Approval-queue in `/modules/admin.html` toonde `(geen payload)` voor TL_-
actions die hun payload-keys niet in de oude `approvSummary()`-hardcoded
key-list hadden staan. Vervangen door `renderActionPreview()` met een
switch per `action_type`.

### Preview-mapping per action_type

| action_type                          | Preview-format                                    |
|--------------------------------------|---------------------------------------------------|
| `TL_INVOICE_CONSOLIDATE_AND_RESTART` | `Credit N factu(u)r(en) + nieuw abonnement`       |
| `TL_INVOICE_UPDATE_DUE`              | `Verleng vervaldatum <invoice> naar <date>`       |
| `TL_INVOICE_SPLIT`                   | `Splits <invoice> in N termijnen`                 |
| `TL_SUBSCRIPTION_PAUSE`              | `Pauzeer abonnement tot <date>`                   |
| `TL_SUBSCRIPTION_STOP`               | `Stop abonnement per <date>`                      |
| `TL_INVOICE_WRITEOFF`                | `Schrijf <invoice> af`                            |
| `MANUAL_VERIFY_PAYMENT`              | `Verifieer claim <invoice>`                       |
| `MANUAL_ESCALATION`                  | `Escalatie (severity: <sev>)`                     |
| `MANUAL_PROPOSE_ARRANGEMENT`         | `Voorstel afspraak <klant>` (klant truncated 30c) |
| `MANUAL_FOLLOWUP`                    | `Follow-up bericht <klant>` (klant truncated 30c) |
| onbekend                             | humanized action_type (`tl invoice split`)        |

Invoice-nummer komt uit embedded `action.invoice.invoice_number` (tasks-list
join-pattern) of fallback op `#<uuid-prefix-8>`. `pending-actions-list`
joint geen invoices, dus voor TL_-types is de fallback de norm — bewust,
omdat de korte preview leunt op counts/dates en niet op nummer.

## Smoke-checklist

- [ ] D5 cron handmatig triggeren via `POST /api/cron-arrangements-breach-check`
      met `Authorization: Bearer $CRON_SECRET` → JSON-summary returnt.
- [ ] UITSTEL met `ends_on` in verleden + 1 paid invoice → status wordt `NAGEKOMEN`.
- [ ] UITSTEL met `ends_on` in verleden + 1 open invoice → status wordt `VERBROKEN`.
- [ ] SPLITSING met `parts[0].due_date` in verleden + niet alle paid → `VERBROKEN`.
- [ ] ABONNEMENT_PAUZE met `pause_until` in verleden → `NAGEKOMEN`.
- [ ] Dunning-engine: invoice in ACTIEF arrangement verschijnt niet in `fetchOpenInvoices()`.
- [ ] Verify-payment: `matched_transaction_id=TL-12345` accepteert (200).
- [ ] Verify-payment: `matched_transaction_id=<spatie>` of >64 chars → 400.
- [ ] Annuleer-modal opent vanuit arrangement-detail; reden < 5 chars → disabled.
- [ ] Annuleer-modal: Esc / overlay / X-knop sluiten allemaal.
- [ ] Approval-queue VOORSTEL-kolom toont `Verleng vervaldatum … naar YYYY-MM-DD`
      voor `TL_INVOICE_UPDATE_DUE` rij (niet meer `(geen payload)`).
- [ ] Approval-queue VOORSTEL-kolom fallback toont humanized type voor onbekende rij.
