// tests/lab-uitnodiging.test.js
//
// "Plan je sessie met Dave" — de uitnodiging en de vaste balk in het LMS,
// per hook naar boekingen (api/_lib/lab-uitnodiging.js):
//   - een lead telt bij de hook van zijn EERSTE aanmelding; test telt niet;
//   - zien → boeken: in de uitnodiging, of nadien hoe dan ook;
//   - de balk apart; per aanleiding getoond en geboekt;
//   - elke nieuwe soort heeft een leesbare regel in het dossier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uitnodigingPerSleutel, eersteSleutelPerEmail, leesUitnodigingGebeurtenissen, UITNODIGING_SOORTEN } from '../api/_lib/lab-uitnodiging.js';
import { gebeurtenisRegel } from '../api/_lib/lab-dossier.js';
import { maakFakeDb } from './lab-fake-db.js';

const aanm = [
  { email: 'a@x.be', hook: 'H1', aangemaakt: '2026-10-01' },
  { email: 'a@x.be', hook: 'H2', aangemaakt: '2026-10-03' },
  { email: 'b@x.be', hook: 'H1', aangemaakt: '2026-10-02' },
  { email: 'c@x.be', hook: 'H2', aangemaakt: '2026-10-02' },
  { email: 't@x.be', hook: 'H1', aangemaakt: '2026-10-02', is_test: true },
];

test('eerste aanmelding bepaalt de hook; test telt niet', () => {
  const m = eersteSleutelPerEmail(aanm);
  assert.deepEqual([...m], [['a@x.be', 'H1'], ['b@x.be', 'H1'], ['c@x.be', 'H2']]);
});

test('uitnodiging → boeking per hook, balk apart, per aanleiding', () => {
  const lms = new Map([
    ['a@x.be', { labLead: { id: 'la', sessie_geboekt_op: 'x' } }],
    ['b@x.be', { labLead: { id: 'lb' }, geboekt: true }],
    ['c@x.be', { labLead: { id: 'lc', sessie_geboekt_op: 'x' } }],
    ['t@x.be', { labLead: { id: 'lt', sessie_geboekt_op: 'x' } }],
  ]);
  const g = new Map([
    ['la', [
      { soort: 'uitnodiging_getoond', sleutel: '1', data: { aanleiding: 'tijd' } },
      { soort: 'uitnodiging_niet_nu', sleutel: '1' },
      { soort: 'uitnodiging_getoond', sleutel: '2', data: { aanleiding: 'video' } },
      { soort: 'uitnodiging_geboekt', sleutel: '2', data: { bron: 'video' } },
    ]],
    // b zag hem, sloot, en boekte later via de agendalink (CRM): telt als "na".
    ['lb', [{ soort: 'uitnodiging_getoond', sleutel: '1', data: { aanleiding: 'tweede_pagina' } }, { soort: 'uitnodiging_gesloten', sleutel: '1' }]],
    // c boekte via de balk, zonder uitnodiging.
    ['lc', [{ soort: 'balk_geklikt', sleutel: '2026-10-15' }, { soort: 'uitnodiging_geboekt', sleutel: 'balk-2026-10-15', data: { bron: 'balk' } }]],
    ['lt', [{ soort: 'uitnodiging_getoond', sleutel: '1', data: { aanleiding: 'exit' } }]],
  ]);
  const u = uitnodigingPerSleutel(aanm, lms, g);
  const h1 = u.rijen.find((r) => r.sleutel === 'H1');
  const h2 = u.rijen.find((r) => r.sleutel === 'H2');
  assert.deepEqual(h1, { sleutel: 'H1', leads: 2, gezien: 2, getoond: 3, via_uitnodiging: 1, geboekt_na: 2, balk_geklikt: 0, via_balk: 0 });
  assert.deepEqual(h2, { sleutel: 'H2', leads: 1, gezien: 0, getoond: 0, via_uitnodiging: 0, geboekt_na: 0, balk_geklikt: 1, via_balk: 1 });
  assert.equal(u.totaal.leads, 3);
  assert.equal(u.totaal.getoond, 3);
  assert.deepEqual(u.perAanleiding, { tijd: { getoond: 1, geboekt: 0 }, video: { getoond: 1, geboekt: 1 }, tweede_pagina: { getoond: 1, geboekt: 0 } });
});

test('zonder gebeurtenissen of LMS: alles 0, geen crash', () => {
  const u = uitnodigingPerSleutel(aanm, new Map(), new Map());
  assert.equal(u.totaal.gezien, 0);
  assert.equal(u.rijen.length, 2);
});

test('lezen: alleen de uitnodiging-soorten, per lead; leesfout = leeg (fail-soft)', async () => {
  const lms = maakFakeDb({ hlms_lab_lead_gebeurtenis: [
    { lead_id: 'la', soort: 'uitnodiging_getoond', sleutel: '1', data: {} },
    { lead_id: 'la', soort: 'video_gestart', sleutel: 'v', data: {} },
    { lead_id: 'lb', soort: 'balk_geklikt', sleutel: 'd', data: {} },
  ] });
  const m = await leesUitnodigingGebeurtenissen(lms, ['la', 'lb', 'la', null]);
  assert.deepEqual(m.get('la').map((g) => g.soort), ['uitnodiging_getoond']);
  assert.deepEqual(m.get('lb').map((g) => g.soort), ['balk_geklikt']);
  const kapot = { from: () => ({ select() { return this; }, in() { return this; }, then: (r) => r({ data: null, error: { message: 'relation does not exist' } }) }) };
  assert.equal((await leesUitnodigingGebeurtenissen(kapot, ['la'])).size, 0);
});

test('dossier: elke nieuwe soort is leesbaar voor Dave', () => {
  assert.equal(gebeurtenisRegel({ soort: 'uitnodiging_getoond', data: { aanleiding: 'video' } }), 'Kreeg de uitnodiging "Plan je sessie met Dave" (na een video)');
  assert.equal(gebeurtenisRegel({ soort: 'uitnodiging_geboekt', data: { bron: 'balk' } }), 'Boekte via de sessiebalk');
  assert.equal(gebeurtenisRegel({ soort: 'uitnodiging_geboekt', data: { bron: 'tijd' } }), 'Boekte via de uitnodiging');
  for (const s of UITNODIGING_SOORTEN) assert.notEqual(gebeurtenisRegel({ soort: s }), s, s);
});
