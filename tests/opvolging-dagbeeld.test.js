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
  oorspronkelijkeDag, oorspronkelijkeTijd, verzetNaar, toonStaat, nlDatum, dagenVoorAfspraak,
  knoppenVoor,
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

// ═══════════════════════════════════════════════════════════════════════════
// WAT ER WERKT ZOLANG DE MIGRATIE NIET GEDRAAID IS
// ═══════════════════════════════════════════════════════════════════════════
//
// Gemeten op 9 september: de kolom eerst_gepland_op bestaat nog niet op
// productie. De grens tussen wat dan wél en niet kan is scherp, en hij hoort
// vast te liggen — anders wordt hij op een dag stilletjes een andere grens.
//
// De aanleiding: het dagscherm toonde voor 8 september maar EEN afspraak, van
// de zeven die er stonden. Alles met een uitkomst — afgerond, niet gekomen,
// geannuleerd — viel weg omdat de weergave op status 'scheduled' filterde. Juist
// de interessantste feiten van die dag waren daardoor onzichtbaar.

const GISTEREN = '2026-09-08';
/** De zeven rijen van 8 september, zonder eerst_gepland_op. */
const ZEVEN_ZONDER_KOLOM = [
  { id: '1', lead_name: 'Martin Van Pijkeren',    status: 'completed', scheduled_at: '2026-09-08T08:00:00Z' },
  { id: '2', lead_name: 'yeivi medinw',           status: 'scheduled', scheduled_at: '2026-09-08T13:00:00Z' },
  { id: '3', lead_name: 'Mehran Jahani',          status: 'no_show',   scheduled_at: '2026-09-08T16:00:00Z' },
  { id: '4', lead_name: 'Sebastian Kolodziejski', status: 'no_show',   scheduled_at: '2026-09-08T18:30:00Z' },
];

test('ZONDER de kolom: alle vier de afspraken van 8 september staan er, met hun uitkomst', () => {
  // Dit is de winst die NIET op de migratie wacht. Het statusfilter weghalen
  // heeft niets met eerst_gepland_op te maken.
  const [dag] = voegAgendaSamen({
    slots: [], afspraken: ZEVEN_ZONDER_KOLOM, van: GISTEREN, tot: GISTEREN, nuMs: NU,
  });
  assert.equal(dag.bezet.length, 1, 'het oude gedrag toonde er precies een');
  assert.equal(dag.bezet[0].naam, 'yeivi medinw');

  assert.deepEqual(dag.gepland.map((g) => g.naam),
    ['Martin Van Pijkeren', 'yeivi medinw', 'Mehran Jahani', 'Sebastian Kolodziejski']);
  assert.deepEqual(dag.gepland.map((g) => g.label),
    ['geweest', null, 'niet gekomen', 'niet gekomen']);
});

test('ZONDER de kolom: een verzetting via een NIEUWE rij blijft gewoon zichtbaar', () => {
  // De oude rij houdt zijn eigen scheduled_at, dus die heeft de kolom niet nodig.
  const [dag] = voegAgendaSamen({
    slots: [], van: '2026-09-07', tot: '2026-09-07', nuMs: NU,
    afspraken: [{ id: 'v1', lead_name: 'Verzet via nieuwe rij', status: 'verplaatst',
      scheduled_at: '2026-09-07T13:00:00Z' }],
  });
  assert.equal(dag.gepland.length, 1);
  assert.equal(dag.gepland[0].label, 'verzet');
  assert.equal(dag.gepland[0].verzet_naar, null, 'de bestemming weten we hier niet');
});

test('ZONDER de kolom: een verzetting in DEZELFDE rij is en blijft onvindbaar', () => {
  // De grens. scheduled_at is overschreven naar de 15e; er is niets meer wat
  // zegt dat hij op de 7e stond. Dit legt vast dat we dat niet stilletjes gaan
  // gokken — de endpoints melden het als blinde vlek.
  const [dag] = voegAgendaSamen({
    slots: [], van: '2026-09-07', tot: '2026-09-07', nuMs: NU,
    afspraken: [{ id: 'v2', lead_name: 'sander De groot', status: 'scheduled',
      scheduled_at: '2026-09-15T13:00:00Z' }],
  });
  assert.equal(dag.gepland.length, 0);
});

