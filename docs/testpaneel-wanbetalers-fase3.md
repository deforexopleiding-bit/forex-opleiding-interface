# Testpaneel Wanbetalers — Fase 3 (flow-overgangen)

**Voortbouwend op fase 1 + 2** (
[fase 1](testpaneel-wanbetalers-fase1.md) ·
[fase 2](testpaneel-wanbetalers-fase2.md)
).

## Doel

Bewijs met geautomatiseerde tests dat de 3 kritieke flow-overgangen correct
werken, voor **beide** flows (1-factuur "Aanmaningen" + multi-factuur
"Multi-factuur aanmaning"):

1. **Klant reageert → run pauzeert** (`active` → `paused` + `paused_by_conversation_id` gezet)
2. **Snooze N dagen → engine skipt → fast-forward → engine hervat**
3. **Handmatige pauze → engine no-op → handmatig hervat → engine loopt weer**

Elk test-endpoint doet: reset + seed → `runEngine` → transitie → verify. Elke
verify is een expliciete assert met `expected` / `actual` → PASS/FAIL. Geen
mocks, geen namaak-simulatie — de echte `runEngine`, echte
`pauseRunsForConversation`, echte `dunning_workflow_runs`-writes.

## Nieuwe files

| File | Regels | Doel |
|---|---|---|
| [api/_lib/wanbetalers-flow-test.js](../api/_lib/wanbetalers-flow-test.js) | ~200 | Shared helpers: `loadSandboxCustomerOrFail`, `resetAndSeedForFlowTest`, `runEngineTestScope`, `captureRunState`, `simulateSandboxInbound` (minimaal, met `pauseRunsForConversation`-hook), `snoozeRunDays`, `fastForwardRunNextActionDays`, `manualPauseRun`, `manualResumeRun` |
| [api/wanbetalers-sandbox-flow-test-inbound.js](../api/wanbetalers-sandbox-flow-test-inbound.js) | ~110 | Transitie 1: WA-inbound → run pauzeert |
| [api/wanbetalers-sandbox-flow-test-snooze.js](../api/wanbetalers-sandbox-flow-test-snooze.js) | ~145 | Transitie 2: snooze N dagen → auto-hervat na fast-forward |
| [api/wanbetalers-sandbox-flow-test-manual-pause.js](../api/wanbetalers-sandbox-flow-test-manual-pause.js) | ~155 | Transitie 3: handmatig pause → engine no-op → handmatig resume |

## Gewijzigde files

- [modules/wanbetalers-test.html](../modules/wanbetalers-test.html) — nieuwe sectie 6 met 3 test-kaarten (per test flow-selector 1-factuur/multi-factuur), resultaat-lijst met PASS/FAIL badge + stappen-timeline (expand voor detail). Live status wordt sectie 7.

## Waarom "de echte engine"

De 3 endpoints importeren:

```js
import { runEngine } from './_lib/dunning-engine.js';           // ← productie-cron gebruikt dit
import { pauseRunsForConversation } from './dunning-arrangement-hooks.js'; // ← inbox-webhook gebruikt dit
```

Geen wrapper, geen mock. Als de test PASS geeft is dat bewijs dat de
productie-cron én de productie-webhook dezelfde overgangen correct
uitvoeren.

De handmatige pause/resume-writes spiegelen [api/finance-dunning-run-control.js](../api/finance-dunning-run-control.js) exact:
- `pause`: `status='paused'`, `updated_at=now`
- `resume`: `status='active'`, `next_action_at=now`, wist alle `paused_by_*`-relicten

## Assertions per test

### Test 1 — Inbound → pauzeert

- `assert_run_started`: BEFORE `status === 'active'`
- `assert_status_paused`: AFTER `status === 'paused'`
- `assert_paused_by_conversation_id_set`: AFTER `paused_by_conversation_id === <geïnsertd conv_id>`

### Test 2 — Snooze → auto-hervat

- `assert_run_started`: BEFORE snooze `status === 'active'`
- `assert_snooze_next_action_in_future`: na snooze `next_action_at > now`
- `assert_no_advance_during_snooze`: na engine tijdens snooze, `current_step_id` **ongewijzigd** + `next_action_at` nog steeds toekomst
- `assert_engine_advanced_after_snooze_expired`: na fast-forward + engine, `current_step_id` veranderd OF `status='completed'` OF `updated_at` nieuwer

### Test 3 — Manual pause → resume

- `assert_run_started`: BEFORE `status === 'active'`
- `assert_paused_after_manual_pause`: `status === 'paused'`
- `assert_no_advance_during_manual_pause`: na fast-forward + engine, `status` blijft `'paused'` + `current_step_id` ongewijzigd
- `assert_engine_advanced_after_manual_resume`: na resume + engine, `current_step_id` veranderd OF `status='completed'` OF `updated_at` nieuwer

## Veiligheid — inheritance van fase 1 + 2

Alle 5 lagen actief. Nieuwe defenses in fase 3:

- **`resetAndSeedForFlowTest`** doet `.eq('customer_id', customer.id).eq('is_test', true)` op invoices DELETE en `.eq('customer_id', customer.id)` op runs DELETE
- **`snoozeRunDays`** UPDATE-guard: `.eq('id', runId).eq('customer_id', customer.id).eq('status', 'active')` + fail-loud bij 0 rows
- **`manualPauseRun`** UPDATE-guard: idem
- **`manualResumeRun`** UPDATE-guard: `.eq('status', 'paused')` + fail-loud bij 0 rows
- **`fastForwardRunNextActionDays`** UPDATE-guard: `.eq('id', runId).eq('customer_id', customer.id)`
- **`simulateSandboxInbound`** — hijack-guard weigert een conversation die al aan een andere klant hangt

Test-3 (manual pause) doet de fast-forward direct met een sandbox-scoped
UPDATE die **alleen matcht als `status='paused'`** — dus als je test faalt,
raakt de update 0 rijen en niet een productie-run.

## Dry-run compatibility

Alle 3 tests werken in DRY-RUN=AAN (de default bij page-open, fase 1). Het
engine-pad doet geen echte Meta/mail send in dry-run — de flow-overgangen
zelf (status/next_action_at/paused_by_*) gebeuren op DB-niveau ongeacht
dry-run. Dus je kunt de tests helemaal doorlopen zonder een enkele echte
send.

Als je bewust in LIVE-mode test kan de engine tijdens de test wél een echte
send doen (bv. dag7-WhatsApp). De executor gebruikt in dat geval
`assertRecipientMatchesSandbox` — send gaat alleen naar de sandbox-contact,
never naar een echte klant.

## Verificatie-checklist fase 3

- [ ] Test 1 (single) — PASS met status active→paused + paused_by_conversation_id gezet
- [ ] Test 1 (multi) — PASS
- [ ] Test 2 (single, 3 dagen) — PASS met snooze future + engine skip + resume
- [ ] Test 2 (multi, 3 dagen) — PASS
- [ ] Test 3 (single) — PASS met manual pause + engine no-op + resume
- [ ] Test 3 (multi) — PASS
- [ ] Steps-timeline uitklapbaar toont per stap ✅/❌ + expected/actual
- [ ] Productie ongewijzigd:
      `git diff main -- api/_lib/dunning-step-executors.js api/_lib/dunning-engine.js api/_lib/dunning-dry-run.js api/_lib/wanbetalers-sandbox.js api/_lib/dunning-arrangement-hooks.js vercel.json`
      = leeg
