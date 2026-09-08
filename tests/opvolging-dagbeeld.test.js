// tests/opvolging-dagbeeld.test.js
//
// EEN DAG MOET ACHTERAF TE RECONSTRUEREN ZIJN.
//
// Maxims eis: een geplande zoomcall blijft hard op zijn dag staan, ook als hij
// verzet is — dan in het grijs. De reden erachter is scherper dan de wens:
// verdwijnt een afspraak stil uit een dag, dan klopt het dagbeeld van gisteren
// morgen niet meer, en dan is het rapport over die dag ook niet meer waar.
//
// De valkuil zit in de TWEEDE soort verzetting. Bij de eerste maakt
// follow-up-verplaats-call een nieuwe rij en blijft de oude staan. Bij de
// tweede schrijft de GHL-poll `scheduled_at` in DEZELFDE rij over — sander De
// groot ging zo van 7 naar 15 september — en dan is de oorspronkelijke dag weg.
// Daar is `eerst_gepland_op` voor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  oorspronkelijkeDag, oorspronkelijkeTijd, verzetNaar, toonStaat, nlDatum,
  ACTIEF_STAAT, VERZET, GEANNULEERD, NIET_GEKOMEN, GEWEEST, ONBEKEND,
} from '../api/_lib/opvolging-dagbeeld.js';
import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';

const NU = Date.parse('2026-09-08T12:00:00Z');

// ═══════════════════════════════════════════════════════════════════════════
// DE OORSPRONKELIJKE DAG OVERLEEFT EEN VERZETTING IN DEZELFDE RIJ
// ═══════════════════════════════════════════════════════════════════════════

const SANDER = {
  id: 'a-sander', lead_name: 'sander De groot', status: 'scheduled',
  scheduled_at    : '2026-09-15T13:00:00Z',   // waar hij nu staat
  eerst_gepland_op: '2026-09-07T13:00:00Z',   // waar hij stond
};

test('sander De groot blijft op 7 september staan, ook al staat hij nu op de 15e', () => {
  assert.equal(oorspronkelijkeDag(SANDER), '2026-09-07');
  assert.equal(oorspronkelijkeTijd(SANDER), '15:00');
});

test('en we weten waarheen: verzet naar 15 september', () => {
  const naar = verzetNaar(SANDER);
  assert.equal(naar.dag, '2026-09-15');
  const t = toonStaat(SANDER, NU);
  assert.equal(t.staat, VERZET);
  assert.equal(t.doorgehaald, true);
  assert.match(t.label, /verzet naar 15 september/);
});

test('zonder de kolom valt hij terug op scheduled_at — en dan is de dag weg', () => {
  // Dit legt de BEPERKING vast, niet de wens. Zolang de migratie niet gedraaid
  // is kan het dagbeeld deze afspraak niet op 7 september tonen, want er is
  // niets meer wat zegt dat hij daar stond. De endpoints melden dat als blinde
  // vlek; stil doen alsof het klopt is de fout.
  const zonder = { ...SANDER, eerst_gepland_op: null };
  assert.equal(oorspronkelijkeDag(zonder), '2026-09-15');
  assert.equal(verzetNaar(zonder), null);
});

