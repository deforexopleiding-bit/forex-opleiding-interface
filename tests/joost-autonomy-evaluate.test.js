// tests/joost-autonomy-evaluate.test.js
//
// Regressietest voor de Joost autonomie-poortwachter. Test de PURE functies
// `evaluateAutonomy` (+ `isWithinOfficeHours`) uit api/joost-autonomy-evaluate.js.
// Geen DB, geen netwerk, geen mocks — de evaluator is expliciet ontworpen als
// zuivere functie.
//
// Framework: Node's ingebouwde `node:test` (beschikbaar vanaf Node 18, project
// vereist Node >=20). GEEN externe test-framework toegevoegd — dat introduceert
// npm-deps waar er nu geen zijn (package.json heeft geen devDependencies).
//
// Supabase-aanpak: `api/joost-autonomy-evaluate.js` doet top-level
// `import { supabaseAdmin } from './supabase.js'`, en supabase-js v2.105.4
// gooit `supabaseUrl is required.` bij createClient('', ...). Zonder env-vars
// crasht de import dus. Oplossing: dummy env-vars in tests/setup.js, gepreload
// via `--import ./tests/setup.js` (ESM imports zijn gehoist, dus env-vars in
// dit bestand zetten is te laat — supabase.js is dan al geëvalueerd).
// evaluateAutonomy doet zelf geen DB-call, dus de dummy URL wordt nooit
// aangesproken. Zie npm-script `test` in package.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutonomy, isWithinOfficeHours } from '../api/joost-autonomy-evaluate.js';

// ─────────────────────────────────────────────────────────────────────────────
// Vaste NOW voor determinisme (ma 2026-07-15 12:00:00 UTC = 14:00 Europe/Amsterdam).
// Alle relatieve datums (NOW+10d, NOW-10s, etc.) worden hieruit afgeleid zodat
// een test-run niet afhangt van de klok.
// ─────────────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-07-15T12:00:00.000Z');

function isoDayOffset(days) {
  const d = new Date(NOW.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}
function isoOffsetMs(ms) {
  return new Date(NOW.getTime() + ms).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline joost_config — arrangement_request + other beide autonomous, alle
// poorten open. Elke scenario-test kloont dit en past 1 veld aan.
// ─────────────────────────────────────────────────────────────────────────────
function baselineConfig() {
  return {
    autonomy_config: {
      intents: {
        arrangement_request: { enabled: true, mode: 'autonomous', min_confidence: 0.85, max_messages_per_conv: 8 },
        other:               { enabled: true, mode: 'autonomous', min_confidence: 0.85 },
      },
      communication_limits: {
        office_hours_only: false,
        cooldown_after_outbound_seconds: 30,
        max_messages_per_conversation_total: 10,
        max_messages_per_conversation_per_day: 10,
      },
      arrangement_mandate: {
        allowed_types: ['UITSTEL', 'SPLITSING'],
        min_total_amount_to_negotiate_eur: 100,
        max_total_amount_to_auto_propose_eur: 2500,
        splitsing: { max_termijnen_total: 6, max_dagen_tot_eerste_termijn: 45 },
        uitstel:   { max_dagen_total: 90 },
      },
    },
    feature_flags: { e2_auto_send_text: true },
  };
}

function baselineSuggestion() {
  return {
    detected_intent:               'arrangement_request',
    confidence:                    0.95,
    proposal_termijnen:            3,
    proposal_termijn_bedrag_eur:   150,
    proposal_eerste_termijn_datum: isoDayOffset(10),
  };
}

function baselineArgs(overrides = {}) {
  const merged = {
    suggestion:       baselineSuggestion(),
    conv_state:       {},
    joost_config:     baselineConfig(),
    customer_context: { open_amount: 500 },
    now:              NOW,
    ...overrides,
  };
  return merged;
}

// Deep-merge helper voor gerichte config-overrides in scenario's.
function withConfigPatch(patchFn) {
  const args = baselineArgs();
  patchFn(args.joost_config.autonomy_config, args);
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO'S 1-17 — assert op allow_autonomous / blocked_reason / stop_action.
// ─────────────────────────────────────────────────────────────────────────────

test('1. baseline arrangement_request + autonomous → allow=true, reason=null', () => {
  const d = evaluateAutonomy(baselineArgs());
  assert.equal(d.allow_autonomous, true);
  assert.equal(d.blocked_reason, null);
  assert.equal(d.stop_action, null);
});

test('2. intent="other" (autonomous, high confidence) → allow=true, reason=null', () => {
  const args = baselineArgs({ suggestion: { detected_intent: 'other', confidence: 0.95 } });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, true);
  assert.equal(d.blocked_reason, null);
});

test('3. suggestion=null → BLOCKED_NO_SUGGESTION', () => {
  const d = evaluateAutonomy(baselineArgs({ suggestion: null }));
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_NO_SUGGESTION');
});

test('4. confidence=0.50 (< 0.85) → BLOCKED_LOW_CONFIDENCE', () => {
  const args = baselineArgs();
  args.suggestion.confidence = 0.50;
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_LOW_CONFIDENCE');
});

test('5. intents.other.enabled=false + intent="other" → stop=escalation', () => {
  const args = withConfigPatch((cfg) => {
    cfg.intents.other.enabled = false;
  });
  args.suggestion = { detected_intent: 'other', confidence: 0.95 };
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.stop_action, 'escalation');
});

test('6. office_hours_only=true + zondag 03:00 NL → BLOCKED_OFFICE_HOURS', () => {
  const args = withConfigPatch((cfg) => {
    cfg.communication_limits.office_hours_only = true;
  });
  // 2026-07-19 01:00 UTC = 03:00 Europe/Amsterdam op zondag (CEST +02:00) —
  // buiten [ma-vr 08:30-18:00] venster op meerdere assen.
  args.now = new Date('2026-07-19T01:00:00.000Z');
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_OFFICE_HOURS');
});

test('7. office_hours_only=false + zondag 03:00 NL → allow=true (24/7)', () => {
  const args = baselineArgs();
  args.now = new Date('2026-07-19T01:00:00.000Z');
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, true);
  assert.equal(d.blocked_reason, null);
});

