// tests/opvolging-leads-import.test.js
//
// 'Lijst opladen' in Leads bellen: CSV lezen, voorvertoning, dosering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leesCsv, splitsRegel, maakVoorvertoning, werkdagPlus, importKaart,
} from '../api/_lib/opvolging-leads-import.js';

test('CSV: kop op naam herkend, ; of , als scheiding, aanhalingstekens', () => {
  const { rijen, fout } = leesCsv('Naam;Telefoon;Notitie\n"Jan, de Smet";0471 12 34 56;"zei ""later"""\nAn;0612345678;');
  assert.equal(fout, null);
  assert.equal(rijen.length, 2);
  assert.equal(rijen[0].naam, 'Jan, de Smet');
  assert.equal(rijen[0].notitie, 'zei "later"');
  assert.deepEqual(splitsRegel('a,"b,c",d', ','), ['a', 'b,c', 'd']);
});

test('CSV: zonder telefoonkolom of zonder rijen een duidelijke fout', () => {
  assert.match(leesCsv('naam,email\nJan,j@x.be').fout, /telefoon/);
  assert.match(leesCsv('naam,telefoon').fout, /minstens één/);
});

test('voorvertoning: geldig / dubbel (bekend of twee keer) / ongeldig', () => {
  const { rijen } = leesCsv('naam,telefoon\nA,0471111111\nB,0472222222\nC,123\nD,+32 471 11 11 11\n,0473333333');
  const vv = maakVoorvertoning({ rijen, bekendeTelefoons: ['+32472222222'], vandaag: '2026-10-02', perDag: 10 });
  assert.deepEqual(vv.rijen.map((r) => r.status), ['geldig', 'dubbel', 'ongeldig', 'dubbel', 'ongeldig']);
  assert.deepEqual(vv.aantallen, { geldig: 1, dubbel: 2, ongeldig: 2 });
  assert.equal(vv.rijen[0].telefoon, '+32471111111');
});

test('dosering: max N per werkdag, weekend overgeslagen, vandaag-teller telt mee', () => {
  // 2026-10-02 is een vrijdag.
  const csv = 'naam,telefoon\n' + Array.from({ length: 5 }, (_, i) => 'L' + i + ',047100000' + i).join('\n');
  const vv = maakVoorvertoning({ rijen: leesCsv(csv).rijen, vandaag: '2026-10-02', perDag: 2 });
  assert.deepEqual(vv.rijen.map((r) => r.due), ['2026-10-02', '2026-10-02', '2026-10-05', '2026-10-05', '2026-10-06']);
  assert.equal(vv.samenvatting, '2 vandaag, rest verspreid tot 2026-10-06');
  const vol = maakVoorvertoning({ rijen: leesCsv(csv).rijen, vandaag: '2026-10-02', perDag: 2, alVandaag: 2 });
  assert.equal(vol.rijen[0].due, '2026-10-05');
});

test('werkdagPlus: op zaterdag begint het op maandag', () => {
  assert.equal(werkdagPlus('2026-10-03', 0), '2026-10-05');
  assert.equal(werkdagPlus('2026-10-02', 1), '2026-10-05');
});

test('de kaart: lijst leads, bron import, label als etiket, geen lead_id', () => {
  const k = importKaart({ rij: { naam: 'A', telefoon: '+32471', due: '2026-10-05', notitie: 'belde terug' }, label: 'Geannuleerd voorjaar', nuIso: '2026-10-02T10:00:00Z' });
  assert.equal(k.lijst, 'leads');
  assert.equal(k.bron, 'import');
  assert.equal(k.reden, 'lead_bellen');
  assert.equal(k.lead_id, null);
  assert.equal(k.badge_label, 'Geannuleerd voorjaar');
  assert.equal(k.status, 'open');
  assert.match(k.notitie, /belde terug/);
});
