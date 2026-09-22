// tests/gesprekken-v2-vlag.test.js
//
// De vlag die het oude scherm moet beschermen.
//
// De audit belooft: staat GESPREKKEN_V2 niet aan, dan verandert er niets aan
// het bestaande gesprekkenscherm. Die belofte is precies zoveel waard als de
// strengheid van deze lezing — een vlag die per ongeluk 'aan' leest bij de
// tekst 'false' of bij een lege waarde is geen vlag maar een verrassing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gesprekkenV2Aan } from '../api/_lib/gesprekken-vlag.js';

test("alleen een uitdrukkelijke 'true' zet de nieuwe weergave aan", () => {
  assert.equal(gesprekkenV2Aan({ GESPREKKEN_V2: 'true' }), true);
  assert.equal(gesprekkenV2Aan({ GESPREKKEN_V2: 'TRUE' }), true);
  assert.equal(gesprekkenV2Aan({ GESPREKKEN_V2: '  true  ' }), true);
});

test('alles wat geen true is, is uit', () => {
  for (const waarde of ['false', '0', '1', 'ja', 'yes', 'on', '', ' ', 'truthy', 'True!']) {
    assert.equal(gesprekkenV2Aan({ GESPREKKEN_V2: waarde }), false, `"${waarde}" zette de vlag aan`);
  }
});

test('ontbrekend of leeg is uit, zonder te struikelen', () => {
  assert.equal(gesprekkenV2Aan({}), false);
  assert.equal(gesprekkenV2Aan(null), false);
  assert.equal(gesprekkenV2Aan(undefined), false);
  assert.equal(gesprekkenV2Aan({ GESPREKKEN_V2: null }), false);
});
