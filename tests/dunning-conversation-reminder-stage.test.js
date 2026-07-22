// tests/dunning-conversation-reminder-stage.test.js
//
// Unit-tests voor determineStage — de pure functie die per gepauzeerde
// dunning-run bepaalt of er een reminder gestuurd moet worden.
//
// Regressie-guards + nieuwe reply-guard uit spoedfix voor David/Ayoub:
//   count=1 + klant reageerde NA r1-reminder -> return null (geen r2).
//
// Verifieert (verplichte scenarios uit spec):
//   (a) - via het echte gedrag: twee-tick-race wordt door de atomic claim
//         in processReminderRun voorkomen (niet in determineStage; die is
//         puur en levert twee ticks stage='r1' -- claim doet de rest).
//   (b) - dito: 'CLAIM_LOST' skip-pad zit in processReminderRun (DB-code).
//   (c) - determineStage kan geen "paused run" concept zien (de query in
//         de handler filtert al op status='paused' met
//         paused_by_conversation_id NOT NULL). Deze test dekt de reply-
//         guard binnen die selectie: klant-reply NA reminder -> null.
//   (d) - normale flow zonder concurrency: stage komt netjes uit.
//
// atomic claim (rijk aan DB-mocking) wordt via code-inspectie geverifieerd
// in de PR-body; niet in unit-test hier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineStage } from '../api/cron-dunning-conversation-reminders.js';

const H = 60 * 60 * 1000;
const NOW = 1_722_500_000_000; // 2024-08-01T~ish; niet relevant, alleen delta's tellen.

function iso(ms) { return new Date(ms).toISOString(); }

const NR_CFG = {
  reminder_1_hours:  20,
  reminder_2_hours:  24,
  resume_after_hours: 24,
};

// ── count=0: r1-gate op inbound-age ──────────────────────────────────
test('count=0 + inbound 21h geleden -> r1', () => {
  const run = { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 21 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r1');
});

test('count=0 + inbound 5h geleden -> null (te vroeg)', () => {
  const run = { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 5 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

test('count=0 zonder inbound-ankerpunt -> null', () => {
  const run = { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null };
  const stage = determineStage({
    run,
    convLastInboundAt: null,
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

// ── count=1: r2-gate + NIEUWE reply-guard ────────────────────────────
test('count=1 + last_reminder 25h geleden + geen inbound sindsdien -> r2', () => {
  const lastReminderMs = NOW - 25 * H;
  const run = {
    paused_conversation_reminder_count: 1,
    paused_conversation_last_reminder_at: iso(lastReminderMs),
  };
  const stage = determineStage({
    run,
    // Inbound was VOOR de reminder -> klant heeft niet gereageerd na r1.
    convLastInboundAt: iso(lastReminderMs - 5 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r2');
});

test('count=1 + last_reminder 25h geleden + klant reageerde 2h geleden -> null (reply-guard)', () => {
  // SPOEDFIX-guard: klant reageerde NA onze r1-reminder -> stop, geen r2.
  const lastReminderMs = NOW - 25 * H;
  const run = {
    paused_conversation_reminder_count: 1,
    paused_conversation_last_reminder_at: iso(lastReminderMs),
  };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 2 * H), // inbound > last_reminder
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

test('count=1 + last_reminder 5h geleden -> null (te vroeg voor r2)', () => {
  const run = {
    paused_conversation_reminder_count: 1,
    paused_conversation_last_reminder_at: iso(NOW - 5 * H),
  };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 100 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

test('count=1 zonder last_reminder_at -> null', () => {
  const run = { paused_conversation_reminder_count: 1, paused_conversation_last_reminder_at: null };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 100 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

// ── count>=2: rz-gate (geen reply-guard nodig, dit is een resume-actie) ─
test('count=2 + last_reminder 25h geleden -> rz (resume, geen send)', () => {
  const run = {
    paused_conversation_reminder_count: 2,
    paused_conversation_last_reminder_at: iso(NOW - 25 * H),
  };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 50 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'rz');
});

test('count=2 + last_reminder 5h geleden -> null (te vroeg voor rz)', () => {
  const run = {
    paused_conversation_reminder_count: 2,
    paused_conversation_last_reminder_at: iso(NOW - 5 * H),
  };
  const stage = determineStage({
    run,
    convLastInboundAt: iso(NOW - 50 * H),
    noReplyCfg: NR_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

// ── Config-defaults (noReplyCfg leeg -> 20/24/24 defaults) ───────────
test('lege noReplyCfg gebruikt defaults 20/24/24', () => {
  const run = { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null };
  const early = determineStage({
    run, convLastInboundAt: iso(NOW - 19 * H), noReplyCfg: {}, nowMs: NOW,
  });
  const ontime = determineStage({
    run, convLastInboundAt: iso(NOW - 21 * H), noReplyCfg: {}, nowMs: NOW,
  });
  assert.equal(early,  null);
  assert.equal(ontime, 'r1');
});
