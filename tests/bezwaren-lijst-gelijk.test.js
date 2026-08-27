// tests/bezwaren-lijst-gelijk.test.js
//
// Bewaakt dat de elf bezwaren aan beide kanten identiek blijven.
//
// De frontend is een klassiek script en de API draait op ES-modules, dus één
// bestand delen kan niet. De lijst staat daarom twee keer:
//   · api/_lib/bezwaren.js                          (server, waarheid)
//   · modules/klanten-v2/views/_shared-v2.js        (scherm)
//
// Lopen die twee uit elkaar, dan accepteert de server een bezwaar niet dat het
// scherm wél aanbiedt — of erger: er ontstaan twee rapportages over dezelfde
// vraag die niet op te tellen zijn. Dat merk je pas als iemand de cijfers naast
// elkaar legt, en dan is het al maanden mis.
//
// Deze test leest het frontend-bestand als TEKST. Dat is bewust: het bestand
// importeren kan niet (het verwacht een browser met window.DFO).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BEZWAREN, isBezwaar } from '../api/_lib/bezwaren.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'modules/klanten-v2/views/_shared-v2.js');

/** Haal de literal `const BEZWAREN = [ ... ];` uit de broncode. */
function bezwarenUitScherm() {
  const src = readFileSync(SHARED, 'utf8');
  const m = src.match(/const BEZWAREN = \[([\s\S]*?)\];/);
  assert.ok(m, 'geen `const BEZWAREN = [...]` gevonden in _shared-v2.js — is de lijst verplaatst?');
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

test('scherm en server kennen exact dezelfde elf bezwaren, in dezelfde volgorde', () => {
  assert.deepEqual(bezwarenUitScherm(), [...BEZWAREN]);
});

test('het zijn er elf, en geen enkele is leeg of dubbel', () => {
  assert.equal(BEZWAREN.length, 11);
  assert.equal(new Set(BEZWAREN).size, 11);
  for (const b of BEZWAREN) assert.ok(b.trim().length > 0, 'leeg bezwaar');
});

test('isBezwaar accepteert alleen exacte waarden', () => {
  assert.ok(isBezwaar('Te duur'));
  assert.ok(isBezwaar('Anders'));
  // Geen varianten: een spatie of een kleine letter erbij is een andere waarde
  // en zou als aparte categorie in de rapportage belanden.
  for (const nee of ['te duur', 'Te duur ', ' Te duur', 'Te  duur', '', null, undefined, 42, {}]) {
    assert.equal(isBezwaar(nee), false, `${JSON.stringify(nee)} hoort geen geldig bezwaar te zijn`);
  }
});

test('de lijst is bevroren — niemand voegt er tijdens runtime iets aan toe', () => {
  assert.throws(() => { BEZWAREN.push('Nog een reden'); }, TypeError);
  assert.equal(BEZWAREN.length, 11);
});
