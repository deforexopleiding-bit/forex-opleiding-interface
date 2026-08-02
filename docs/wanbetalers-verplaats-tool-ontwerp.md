# Verplaats-tool: dunning-run naar specifieke stap zetten — ONTWERP

**Status: alleen ontwerp. Nog niets gebouwd.** Doel: vanuit het diagnose-
dashboard een klant naar een specifieke workflow-stap kunnen verplaatsen,
met harde waarborgen tegen ongewenste sends of verkeerde-klant-fouten.

## Waarom dit een risicovolle tool is

Op dit moment beweegt de engine autonoom door workflow-stappen. Een
handmatige "verplaats"-actie kan:

1. **Direct een send triggeren** — als je een run op een `email`- of
   `whatsapp`-stap zet met `next_action_at=now`, pikt de eerstvolgende
   cron 'em op en verstuurt de aanmaning. Dat kan de VERKEERDE aanmaning
   sturen (bv. dag17 terwijl klant nog dag7 verdient) of naar de VERKEERDE
   klant.
2. **Log-inconsistentie** — als de stappen ertussenin worden overgeslagen
   (bv. van step 2 → step 6), is er geen bewijs in `dunning_log` dat 3-4-5
   zijn "gedaan". Downstream-analyse (bv. dit dashboard, breach-check)
   krijgt een misleidend beeld.
3. **Blocking-guards omzeilen** — een task-step wacht op afhandeling in
   Acties. Verplaatsen weg van die stap laat de openstaande
   `pending_actions`-rij achter als spook-taak.

## Stap-classificatie: veilig vs risicovol

Elke workflow-stap krijgt een label voor de UI:

| step_type | Wat gebeurt na verplaatsing + engine-tick | Risico |
|---|---|---|
| `wait` | Zet `next_action_at = now + N days`. Geen send. | ✅ SAFE |
| `stop` | Zet run op `completed`. Geen send. | ✅ SAFE (definitief) |
| `task` | Maakt `pending_actions`-rij. Geen send naar klant. | ✅ SAFE (mens beslist) |
| `resume` | Zet paused runs weer active. Geen send. | ✅ SAFE |
| `email` | Executor verstuurt echte mail via SMTP. | 🔴 RISKY |
| `whatsapp` | Executor verstuurt echte template-send via Meta. | 🔴 RISKY |

**Standaard-gedrag na verplaatsing:** run status='active', `current_step_id`
= gekozen stap, **`next_action_at = NULL`** (dus engine pikt 'em niet
automatisch op). De gebruiker moet daarna expliciet "trigger nu"-knop
klikken als 'ie wél wil dat het uitvoert. **Deze non-auto-trigger is de
kern van de veiligheid.**

## User-flow (4 stappen)

### Stap 1 — "Verplaats"-knop op de klant-kaart

Zichtbaar in het dashboard alleen voor super_admin, alleen als klant een
run heeft. Klik opent een modal.

### Stap 2 — Modal: kies doel-stap

Toont in dropdown alle stappen van de huidige workflow (`step_order` +
`step_type` + `config.title` + veiligheidslabel):
```
  1 · email    · "Vriendelijke herinnering"       [🔴 stuurt mail]
  2 · wait     · "Wacht 7 dagen"                  [✅ geen send]
  3 · whatsapp · "aanmaning_dag7"                 [🔴 stuurt WhatsApp]
  4 · task     · "Bel klant" (huidig)             [✅ geen send]
  5 · wait     · "Wacht 3 dagen"                  [✅ geen send]
  6 · whatsapp · "aanmaning_dag14"                [🔴 stuurt WhatsApp]
```
Onder de dropdown een toggle: `[ ] Trigger direct na verplaatsen (LIVE
SEND als step_type=email/whatsapp)`. Default UIT.

### Stap 3 — Preview + expliciete bevestiging

Preview-blok toont:
```
  Klant:     🧪 Ingrid Van Den Eede  (customer_id: be4edb03…)
  E-mail:    ingrid@voorbeeld.nl
  Telefoon:  +31612345678
  Openstaand: € 1.245,00 (3 facturen)

  Huidige stap:   4 · task · "Bel klant"
  Nieuwe stap:    3 · whatsapp · "aanmaning_dag7"  🔴

  Wat gaat er gebeuren:
   • current_step_id → step-3
   • next_action_at → NULL (engine pikt NIET automatisch op)
   • trigger_now = UIT → geen send

  Wat gebeurt er NIET:
   • Geen bericht wordt verstuurd
   • Bestaande pending_actions van step-4 worden NIET vanzelf gecanceld
     (aparte cleanup nodig als je die niet meer wilt)
```

Bij `trigger_now=AAN` én `step_type` in {email, whatsapp}:
- Extra rode waarschuwing "🔴 LIVE SEND — er gaat NU een bericht naar bovenstaande klant"
- 2-staps typ-bevestiging (zoals fase 1 testpaneel DRY-RUN wissel): typ letterlijk `IK BEVESTIG SEND NAAR <klantnaam>`
- Preview van het exacte template (via bestaande `renderTemplate`) — de gebruiker ziet de definitieve tekst

Bij `trigger_now=UIT`: 1-staps confirm met klantnaam + bedrag ("Verplaats run van Ingrid Van Den Eede (€1245) naar step-3?").

### Stap 4 — Uitvoering + audit

Backend endpoint `POST /api/wanbetalers-diagnose-run-verplaats` (super_admin):

