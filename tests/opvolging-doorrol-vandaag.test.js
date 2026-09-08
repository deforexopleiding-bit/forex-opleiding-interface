// tests/opvolging-doorrol-vandaag.test.js
//
// DE DOORROL SLOEG ELKE NACHT EEN DAG OVER.
//
// Gemeten op 8 september. De vijf leads die Dave op 7 september niet te pakken
// kreeg — Achraf Deflaoui, Kris Sienaert, Said Hachemi, Gevorg Khetchoumian en
// Werner De Kesel — stonden alle vijf op due 2026-09-09. Dat is niet 'blijven
// liggen', dat is een dag OVERSLAAN: op 8 september stonden ze nergens.
//
// Alle vijf droegen updated_at 2026-09-07T23:59, dus de doorrol had ze wel
// degelijk aangeraakt en er de verkeerde datum op gezet.
//
// DE OORZAAK. In vercel.json staat de doorrol op `59 23 * * *`, en Vercel
// draait crons in UTC. 23:59 UTC is 01:59 in Amsterdam — het is dan dus AL de
// volgende dag. De cron rekende vervolgens netjes uit wat 'morgen' was vanuit
// Amsterdams perspectief, en kwam daarmee op overmorgen uit.
//
// DE FIX IS GEEN TIJDZONECORRECTIE. `59 21 * * *` klopt in de zomer en is in de
// winter weer mis, want Nederland schuift twee keer per jaar. De regel wordt
// daarom: elke openstaande taak met een due VOOR de huidige Amsterdamse datum
// krijgt die datum. Dat is idempotent, het maakt niet uit hoe laat de cron
// draait, en als een nacht overslaat haalt de volgende run alles alsnog naar
// voren in plaats van kaarten voorgoed in het verleden te laten hangen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bepaalDoorrol, doorrolDag } from '../api/_lib/opvolging-doorrol.js';
import { dagVan } from '../api/_lib/opvolging-vensters.js';

// ═══════════════════════════════════════════════════════════════════════════
// DE FEITEN OVER DE KLOK
// ═══════════════════════════════════════════════════════════════════════════

test('23:59 UTC is in Amsterdam al de volgende dag — dat is de hele fout', () => {
  // Zomertijd (CEST, UTC+2). Dit is het moment waarop de cron draait.
  assert.equal(dagVan('2026-09-07T23:59:00Z'), '2026-09-08');
  // En in de winter (CET, UTC+1) net zo goed.
  assert.equal(dagVan('2026-12-07T23:59:00Z'), '2026-12-08');
});

test('de doorrol richt op de dag waarop hij draait, niet op de dag erna', () => {
  // DIT is de regressietest van de bug zelf. De oude code deed
  // dagInZone(nu + 24 uur) en kwam daarmee op 2026-09-09 uit, waardoor 8
  // september werd overgeslagen.
  assert.equal(doorrolDag(Date.parse('2026-09-07T23:59:00Z')), '2026-09-08');
  assert.equal(doorrolDag(Date.parse('2026-12-07T23:59:00Z')), '2026-12-08');
  // En midden op de dag levert hij gewoon die dag op, zodat een handmatige run
  // hetzelfde doet als de nachtelijke.
  assert.equal(doorrolDag(Date.parse('2026-09-08T10:00:00Z')), '2026-09-08');
});

test('DE RUN VAN VANNACHT: 8 september 23:59 UTC richt op 9 september', () => {
  // De concrete run waar het vanavond om gaat. De cron vuurt op
  // 2026-09-08T23:59:00Z; dat is in Amsterdam al 9 september 01:59. De oude
  // regel telde daar nog een etmaal bij op en kwam op 2026-09-10 uit, waardoor
  // alles wat vandaag openstaat 9 september zou overslaan.
  const nacht = Date.parse('2026-09-08T23:59:00Z');
  assert.equal(doorrolDag(nacht), '2026-09-09');

  const patches = bepaalDoorrol({
    taken: [{ id: 't', status: 'open', due: '2026-09-08', later: true }],
    vandaag: doorrolDag(nacht),
  });
  assert.equal(patches[0].patch.due, '2026-09-09', 'niet 2026-09-10');
  assert.equal(patches[0].patch.later, false);
});

test('zomer- en wintertijd geven allebei het goede antwoord — geen schemacorrectie nodig', () => {
  // De reden dat de fix niet in vercel.json zit: Nederland schuift twee keer
  // per jaar, dus elk vast UTC-uur is de helft van het jaar mis.
  assert.equal(doorrolDag(Date.parse('2026-06-30T22:30:00Z')), '2026-07-01');  // CEST
  assert.equal(doorrolDag(Date.parse('2026-01-30T22:30:00Z')), '2026-01-30');  // CET
});

