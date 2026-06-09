# Taken-module — F1 Foundation

Datum: 2026-06-09
Sprint: F1 (centraal taken-dashboard + verify_payment vanuit inbox)
Branch: `feat/payment-arrangements-d16-manual-execute`

---

## 1. Wat F1 doet

F1 introduceert `/modules/open-acties.html` als **centraal dashboard voor alle
handmatige verificaties** die op het bordje van administratie/manager liggen.
(NB: oorspronkelijk geland onder `/modules/taken.html`, maar dat conflicteerde
met de bestaande Takenbeheer kanban-module. Hernoemd naar `open-acties.html`
in fix/taken-naming-conflict; oude Takenbeheer is hersteld.)
Tot nu toe leefde de approval-queue alleen in `admin.html#approval-queue` met
focus op D1-arrangements. F1 verbreedt dat naar een echt taken-bakje dat ook
losse verificatie-stappen toont die niet aan een arrangement hangen.

Concreet biedt F1:

1. **Centrale lijst** — één tabel die alle `pending_actions` toont (zowel
   arrangement-stappen als standalone verify-taken) met filter-pills per
   status (PENDING/APPROVED/EXECUTED/REJECTED/FAILED/CANCELLED) en per
   categorie (arrangement / verify_payment).
2. **Klant-claim flow uit inbox** — knop "Klant claimt betaald" in de
   WhatsApp-inbox conversation header. Pre-fillt customer + open facturen,
   maakt `MANUAL_VERIFY_PAYMENT` pending_action aan zonder arrangement.
3. **Detail-modal** met joins op customer + arrangement + invoice, en
   mark-executed / mark-not-executed knoppen.

Wat F1 expliciet NIET doet: agent-gedreven taken (Joost, escalaties,
follow-ups). Die staan op de roadmap (§5).

---

## 2. Twee task-categorieën in F1

`tasks-list` discrimineert op `action_type` via `category`-param:

| Category         | action_type-patroon              | Source                                |
|---|---|---|
| `arrangement`    | `TL_*` (alle D1 TL_-prefix acties) | `arrangements-propose` (wizard)       |
| `verify_payment` | `MANUAL_VERIFY_PAYMENT`            | `tasks-create-verify-payment` (inbox) |

Beide categorieën leven in dezelfde `pending_actions`-tabel — de UI biedt
filter-pills die client-side de URL-query bijwerken.

---

## 3. Endpoints + RBAC

| Endpoint                                    | Methode | Doel                                   | Permission key                   |
|---|---|---|---|
| `/api/tasks-list`                           | GET     | Paginated lijst + counts (status+cat)  | `finance.tasks.view` *           |
| `/api/tasks-create-verify-payment`          | POST    | MANUAL_VERIFY_PAYMENT aanmaken         | `finance.tasks.create` *         |
| `/api/pending-actions-detail`               | GET     | Detail (1 task) — gedeeld met admin    | `finance.arrangements.view`      |
| `/api/pending-actions-mark-executed`        | POST    | Handmatig EXECUTED + arrangement cascade | `finance.arrangements.approve` |
| `/api/pending-actions-mark-not-executed`    | POST    | Handmatig FAILED + reden               | `finance.arrangements.approve`   |

\* Fallback in F1: endpoints accepteren ook `finance.arrangements.view` /
`finance.arrangements.propose` zodat bestaande approvers/proposers zonder
extra rolwijziging meteen toegang hebben.

---

## 4. Inbox-knop flow (klant claimt betaald)

```
 WhatsApp-conversatie (inbox.html)
        │
        │  klik "Klant claimt betaald"
        ▼
 Modal: kies open factuur + bedrag + claim-tekst
        │
        │  POST /api/tasks-create-verify-payment
        │  { invoice_id, customer_id, claimed_amount, claim_text, klant_message_id }
        ▼
 pending_actions
   action_type     = 'MANUAL_VERIFY_PAYMENT'
   arrangement_id  = NULL              <-- standalone, geen arrangement
   invoice_id      = FK (first-class)  <-- direct indexeerbaar
   status          = 'PENDING'
   payload         = { claim_text, claimed_amount, klant_message_id, claimed_at, ... }
        │
        ▼
 Verschijnt in /modules/open-acties.html onder category=verify_payment
   Administratie verifieert in bankafschrift / TL → mark-executed of mark-not-executed
```

