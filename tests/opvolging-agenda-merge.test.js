// tests/opvolging-agenda-merge.test.js
//
// Fase 2 DEEL B — vrij en bezet samenvoegen tot de weekweergave achter
// 'Opnieuw inplannen'.
//
// Twee bronnen die niets van elkaar weten: wat GHL aanbiedt, en wat wij zelf
// geboekt hebben. Gaat dat samenvoegen mis, dan boekt Dave een tweede afspraak
// bovenop een bestaande — en dat merk je pas als er twee mensen tegelijk in
// dezelfde Zoom zitten. Vandaar: bezet wint altijd van vrij.
//
// De tweede val is de tijdzone. scheduled_at staat in UTC; een afspraak van
// 00:30 in Amsterdam valt in UTC op de vorige dag. Wie hier toISOString().slice()
// gebruikt zet 'm een dag te vroeg in de week, en dat valt niemand op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  voegAgendaSamen, dagenTussen, delenInZone, zoneMomentNaarIso,
} from '../api/_lib/opvolging-agenda-merge.js';

const WEEK = { van: '2026-09-07', tot: '2026-09-11' };   // maandag t/m vrijdag

const slot = (date, ...times) => ({ date, times });
const appt = (scheduled_at, lead_name, status = 'scheduled') => ({ id: 'a', scheduled_at, lead_name, status });

const dagVan = (dagen, d) => dagen.find((x) => x.dag === d);
const tijden = (lijst) => lijst.map((x) => x.tijd);

// ── Het venster ────────────────────────────────────────────────────────────

