// tests/opvolging-call-link.test.js
//
// Fase 2 DEEL A — een softphone-gesprek dat automatisch als belpoging bij de
// juiste opvolgtaak landt.
//
// Waarom dit bewaakt wordt: de teller die hier gevuld wordt bepaalt in Afgerond
// het oordeel over hoeveel moeite er gedaan is. Een poging te weinig maakt van
// een nette ronde 'te weinig moeite'; een poging bij de verkeerde persoon maakt
// het oordeel over allebei die mensen onwaar. Van de twee is de tweede erger,
// want die valt niet op — vandaar dat een dubbelzinnige match liever niets doet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseerTelefoon, telefoonStaart, kiesTaakVoorCall, bouwCallPoging, KOPPEL_VENSTER_MS,
} from '../api/_lib/opvolging-call-link.js';

const NU = Date.parse('2026-09-04T14:00:00Z');
const NET_GEBELD = new Date(NU - 5 * 60 * 1000).toISOString();

const taak = (over) => ({
  id: 'taak-1', telefoon: '+32470123456', status: 'open',
  updated_at: '2026-09-04T10:00:00Z', ...over,
});

// ── Nummers vergelijken ────────────────────────────────────────────────────

test('normaliseren stript alles wat geen cijfer is', () => {
  // Dezelfde persoon, vier notaties zoals ze echt in de database staan.
  const varianten = ['+32 470 12 34 56', '0032470123456', '+32-470-123456', '(0032) 470 123 456'];
  const uit = varianten.map(normaliseerTelefoon);
  assert.deepEqual(new Set(uit), new Set(['32470123456']));
});

test('leeg of onzinnig nummer levert null, geen lege string', () => {
  for (const raar of [null, undefined, '', '   ', 'geen nummer']) {
    assert.equal(normaliseerTelefoon(raar), null, JSON.stringify(raar));
  }
});

test('de staart is de lokale variant, en alleen bij genoeg cijfers', () => {
  assert.equal(telefoonStaart('+32470123456'), '470123456');
  assert.equal(telefoonStaart('0470123456'), '470123456');
  assert.equal(telefoonStaart('12345'), null);   // te kort om iets over te zeggen
});

// ── De juiste taak kiezen ──────────────────────────────────────────────────

test('exacte match op het volle nummer wint', () => {
  const gekozen = kiesTaakVoorCall({
    taken    : [taak({ id: 'a', telefoon: '+31612345678' }), taak({ id: 'b', telefoon: '+32470123456' })],
    toNumber : '+32 470 123 456',
    startedAt: NET_GEBELD,
    nu       : NU,
  });
  assert.equal(gekozen.id, 'b');
});

test('bij twee taken op hetzelfde nummer wint de meest recent aangeraakte', () => {
  const gekozen = kiesTaakVoorCall({
    taken: [
      taak({ id: 'oud',    updated_at: '2026-08-01T10:00:00Z' }),
      taak({ id: 'recent', updated_at: '2026-09-04T09:00:00Z' }),
    ],
    toNumber : '+32470123456',
    startedAt: NET_GEBELD,
    nu       : NU,
  });
  assert.equal(gekozen.id, 'recent');
});

test('zonder landcode koppelt het nog, maar alleen bij één kandidaat', () => {
  // De taak staat lokaal genoteerd, er is gebeld met landcode.
  const een = kiesTaakVoorCall({
    taken: [taak({ id: 'lokaal', telefoon: '0470123456' })],
    toNumber: '+32470123456', startedAt: NET_GEBELD, nu: NU,
  });
  assert.equal(een.id, 'lokaal');

  // Twee mensen met dezelfde laatste negen cijfers: dan is kiezen gokken.
  const twee = kiesTaakVoorCall({
    taken: [
      taak({ id: 'x', telefoon: '0470123456' }),
      taak({ id: 'y', telefoon: '00470123456' }),
    ],
    toNumber: '+32470123456', startedAt: NET_GEBELD, nu: NU,
  });
  assert.equal(twee, null, 'liever niets dan de verkeerde persoon');
});

