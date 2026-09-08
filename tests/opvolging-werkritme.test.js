// tests/opvolging-werkritme.test.js
//
// Het werkritme-blok en de driedeling 'vandaag gedaan'. Beide zijn om de
// gemeten dag van 7 september heen gebouwd, met de echte getallen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bouwWerkritme, uurInZone, klokInZone,
  WERKUUR_VAN, WERKUUR_TOT, GAT_DREMPEL_MIN, BEZETTING_DREMPEL,
} from '../api/_lib/opvolging-werkritme.js';
import { verdeelVandaagGedaan } from '../api/_lib/opvolging-vandaag-gedaan.js';

// ═══════════════════════════════════════════════════════════════════════════
// DE TIJDZONE — de valkuil van dit hele blok
// ═══════════════════════════════════════════════════════════════════════════
// Alles staat in UTC. In september is Amsterdam UTC+2, in december UTC+1, en
// op 25 oktober 2026 verspringt dat middenin. Wie het uur uit de ISO-tekst
// snijdt toont elk uur twee uur verkeerd.

test('het uur is Amsterdams, niet UTC — de zes gemeten uren van 7 september', () => {
  const gemeten = [
    ['2026-09-07T08:30:00Z', 10], ['2026-09-07T09:27:00Z', 11],
    ['2026-09-07T14:55:00Z', 16], ['2026-09-07T15:23:00Z', 17],
    ['2026-09-07T17:10:00Z', 19], ['2026-09-07T18:40:00Z', 20],
  ];
  for (const [utc, uur] of gemeten) assert.equal(uurInZone(utc), uur, utc);
});

test('de zomertijdgrens van 25 oktober verschuift het uur mee', () => {
  // Zelfde UTC-moment, één dag voor en één dag na de omzetting.
  assert.equal(uurInZone('2026-10-24T15:00:00Z'), 17, 'zomertijd, UTC+2');
  assert.equal(uurInZone('2026-10-26T15:00:00Z'), 16, 'wintertijd, UTC+1');
});

