// tests/onboarding-intake-spiegel.test.js — de intake-pot vullen (5 oktober 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  crmStandVoorIntake, hoortVanzelfInPot, intakePotVanaf,
} from '../api/_lib/onboarding-intake-spiegel.js';

test('DE STAND IN DE POT volgt de CRM-status', () => {
  assert.equal(crmStandVoorIntake({ status: 'aangemeld' }), 'open');
  assert.equal(crmStandVoorIntake({ status: 'bezig' }), 'open');
  // Wizard voltooid is géén afgesloten onboarding: open in de pot (6 okt 2026).
  assert.equal(crmStandVoorIntake({ status: 'afgerond' }), 'open');
  assert.equal(crmStandVoorIntake({ status: 'afgerond', auto_afgerond_op: '2026-10-07T12:00:00Z' }), 'afgerond');
  assert.equal(crmStandVoorIntake({ status: 'geannuleerd' }), 'vervallen');
  assert.equal(crmStandVoorIntake({ status: 'gearchiveerd' }), 'vervallen');
  assert.equal(crmStandVoorIntake({ status: 'bezig', archived_at: '2026-10-01' }), 'vervallen');
});

test('ALLEEN VANAF DE UITROL komt een onboarding vanzelf in de pot', () => {
  const vanaf = '2026-10-06T00:00:00+02:00';
  assert.equal(hoortVanzelfInPot({ created_at: '2026-10-06T08:00:00Z' }, vanaf), true);
  assert.equal(hoortVanzelfInPot({ created_at: '2026-10-05T12:00:00Z' }, vanaf), false);
  assert.equal(hoortVanzelfInPot({}, vanaf), false);
  assert.equal(intakePotVanaf({ INTAKE_POT_VANAF: '2026-11-01' }), '2026-11-01');
  assert.equal(intakePotVanaf({}), '2026-10-06T00:00:00+02:00');
});

test('CONTRACT: alleen de CRM-kolommen — claim en afronding zijn van het LMS', () => {
  const bron = readFileSync(new URL('../api/_lib/onboarding-intake-spiegel.js', import.meta.url), 'utf8');
  const rij = bron.slice(bron.indexOf('const rij = {'), bron.indexOf('};', bron.indexOf('const rij = {')));
  for (const verboden of ['geclaimd_door', 'afgerond_door', 'afgerond_op', 'uitkomst', 'actieplan', 'gesprek_op']) {
    assert.doesNotMatch(rij, new RegExp(verboden), 'de spiegel schrijft ' + verboden);
  }
  assert.doesNotMatch(bron, /sendMail|sendOnboardingMail|sendOnboardingTemplate|createNotification/);
  //  En de onboardingspiegel roept hem aan, vóór de vroege uitgangen.
  const spiegel = readFileSync(new URL('../api/_lib/onboarding-spiegel.js', import.meta.url), 'utf8');
  assert.ok(spiegel.indexOf('spiegelIntake(lms, id)') < spiegel.indexOf('return await verwijderSpiegel(lms, id);'));
});
