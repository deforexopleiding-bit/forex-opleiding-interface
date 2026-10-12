// tests/iris-taak6-docs.test.js
//
// De handleiding is wat Maxim leest. Een handleiding die gedrag beschrijft dat
// niet meer zo is, is erger dan geen handleiding: dan werkt iemand volgens een
// beschrijving en snapt niet waarom het anders gaat.
//
// Deze toetsen pinnen GEEN proza. Ze pinnen dat de drie dingen die in taak 6
// veranderden ook in de handleiding staan, en dat er niets meer staat dat
// inmiddels niet waar is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HAND = readFileSync(new URL('../docs/iris/handleiding.md', import.meta.url), 'utf8');
const DOC  = readFileSync(new URL('../docs/iris/05-belrij-en-mentorsignalen.md', import.meta.url), 'utf8');

test('de handleiding zegt niet meer dat je zelf een bericht moet klaarzetten', () => {
  // Stond er: "Dan zet je in de Post een bericht klaar." Dat doet Iris nu.
  assert.ok(
    !/Dan zet je in de Post een bericht klaar/.test(HAND),
    'de handleiding beschrijft nog de handmatige escalatie'
  );
});

test('de handleiding zegt dat de belrij zichzelf vult', () => {
  assert.match(HAND, /vult zichzelf/);
  assert.match(HAND, /drie bronnen/);
});

test('de handleiding zegt dat er meerdere redenen per rij staan', () => {
  assert.match(HAND, /alle\*\* redenen|\*\*alle\*\* redenen/);
});

test('de handleiding legt de drie escalatie-standen uit, met zelf sturen als UIT', () => {
  for (const stand of ['niets doen', 'voorstel in de Post', 'zelf sturen']) {
    assert.ok(HAND.includes(stand), `de stand "${stand}" staat niet in de handleiding`);
  }
  assert.match(HAND, /\*\*Zelf sturen staat uit\*\*/);
});

test('de handleiding noemt de vier poorten die ook bij zelf sturen gelden', () => {
  assert.match(HAND, /tussen 8 en 20 uur/);
  assert.match(HAND, /één bericht per persoon per drie dagen/);
  assert.match(HAND, /lopende\s*\n?betaalafspraak/);
  assert.match(HAND, /tweede voorstel naast een eerste/);
});

test('de handleiding zegt dat het afvinken van een signaal niets in het LMS doet', () => {
  const nooit = HAND.slice(HAND.indexOf('## Wat Iris nooit doet'));
  assert.match(nooit, /mentorsignaal afsluiten in het LMS/i);
  assert.match(nooit, /Heropen/);
});

test('de handleiding zegt dat Iris niet gokt op wie iemand is', () => {
  assert.match(HAND, /twee gesprekken op hetzelfde\s*\n?kanaal/);
});

test('het ontwerpdocument bestaat en noemt de migraties met hun volgorde-eis', () => {
  assert.match(DOC, /2026-10-12-iris-belrij-redenen\.sql/);
  assert.match(DOC, /2026-10-12-iris-belrij-een-rij-per-persoon\.sql/);
  assert.match(DOC, /23505/);
});

test('het ontwerpdocument legt uit waarom er geen ON CONFLICT op iris_belrij staat', () => {
  // Dat is de val waar de volgende lezer in trapt als het er niet staat.
  assert.match(DOC, /PARTIËLE unieke index|partiële\s*\n?index/);
  assert.match(DOC, /ON CONFLICT/);
});

test('het ontwerpdocument wijst naar de code, zodat de volgende sessie niet hoeft te zoeken', () => {
  for (const bestand of [
    'api/_lib/iris/belrij-bronnen.js',
    'api/_lib/iris/belrij-vullen.js',
    'api/_lib/iris/belrij-escalatie.js',
    'api/_lib/iris/belrij-escalatie-concept.js',
    'api/_lib/iris/belrij-escalatie-ronde.js',
    'api/iris-signaal-afhandelen.js',
    'tests/vast/nep-db.js',
  ]) {
    assert.ok(DOC.includes(bestand), `${bestand} staat niet in het ontwerpdocument`);
  }
});