test('de klok is ook Amsterdams', () => {
  assert.equal(klokInZone('2026-09-07T09:27:00Z'), '11:27');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE GEMETEN DAG: 36 acties over 6 uren, gat van 5,5 uur
// ═══════════════════════════════════════════════════════════════════════════

/** 10u=8 · 11u=2 · 16u=1 · 17u=12 · 19u=1 · 20u=12, uitersten 11:27 en 16:55. */
function dagVan7September() {
  const p = [];
  const zet = (uurUtc, min, n) => {
    for (let i = 0; i < n; i++) {
      p.push({ tijdstip: `2026-09-07T${String(uurUtc).padStart(2, '0')}:${String(min + i).padStart(2, '0')}:00Z`,
        richting: 'uit', soort: 'call' });
    }
  };
  zet(8, 10, 8); zet(9, 26, 2); zet(14, 55, 1); zet(15, 10, 12); zet(17, 5, 1); zet(18, 20, 12);
  return p;
}

test('de verdeling per uur klopt met de meting', () => {
  const r = bouwWerkritme({ pogingen: dagVan7September(), dag: '2026-09-07' });
  assert.equal(r.totaal, 36);
  const gevuld = r.per_uur.filter((u) => u.aantal).map((u) => `${u.uur}=${u.aantal}`).join(' ');
  assert.equal(gevuld, '10=8 11=2 16=1 17=12 19=1 20=12');
});

test('alle werkuren staan in de balk, ook de lege', () => {
  // Een ontbrekend uur leest als 'niet gemeten'; een uur met nul leest als
  // 'niets gedaan', en dat is hier het hele punt.
  const r = bouwWerkritme({ pogingen: dagVan7September(), dag: '2026-09-07' });
  assert.equal(r.per_uur.length, WERKUUR_TOT - WERKUUR_VAN);
  assert.equal(r.per_uur[0].uur, WERKUUR_VAN);
  assert.ok(r.per_uur.some((u) => u.aantal === 0), 'de lege uren horen erin te staan');
});

test('het langste gat is het gat van 5,5 uur, met begin- en eindtijd', () => {
  const r = bouwWerkritme({ pogingen: dagVan7September(), dag: '2026-09-07' });
  assert.equal(r.langste_gat.van, '11:27');
  assert.equal(r.langste_gat.tot, '16:55');
  assert.ok(r.langste_gat.minuten >= 320 && r.langste_gat.minuten <= 335, r.langste_gat.minuten);
  const b = r.bevindingen.find((x) => x.soort === 'lang_gat');
  assert.match(b.tekst, /11:27/);
  assert.match(b.tekst, /16:55/);
  assert.equal(b.getallen.drempel_min, GAT_DREMPEL_MIN, 'de drempel hoort zichtbaar te zijn');
});

test('zes van de twaalf werkuren is geklonterd, en dat wordt gemeld', () => {
  const r = bouwWerkritme({ pogingen: dagVan7September(), dag: '2026-09-07' });
  assert.equal(r.actieve_uren, 6);
  assert.equal(r.werkuren, 12);
  const b = r.bevindingen.find((x) => x.soort === 'geklonterd');
  assert.ok(b, '6 van 12 hoort onder de drempel van ' + BEZETTING_DREMPEL + ' te vallen');
  assert.match(b.tekst, /6 van de 12/);
});

test('een nette dag levert GEEN bevindingen op — anders is de melding niks waard', () => {
  // Elk werkuur één actie: verdeeld, geen gat.
  const p = [];
  for (let u = WERKUUR_VAN; u < WERKUUR_TOT; u++) {
    p.push({ tijdstip: `2026-09-07T${String(u - 2).padStart(2, '0')}:15:00Z`, richting: 'uit', soort: 'call' });
  }
  const r = bouwWerkritme({ pogingen: p, dag: '2026-09-07' });
  assert.equal(r.actieve_uren, 12);
  assert.deepEqual(r.bevindingen, []);
});

test('een dag zonder enige poging meldt geen gat — er valt niets te beoordelen', () => {
  const r = bouwWerkritme({ pogingen: [], dag: '2026-09-07' });
  assert.equal(r.totaal, 0);
  assert.equal(r.langste_gat, null);
  assert.deepEqual(r.bevindingen, []);
});

test('acties buiten werkuren gaan niet verloren uit de telling', () => {
  const p = [{ tijdstip: '2026-09-07T04:00:00Z', richting: 'uit', soort: 'call' }];  // 06:00 lokaal
  const r = bouwWerkritme({ pogingen: p, dag: '2026-09-07' });
  assert.equal(r.totaal, 1);
  assert.equal(r.buiten_werkuren, 1);
  assert.equal(r.binnen_werkuren, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// VANDAAG GEDAAN — drie groepen, en een kaart in precies één
// ═══════════════════════════════════════════════════════════════════════════

const dagVan = (ts) => (ts ? String(new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })) : null);
const DAG = '2026-09-07';

const BRYAN = { id: 'b', naam: 'Bryan Van Der Heyden', status: 'open',
  bevestigd_op: '2026-09-07T16:12:00Z', due: '2026-09-19' };
const PETER = { id: 'p', naam: 'Peter Tournelle', status: 'open',
  bevestigd_op: '2026-09-07T16:35:00Z', due: '2026-09-22' };
const ANAIS = { id: 'a', naam: 'Anais Beijer', status: 'gearchiveerd',
  archief_reden: 'bevestigd', gearchiveerd_at: '2026-09-07T12:00:00Z' };

test('Bryan en Peter staan bij doorgeschoven, met hun terugkeerdatum', () => {
  const r = verdeelVandaagGedaan({ taken: [BRYAN, PETER, ANAIS], pogingen: [], dag: DAG, dagVan });
  assert.deepEqual(r.doorgeschoven.map((d) => d.naam), ['Bryan Van Der Heyden', 'Peter Tournelle']);
  assert.equal(r.doorgeschoven[0].terug_op, '2026-09-19');
  assert.equal(r.doorgeschoven[1].terug_op, '2026-09-22');
});

test('Anais staat bij afgesloten, met de reden', () => {
  const r = verdeelVandaagGedaan({ taken: [BRYAN, PETER, ANAIS], pogingen: [], dag: DAG, dagVan });
  assert.deepEqual(r.afgesloten.map((a) => a.naam), ['Anais Beijer']);
  assert.equal(r.afgesloten[0].reden, 'bevestigd');
});

test('wie een beslissing kreeg staat NIET ook bij aangeraakt — de dubbele Yasmine', () => {
  // Bij een bevestiging wordt een poging geschreven. Zonder aftrek staat Bryan
  // twee keer op het scherm.
  const pogingen = [
    { taak_id: 'b', tijdstip: '2026-09-07T16:12:00Z' },
    { taak_id: 'a', tijdstip: '2026-09-07T11:59:00Z' },
    { taak_id: 'x', tijdstip: '2026-09-07T09:00:00Z' },
  ];
  const r = verdeelVandaagGedaan({
    taken: [BRYAN, PETER, ANAIS, { id: 'x', naam: 'Iemand anders', status: 'open', due: DAG }],
    pogingen, dag: DAG, dagVan,
  });
  assert.deepEqual(r.aangeraakt.map((a) => a.naam), ['Iemand anders']);
  const alle = [...r.afgesloten, ...r.doorgeschoven, ...r.aangeraakt].map((x) => x.taak_id);
  assert.equal(new Set(alle).size, alle.length, 'geen enkele kaart mag in twee blokken staan');
});

test('een kaart die vandaag bevestigd is maar NIET terugkomt is geen doorgeschoven kaart', () => {
  const vandaagDue = { ...BRYAN, due: DAG };
  const r = verdeelVandaagGedaan({ taken: [vandaagDue], pogingen: [], dag: DAG, dagVan });
  assert.equal(r.doorgeschoven.length, 0, 'due van vandaag betekent dat hij niet vooruit is gezet');
});

test('een poging van gisteren telt niet mee bij vandaag', () => {
  const r = verdeelVandaagGedaan({
    taken: [{ id: 'x', naam: 'Gisteren', status: 'open' }],
    pogingen: [{ taak_id: 'x', tijdstip: '2026-09-06T10:00:00Z' }], dag: DAG, dagVan,
  });
  assert.equal(r.aangeraakt.length, 0);
});

test('de aantallen kloppen met de lijsten', () => {
  const r = verdeelVandaagGedaan({
    taken: [BRYAN, PETER, ANAIS], pogingen: [{ taak_id: 'q', tijdstip: '2026-09-07T10:00:00Z' }],
    dag: DAG, dagVan,
  });
  assert.equal(r.aantallen.afgesloten, r.afgesloten.length);
  assert.equal(r.aantallen.doorgeschoven, r.doorgeschoven.length);
  assert.equal(r.aantallen.aangeraakt, r.aangeraakt.length);
});
