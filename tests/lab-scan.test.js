// tests/lab-scan.test.js — de strategiescan die bij een Lab-boeking klaarstaat
// (api/_lib/lab-scan.js): alleen wat één-op-één uit The Lab volgt, idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRijUitLab, maakLabScan } from '../api/_lib/lab-scan.js';
import { normaliseerAntwoorden, ONDERDELEN } from '../modules/scan/scan-model.js';
import { maakFakeDb } from './lab-fake-db.js';

const LAB = { voornaam: 'Lien', achternaam: 'Peeters', email: 'Lien@Voorbeeld.be', telefoon: '+32470000000' };

test('elk Lab-doel landt op een BESTAANDE optie van de scanvraag — de scan aanvaardt het antwoord', () => {
  const opties = ONDERDELEN[0].items[0].opts.map((o) => o[0]);
  for (const [doel, verwacht] of [['bijverdienste', 'Een tweede inkomen naast mijn werk'], ['vermogen', 'Vermogen opbouwen voor later'], ['volledig_inkomen', 'Financiële vrijheid'], ['weet_niet', 'Ik heb (nog) geen concreet doel']]) {
    const r = scanRijUitLab({ lab: { ...LAB, kwalificatie: { doel } }, afspraakId: 'a1' });
    assert.equal(r.doel, verwacht, doel);
    assert.equal(opties[r.antwoorden.motivatie_0], verwacht, doel);
    // De validatie van de scanmodule zelf laat het antwoord door.
    assert.deepEqual(normaliseerAntwoorden(r.antwoorden), r.antwoorden, doel);
  }
});

test('geen kwalificatie: lege antwoorden, geen doel, geen notitie — en nooit een gok', () => {
  const r = scanRijUitLab({ lab: LAB, afspraakId: 'a1', leadId: 'l1', assessorId: 'dave' });
  assert.deepEqual(r.antwoorden, {});
  assert.equal(r.doel, null);
  assert.equal(r.dave_notitie, null);
  assert.equal(r.status, 'concept');
  assert.equal(r.deelnemer_email, 'lien@voorbeeld.be');
  assert.equal(r.deelnemer_naam, 'Lien Peeters');
  // tijd en investeren passen niet één-op-één op een scanvraag → alleen in de notitie.
  const k = scanRijUitLab({ lab: { ...LAB, kwalificatie: { tijd: 'meer_6u', investeren: 'misschien' } }, afspraakId: 'a1' });
  assert.deepEqual(k.antwoorden, {});
  assert.equal(k.dave_notitie, 'Uit The Lab: tijd per week: meer dan 6 uur · bereid te investeren in begeleiding: misschien.');
});

test('test-boeking: TEST in de naam', () => {
  assert.equal(scanRijUitLab({ lab: { voornaam: 'Test' }, afspraakId: 'a1', test: true }).deelnemer_naam, 'TEST · Test');
});

test('idempotent: een tweede keer bij dezelfde afspraak maakt niets bij', async () => {
  const db = maakFakeDb({ scans: [] });
  const een = await maakLabScan(db, { lab: LAB, afspraakId: 'a1' });
  const twee = await maakLabScan(db, { lab: LAB, afspraakId: 'a1' });
  assert.equal(een.nieuw, true);
  assert.equal(twee.nieuw, false);
  assert.equal(twee.id, een.id);
  assert.equal(db.tabellen.scans.length, 1);
});
