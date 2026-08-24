# BLOK 2 — Cockpit-schil scope

Deze doc beschrijft hoe de native cockpit-schil in `wanbetalers-v2.js` wordt gebouwd
bovenop de BLOK 1-endpoints (grendel, provisioning, reset, trigger, verify, status,
set-sandbox-contact). Design-referentie: `docs/dunning-test-cockpit-reference.html`
(pixel-exacte visuele lat: donkere mission-control-look, mono-typografie
Bricolage/Inter/JetBrains Mono, tokens uit de referentie 1-op-1 overnemen).

## Panels (volgorde volgt referentie)

1. **Header-bar** — brand-logo + `TEST-COCKPIT`-badge + live-beacon + dry-run/LIVE-toggle
   (koppelt aan `dunning_dry_run.enabled` via bestaande sandbox-set-dry-run endpoint).
2. **Guard-status strip** — leest `/api/dunning-test-status` bij mount + na elke actie.
   Toont `ready`/`blockers`, `sandbox_contact.phone`/`email`, `dry_run_enabled`, en
   `test_customer_count`/`test_invoice_count`. Blockers = rood, ready = groen.
3. **Persona-hero** — actieve test-customer (uit `test_customer_count > 0` → laatste
   is_test rij). Toont naam, telefoon, e-mail, statuspill (active/paused/resumed/
   blocked/done afgeleid uit `dunning_workflow_runs.status`). Rechts: mini-facturen
   lijst met bedrag + status + backdated dagen.
4. **Scenariobibliotheek** — 8 preset-kaarten: `warm-2x-3d`, `koud-3x-14d`,
   `pauze-belofte`, `escalatie-14d`, `bulk-round-1`, `credit-round`, `no-show-inbound`,
   `custom`. Klik = seed customer + invoices via `dunning-test-customer-create` +
   `dunning-test-invoice-create` met per-scenario preset (amount/days_late/scenario_tag).
5. **Blok-bouwer** — sleepbare stappen (huidige customer → engine → conv-reminders →
   simulate-inbound → mark-paid → reset). Elke stap dispatcht via
   `/api/dunning-test-trigger`. Ondersteunt "sequentie draaien" (n stappen achter
   elkaar met tussentijdse audit-refresh).
6. **AI-tekstinvoer** — vrije prompt naar de nieuwe `/api/dunning-test-ai-plan`
   endpoint (Claude Sonnet 4.6). Retourneert een gestructureerd plan (array van
   cockpit-stappen). UI toont het plan met "Voer uit" (bevestigt eerst) én "Bewerk".
7. **Ladder** — 7-staps horizontale voortgangsindicator (nieuw → r1 → r2 → r3 →
   r4 → escalatie → afgesloten) afgeleid uit `dunning_workflow_runs.step_index`.
8. **Live tijdlijn** — `test_cockpit_audit` (laatste 50) + `dunning_log` van de
   actieve run + `whatsapp_messages` van de actieve conv, gemerged op timestamp.
9. **Berichten** — WA-conv preview (in/out) van de actieve is_test-conversation.
10. **Takenlijst** — `pending_actions` van de actieve is_test-customer.
11. **Verify-grendel-widget** — knop "Draai bewijs" → `/api/dunning-test-verify-grendel`,
    toont 6/6 ok/fout in een pill.

## AI-tekstinvoer — hoe Claude aangesloten wordt

Nieuwe endpoint `POST /api/dunning-test-ai-plan`:
- Super_admin-only.
- Body: `{ prompt: string, current_state?: { customer_id, run_id, ... } }`.
- Server bouwt system-prompt met:
  - Whitelist van cockpit-acties (`ACTION_ROUTES` uit `dunning-test-trigger.js` +
    `customer-create`, `invoice-create`, `reset`, `verify-grendel`).
  - Huidige cockpit-state (customer/run/facturen als context).
  - Instructie: **retourneer JSON-plan**, geen prose.
- Roept Anthropic Messages API aan met **tool-use** pattern:
  - Één tool `emit_cockpit_plan` met JSON-schema:
    ```json
    {
      "reasoning": "string (1-2 zinnen waarom)",
      "steps": [
        { "action": "engine|conversation-reminders|simulate-inbound|mark-paid|reset|customer-create|invoice-create|verify-grendel", "params": { ... }, "explain": "string" }
      ]
    }
    ```
  - `tool_choice: {type:'tool', name:'emit_cockpit_plan'}` forceert Claude om via
    de tool te antwoorden — geen prose-fallback.
- Response naar de UI: het plan + Claude's reasoning. **Geen automatische executie.**
- UI toont plan met "Voer uit" (custom confirm) → chained calls naar
  `dunning-test-trigger` etc. Elke stap audit'ed in `test_cockpit_audit` met
  `action: 'ai_plan_step_N'` + originele prompt in payload.

Model: `claude-sonnet-4-6-20250101` (of het huidige productie-model uit `agent-chat.js` —
verifieer bij implementatie). Max tokens: 2048 (plannen zijn kort). Temperature 0.2
(deterministisch — plannen moeten reproduceerbaar zijn).

## Freeze-veilige rendering (waarschuwing uit CLAUDE.md-Lessons)

- Uncontrolled inputs met `data-*` attributes; sync-from-DOM vóór actie-dispatch.
- Geen `render()`-call per keystroke.
- Structural re-render alleen na state-mutatie (customer aangemaakt, plan uitgevoerd,
  etc.), niet na typen.
- Live tijdlijn poll: `setInterval` cleared bij view-switch (Lesson-20).

## Cache-bump

`instellingen-v2 v=82 → v=83` bij eerste iteratie; verder telkens +1 per iteratie.
Nieuwe endpoint `dunning-test-ai-plan.js` geen v-param.

## PR-strategie

Deze PR is **report-first**. Ik lever eerst:

1. Deze scope-doc.
2. Eerste diff-preview: `bodyWbTestCockpit` skeleton (header-bar + guard-status
   strip + persona-hero placeholder) met styling uit reference. Nog geen JS-wiring
   naar de trigger-actie; alleen lees-endpoint-koppeling.
3. AI-plan endpoint als stub — returnt vaste dummy-plan op mock-prompt, echte
   Claude-integratie in vervolg-iteratie ná scope-akkoord.

Vervolg-commits binnen dezelfde PR (na scope-akkoord):
- Iteratie 2: scenariobibliotheek + blok-bouwer + trigger-wiring.
- Iteratie 3: AI-plan echte Claude + plan-executor.
- Iteratie 4: ladder + live tijdlijn + berichten + takenlijst.
- Iteratie 5: verify-grendel-widget + polish.

Elke iteratie report-first met diff-preview vóór commit. Geen merge tot alle
iteraties gereviewd zijn.

## Constraints

- 0 incasso-writes.
- Alle acties super_admin-only (server autoritatief; UI-gate cosmetisch).
- Alles is_test-gescoped (de grendel is autoritatief).
- Verzending alleen naar `dunning_sandbox_contact` (grendel weigert alles anders).
- `admin.html` v1 ongemoeid.
- Wanbetalers-test.html (oude pagina) blijft functioneel — geen breekwijziging.