```
Body: {
  run_id, target_step_id,
  trigger_now: bool,
  live_send_confirmation?: string   // vereist bij trigger_now + email/whatsapp
}
```

Doet:
1. Verify super_admin
2. Fetch run + target step (moeten in dezelfde workflow zitten)
3. Als step_type in {email, whatsapp} én trigger_now=true:
   - Vereist `live_send_confirmation === 'IK BEVESTIG SEND NAAR <klantnaam>'`
4. UPDATE `dunning_workflow_runs SET current_step_id, next_action_at, updated_at` (idempotent, met status='active' guard)
5. INSERT `dunning_log` event `run_step_manual_move` met payload:
   ```
   {
     from_step_id, to_step_id,
     from_step_type, to_step_type,
     trigger_now,
     moved_by_user_id: <admin.id>,
     moved_by_user_email: <admin.email>,
     reason: <optioneel body.reason>,
   }
   ```
6. INSERT `audit_log`-rij met actie `finance_dunning.run_step_manual_move` (bestaand patroon, zelfde als `finance_dunning.customer_closed_manually`)
7. Als trigger_now=true → returnt 200 met `note:"engine pikt bij volgende cron-tick op"`. **Geen** direct-execute (bewuste beperking; anders zou de endpoint zelf een executor-call moeten doen, wat de guard-oppervlakte vergroot).

## Waarborgen — samenvatting

| # | Waarborg | Waar |
|---|---|---|
| 1 | Super_admin only | endpoint gate + UI-knop verborgen voor rest |
| 2 | Preview toont exacte klantnaam + bedrag vóór bevestiging | modal stap 3 |
| 3 | Trigger-toggle default UIT — verplaatsing lekt zelf geen send | endpoint zet next_action_at=NULL default |
| 4 | 2-staps typ-bevestiging als trigger_now én send-step | modal stap 3 + endpoint check |
| 5 | Server-side check: `live_send_confirmation` moet letterlijk klantnaam bevatten (backend) | endpoint validatie |
| 6 | Guard: target_step_id moet in dezelfde workflow zitten als run.workflow_id | endpoint validatie |
| 7 | Race-guard: UPDATE met `.eq('id', run.id).in('status', ['active','paused'])` | endpoint SQL |
| 8 | Volledig audit-spoor: dunning_log + audit_log met user_id + email | endpoint |
| 9 | Meerdere-klant-veiligheid: 1 endpoint = 1 run (geen bulk) | endpoint signature |
| 10 | Klant is_test-check optioneel? — bij PRODUCTIE-klant EXTRA waarschuwing in UI ("dit is een echte klant"), bij is_test=true stille pass | UI |

## Wat de tool NIET kan (bewust)

- ❌ **Bulk-verplaatsingen** — één klik = één klant. Voorkomt massa-fouten.
- ❌ **Sync-executor-call** — endpoint wacht op de cron. Wil je 'em zien
  vuren binnen minuten: draai handmatig `cron-dunning-engine` via de
  test-panel (fase 1) of het bestaande admin-endpoint.
- ❌ **Steppen buiten de huidige workflow** — je kunt niet van workflow A
  naar workflow B verplaatsen (schema-inconsistentie risico). Voor "andere
  workflow starten" is een aparte flow nodig (nog te ontwerpen).
- ❌ **Automatisch bestaande pending_actions cancellen** — als je van
  step-4 (task "Bel klant" met PENDING pending_action) verplaatst naar
  step-3, blijft die taak in Acties staan. Cancellen is een aparte handmatige
  actie in de Acties-tab. Bewust: verwijderen zonder audit = data-verlies.

## Wat er in fase 2 mag/moet volgen

- **Cancel-cascade toggle in de modal**: "cancel bestaande PENDING pending_actions
  van huidige step" — met eigen confirm.
- **"Andere workflow starten"-flow**: aparte endpoint dat een nieuwe run
  aanmaakt bij een andere workflow (vereist eerst huidige run cancellen).
- **UI-inline in de Acties-tab**: nu is verplaats alleen zichtbaar in
  diagnose-dashboard. Wanneer de tool bewezen veilig is, kan 'ie ook op de
  klant-detail in de wanbetalers-module verschijnen.

## Data-model — geen migratie nodig

Alle info zit al in bestaande kolommen:
- `dunning_workflow_runs.current_step_id`, `.next_action_at`, `.status`
- `dunning_workflow_steps.step_type`, `.step_order`, `.config`
- `dunning_log` (event `run_step_manual_move`)
- `audit_log` (action `finance_dunning.run_step_manual_move`)

## Beslissings-vragen voor jou vóór we bouwen

1. **Bulk of niet?** Ik voorstel: NEE (één klant per keer). Akkoord?
2. **Cancel-cascade in fase 1 of fase 2?** Ik voorstel: fase 2 (bewuste extra
   knop, apart audit-spoor).
3. **Trigger-toggle nodig, of alleen "geen trigger"?** Ik voorstel:
   toggle mét de 2-staps typ-bevestiging als 'ie aan gaat. Zonder trigger
   is de engine-cron-vertraging (~24u/dag; ~5min/*) de natuurlijke rem.
4. **Waar de knop plaatsen?** Ik voorstel: alleen in diagnose-dashboard
   ("Verplaats stap"-knop naast de run-details in het uitklap-blok).
   Optioneel later ook in wanbetalers-module.

**Wacht op jouw antwoorden op deze 4 vragen voor ik ga bouwen.**
