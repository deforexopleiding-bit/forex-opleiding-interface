// tests/dunning-skip-helpers.test.js
//
// Unit tests voor api/_lib/dunning-skip-helpers.js. Pure functie —
// input steps + currentStepId → { current, next }.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNextStep } from '../api/_lib/dunning-skip-helpers.js';

const steps = [
  { id: 's1', step_order: 1, step_type: 'email' },
  { id: 's2', step_order: 2, step_type: 'wait',     config: { days: 7 } },
  { id: 's3', step_order: 3, step_type: 'whatsapp' },
  { id: 's4', step_order: 4, step_type: 'stop' },
];

test('findNextStep: op stap 1 → next = stap 2', () => {
  const { current, next } = findNextStep(steps, 's1');
  assert.equal(current.id, 's1');
  assert.equal(next.id, 's2');
  assert.equal(next.step_type, 'wait');
});

test('findNextStep: op wait-stap 2 → next = stap 3 (skip vervalt wachttijd)', () => {
  const { current, next } = findNextStep(steps, 's2');
  assert.equal(current.step_type, 'wait');
  assert.equal(next.id, 's3');
});

test('findNextStep: op laatste stap → next = null', () => {
  const { current, next } = findNextStep(steps, 's4');
  assert.equal(current.id, 's4');
  assert.equal(next, null);
});

test('findNextStep: currentStepId niet in lijst → current=null, next=null (engine-glitch)', () => {
  const { current, next } = findNextStep(steps, 's-onbekend');
  assert.equal(current, null);
  assert.equal(next, null);
});

test('findNextStep: lege stap-lijst → beide null', () => {
  const { current, next } = findNextStep([], 's1');
  assert.equal(current, null);
  assert.equal(next, null);
});

test('findNextStep: null/undefined input → beide null (defensief)', () => {
  assert.deepEqual(findNextStep(null, 's1'),     { current: null, next: null });
  assert.deepEqual(findNextStep(steps, null),    { current: null, next: null });
  assert.deepEqual(findNextStep(steps, ''),      { current: null, next: null });
});

test('findNextStep: input ongesorteerd → resultaat correct (helper sorteert zelf)', () => {
  const scrambled = [steps[2], steps[0], steps[3], steps[1]];  // door elkaar
  const { current, next } = findNextStep(scrambled, 's2');
  assert.equal(current.id, 's2');
  assert.equal(next.id, 's3');
});

test('findNextStep: step_order als string (defensief) — Number-conversie', () => {
  const messy = [
    { id: 'a', step_order: '2', step_type: 'x' },
    { id: 'b', step_order: '1', step_type: 'x' },
    { id: 'c', step_order: '3', step_type: 'x' },
  ];
  const { current, next } = findNextStep(messy, 'b');
  assert.equal(current.id, 'b');
  assert.equal(next.id, 'a');   // step_order '2' > '1'
});