test('buiten het venster van twee uur wordt er niet meer gekoppeld', () => {
  const opTijd = kiesTaakVoorCall({
    taken: [taak()], toNumber: '+32470123456',
    startedAt: new Date(NU - (KOPPEL_VENSTER_MS - 60000)).toISOString(), nu: NU,
  });
  assert.ok(opTijd, 'net binnen het venster hoort nog te koppelen');

  const teLaat = kiesTaakVoorCall({
    taken: [taak()], toNumber: '+32470123456',
    startedAt: new Date(NU - (KOPPEL_VENSTER_MS + 60000)).toISOString(), nu: NU,
  });
  assert.equal(teLaat, null, 'een oude call-log hoort nergens meer aan te hangen');
});

test('een begintijd uit de toekomst of zonder waarde koppelt niet', () => {
  for (const start of [null, '', 'gisteren', new Date(NU + 10 * 60000).toISOString()]) {
    assert.equal(
      kiesTaakVoorCall({ taken: [taak()], toNumber: '+32470123456', startedAt: start, nu: NU }),
      null, JSON.stringify(start),
    );
  }
});

test('geen kandidaten of geen nummer levert netjes null', () => {
  assert.equal(kiesTaakVoorCall({ taken: [], toNumber: '+32470123456', startedAt: NET_GEBELD, nu: NU }), null);
  assert.equal(kiesTaakVoorCall({ taken: [taak()], toNumber: '', startedAt: NET_GEBELD, nu: NU }), null);
  assert.equal(kiesTaakVoorCall({ taken: null, toNumber: '+32470123456', startedAt: NET_GEBELD, nu: NU }), null);
});

test('een taak zonder nummer matcht nooit mee', () => {
  const gekozen = kiesTaakVoorCall({
    taken: [taak({ id: 'leeg', telefoon: null }), taak({ id: 'echt' })],
    toNumber: '+32470123456', startedAt: NET_GEBELD, nu: NU,
  });
  assert.equal(gekozen.id, 'echt');
});

// ── De rij die eruit komt ──────────────────────────────────────────────────

test('een opgenomen gesprek wordt gesproken, met duur', () => {
  const p = bouwCallPoging({ taakId: 'taak-1', outcomeHint: 'answered', durationSec: 214, callLogId: 'cl-9' });
  assert.equal(p.soort, 'call');
  assert.equal(p.resultaat, 'gesproken');
  assert.equal(p.duur_sec, 214);
  assert.equal(p.call_log_id, 'cl-9');
  // Automatisch is het halve punt: in de historiek zie je aan het bliksem-icoon
  // dat dit gemeten is en niet door iemand aangeklikt.
  assert.equal(p.automatisch, true);
});

test('elke andere afloop is niet opgenomen', () => {
  for (const hint of ['no_answer', 'busy', 'failed', 'local_cancel', null, undefined, '']) {
    const p = bouwCallPoging({ taakId: 'taak-1', outcomeHint: hint });
    assert.equal(p.resultaat, 'niet opgenomen', String(hint));
    assert.equal(p.automatisch, true);
  }
});

test('een ontbrekende of onzinnige duur wordt null, geen 0 of NaN', () => {
  for (const d of [null, undefined, NaN, -5, 'lang']) {
    assert.equal(bouwCallPoging({ taakId: 't', outcomeHint: 'answered', durationSec: d }).duur_sec, null, String(d));
  }
  assert.equal(bouwCallPoging({ taakId: 't', outcomeHint: 'answered', durationSec: 0 }).duur_sec, 0);
});

test('zonder taak komt er geen rij', () => {
  assert.equal(bouwCallPoging({ taakId: null, outcomeHint: 'answered' }), null);
});
