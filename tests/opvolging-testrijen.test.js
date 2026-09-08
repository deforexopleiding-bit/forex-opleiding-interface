// tests/opvolging-testrijen.test.js
//
// Testrijen uit de cijfers. Drie soorten, en de derde bepaalt de oplossing:
// een poging met resultaat 'gesproken: test' op Jeffrey Biemold — een ECHTE
// lead. De testcall zit dus op een echte kaart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  haalMetTestvlag, isKolomOnbekend, isTestrij, scheidTestrijen, filterPogingen, testZin,
} from '../api/_lib/opvolging-testrijen.js';

// ═══════════════════════════════════════════════════════════════════════════
// DE VLAG, EN NIETS ANDERS
// ═══════════════════════════════════════════════════════════════════════════

test('alleen de expliciete vlag maakt een rij een testrij', () => {
  // Geen naamherkenning en geen tekstherkenning: die zouden geval 3 missen en
  // vroeg of laat echte pogingen wegfilteren op het woord 'test' in een notitie.
  assert.equal(isTestrij({ is_test: true }), true);
  assert.equal(isTestrij({ naam: 'test test2', resultaat: 'gesproken: test' }), false);
  assert.equal(isTestrij({ is_test: false }), false);
  assert.equal(isTestrij({}), false);
  assert.equal(isTestrij(null), false);
});

test('een testpoging op een ECHTE kaart valt weg zonder de kaart te raken', () => {
  // Geval 3: Jeffrey Biemold is een echte lead met een testcall erop.
  const pogingen = [
    { id: 'p1', taak_id: 'jeffrey', resultaat: 'gesproken: test', is_test: true },
    { id: 'p2', taak_id: 'jeffrey', resultaat: 'gesproken', is_test: false },
  ];
  const r = filterPogingen(pogingen, new Set());
  assert.deepEqual(r.echt.map((p) => p.id), ['p2']);
  assert.equal(r.aantalTest, 1);
});

test('elke poging op een TESTKAART telt als testhandeling, ook zonder eigen vlag', () => {
  const pogingen = [
    { id: 'p1', taak_id: 'nep', is_test: false },
    { id: 'p2', taak_id: 'echt', is_test: false },
  ];
  const r = filterPogingen(pogingen, new Set(['nep']));
  assert.deepEqual(r.echt.map((p) => p.id), ['p2']);
  assert.equal(r.aantalTest, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KOLOM MAG ONTBREKEN — IN BEIDE VOLGORDES
// ═══════════════════════════════════════════════════════════════════════════
// Tussen de deploy en het draaien van de migratie mag er geen seconde zijn
// waarin het rapport stukstaat, in welke volgorde die twee ook gebeuren.

test('zonder de kolom valt de select terug en telt alles gewoon mee', async () => {
  const gevraagd = [];
  const r = await haalMetTestvlag(async (k) => {
    gevraagd.push(k);
    if (k.includes('is_test')) return { data: null, error: { code: '42703', message: 'column "is_test" does not exist' } };
    return { data: [{ id: 'a' }, { id: 'b' }], error: null };
  }, 'id, naam');
  assert.equal(r.error, null);
  assert.equal(r.data.length, 2, 'alles telt mee, precies zoals gisteren');
  assert.equal(r.kolomAanwezig, false);
  assert.deepEqual(gevraagd, ['id, naam, is_test', 'id, naam']);
});

test('een ANDERE fout wordt niet als ontbrekende kolom weggemoffeld', () => {
  assert.equal(isKolomOnbekend({ code: '42703' }), true);
  assert.equal(isKolomOnbekend({ code: '42501', message: 'permission denied' }), false);
  assert.equal(isKolomOnbekend({ message: 'column "iets_anders" does not exist' }, 'is_test'), false);
});

test('met de kolom wordt er maar één keer gevraagd', async () => {
  let n = 0;
  const r = await haalMetTestvlag(async () => { n += 1; return { data: [{ id: 'a', is_test: false }], error: null }; }, 'id');
  assert.equal(n, 1);
  assert.equal(r.kolomAanwezig, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET FILTER IS ZICHTBAAR
// ═══════════════════════════════════════════════════════════════════════════

test('als er testrijen zijn weggelaten staat dat er letterlijk bij', () => {
  assert.match(testZin({ pogingen: 2, taken: 1 }), /2 testhandelingen en 1 testkaart buiten de telling/);
  assert.match(testZin({ pogingen: 1, taken: 0 }), /1 testhandeling buiten de telling/);
});

test('zonder weglatingen geen zin — anders wordt het ruis', () => {
  assert.equal(testZin({ pogingen: 0, taken: 0 }), '');
});

test('zolang de kolom er niet is zegt het rapport dát ook', () => {
  // Stil doen alsof er gefilterd wordt terwijl dat niet kan, is de ergste
  // variant: dan denkt de lezer dat de testrijen eruit zijn.
  assert.match(testZin({ pogingen: 0, taken: 0, kolomAanwezig: false }), /bestaat nog niet/);
});

test('de zin wordt op het scherm ÉN in de PDF getekend', () => {
  const view = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  const print = readFileSync('modules/klanten-v2/rapport-print.html', 'utf8');
  assert.match(view, /d\.testrijen && d\.testrijen\.zin/);
  assert.match(print, /d\.testrijen && d\.testrijen\.zin/);
});

test('het rapport levert de telling mee', () => {
  const bron = readFileSync('api/opvolging-rapport.js', 'utf8');
  assert.match(bron, /testrijen: testTelling/);
  // En het filter staat op ÉÉN plek: de pogingen worden één keer gesplitst.
  assert.equal((bron.match(/filterPogingen\(/g) || []).length, 1);
});