test('MET de kolom komt precies die ene terug', () => {
  const [dag] = voegAgendaSamen({
    slots: [], van: '2026-09-07', tot: '2026-09-07', nuMs: NU,
    afspraken: [{ id: 'v2', lead_name: 'sander De groot', status: 'scheduled',
      scheduled_at: '2026-09-15T13:00:00Z', eerst_gepland_op: '2026-09-07T13:00:00Z' }],
  });
  assert.equal(dag.gepland.length, 1);
  assert.match(dag.gepland[0].label, /verzet naar 15 september/);
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN AFSPRAAK DIE NAAR EEN DAG TOE IS VERPLAATST
// ═══════════════════════════════════════════════════════════════════════════
//
// De andere kant van hetzelfde gat, gevonden nadat de migratie gedraaid was.
// De eerste versie zette een verplaatste afspraak alléén op zijn oorspronkelijke
// dag — en dan verdwijnt hij van de dag waarop hij ECHT plaatsvindt. Dat is
// dezelfde fout, alleen in de andere richting.
//
// Twee dagen dus, en dat is geen dubbeling maar twee verschillende feiten:
// wat er die dag STOND, en wat er die dag STAAT.

const INGESCHOVEN = {
  id: 'x', lead_name: 'Ingeschoven', status: 'scheduled',
  scheduled_at: '2026-09-08T13:00:00Z', eerst_gepland_op: '2026-09-01T13:00:00Z',
};

test('een verplaatste afspraak staat op BEIDE dagen', () => {
  const plekken = dagenVoorAfspraak(INGESCHOVEN, NU);
  assert.deepEqual(plekken.map((p) => p.dag), ['2026-09-01', '2026-09-08']);
});

test('op de oude dag als verzet, op de nieuwe dag gewoon als afspraak', () => {
  const [oud, nieuw] = dagenVoorAfspraak(INGESCHOVEN, NU);
  assert.equal(oud.toon.staat, VERZET);
  assert.match(oud.toon.label, /verzet naar 8 september/);
  assert.equal(nieuw.toon.staat, ACTIEF_STAAT, 'op de dag zelf is de verplaatsing geen bijzonderheid meer');
  assert.equal(nieuw.toon.doorgehaald, false);
  assert.equal(nieuw.verzet_van, '2026-09-01');
});

test('en in de agenda komt hij op allebei die dagen terug', () => {
  const nu = NU;
  const [een]  = voegAgendaSamen({ slots: [], afspraken: [INGESCHOVEN], van: '2026-09-01', tot: '2026-09-01', nuMs: nu });
  const [acht] = voegAgendaSamen({ slots: [], afspraken: [INGESCHOVEN], van: '2026-09-08', tot: '2026-09-08', nuMs: nu });
  assert.equal(een.gepland.length, 1);
  assert.equal(een.gepland[0].doorgehaald, true);
  assert.equal(acht.gepland.length, 1, 'hij verdween van de dag waarop hij plaatsvindt');
  assert.equal(acht.gepland[0].doorgehaald, false);
  assert.equal(acht.gepland[0].verzet_van, '2026-09-01');
});

test('een DODE rij krijgt geen tweede dag', () => {
  // Een geannuleerde of als verplaatst gemarkeerde rij gaat nergens meer door;
  // die twee keer tonen zou twee doorgehaalde regels voor niets opleveren.
  for (const status of ['cancelled', 'verplaatst', 'wacht_op_reschedule', 'verwijderd']) {
    const plekken = dagenVoorAfspraak({ ...INGESCHOVEN, status }, NU);
    assert.equal(plekken.length, 1, status + ' hoort maar op een dag te staan');
    assert.equal(plekken[0].dag, '2026-09-01');
  }
});

test('een afgeronde call die verplaatst was telt op zijn nieuwe dag als geweest', () => {
  const [, nieuw] = dagenVoorAfspraak({ ...INGESCHOVEN, status: 'completed' }, NU);
  assert.equal(nieuw.toon.staat, GEWEEST);
  assert.equal(nieuw.toon.doorgehaald, false);
});

test('een afspraak die niet verplaatst is levert precies een dag op', () => {
  const plekken = dagenVoorAfspraak({
    id: 'g', lead_name: 'Gewoon', status: 'scheduled',
    scheduled_at: '2026-09-08T13:00:00Z', eerst_gepland_op: '2026-09-08T13:00:00Z',
  }, NU);
  assert.equal(plekken.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// GRIJS BETEKENT NIET ONAANRAAKBAAR
// ═══════════════════════════════════════════════════════════════════════════
//
// De koppeling die dit blok belangrijk maakt: Dave kan alleen afronden bij een
// call die hij ZIET. Mehran Jahani en Sebastian Kolodziejski kregen op 9
// september de status no_show en verdwenen daarmee uit de lijst voordat iemand
// er iets mee kon. Ze zijn niet vergeten door nalatigheid — het scherm toonde
// ze niet meer.
//
// Het dagbeeld is dus niet alleen een weergavefix; het is wat die uitkomst
// alsnog vastlegbaar maakt. Een regel die je wél ziet maar niets mee kunt maakt
// het probleem zichtbaar zonder het op te lossen.
//
// Mijn eerste versie deed precies dat verkeerd: die verborg de knoppen op elke
// doorgehaalde regel. Deze tests leggen vast dat 'grijs' en 'onaanraakbaar'
// twee verschillende dingen zijn.

// De dag ERNA, want dat is de situatie: Mehran was no-show op 8 september en
// Dave kijkt er op de 9e naar. Met NU (8 september 12:00) zou zijn call van
// 18:00 nog in de toekomst liggen — een no-show die nog moet gebeuren bestaat
// niet, en de test viel daar terecht over.
const MORGEN_OCHTEND = Date.parse('2026-09-09T07:00:00Z');

const NO_SHOW = {
  id: 'm', lead_name: 'Mehran Jahani', status: 'no_show',
  scheduled_at: '2026-09-08T16:00:00Z', eerst_gepland_op: '2026-09-08T16:00:00Z',
  lead_phone: '+32470111222', zoom_join_url: 'https://zoom.us/j/1',
};

test('een no-show is doorgehaald EN afrondbaar', () => {
  assert.equal(toonStaat(NO_SHOW, MORGEN_OCHTEND).doorgehaald, true);
  assert.equal(knoppenVoor(NO_SHOW, MORGEN_OCHTEND).afronden, true,
    'zonder deze knop is de no-show zichtbaar maar niet vastlegbaar');
});

test('en nabellen kan ook — dat is de hele bedoeling', () => {
  const k = knoppenVoor(NO_SHOW, MORGEN_OCHTEND);
  assert.equal(k.bellen, true);
  assert.equal(k.whatsapp, true);
});

test('de Zoom-link verdwijnt zodra de call geweest is', () => {
  // Een Zoom-knop bij een call van gisteren nodigt uit tot een gesprek dat
  // niemand verwacht.
  assert.equal(knoppenVoor(NO_SHOW, MORGEN_OCHTEND).zoom, false, 'de call van gisteren 18:00 is geweest');
  // eerst_gepland_op MEE verzetten: alleen scheduled_at veranderen maakt er een
  // verplaatste afspraak van, en die is per definitie dood op zijn oude dag.
  const straks = { ...NO_SHOW, status: 'scheduled',
    scheduled_at: '2026-09-09T16:00:00Z', eerst_gepland_op: '2026-09-09T16:00:00Z' };
  assert.equal(knoppenVoor(straks, MORGEN_OCHTEND).zoom, true, 'een call van straks krijgt hem wel');
});

test('een afspraak waarvan de tijd voorbij is en die nog op scheduled staat, is afrondbaar', () => {
  // yeivi medinw van 8 september 15:00. Precies het geval dat nu blijft hangen.
  const yeivi = { id: 'y', lead_name: 'yeivi medinw', status: 'scheduled',
    scheduled_at: '2026-09-08T13:00:00Z', lead_phone: '+32470999888' };
  assert.equal(knoppenVoor(yeivi, MORGEN_OCHTEND).afronden, true);
});

test('bij een geannuleerde of verwijderde afspraak valt er niets af te ronden', () => {
  for (const status of ['cancelled', 'verwijderd']) {
    const k = knoppenVoor({ ...NO_SHOW, status }, MORGEN_OCHTEND);
    assert.deepEqual([k.afronden, k.bellen, k.whatsapp, k.zoom], [false, false, false, false], status);
  }
});

test('op de OUDE dag van een verplaatste afspraak hoort geen afrondknop', () => {
  // De uitkomst hoort bij de nieuwe datum. Anders legt Dave een no-show vast
  // op een call die gewoon verzet is.
  const k = knoppenVoor(INGESCHOVEN, NU, { opNieuweDag: false });
  assert.equal(k.afronden, false);
});

test('op de NIEUWE dag van diezelfde afspraak wel', () => {
  const k = knoppenVoor(INGESCHOVEN, NU, { opNieuweDag: true });
  assert.equal(k.afronden, true);
});

test('en de agenda stuurt die knoppen mee, per regel', () => {
  const [dag] = voegAgendaSamen({
    slots: [], van: '2026-09-08', tot: '2026-09-08', nuMs: MORGEN_OCHTEND,
    afspraken: [NO_SHOW, { id: 'c', lead_name: 'Afgezegd', status: 'cancelled',
      scheduled_at: '2026-09-08T09:00:00Z', lead_phone: '+32470000000' }],
  });
  const mehran = dag.gepland.find((g) => g.naam === 'Mehran Jahani');
  assert.equal(mehran.doorgehaald, true);
  assert.equal(mehran.knoppen.afronden, true);
  assert.equal(dag.gepland.find((g) => g.naam === 'Afgezegd').knoppen.afronden, false);
});