// ═══════════════════════════════════════════════════════════════════════════
// DE REGEL: NAAR VANDAAG, NIET NAAR MORGEN
// ═══════════════════════════════════════════════════════════════════════════

test('een kaart van gisteren komt VANDAAG terug, niet morgen', () => {
  const patches = bepaalDoorrol({
    taken: [{ id: 't1', status: 'open', due: '2026-09-07', later: true }],
    vandaag: '2026-09-08',
  });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].patch.due, '2026-09-08');
  assert.equal(patches[0].patch.later, false);
});

test('de vijf van 7 september komen op 8 september terug en niet op de 9e', () => {
  const namen = ['Achraf Deflaoui', 'Kris Sienaert', 'Said Hachemi',
    'Gevorg Khetchoumian', 'Werner De Kesel'];
  const taken = namen.map((naam, i) => ({ id: 'k' + i, naam, status: 'open', due: '2026-09-07' }));
  const patches = bepaalDoorrol({ taken, vandaag: '2026-09-08' });
  assert.equal(patches.length, 5);
  for (const p of patches) assert.equal(p.patch.due, '2026-09-08');
});

test('een kaart die al op vandaag staat wordt niet aangeraakt', () => {
  // Anders verschuift updated_at elke nacht zonder dat er iets verandert, en
  // dan is niet meer te zien wanneer er echt iets met de kaart gebeurde.
  assert.deepEqual(bepaalDoorrol({
    taken: [{ id: 't1', status: 'open', due: '2026-09-08' }], vandaag: '2026-09-08',
  }), []);
});

test('een kaart die de gebruiker zelf vooruit zette blijft staan', () => {
  assert.deepEqual(bepaalDoorrol({
    taken: [{ id: 't1', status: 'open', due: '2026-09-22' }], vandaag: '2026-09-08',
  }), []);
});

test('alleen open kaarten; ingepland en gearchiveerd blijven met rust', () => {
  const taken = [
    { id: 'a', status: 'ingepland',    due: '2026-09-01' },
    { id: 'b', status: 'gearchiveerd', due: '2026-09-01' },
    { id: 'c', status: 'wacht_inplanning', due: '2026-09-01' },
    { id: 'd', status: 'open',         due: '2026-09-01' },
  ];
  const patches = bepaalDoorrol({ taken, vandaag: '2026-09-08' });
  assert.deepEqual(patches.map((p) => p.id), ['d']);
});

// ═══════════════════════════════════════════════════════════════════════════
// ZELFHELEND — DIT IS HET PUNT
// ═══════════════════════════════════════════════════════════════════════════

test('slaat de cron een nacht over, dan haalt de volgende run alles alsnog naar voren', () => {
  // De oude regel ('naar morgen') kon dit niet: wat op een gemiste nacht in het
  // verleden bleef staan, kreeg de dag erna morgen — en stond dus opnieuw op
  // een dag die al voorbij was zodra iemand keek.
  const taken = [
    { id: 'oud', status: 'open', due: '2026-09-01' },
    { id: 'gisteren', status: 'open', due: '2026-09-07' },
  ];
  const patches = bepaalDoorrol({ taken, vandaag: '2026-09-08' });
  assert.equal(patches.length, 2);
  for (const p of patches) assert.equal(p.patch.due, '2026-09-08');
});

test('twee keer draaien geeft de tweede keer niets te doen', () => {
  const taken = [{ id: 't1', status: 'open', due: '2026-09-07' }];
  const eerste = bepaalDoorrol({ taken, vandaag: '2026-09-08' });
  const na = taken.map((t) => ({ ...t, ...(eerste.find((p) => p.id === t.id)?.patch || {}) }));
  assert.deepEqual(bepaalDoorrol({ taken: na, vandaag: '2026-09-08' }), []);
});

test('een onbruikbare datum doet niets, in plaats van iets willekeurigs', () => {
  assert.deepEqual(bepaalDoorrol({ taken: [{ id: 't1', status: 'open', due: '2026-09-07' }], vandaag: 'morgen' }), []);
  assert.deepEqual(bepaalDoorrol({ taken: [{ id: 't1', status: 'open', due: 'onbekend' }], vandaag: '2026-09-08' }), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP HET PAD DAT ECHT DRAAIT
// ═══════════════════════════════════════════════════════════════════════════

test('de cron rekent met VANDAAG en telt er geen etmaal bij op', () => {
  const bron = readFileSync('api/cron-opvolging-doorrol.js', 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(bron, /24 \* 3600 \* 1000/,
    'een etmaal erbij optellen is precies de fout die een dag deed overslaan');
  assert.match(bron, /const vandaag = doorrolDag\(startedAt\)/);
  assert.match(bron, /bepaalDoorrol\(\{ taken, vandaag \}\)/);
  assert.match(bron, /\.lt\('due', vandaag\)/);
});
