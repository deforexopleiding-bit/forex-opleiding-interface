// tests/gesprekken-draadvenster.test.js
//
// Hoeveel van een gesprek je in één keer ophaalt, en hoe je aan de rest komt.
//
// Het gat: de draad haalde alle berichten op, gooide alles weg behalve de
// laatste 200, en zei er niets over. Je leest dan een gesprek dat halverwege
// begint zonder dat iets dat zegt — en het werk groeit mee met de
// geschiedenis, dus precies bij de klant met wie je het meest gepraat hebt
// loopt het endpoint als eerste tegen zijn tijdslimiet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VENSTER_STANDAARD,
  VENSTER_MAX,
  leesGrens,
  ophaalAantal,
  venster,
} from '../api/_lib/gesprekken-draadvenster.js';

const maak = (n, vanaf = 0) => Array.from({ length: n }, (_, i) => ({
  id: String(vanaf + i),
  channel: 'whatsapp',
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, vanaf + i)).toISOString(),
}));

// ── de grens lezen ──────────────────────────────────────────────────────────

test('een onleesbare grens wordt null, nooit "dan maar alles"', () => {
  // Dit is de gevaarlijke kant. Een grens die stilletjes wegvalt is een
  // opvraging zonder filter, en die haalt de hele geschiedenis op.
  assert.equal(leesGrens('gisteren'), null);
  assert.equal(leesGrens(''), null);
  assert.equal(leesGrens('   '), null);
  assert.equal(leesGrens(null), null);
  assert.equal(leesGrens(undefined), null);
  assert.equal(leesGrens({}), null);
});

test('een geldige grens komt er genormaliseerd uit', () => {
  assert.equal(leesGrens('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(leesGrens('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
});

// ── hoeveel we ophalen ──────────────────────────────────────────────────────

test('we halen er één meer op dan we tonen', () => {
  // Die ene extra is het hele antwoord op "is er nog meer?", zonder een
  // tweede opvraging die alleen maar telt.
  assert.equal(ophaalAantal(200), 201);
  assert.equal(ophaalAantal(10), 11);
});

test('onzin als omvang valt terug op iets veiligs', () => {
  assert.equal(ophaalAantal('honderd'), VENSTER_STANDAARD + 1);
  assert.equal(ophaalAantal(0), 2);
  assert.equal(ophaalAantal(-5), 2);
  assert.equal(ophaalAantal(99999), VENSTER_MAX + 1);
});

// ── de bladzijde knippen ────────────────────────────────────────────────────

test('past het erin, dan is er niets meer en wordt er niets geknipt', () => {
  const r = venster(maak(50), 200);
  assert.equal(r.zichtbaar.length, 50);
  assert.equal(r.heeftMeer, false);
});

test('precies vol is NIET "er is meer"', () => {
  // De grens op een na. Zonder de extra rij zou je hier onterecht "toon
  // oudere berichten" tonen, en dan klikt iemand op iets dat niets oplevert.
  const r = venster(maak(200), 200);
  assert.equal(r.zichtbaar.length, 200);
  assert.equal(r.heeftMeer, false);
});

test('één te veel is wel "er is meer"', () => {
  const r = venster(maak(201), 200);
  assert.equal(r.zichtbaar.length, 200);
  assert.equal(r.heeftMeer, true);
});

test('bij overloop houden we de NIEUWSTE, niet de oudste', () => {
  // Een gesprek lees je van onder naar boven. De oudste 200 tonen van een
  // gesprek van 300 is onbruikbaar: het laatste bericht is waar het om gaat.
  const r = venster(maak(300), 200);
  assert.equal(r.zichtbaar[r.zichtbaar.length - 1].id, '299');
  assert.equal(r.zichtbaar[0].id, '100');
});

test('de grens voor de volgende bladzijde is het OUDSTE getoonde bericht', () => {
  const alles = maak(300);
  const r = venster(alles, 200);
  assert.equal(r.oudsteAt, alles[100].at);
});

test('een lege draad geeft geen grens', () => {
  const r = venster([], 200);
  assert.deepEqual(r.zichtbaar, []);
  assert.equal(r.heeftMeer, false);
  assert.equal(r.oudsteAt, null);
});

test('onzin erin geeft een lege bladzijde in plaats van een uitzondering', () => {
  assert.deepEqual(venster(null, 200).zichtbaar, []);
  assert.deepEqual(venster(undefined, 200).zichtbaar, []);
});

// De ontdubbeling van de bladzijdegrens hoort bij het scherm; die tests staan
// in tests/gesprekken-v2-venster-en-status.test.js.