test('een afspraak die nooit verzet is levert geen bestemming op', () => {
  const gewoon = { scheduled_at: '2026-09-08T11:30:00Z', eerst_gepland_op: '2026-09-08T11:30:00Z' };
  assert.equal(verzetNaar(gewoon), null);
  assert.equal(toonStaat({ ...gewoon, status: 'scheduled' }, NU).staat, ACTIEF_STAAT);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE LABELS, IN DAVES TAAL
// ═══════════════════════════════════════════════════════════════════════════

test('elke staat krijgt zijn eigen woord', () => {
  const op = (status) => toonStaat({ status, scheduled_at: '2026-09-08T11:00:00Z' }, NU);
  assert.equal(op('scheduled').staat, ACTIEF_STAAT);
  assert.equal(op('cancelled').staat, GEANNULEERD);
  assert.equal(op('cancelled').label, 'geannuleerd');
  assert.equal(op('no_show').staat, NIET_GEKOMEN);
  assert.equal(op('no_show').label, 'niet gekomen');
  assert.equal(op('verplaatst').staat, VERZET);
  assert.equal(op('wacht_op_reschedule').staat, VERZET);
  assert.equal(op('completed').staat, GEWEEST);
});

test('een afspraak die geweest is wordt NIET doorgehaald', () => {
  // Grijs en doorgestreept leest als 'ging niet door'. Dat is het
  // tegenovergestelde van wat completed betekent.
  assert.equal(toonStaat({ status: 'completed', scheduled_at: '2026-09-08T11:00:00Z' }, NU).doorgehaald, false);
});

test('een onbekende status wordt als onbekend gemeld, niet stil als geweest geboekt', () => {
  // Zelfde regel als callStaat in het rapport: follow_up_appointments.status
  // draagt meer waarden dan de CHECK-constraint noemt.
  const t = toonStaat({ status: 'iets_nieuws', scheduled_at: '2026-09-08T11:00:00Z' }, NU);
  assert.equal(t.staat, ONBEKEND);
  assert.match(t.label, /iets_nieuws/);
});

test('de datum staat er in gewone taal, en het jaar alleen als het afwijkt', () => {
  assert.equal(nlDatum('2026-09-15', NU), '15 september');
  assert.equal(nlDatum('2027-01-04', NU), '4 januari 2027');
});

// ═══════════════════════════════════════════════════════════════════════════
// EN IN DE AGENDA: TWEE LIJSTEN, MET OPZET
// ═══════════════════════════════════════════════════════════════════════════

const DAG = '2026-09-07';
const AFSPRAKEN = [
  SANDER,
  { id: 'a2', lead_name: 'Blijft staan', status: 'scheduled',  scheduled_at: DAG + 'T07:00:00Z', eerst_gepland_op: DAG + 'T07:00:00Z' },
  { id: 'a3', lead_name: 'Afgezegd',     status: 'cancelled',  scheduled_at: DAG + 'T08:00:00Z', eerst_gepland_op: DAG + 'T08:00:00Z' },
  { id: 'a4', lead_name: 'Niet gekomen', status: 'no_show',    scheduled_at: DAG + 'T09:00:00Z', eerst_gepland_op: DAG + 'T09:00:00Z' },
];

test('het dagbeeld toont ALLES wat voor die dag stond', () => {
  const [dag] = voegAgendaSamen({ slots: [], afspraken: AFSPRAKEN, van: DAG, tot: DAG, nuMs: NU });
  assert.deepEqual(dag.gepland.map((g) => g.naam),
    ['Blijft staan', 'Afgezegd', 'Niet gekomen', 'sander De groot']);
  assert.equal(dag.gepland.find((g) => g.naam === 'sander De groot').staat, VERZET);
});

test('maar BEZET blijft smal — anders blokkeert een afzegging voorgoed een slot', () => {
  // Dit is de reden dat het twee lijsten zijn. Zou het dagbeeld ook de vrije
  // momenten bepalen, dan kan niemand meer boeken op een tijd waar ooit een
  // geannuleerde afspraak stond.
  const [dag] = voegAgendaSamen({ slots: [], afspraken: AFSPRAKEN, van: DAG, tot: DAG, nuMs: NU });
  assert.deepEqual(dag.bezet.map((b) => b.naam), ['Blijft staan']);
});

test('een geannuleerd moment blijft vrij boekbaar', () => {
  const [dag] = voegAgendaSamen({
    slots: [{ date: DAG, times: ['10:00'] }],
    afspraken: [{ id: 'x', lead_name: 'Afgezegd', status: 'cancelled',
      scheduled_at: DAG + 'T08:00:00Z', eerst_gepland_op: DAG + 'T08:00:00Z' }],
    van: DAG, tot: DAG, nuMs: NU,
  });
  assert.deepEqual(dag.vrij.map((v) => v.tijd), ['10:00']);
  assert.equal(dag.gepland.length, 1, 'hij staat wél in het dagbeeld');
});

test('een verzette afspraak blokkeert zijn NIEUWE moment, niet zijn oude', () => {
  // Op 15 september is hij bezet; op 7 september staat hij alleen nog in het
  // dagbeeld. Twee verschillende vragen, twee verschillende antwoorden.
  const [zeven] = voegAgendaSamen({ slots: [], afspraken: [SANDER], van: DAG, tot: DAG, nuMs: NU });
  assert.equal(zeven.bezet.length, 0);
  assert.equal(zeven.gepland.length, 1);

  const [vijftien] = voegAgendaSamen({
    slots: [], afspraken: [SANDER], van: '2026-09-15', tot: '2026-09-15', nuMs: NU,
  });
  assert.equal(vijftien.bezet.length, 1, 'daar houdt hij het moment wél bezet');
});
