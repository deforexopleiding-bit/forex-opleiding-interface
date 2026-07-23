// tests/dunning-reminder-conversation-guard.test.js
//
// Echte tests voor de twee guard-lagen die #880's per-run atomic claim
// aanvullen zodat een klant met meerdere gepauzeerde runs of een open
// pending_action geen automatische reminder krijgt.
//
// Gedekte scenarios uit de spec (letter = spec-letter uit PR-brief):
//   (a) 2 runs op DEZELFDE conversatie -> dedup returnt exact 1 winnaar.
//   (b) 2 runs op VERSCHILLENDE conversaties -> beide zijn winnaar.
//   (c) klant met open pending_action (status='pending')  -> guard blokkeert.
//   (d) klant met afgehandelde pending_action (executed)  -> guard blokkeert.
//   (e) klant met alleen rejected/cancelled -> guard laat door.
//   (f) klant zonder acties + solo-run -> guard + dedup allebei doorloop.
//
// De handler-integratie (die dedup + guard aanroept) is code-inspectie
// hardcoded via de exports uit cron-dunning-conversation-reminders.js —
// als iemand dedup of guard uit de flow rolt, moet de review het pakken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupRunsByConversation,
  hasOpenBlockingAction,
} from '../api/cron-dunning-conversation-reminders.js';

// ── dedupRunsByConversation ──────────────────────────────────────────
test('(a) 2 runs op dezelfde conversatie -> 1 winnaar + 1 duplicate', () => {
  const runs = [
    { id: 'run-A', paused_by_conversation_id: 'conv-1', updated_at: '2026-05-15T07:00:00Z' },
    { id: 'run-B', paused_by_conversation_id: 'conv-1', updated_at: '2026-05-15T08:00:00Z' },
  ];
  const { winners, duplicates } = dedupRunsByConversation(runs);
  assert.equal(winners.length, 1);
  assert.equal(duplicates.length, 1);
  // Oudste updated_at wint (query ordent asc, dus eerste in de lijst).
  assert.equal(winners[0].id, 'run-A');
  assert.equal(duplicates[0].id, 'run-B');
});

test('(b) 2 runs op verschillende conversaties -> beide winnaar', () => {
  const runs = [
    { id: 'run-A', paused_by_conversation_id: 'conv-1', updated_at: '2026-05-15T07:00:00Z' },
    { id: 'run-B', paused_by_conversation_id: 'conv-2', updated_at: '2026-05-15T07:05:00Z' },
  ];
  const { winners, duplicates } = dedupRunsByConversation(runs);
  assert.equal(winners.length, 2);
  assert.equal(duplicates.length, 0);
  assert.deepEqual(winners.map(w => w.id).sort(), ['run-A', 'run-B']);
});

test('dedup: 3 runs (2 op conv-X, 1 op conv-Y) -> 2 winners + 1 duplicate', () => {
  const runs = [
    { id: 'r1', paused_by_conversation_id: 'X', updated_at: '2026-05-15T07:00:00Z' },
    { id: 'r2', paused_by_conversation_id: 'Y', updated_at: '2026-05-15T07:01:00Z' },
    { id: 'r3', paused_by_conversation_id: 'X', updated_at: '2026-05-15T07:02:00Z' },
  ];
  const { winners, duplicates } = dedupRunsByConversation(runs);
  assert.equal(winners.length, 2);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(winners.map(w => w.id), ['r1', 'r2']);
  assert.equal(duplicates[0].id, 'r3');
});

test('dedup: lege input -> lege winners + duplicates', () => {
  const { winners, duplicates } = dedupRunsByConversation([]);
  assert.equal(winners.length, 0);
  assert.equal(duplicates.length, 0);
});

test('dedup: run zonder paused_by_conversation_id -> altijd winnaar (kan niet ontdupen)', () => {
  // De handler-query filtert al op NOT NULL, maar de pure functie mag
  // hier niet crashen als er ooit een null-conv-run doorheen slipt.
  const runs = [
    { id: 'no-conv', paused_by_conversation_id: null, updated_at: '2026-05-15T07:00:00Z' },
    { id: 'also-no-conv', paused_by_conversation_id: null, updated_at: '2026-05-15T07:01:00Z' },
  ];
  const { winners, duplicates } = dedupRunsByConversation(runs);
  assert.equal(winners.length, 2);
  assert.equal(duplicates.length, 0);
});

test('dedup: null/undefined input -> lege output (geen crash)', () => {
  const a = dedupRunsByConversation(null);
  const b = dedupRunsByConversation(undefined);
  assert.deepEqual(a, { winners: [], duplicates: [] });
  assert.deepEqual(b, { winners: [], duplicates: [] });
});

// ── hasOpenBlockingAction ─────────────────────────────────────────────
test('(c) open pending_action (status=pending) -> blokkeert', () => {
  assert.equal(hasOpenBlockingAction([{ status: 'pending' }]), true);
});

test('(c-approved) pending_action met status=approved -> blokkeert (wacht op executor)', () => {
  assert.equal(hasOpenBlockingAction([{ status: 'approved' }]), true);
});

test('(d) afgehandelde pending_action (executed) -> blokkeert (mens heeft zaak opgepakt)', () => {
  assert.equal(hasOpenBlockingAction([{ status: 'executed' }]), true);
});

test('(d-failed) failed pending_action -> blokkeert (executor viel om, mens moet fixen)', () => {
  assert.equal(hasOpenBlockingAction([{ status: 'failed' }]), true);
});

test('(e) alleen rejected action -> laat door (geen bezig-signaal)', () => {
  assert.equal(hasOpenBlockingAction([{ status: 'rejected' }]), false);
});

test('(e-cancelled) alleen cancelled action -> laat door', () => {
  assert.equal(hasOpenBlockingAction([{ status: 'cancelled' }]), false);
});

test('(e-mixed-safe) mix rejected+cancelled -> laat door', () => {
  assert.equal(hasOpenBlockingAction([
    { status: 'rejected' },
    { status: 'cancelled' },
  ]), false);
});

test('(e-mixed-block) mix rejected+pending -> BLOKKEERT (pending is open)', () => {
  assert.equal(hasOpenBlockingAction([
    { status: 'rejected' },
    { status: 'pending' },
  ]), true);
});

test('(f) geen acties (lege array) -> laat door', () => {
  assert.equal(hasOpenBlockingAction([]), false);
});

test('guard: null/undefined input -> laat door (geen crash, fail-safe)', () => {
  assert.equal(hasOpenBlockingAction(null), false);
  assert.equal(hasOpenBlockingAction(undefined), false);
});

test('guard: case-insensitive op status (PENDING vs pending)', () => {
  // Defensive: als een migratie of legacy-rij ooit uppercase status heeft,
  // moet de guard 'em nog steeds herkennen.
  assert.equal(hasOpenBlockingAction([{ status: 'PENDING' }]), true);
  assert.equal(hasOpenBlockingAction([{ status: 'Approved' }]), true);
  assert.equal(hasOpenBlockingAction([{ status: 'REJECTED' }]), false);
});

test('guard: onbekende status -> laat door (geen false-positive blok)', () => {
  // Als er ooit een nieuwe status ('paused', 'draft') bij komt buiten de
  // whitelist om, blokkeert die niet automatisch. Bewuste keuze: liever
  // een gemist blok dan een over-blokkade die een klant nooit meer bereikt.
  assert.equal(hasOpenBlockingAction([{ status: 'paused' }]), false);
  assert.equal(hasOpenBlockingAction([{ status: 'draft' }]), false);
});