test('de week bevat elke dag van van t/m tot, ook de lege', () => {
  const dagen = voegAgendaSamen({ slots: [], afspraken: [], ...WEEK });
  assert.deepEqual(dagen.map((d) => d.dag),
    ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  // Een lege kolom is informatie: 'hier is niets vrij' leest anders dan
  // 'deze dag bestaat niet'.
  for (const d of dagen) { assert.deepEqual(d.vrij, []); assert.deepEqual(d.bezet, []); }
});

test('dagenTussen weigert onzin in plaats van iets te verzinnen', () => {
  assert.deepEqual(dagenTussen('2026-09-11', '2026-09-07'), []);   // tot voor van
  assert.deepEqual(dagenTussen('gisteren', '2026-09-11'), []);
  assert.deepEqual(dagenTussen(null, null), []);
  assert.equal(dagenTussen('2026-09-07', '2026-09-07').length, 1);
});

test('een dag buiten het venster wordt niet meegenomen', () => {
  const dagen = voegAgendaSamen({
    slots    : [slot('2026-09-14', '09:00')],                 // volgende maandag
    afspraken: [appt('2026-09-14T08:00:00Z', 'Buiten beeld')],
    ...WEEK,
  });
  assert.equal(dagen.length, 5);
  assert.equal(dagen.reduce((n, d) => n + d.vrij.length + d.bezet.length, 0), 0);
});

// ── Samenvoegen ────────────────────────────────────────────────────────────

test('vrije momenten komen per dag terug, gesorteerd', () => {
  const dagen = voegAgendaSamen({
    slots: [slot('2026-09-08', '11:00', '09:00', '10:00')], afspraken: [], ...WEEK,
  });
  assert.deepEqual(tijden(dagVan(dagen, '2026-09-08').vrij), ['09:00', '10:00', '11:00']);
});

test('een bezet moment verdwijnt uit vrij en komt met naam terug', () => {
  const dagen = voegAgendaSamen({
    slots    : [slot('2026-09-08', '09:00', '10:00', '11:00')],
    // 08:00Z is 10:00 in Amsterdam (zomertijd).
    afspraken: [appt('2026-09-08T08:00:00Z', 'Karel Jansen')],
    ...WEEK,
  });
  const dag = dagVan(dagen, '2026-09-08');
  assert.deepEqual(tijden(dag.vrij), ['09:00', '11:00'], '10:00 hoort niet meer vrij te zijn');
  assert.deepEqual(dag.bezet, [{ tijd: '10:00', naam: 'Karel Jansen', status: 'scheduled' }]);
});

test('een afspraak die GHL niet kent houdt het moment alsnog bezet', () => {
  // Dit is de hele reden dat we aftrekken in plaats van vertrouwen: GHL kent
  // onze afspraken meestal wel, maar niet altijd.
  const dagen = voegAgendaSamen({
    slots    : [slot('2026-09-09', '14:00')],
    afspraken: [appt('2026-09-09T12:00:00Z', 'Buiten GHL om')],
    ...WEEK,
  });
  const dag = dagVan(dagen, '2026-09-09');
  assert.deepEqual(dag.vrij, []);
  assert.equal(dag.bezet[0].naam, 'Buiten GHL om');
});

test('geannuleerd of verplaatst houdt niets bezet', () => {
  for (const status of ['cancelled', 'verplaatst', 'verwijderd', 'no_show', 'completed']) {
    const dagen = voegAgendaSamen({
      slots    : [slot('2026-09-08', '10:00')],
      afspraken: [appt('2026-09-08T08:00:00Z', 'Afgezegd', status)],
      ...WEEK,
    });
    const dag = dagVan(dagen, '2026-09-08');
    assert.deepEqual(tijden(dag.vrij), ['10:00'], `${status} hoort het slot vrij te laten`);
    assert.deepEqual(dag.bezet, [], status);
  }
});

test('twee afspraken op hetzelfde tijdstip worden één bezet blokje', () => {
  const dagen = voegAgendaSamen({
    slots: [], ...WEEK,
    afspraken: [
      appt('2026-09-08T08:00:00Z', 'Eerste'),
      appt('2026-09-08T08:00:00Z', 'Tweede'),
    ],
  });
  const bezet = dagVan(dagen, '2026-09-08').bezet;
  assert.equal(bezet.length, 1, 'niet twee blokjes over elkaar');
  assert.equal(bezet[0].naam, 'Eerste');
});

test('een afspraak zonder naam krijgt een leesbaar label', () => {
  const dagen = voegAgendaSamen({
    slots: [], afspraken: [appt('2026-09-08T08:00:00Z', '   ')], ...WEEK,
  });
  assert.equal(dagVan(dagen, '2026-09-08').bezet[0].naam, 'Bezet');
});

test('rommel in de bronnen wordt overgeslagen, niet doorgegeven', () => {
  const dagen = voegAgendaSamen({
    slots    : [{ date: '2026-09-08', times: ['09:00', 'kwart over negen', '', null, '9:00'] }],
    afspraken: [null, { lead_name: 'Geen tijd' }, appt('geen datum', 'Kapot')],
    ...WEEK,
  });
  const dag = dagVan(dagen, '2026-09-08');
  assert.deepEqual(tijden(dag.vrij), ['09:00']);
  assert.deepEqual(dag.bezet, []);
});

test('ontbrekende of niet-array invoer levert gewoon lege dagen', () => {
  const dagen = voegAgendaSamen({ slots: null, afspraken: undefined, ...WEEK });
  assert.equal(dagen.length, 5);
  assert.equal(dagen.reduce((n, d) => n + d.vrij.length + d.bezet.length, 0), 0);
});

// ── Tijdzone ───────────────────────────────────────────────────────────────

test('een afspraak laat op de avond blijft op de juiste dag staan', () => {
  // 22:30Z op 8 september is 00:30 op 9 september in Amsterdam. Op de UTC-dag
  // afgaan zou 'm een dag te vroeg zetten.
  const dagen = voegAgendaSamen({
    slots: [], afspraken: [appt('2026-09-08T22:30:00Z', 'Laat')], ...WEEK,
  });
  assert.deepEqual(dagVan(dagen, '2026-09-08').bezet, []);
  assert.deepEqual(dagVan(dagen, '2026-09-09').bezet, [{ tijd: '00:30', naam: 'Laat', status: 'scheduled' }]);
});

test('delenInZone geeft de Amsterdamse dag en tijd, niet de UTC-versie', () => {
  assert.deepEqual(delenInZone(Date.parse('2026-09-08T08:00:00Z')), { dag: '2026-09-08', tijd: '10:00' });
  assert.deepEqual(delenInZone(Date.parse('2026-12-08T08:00:00Z')), { dag: '2026-12-08', tijd: '09:00' });
});

test('elk vrij moment draagt zijn eigen ISO-tijdstip mee', () => {
  // De browser hoeft dan niets om te rekenen bij het boeken — hij stuurt terug
  // wat hij kreeg. Omrekenen in de browser is precies waar een klik op 10:00
  // een afspraak om 11:00 wordt.
  const dagen = voegAgendaSamen({ slots: [slot('2026-09-08', '10:00')], afspraken: [], ...WEEK });
  assert.equal(dagVan(dagen, '2026-09-08').vrij[0].iso, '2026-09-08T08:00:00.000Z');
});

test('de ISO klopt in zomertijd, in wintertijd en op de omschakeldag', () => {
  assert.equal(zoneMomentNaarIso('2026-09-10', '10:00'), '2026-09-10T08:00:00.000Z');  // CEST +2
  assert.equal(zoneMomentNaarIso('2026-12-10', '10:00'), '2026-12-10T09:00:00.000Z');  // CET  +1
  // 25 oktober 2026: de klok gaat om 03:00 terug naar 02:00.
  assert.equal(zoneMomentNaarIso('2026-10-25', '01:00'), '2026-10-24T23:00:00.000Z');  // nog +2
  assert.equal(zoneMomentNaarIso('2026-10-25', '10:00'), '2026-10-25T09:00:00.000Z');  // al  +1
  assert.equal(zoneMomentNaarIso('kapot', '10:00'), null);
  assert.equal(zoneMomentNaarIso('2026-10-25', '25:00'), null);
});

test('een andere tijdzone uit het GHL-antwoord wordt ook echt gebruikt', () => {
  // De tijdzone komt uit het antwoord; wij verzinnen 'm niet.
  const dagen = voegAgendaSamen({
    slots: [], afspraken: [appt('2026-09-08T08:00:00Z', 'Londen')],
    ...WEEK, timeZone: 'Europe/London',
  });
  assert.equal(dagVan(dagen, '2026-09-08').bezet[0].tijd, '09:00');
});
