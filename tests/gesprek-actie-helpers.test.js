// tests/gesprek-actie-helpers.test.js
//
// Unit-tests voor Blok 2/3 pure helpers uit
// api/_lib/gesprek-actie-helpers.js.  Puur, geen DB / HTTP / env-vars.
//
// Dekt:
//   • buildFollowupPayload — basis-payload + optionele title/note/kind +
//     clamping op max-lengte, coercing van non-strings, defaults.
//   • filterActiveProfilesForPicker — drop rijen zonder id of full_name,
//     preserve volgorde, defaults op role.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFollowupPayload,
  filterActiveProfilesForPicker,
} from '../api/_lib/gesprek-actie-helpers.js';

// ── buildFollowupPayload — basis ──────────────────────────────────────

test('buildFollowupPayload: lege body → defaults + userId', () => {
  const p = buildFollowupPayload({}, 'user-abc');
  assert.equal(p.source, 'inbox', 'default source is "inbox"');
  assert.equal(p.reason, null, 'geen reason → null');
  assert.equal(p.created_from, 'inbox');
  assert.equal(p.created_by_user_id, 'user-abc');
  assert.ok(!('title' in p), 'title afwezig als input leeg');
  assert.ok(!('note' in p),  'note afwezig als input leeg');
  assert.ok(!('kind' in p),  'kind afwezig als input leeg');
});

test('buildFollowupPayload: null/undefined body handeld af', () => {
  const p1 = buildFollowupPayload(null, 'u');
  const p2 = buildFollowupPayload(undefined, 'u');
  assert.equal(p1.source, 'inbox');
  assert.equal(p2.source, 'inbox');
  assert.equal(p1.created_by_user_id, 'u');
});

test('buildFollowupPayload: userId null blijft null (audit-veld)', () => {
  const p = buildFollowupPayload({}, null);
  assert.equal(p.created_by_user_id, null);
});

// ── buildFollowupPayload — velden ─────────────────────────────────────

test('buildFollowupPayload: title/note/kind allemaal gezet komen erin', () => {
  const p = buildFollowupPayload({
    title: 'Bel-taak',
    note:  'Vraag hoe het staat met de deelbetaling',
    kind:  'bel',
  }, 'u1');
  assert.equal(p.title, 'Bel-taak');
  assert.equal(p.note, 'Vraag hoe het staat met de deelbetaling');
  assert.equal(p.kind, 'bel');
});

test('buildFollowupPayload: reason wordt geclamped op 500 chars', () => {
  const longReason = 'x'.repeat(1000);
  const p = buildFollowupPayload({ reason: longReason }, 'u');
  assert.equal(p.reason.length, 500, 'reason max 500 tekens');
});

test('buildFollowupPayload: title 200 / note 2000 / kind 40 clamps', () => {
  const p = buildFollowupPayload({
    title: 'x'.repeat(500),
    note:  'y'.repeat(5000),
    kind:  'z'.repeat(100),
  }, 'u');
  assert.equal(p.title.length, 200);
  assert.equal(p.note.length, 2000);
  assert.equal(p.kind.length, 40);
});

test('buildFollowupPayload: whitespace-only velden worden geskipt', () => {
  const p = buildFollowupPayload({
    title: '   ',
    note:  '\n\t',
    kind:  '  ',
  }, 'u');
  assert.ok(!('title' in p));
  assert.ok(!('note' in p));
  assert.ok(!('kind' in p));
});

test('buildFollowupPayload: numeric input wordt gecoerced naar string', () => {
  // Defensive: als een frontend per ongeluk een number stuurt (bv. 123 als id).
  const p = buildFollowupPayload({ title: 123, note: 456 }, 'u');
  assert.equal(p.title, '123');
  assert.equal(p.note, '456');
});

test('buildFollowupPayload: custom source overrides default "inbox"', () => {
  const p = buildFollowupPayload({ source: 'agent' }, 'u');
  assert.equal(p.source, 'agent');
});

// ── filterActiveProfilesForPicker ─────────────────────────────────────

test('filterActiveProfilesForPicker: valide rijen door-mapped', () => {
  const rows = [
    { id: 'p1', full_name: 'Dave Heylen',    role: 'sales' },
    { id: 'p2', full_name: 'Jeffrey Biemold', role: 'manager' },
  ];
  const out = filterActiveProfilesForPicker(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'p1', full_name: 'Dave Heylen',    role: 'sales' });
  assert.deepEqual(out[1], { id: 'p2', full_name: 'Jeffrey Biemold', role: 'manager' });
});

test('filterActiveProfilesForPicker: rows zonder id/full_name eruit', () => {
  const rows = [
    { id: 'p1', full_name: 'Dave',   role: 'sales' },
    { id: null, full_name: 'Anon',   role: 'x' },       // geen id
    { id: 'p3', full_name: '',       role: 'x' },       // lege naam
    { id: 'p4', full_name: '   ',    role: 'x' },       // whitespace-only
    { id: 'p5', full_name: 'Bob',    role: null },      // valide, role null
  ];
  const out = filterActiveProfilesForPicker(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'p1');
  assert.equal(out[1].id, 'p5');
  assert.equal(out[1].role, '', 'role null → lege string');
});

test('filterActiveProfilesForPicker: null / non-array input → []', () => {
  assert.deepEqual(filterActiveProfilesForPicker(null), []);
  assert.deepEqual(filterActiveProfilesForPicker(undefined), []);
  assert.deepEqual(filterActiveProfilesForPicker('nope'), []);
  assert.deepEqual(filterActiveProfilesForPicker({}), []);
});

test('filterActiveProfilesForPicker: preserves input volgorde', () => {
  const rows = [
    { id: 'z', full_name: 'Zeb' },
    { id: 'a', full_name: 'Ada' },
    { id: 'm', full_name: 'Mia' },
  ];
  const out = filterActiveProfilesForPicker(rows);
  assert.deepEqual(out.map(o => o.id), ['z', 'a', 'm'],
    'volgorde blijft — sortering gebeurt in de SQL query');
});
