# Joost AI — E1.2 Intent-to-Task

Datum: 2026-06-10
Sprint: E1.2 (intent-aware suggestion-card + task/arrangement linking)
Branch: `feat/joost-e12-intent-to-task`

---

## 1. Wat E1.2 oplost

E1.0 leverde de Joost-foundation (draft-mode suggesties + outcome-log). E1.1
voegt auto-suggest bij webhook toe. E1.2 **sluit de loop** tussen Joost en de
rest van het Agency Command Center: een suggestie wordt geen tekst-eilandje
meer, maar een vertrekpunt voor concrete operationele acties.

Concreet: zodra Joost een `verify_payment`-intent detecteert ("Ik heb al
gisteren overgemaakt"), kan de medewerker met 1 klik vanuit de
suggestion-card een `MANUAL_VERIFY_PAYMENT` task aanmaken in Open Acties
(F1) — inclusief klant-context, factuur-koppeling en claim-tekst die direct
uit de suggestie komt. Bij `arrangement_request` opent de arrangement-wizard
met pre-fill vanuit D-module. Bij `escalation_needed` opent een vrije
escalatie-flow.

Het resultaat is dat Joost echt waardevol wordt: niet alleen "een tekst
voorstellen", maar **de operationele actie initiëren** die normaal nog
handmatig moest. De medewerker hoeft niet meer naar een andere module te
navigeren, een nieuwe vorm in te vullen en context over te typen.

---

## 2. Drie intents met contextuele knoppen, drie zonder

De 6 intent-categorieën uit E1.0 worden in E1.2 gesplitst in twee groepen
op basis van of er een concrete vervolgactie mogelijk is:

### Met contextuele actie-knop

| Intent                | Knop in suggestion-card        | Vervolgactie                                                                 |
|---|---|---|
| `verify_payment`      | **Maak verify-task**           | POST `/api/joost-create-task-from-suggestion` → `MANUAL_VERIFY_PAYMENT` in F1 met factuur-keuze (modal toont open facturen klant). |
| `arrangement_request` | **Open regeling-wizard**       | Navigeert naar `/modules/finance.html#wanbetalers` met query-param `?joost_suggestion_id=…` zodat propose-wizard pre-fillt. |
| `escalation_needed`   | **Escaleer**                   | Markeert suggestie als `USED_TASK_CREATED` met escalation-flag; toont team-routing modal (handover-target = manager/jurist). |

Voor deze 3 intents toont de UI ook **secundaire acties** (Plak / Plak en
bewerk / Negeer) zodat de medewerker niet gedwongen wordt om de
contextuele actie te kiezen — soms is een simpel antwoord prima.

### Zonder contextuele actie-knop (alleen Plak / Plak en bewerk / Negeer)

| Intent              | Reden                                                                          |
|---|---|
| `payment_promise`   | Klant gaat alsnog betalen — geen task nodig, dunning-loop blijft draaien.      |
| `general_question`  | Inhoudelijke vraag, geen financiële actie vereist.                             |
| `other`             | Fallback — geen voorgekookte actie passend.                                    |

Deze drie krijgen alleen het standaard 3-knoppen-paneel uit E1.0. Het
voordeel: de UI wordt niet vol gebouwd met "Escaleer"-knoppen op een
neutrale vraag, en de medewerker leert intuïtief dat een contextuele knop
betekent: er is iets concreets te doen voorbij tekst.

---

## 3. Confidence-bands voor styling

De `confidence`-score (0.0–1.0) bepaalt **hoe nadrukkelijk** de
contextuele actie-knop in beeld komt. Geen auto-execute in E1.2 — alleen
visuele weging:

| Band       | Range          | Styling suggestion-card                                            |
|---|---|---|
| **High**   | `>= 0.80`      | Card-border in module-accent-kleur. Contextuele knop heeft primary-styling (gevuld). Confidence-pill groen. |
| **Medium** | `0.50 – 0.79`  | Card-border subtiel grijs. Contextuele knop heeft secondary-styling (outline). Confidence-pill amber. |
| **Low**    | `< 0.50`       | Card-border zacht rood. Contextuele knop verborgen — alleen Plak/Bewerken/Negeer beschikbaar. Confidence-pill rood + waarschuwingstekst "zwak signaal, kijk extra na". |

De keuze om bij Low-confidence de contextuele knop te **verbergen** in
plaats van te disablen is bewust: een grijsgemaakte knop nodigt uit tot
"toch maar klikken na refresh", terwijl een verborgen knop een duidelijk
signaal is dat de medewerker zelf moet beoordelen. Bij high-confidence
acteren tegenover bij low-confidence handmatig blijft de richtlijn.

In E2 (autonomous send) wordt deze banding hergebruikt om te bepalen
welke suggesties Joost zelfstandig mag versturen — maar dat is dan een
expliciete config-keuze, niet automatisch gevolg van E1.2.

---

## 4. Traceability: `linked_task_id` + `linked_arrangement_id`

Schema-uitbreiding op `joost_suggestions` (migratie
`docs/sql-migrations/2026-06-10-joost-e12-task-linking.sql`):

| Kolom                     | Type                                    | Doel                                              |
|---|---|---|
| `linked_task_id`          | uuid FK → `pending_actions(id)`         | Set bij `USED_TASK_CREATED`. ON DELETE SET NULL.  |
| `linked_arrangement_id`   | uuid FK → `payment_arrangements(id)`    | Set bij `USED_ARRANGEMENT_OPENED`. ON DELETE SET NULL. |

Twee nieuwe `status`-waarden in de CHECK-constraint:
- `USED_TASK_CREATED` — suggestie heeft geleid tot een `MANUAL_VERIFY_PAYMENT`
  pending_action in Open Acties.
- `USED_ARRANGEMENT_OPENED` — suggestie heeft geleid tot het openen van de
  arrangement-wizard met pre-fill.

Partial indexes op beide FK-kolommen (`WHERE … IS NOT NULL`) voor twee
hoofdqueries:
1. "Welke Joost-suggesties hebben een operationele actie opgeleverd?" —
   evaluatie van Joost's effectiviteit per intent / per periode.
2. "Welke task is uit welke suggestie ontstaan?" — backlink voor
   Open Acties detail-modal (zie §5).

ON DELETE SET NULL is bewust: als een task wordt opgeschoond of een
arrangement geannuleerd, blijft de Joost-suggestion-rij staan voor
audit-doeleinden — alleen de referentie wordt leeg.

### Endpoint

`POST /api/joost-create-task-from-suggestion`

Body: `{ suggestion_id, invoice_id, claim_text_override?, claimed_amount? }`
- Permissies vereist (beide): `finance.joost.use` + `finance.tasks.create`.
- Race-guard: suggestion moet `PROPOSED` zijn (anders 409).
- Best-effort rollback van de pending_action als de status-update faalt.
- Audit-log entry `task.created_from_joost` met klant + factuur + bedrag.

---

## 5. Open Acties dossier-link voor terug-navigatie

Open Acties detail-modal (`/modules/open-acties.html`) toont — als de task
uit een Joost-suggestie komt — een **dossier-link** terug naar de
oorspronkelijke conversatie. Twee signalen worden gebruikt om dit te
detecteren in `pending-actions-detail`:

1. `payload.source === 'joost'` (gezet door
   `joost-create-task-from-suggestion`).
2. `payload.joost_suggestion_id` (uuid van de bron-suggestie).

De modal toont:

> **Aangemaakt vanuit Joost-suggestie**
> Klik om de WhatsApp-conversatie te openen waarin de klant betaling claimde.
> [Open conversatie →]

De knop linkt naar de inbox met de conversation_id geselecteerd. Voor
auditdoeleinden toont de modal ook de Joost `detected_intent` + `confidence`
en de exacte `claim_text` zoals die op het moment van task-aanmaak was.

Dit sluit de loop: vanuit de WhatsApp-inbox naar Open Acties via Joost,
én terug van Open Acties naar de bron-conversatie. Geen sprongen meer
tussen modules waar context verloren gaat.

---

## 6. Roadmap E2 — autonomie

E1.2 maakt expliciet **niet** de stap naar autonomie. Wat wel klaarligt
voor E2:

| Stap                       | Wat het is                                                                                          |
|---|---|
| **E1.1 — auto-suggest**    | `inbox-webhook.js` triggert `joost-suggest` direct bij inbound message. Suggestie klaar bij openen. |
| **E1.2 — intent-to-task**  | Manual click op contextuele knop → task/arrangement aangemaakt. **Status: deze sprint.**            |
| **E2 — auto-execute**      | Joost mag bij `confidence >= 0.90` + intent in safe-list zelfstandig task aanmaken/arrangement openen, met audit-trail en kill-switch per module. |

Voorwaarden voor E2 (uit te werken in eigen design-doc):
- Per-module hard cap (bv. max 5 auto-created tasks per uur platform-breed).
- Verplichte `joost_send_outcomes` log + klant-respons binnen 24u als
  feedback-signaal.
- Opt-in per intent-type via `joost_config.autonomous_intents` jsonb-array
  zodat bv. `verify_payment` wel autonoom mag, maar `escalation_needed`
  nooit.
- Kill-switch via `joost_config.is_enabled = false` blijft hoogste
  prioriteit.

De E1.2-foundation is bewust zo opgezet dat E2 alleen het "wie klikt op
de knop"-deel hoeft te vervangen door een server-side trigger — alle
endpoints, traceability-kolommen en confidence-banding zijn hergebruikbaar.

---

## 7. Bekende beperkingen E1.2

- **Geen multi-invoice task in 1 klik** — als klant betaling claimt op 2
  facturen tegelijk, moet de medewerker 2x een verify-task aanmaken. Een
  bulk-flow kan in F2 (multi-select task-create) opgepakt worden.
- **Geen arrangement-wizard pre-fill yet** — `USED_ARRANGEMENT_OPENED`
  zet de status, maar de finance-wizard leest `?joost_suggestion_id=…`
  nog niet. Eerste opvolger-PR.
- **Escalation-flow nog minimaal** — `escalation_needed`-knop markeert
  alleen status; team-routing modal is mock-up. Wacht op formele
  escalation-pipeline (F3 in tasks-roadmap).
