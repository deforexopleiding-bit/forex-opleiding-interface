// tests/opvolging-belpogingen-bij-call.test.js
//
// Shudino Andrade stond op 7 september als no-show, en de collega die hem nog
// gebeld had moest op zijn woord geloofd worden. Terwijl het in onze data
// stond: een uitgaande call van 41 seconden om 17:23. Deze tests zijn om dat
// getal heen gebouwd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { belpogingenVoorCalls, belZin, bouwZoomcalls, GESPREK_MIN_SEC } from '../api/opvolging-rapport.js';

const TAAK = { id: 'taak-shudino', telefoon: '+31612345678' };
const CALL = {
  id: 'appt-shudino', lead_name: 'Shudino Andrade', lead_phone: '0612345678',
  lead_email: 's@x.nl', scheduled_at: '2026-09-07T16:00:00Z', status: 'no_show',
};
const POGING_1723 = {
  id: 'p1', taak_id: 'taak-shudino', soort: 'call', richting: 'uit',
  tijdstip: '2026-09-07T15:23:00Z', duur_sec: 41,
};

test('het gesprek van 41 seconden staat bij de call van Shudino', () => {
  const m = belpogingenVoorCalls({ afspraken: [CALL], taken: [TAAK], pogingen: [POGING_1723] });
  const b = m.get('appt-shudino');
  assert.equal(b.gekoppeld, true);
  assert.equal(b.aantal, 1);
  assert.equal(b.gesproken, 1);
  assert.equal(b.seconden, 41);
  assert.equal(b.pogingen[0].soort, 'gesprek');
  assert.match(b.samenvatting, /41 s/);
});

test('ALLE pogingen van die dag tellen, niet alleen het nabelvenster', () => {
  // Dit is de kern van de klacht: 17:23 valt ver buiten 12-13 uur en telde
  // daarom nergens mee. Een gesprek om kwart over vijf is evengoed bewijs.
  const ochtend = { ...POGING_1723, id: 'p0', tijdstip: '2026-09-07T06:30:00Z', duur_sec: 4 };
  const middag  = { ...POGING_1723, id: 'pm', tijdstip: '2026-09-07T10:15:00Z', duur_sec: 0 };
  const m = belpogingenVoorCalls({ afspraken: [CALL], taken: [TAAK], pogingen: [ochtend, middag, POGING_1723] });
  const b = m.get('appt-shudino');
  assert.equal(b.aantal, 3, 'alle drie de pogingen van die dag');
  assert.equal(b.gesproken, 1, 'alleen die van 41 s is een gesprek');
  assert.deepEqual(b.pogingen.map((p) => p.soort), ['te_kort', 'te_kort', 'gesprek']);
  assert.deepEqual(b.pogingen.map((p) => p.tijd), ['08:30', '12:15', '17:23']);
});

test('een poging van gisteren telt niet mee bij de call van vandaag', () => {
  const gisteren = { ...POGING_1723, id: 'pg', tijdstip: '2026-09-06T15:23:00Z' };
  const b = belpogingenVoorCalls({ afspraken: [CALL], taken: [TAAK], pogingen: [gisteren] }).get('appt-shudino');
  assert.equal(b.aantal, 0);
  assert.equal(b.samenvatting, 'Die dag niet gebeld.');
});

test('een onbekende duur is geen te korte call — drie uitkomsten, geen twee', () => {
  const zonder = { ...POGING_1723, id: 'pz', duur_sec: null };
  const b = belpogingenVoorCalls({ afspraken: [CALL], taken: [TAAK], pogingen: [zonder] }).get('appt-shudino');
  assert.equal(b.pogingen[0].soort, 'duur_onbekend');
  assert.equal(b.gesproken, 0);
});