Validatie in `tasks-create-verify-payment`:
- `invoice_id` + `customer_id` verplicht (uuid), invoice moet bij de klant horen
- `claimed_amount > 0`
- `claim_text` minimaal 10 karakters (letterlijke klant-quote)
- `klant_message_id` optioneel — voor audit-trail richting inbox-bericht

Audit-log entry: `task.verify_payment.proposed` met `reason_text=claim_text`.

---

## 5. Cascade-semantiek: arrangement_id=NULL skipt cascade

`pending-actions-mark-executed` heeft een arrangement-cascade die bij de
laatste EXECUTED van een arrangement de `payment_arrangements.status` op
`ACTIEF` zet (vanuit `VOORGESTELD`).

Voor `MANUAL_VERIFY_PAYMENT` gelden twee dingen:

1. **`arrangement_id IS NULL`** — er bestaat geen arrangement-rij om te
   updaten. De cascade-tak (`if (arrangementIdForResponse) { … }`) wordt
   automatisch overgeslagen; geen extra guard nodig.
2. **`arrangement_status_updated: false`** komt terug in de response. UI
   toont dat als "Taak afgehandeld" zonder arrangement-banner.

Hetzelfde geldt voor `mark-not-executed` — die zet `pending_actions.status`
op `FAILED` met reden, zonder enig effect op arrangements.

Implicatie voor F2+: nieuwe `MANUAL_*` action_types die geen arrangement
hebben (PROPOSE_ARRANGEMENT, ESCALATION, FOLLOWUP) kunnen dezelfde
mark-executed / mark-not-executed endpoints hergebruiken — de NULL-check
zorgt vanzelf dat er geen incorrect arrangement-cascade getriggerd wordt.

---

## 6. Roadmap

| Sprint | Scope | Status |
|---|---|---|
| **F1** | Centraal taken-dashboard + MANUAL_VERIFY_PAYMENT vanuit inbox + mark-executed/not-executed cascade-aware | ✅ live |
| **F2** | `MANUAL_PROPOSE_ARRANGEMENT` — Joost (AI-agent) detecteert wanbetaler-pattern in inbox/dunning en stelt arrangement voor. Pending_action toont voorgestelde wizard-payload; mark-executed opent de propose-wizard pre-gefilled | TODO |
| **F3** | `MANUAL_ESCALATION` — escalatie-trigger vanuit dunning workflow (laatste-stap-bereikt zonder respons). Pending_action koppelt naar manager voor incassobureau-beslissing | TODO |
| **F4** | `MANUAL_FOLLOWUP` — generieke follow-up taak met `due_at`, `assignee_user_id` en vrije payload. Komt uit agent-prompts (Simon/Leon "vraag Jeffrey of...") + handmatig "Maak follow-up" knop in klant-detail | TODO |

---

## 7. Bekende beperkingen + open items

- **Geen assignee-veld in F1** — alle taken zijn impliciet voor de groep met
  `finance.tasks.view`. F4 introduceert `assignee_user_id` op pending_actions
  voor doelgerichte routing.
- **Inbox-knop nog niet voor email-conversaties** — F1 levert alleen de
  WhatsApp-flow; email-inbox krijgt dezelfde knop in F2.
- **Geen due-date op verify_payment** — `expires_at` blijft NULL. Auto-escalate
  bij langer dan X dagen open is iets voor F3+.
- **search**: client-side filter op klant-naamvelden via PostgREST embed-
  filter (`.or()` met `foreignTable: 'customers'`). Werkt, maar pagineert
  pas na de filter — bij grote datasets met sparse hits kan een pagina
  minder rijen tonen dan `limit`. Acceptabel in F1; herzien als nodig.