test('8. conv_state.messages_sent_today=10 (>= max_per_day 10) → BLOCKED_RATE_LIMIT', () => {
  const args = baselineArgs({ conv_state: { messages_sent_today: 10 } });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_RATE_LIMIT');
});

test('9. conv_state.messages_sent_total=10 (>= max_total 10) → BLOCKED_RATE_LIMIT', () => {
  const args = baselineArgs({ conv_state: { messages_sent_total: 10 } });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_RATE_LIMIT');
});

test('10. conv_state.last_message_sent_at=NOW-10s (cooldown 30s) → BLOCKED_RATE_LIMIT', () => {
  const args = baselineArgs({
    conv_state: { last_message_sent_at: isoOffsetMs(-10_000) },
  });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_RATE_LIMIT');
});

test('11. conv_state.autonomy_paused_until=NOW+1u → BLOCKED_PAUSED', () => {
  const args = baselineArgs({
    conv_state: { autonomy_paused_until: isoOffsetMs(3600_000) },
  });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_PAUSED');
});

test('12. proposal_eerste_termijn_datum=NOW+142d (> 45 max) → BLOCKED_OUT_OF_MANDATE', () => {
  const args = baselineArgs();
  args.suggestion.proposal_eerste_termijn_datum = isoDayOffset(142);
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_OUT_OF_MANDATE');
});

test('13. proposal_termijnen=12 (> 6 max) → BLOCKED_OUT_OF_MANDATE', () => {
  const args = baselineArgs();
  args.suggestion.proposal_termijnen = 12;
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_OUT_OF_MANDATE');
});

test('14. allowed_types=["UITSTEL"] + SPLITSING-voorstel → BLOCKED_OUT_OF_MANDATE', () => {
  const args = withConfigPatch((cfg) => {
    cfg.arrangement_mandate.allowed_types = ['UITSTEL'];
  });
  // baseline suggestion heeft proposal_termijnen=3 → SPLITSING.
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, 'BLOCKED_OUT_OF_MANDATE');
});

test('15. customer_context.open_amount=50 (< min 100) → stop=task_create', () => {
  const args = baselineArgs({ customer_context: { open_amount: 50 } });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.stop_action, 'task_create');
});

test('16. customer_context.open_amount=3000 (> max 2500) → stop=task_create', () => {
  const args = baselineArgs({ customer_context: { open_amount: 3000 } });
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.stop_action, 'task_create');
});

test('17. intents.other.mode="draft" + intent="other" → allow=false, reason=null', () => {
  const args = withConfigPatch((cfg) => {
    cfg.intents.other.mode = 'draft';
  });
  args.suggestion = { detected_intent: 'other', confidence: 0.95 };
  const d = evaluateAutonomy(args);
  assert.equal(d.allow_autonomous, false);
  assert.equal(d.blocked_reason, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Losse isWithinOfficeHours-tests. Verifieert de TZ-aware DST-safe helper
// direct — evaluateAutonomy roept 'em intern aan via office-hours-check.
// ─────────────────────────────────────────────────────────────────────────────

const OFFICE_HOURS = {
  tz:        'Europe/Amsterdam',
  days:      [1, 2, 3, 4, 5],
  startHHMM: '08:00',
  endHHMM:   '20:00',
};

test('isWithinOfficeHours: ma 10:00 NL in [ma-vr 08:00-20:00] → true', () => {
  // 2026-07-13 = maandag. 10:00 Europe/Amsterdam = 08:00 UTC (CEST +02:00).
  const when = new Date('2026-07-13T08:00:00.000Z');
  assert.equal(isWithinOfficeHours(OFFICE_HOURS, when), true);
});

test('isWithinOfficeHours: zo 10:00 NL → false (dag niet toegestaan)', () => {
  const when = new Date('2026-07-19T08:00:00.000Z'); // zondag 10:00 NL
  assert.equal(isWithinOfficeHours(OFFICE_HOURS, when), false);
});

test('isWithinOfficeHours: ma 07:00 NL → false (voor venster)', () => {
  const when = new Date('2026-07-13T05:00:00.000Z'); // ma 07:00 NL
  assert.equal(isWithinOfficeHours(OFFICE_HOURS, when), false);
});
