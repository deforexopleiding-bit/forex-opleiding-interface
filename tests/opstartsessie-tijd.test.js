// tests/opstartsessie-tijd.test.js
//
// Tijd-filter van de Kennismakingsgesprekken-LIJST: Aankomend/Verleden op het
// GEKOZEN MOMENT (scheduled_at wint van gekozen_start_at), nooit op created_at.
// Pure functies — geen DB, geen HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiefMoment, pastBijTijd } from '../api/_lib/opstartsessie-tijd.js';

const NU = Date.parse('2026-10-04T12:00:00Z');
const VERLEDEN = '2026-10-01T10:00:00Z';
const TOEKOMST = '2026-10-08T10:00:00Z';

test('effectiefMoment: afspraak (live) wint van bevroren gekozen_start_at', () => {
  assert.equal(effectiefMoment(TOEKOMST, VERLEDEN), new Date(VERLEDEN).toISOString());
  assert.equal(effectiefMoment(VERLEDEN, TOEKOMST), new Date(TOEKOMST).toISOString());
  assert.equal(effectiefMoment(TOEKOMST, null), new Date(TOEKOMST).toISOString());
  assert.equal(effectiefMoment(null, null), null);
  assert.equal(effectiefMoment('geen datum', undefined), null);
});

test('aankomend = moment >= nu, verleden = moment < nu', () => {
  assert.equal(pastBijTijd(TOEKOMST, 'aankomend', NU), true);
  assert.equal(pastBijTijd(VERLEDEN, 'aankomend', NU), false);
  assert.equal(pastBijTijd(VERLEDEN, 'verleden', NU), true);
  assert.equal(pastBijTijd(TOEKOMST, 'verleden', NU), false);
  // Precies nu telt als aankomend (>= nu).
  assert.equal(pastBijTijd(new Date(NU).toISOString(), 'aankomend', NU), true);
  assert.equal(pastBijTijd(new Date(NU).toISOString(), 'verleden', NU), false);
});

test('zonder gekozen moment: niet onder Aankomend of Verleden, wel onder Alles', () => {
  assert.equal(pastBijTijd(null, 'aankomend', NU), false);
  assert.equal(pastBijTijd(null, 'verleden', NU), false);
  assert.equal(pastBijTijd(null, 'alles', NU), true);
});

test('lek-scenario: bevroren moment in de toekomst, afspraak naar het verleden verzet', () => {
  const m = effectiefMoment(TOEKOMST, VERLEDEN);
  assert.equal(pastBijTijd(m, 'aankomend', NU), false);
  assert.equal(pastBijTijd(m, 'verleden', NU), true);
});

test('endpoint: geen IS NULL-tak meer in Aankomend + post-filter alleen buiten agenda', () => {
  const src = readFileSync(new URL('../api/leadsonderhoud-opstartsessies-list.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gekozen_start_at\.is\.null/);
  assert.match(src, /if \(!useRange\) \{[\s\S]{0,200}const nowMs = Date\.parse\(nowIso\);[\s\S]{0,300}pastBijTijd\(effectiefMoment\(/);
});
