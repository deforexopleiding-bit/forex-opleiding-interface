// tests/support-aanwezigheid-klant.test.js
//
// ZIT DE BEZOEKER IN DE CHAT, EN KOMT ONS ANTWOORD AAN?
//
//   * bezoekerKijktMee() beslist of een antwoord ook per mail gaat. Met de
//     hartslag van de widget (klant_gezien_op) is dat: < 40 s gezien = hij
//     leest mee. Wie de chat dichtdeed, krijgt mail — ook als hij een
//     minuut geleden nog typte. Zonder de kolom: de oude 2-minutenregel.
//   * leesbareUren() is wat de bezoeker leest: "ma–vr 09:00–17:30", niet
//     "09:00-17:30 Europe/Amsterdam (ma,di,wo,do,vr)".
//   * De wachtrijzin noemt het mailadres waar het antwoord vandaan komt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bezoekerKijktMee, IN_CHAT_VENSTER_MS } from '../api/support-antwoord.js';
import { leesbareUren, beschikbaarheidsTekst } from '../api/_lib/support-beschikbaarheid.js';

const NU = Date.parse('2026-09-24T10:00:00Z');
const geleden = (ms) => new Date(NU - ms).toISOString();

test('chat open (hartslag van 10 s geleden): geen mail nodig', () => {
  assert.equal(bezoekerKijktMee({ klant_gezien_op: geleden(10_000) }, NU), true);
});

test('chat dicht, maar een minuut geleden nog getypt: tóch mailen', () => {
  const g = { klant_gezien_op: geleden(90_000), laatste_klant_bericht_op: geleden(60_000) };
  assert.equal(bezoekerKijktMee(g, NU), false);
});

test('kolom bestaat maar is leeg (nooit gezien): mailen', () => {
  assert.equal(bezoekerKijktMee({ klant_gezien_op: null, laatste_klant_bericht_op: geleden(5_000) }, NU), false);
});

test('grens ligt op 40 seconden', () => {
  assert.equal(IN_CHAT_VENSTER_MS, 40_000);
  assert.equal(bezoekerKijktMee({ klant_gezien_op: geleden(39_000) }, NU), true);
  assert.equal(bezoekerKijktMee({ klant_gezien_op: geleden(41_000) }, NU), false);
});

test('zonder de kolom (migratie niet gedraaid): de oude 2-minutenregel', () => {
  assert.equal(bezoekerKijktMee({ laatste_klant_bericht_op: geleden(60_000) }, NU), true);
  assert.equal(bezoekerKijktMee({ laatste_klant_bericht_op: geleden(3 * 60_000) }, NU), false);
});

test('leesbare kantooruren', () => {
  assert.equal(leesbareUren({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:30' }), 'ma–vr 09:00–17:30');
  assert.equal(leesbareUren({ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '20:00' }), 'elke dag 08:00–20:00');
  assert.equal(leesbareUren({ days: [1, 3, 5], start: '10:00', end: '16:00' }), 'ma, wo, vr 10:00–16:00');
  // Zondag hoort achteraan een Nederlandse week, niet vooraan.
  assert.equal(leesbareUren({ days: [0, 6], start: '10:00', end: '14:00' }), 'za, zo 10:00–14:00');
  assert.equal(leesbareUren({ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00' }), 'ma–za 09:00–17:00');
});

test('de wachtrijzin belooft mail en noemt het afzenderadres', () => {
  const t1 = beschikbaarheidsTekst({ live: false, reden: 'niemand_online' }, 'support@deforexopleiding.nl');
  assert.match(t1, /geen collega online/);
  assert.match(t1, /per mail/);
  assert.match(t1, /support@deforexopleiding\.nl/);
  const t2 = beschikbaarheidsTekst({ live: false, reden: 'buiten_kantooruren', label: 'ma–vr 09:00–17:30' });
  assert.match(t2, /ma–vr 09:00–17:30/);
  assert.match(t2, /info@deforexopleiding\.nl/);
});
