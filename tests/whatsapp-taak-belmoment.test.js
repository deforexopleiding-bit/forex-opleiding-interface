// tests/whatsapp-taak-belmoment.test.js
//
// Unit tests voor volgendBelmoment uit api/_lib/whatsapp-taak.js.
//
// Waarom dit apart getest wordt: als Dave een WhatsApp stuurt en de taak
// afvinkt, schuift het belmoment van die lead een dag op. Een fout daarin
// werkt stil door — je belt dan alsnog een uur na het bericht, en dat is
// precies het gevoel dat we wilden vermijden. Een dag te weinig is niet
// zichtbaar in de interface; hier wel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { volgendBelmoment } from '../api/_lib/whatsapp-taak.js';

const DAG = 24 * 3600 * 1000;
const nu = new Date('2026-08-27T10:00:00.000Z');

test('belmoment in de toekomst: precies een dag erbij', () => {
  const straks = new Date(nu.getTime() + 3 * DAG).toISOString();
  assert.equal(volgendBelmoment(straks, nu), new Date(nu.getTime() + 4 * DAG).toISOString());
});

test('belmoment in het verleden: een dag vanaf nu, niet vanaf toen', () => {
  const toen = new Date(nu.getTime() - 5 * DAG).toISOString();
  assert.equal(volgendBelmoment(toen, nu), new Date(nu.getTime() + DAG).toISOString());
});

test('geen belmoment bekend: een dag vanaf nu', () => {
  for (const leeg of [null, undefined, '']) {
    assert.equal(volgendBelmoment(leeg, nu), new Date(nu.getTime() + DAG).toISOString());
  }
});

test('onzin-datum valt terug op nu in plaats van Invalid Date te schrijven', () => {
  const uit = volgendBelmoment('geen-datum', nu);
  assert.equal(uit, new Date(nu.getTime() + DAG).toISOString());
  assert.ok(!Number.isNaN(new Date(uit).getTime()));
});

test('er zit altijd minstens een volle dag tussen — dat is de hele bedoeling', () => {
  for (const invoer of [null, 'geen-datum',
    new Date(nu.getTime() - DAG).toISOString(),
    new Date(nu.getTime() + 60_000).toISOString(),
    new Date(nu.getTime() + 30 * DAG).toISOString()]) {
    const uit = new Date(volgendBelmoment(invoer, nu)).getTime();
    assert.ok(uit - nu.getTime() >= DAG, `te kort voor invoer ${invoer}`);
  }
});