test('WhatsApp en inkomende calls staan niet in de beltelling', () => {
  const wa = { ...POGING_1723, id: 'pw', soort: 'whatsapp' };
  const inkomend = { ...POGING_1723, id: 'pi', richting: 'in' };
  const b = belpogingenVoorCalls({ afspraken: [CALL], taken: [TAAK], pogingen: [wa, inkomend] }).get('appt-shudino');
  assert.equal(b.aantal, 0);
});

test('geen gekoppelde taak is NIET nul — dat zou een verwijt zijn over iets ongemetens', () => {
  const b = belpogingenVoorCalls({ afspraken: [CALL], taken: [], pogingen: [POGING_1723] }).get('appt-shudino');
  assert.equal(b.gekoppeld, false);
  assert.notEqual(b.samenvatting, 'Die dag niet gebeld.');
  assert.equal(b.samenvatting, undefined, 'zonder koppeling geen zin die iets beweert');
});

test('twee leads met dezelfde staart leveren geen koppeling op, geen gok', () => {
  const tweeling = [{ id: 'a', telefoon: '+31612345678' }, { id: 'b', telefoon: '0032612345678' }];
  const b = belpogingenVoorCalls({ afspraken: [CALL], taken: tweeling, pogingen: [POGING_1723] }).get('appt-shudino');
  assert.equal(b.gekoppeld, false);
});

test('bouwZoomcalls hangt de belpogingen aan de call — de aanroep, niet de hulpfunctie', () => {
  const belBijCall = belpogingenVoorCalls({ afspraken: [CALL], taken: [TAAK], pogingen: [POGING_1723] });
  const [c] = bouwZoomcalls({ afspraken: [CALL], uitkomstKolommen: true, nuMs: Date.parse('2026-09-07T20:00:00Z'), belBijCall });
  assert.ok(c.belpogingen, 'de zoomcall-rij moet zijn belpogingen dragen');
  assert.equal(c.belpogingen.seconden, 41);
});

test('zonder belBijCall blijft het veld null — dat is iets anders dan nul keer gebeld', () => {
  const [c] = bouwZoomcalls({ afspraken: [CALL], uitkomstKolommen: true, nuMs: Date.now() });
  assert.equal(c.belpogingen, null);
});

// ── De zin bestaat twee keer; hij mag niet uiteenlopen ─────────────────────

function browserBelZin() {
  const bron = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  const m = bron.match(/function belZin\(aantal, gesproken, seconden\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'belZin niet gevonden in de browser-view');
  const min = bron.match(/const GESPREK_MIN_SEC = (\d+);/);
  assert.ok(min, 'GESPREK_MIN_SEC niet gevonden in de browser-view');
  assert.equal(Number(min[1]), GESPREK_MIN_SEC, 'browser en server hanteren een andere gespreksdrempel');
  const ctx = vm.createContext({ Math });
  vm.runInContext(m[0], ctx);
  return (a, g, s) => vm.runInContext(`belZin(${a}, ${g}, ${s})`, ctx);
}

test('dagscherm en rapport geven exact dezelfde zin', () => {
  const browser = browserBelZin();
  for (const [a, g, s] of [[0, 0, 0], [1, 1, 41], [2, 1, 41], [3, 0, 0], [4, 2, 190], [2, 2, 89]]) {
    assert.equal(browser(a, g, s), belZin(a, g, s), `zin loopt uiteen bij ${a}/${g}/${s}`);
  }
});

test('de call op het dagscherm tekent de belregel écht', () => {
  const bron = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  // DE DEFINITIE-VAL, voor de derde keer vandaag: /belRegel\(taak, dag\)/ matcht
  // ook 'function belRegel(taak, dag)'. Twee treffers, waarvan één aanroep.
  // Daarom hier de aanroep in zijn context, niet de naam los.
  assert.equal((bron.match(/\+\n\s*belRegel\(taak, dag\) \+/g) || []).length, 1,
    'precies één aanroep, in de callkaart');
  assert.equal((bron.match(/function belRegel\(/g) || []).length, 1, 'precies één definitie');
});
