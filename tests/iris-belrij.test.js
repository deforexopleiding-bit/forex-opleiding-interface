// tests/iris-belrij.test.js
//
// De belrij en de escalatie.
//
// Twee regels die hier hard vastgepind worden.
//
// De eerste: een call die wordt afgebroken vóór er opgenomen is, telt NOOIT
// als poging. Wie per ongeluk op bellen drukt en meteen ophangt, heeft niet
// geprobeerd te bereiken. Die poging meetellen betekent dat iemand na drie
// mispieken "onbereikbaar" heet en een escalatiebericht krijgt dat nergens op
// slaat.
//
// De tweede: pogingen en DAGEN zijn twee dingen. Drie keer bellen op één
// ochtend is geen drie dagen proberen — dat is één ochtend waarop iemand in
// een vergadering zat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UITKOMSTEN,
  MAX_PER_DAG,
  uitCallLog,
  teltMee,
  dagVan,
  telPogingen,
  moetEscaleren,
  sorteerBelrij,
  redenTekst,
  REDEN_TEKST,
} from '../api/_lib/iris/belrij.js';

const NU = new Date('2026-09-21T12:00:00Z');
const poging = (dag, uitkomst, afgebroken = false) => ({
  gebeld_op: `2026-09-${String(dag).padStart(2, '0')}T10:00:00Z`,
  uitkomst,
  afgebroken_voor_opname: afgebroken,
});

// ── de softphone vertalen ───────────────────────────────────────────────────

test('answered is gesproken', () => {
  assert.deepEqual(uitCallLog('answered'), { uitkomst: 'gesproken', afgebroken: false });
});

test('local_cancel is de afgebroken poging — de belangrijkste vertaling', () => {
  const r = uitCallLog('local_cancel');
  assert.equal(r.afgebroken, true);
});

test('no_answer en busy zijn echte pogingen', () => {
  assert.equal(uitCallLog('no_answer').afgebroken, false);
  assert.equal(uitCallLog('busy').afgebroken, false);
});

test('een onbekende uitkomst telt WEL mee en verdwijnt niet stil', () => {
  // Onbekend als afgebroken behandelen zou betekenen dat een nieuwe soort
  // fout stilletjes uit de telling valt.
  const r = uitCallLog('iets_nieuws');
  assert.equal(r.afgebroken, false);
  assert.equal(r.uitkomst, 'mislukt');
});

test('leeg en null geven ook een meetellende mislukking', () => {
  assert.equal(uitCallLog(null).afgebroken, false);
  assert.equal(uitCallLog('').afgebroken, false);
});

// ── telt deze poging mee? ───────────────────────────────────────────────────

test('een afgebroken poging telt NIET mee', () => {
  assert.equal(teltMee({ uitkomst: 'niet_opgenomen', afgebroken_voor_opname: true }), false);
});

test('een gewone poging telt wel mee', () => {
  for (const u of UITKOMSTEN) {
    assert.equal(teltMee({ uitkomst: u, afgebroken_voor_opname: false }), true, `${u} hoorde mee te tellen`);
  }
});

test('een onbekende uitkomst telt niet mee', () => {
  assert.equal(teltMee({ uitkomst: 'verzonnen' }), false);
  assert.equal(teltMee({}), false);
  assert.equal(teltMee(null), false);
});

// ── de dag ──────────────────────────────────────────────────────────────────

test('dagVan rekent in de lokale tijdzone, niet in UTC', () => {
  // Kwart over één 's nachts Brussels is de nacht van 21 op 22; in UTC is dat
  // nog 21. Een telefoontje op dat uur hoort bij de dag waarop gebeld is.
  assert.equal(dagVan('2026-09-21T23:15:00Z', 'Europe/Brussels'), '2026-09-22');
  assert.equal(dagVan('2026-09-21T10:00:00Z', 'Europe/Brussels'), '2026-09-21');
});

test('dagVan geeft null bij een onleesbare datum', () => {
  assert.equal(dagVan('gisteren'), null);
  assert.equal(dagVan(''), null);
});

// ── tellen ──────────────────────────────────────────────────────────────────

test('drie pogingen op drie dagen geven drie dagen', () => {
  const t = telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  assert.equal(t.meetellend, 3);
  assert.equal(t.niet_opgenomen, 3);
  assert.equal(t.dagen_niet_opgenomen, 3);
});

test('drie pogingen op ÉÉN dag geven één dag — dat is de hele grap', () => {
  const t = telPogingen([
    { gebeld_op: '2026-09-20T09:00:00Z', uitkomst: 'niet_opgenomen' },
    { gebeld_op: '2026-09-20T11:00:00Z', uitkomst: 'niet_opgenomen' },
    { gebeld_op: '2026-09-20T15:00:00Z', uitkomst: 'niet_opgenomen' },
  ], { nu: NU });
  assert.equal(t.niet_opgenomen, 3);
  assert.equal(t.dagen_niet_opgenomen, 1);
});

test('afgebroken pogingen tellen nergens in mee', () => {
  const t = telPogingen([
    poging(18, 'mislukt', true),
    poging(19, 'mislukt', true),
    poging(20, 'niet_opgenomen'),
  ], { nu: NU });
  assert.equal(t.meetellend, 1);
  assert.equal(t.niet_opgenomen, 1);
  assert.equal(t.dagen_niet_opgenomen, 1);
});

test('voicemail en bezet tellen als niet bereikt', () => {
  // Iemand die zijn voicemail laat aanslaan, heb je niet gesproken — en daar
  // gaat de escalatie over.
  const t = telPogingen([poging(18, 'voicemail'), poging(19, 'bezet')], { nu: NU });
  assert.equal(t.niet_opgenomen, 2);
});

test('een gesprek wordt onthouden als laatste contact', () => {
  const t = telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'gesproken')], { nu: NU });
  assert.equal(t.laatste_contact, '2026-09-19T10:00:00Z');
});

test('hoogstens twee pogingen per dag', () => {
  assert.equal(MAX_PER_DAG, 2);
  const vandaag = (u) => ({ gebeld_op: '2026-09-21T09:00:00Z', uitkomst: u });
  assert.equal(telPogingen([vandaag('niet_opgenomen')], { nu: NU }).mag_vandaag_nog, true);
  assert.equal(telPogingen([vandaag('niet_opgenomen'), vandaag('bezet')], { nu: NU }).mag_vandaag_nog, false);
});

test('een afgebroken poging vult de dagteller niet', () => {
  // Anders kost één mispiek je de rest van de dag.
  const t = telPogingen([
    { gebeld_op: '2026-09-21T09:00:00Z', uitkomst: 'mislukt', afgebroken_voor_opname: true },
    { gebeld_op: '2026-09-21T09:01:00Z', uitkomst: 'mislukt', afgebroken_voor_opname: true },
  ], { nu: NU });
  assert.equal(t.vandaag, 0);
  assert.equal(t.mag_vandaag_nog, true);
});

test('een lege lijst geeft nullen, geen fout', () => {
  const t = telPogingen([], { nu: NU });
  assert.equal(t.meetellend, 0);
  assert.equal(t.mag_vandaag_nog, true);
  assert.equal(t.laatste_contact, null);
});

test('rommel als lijst breekt niets', () => {
  for (const v of [null, undefined, 'x', 42]) {
    assert.equal(telPogingen(v, { nu: NU }).meetellend, 0);
  }
});

// ── escaleren ───────────────────────────────────────────────────────────────

const DREMPEL = { pogingen: 3, dagen: 3 };

test('drie pogingen op drie dagen zonder contact: escaleren', () => {
  const t = telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  const r = moetEscaleren(t, DREMPEL, { nu: NU });
  assert.equal(r.escaleren, true);
});

test('drie pogingen op ÉÉN dag: niet escaleren, met uitleg waarom', () => {
  const t = telPogingen([
    { gebeld_op: '2026-09-20T09:00:00Z', uitkomst: 'niet_opgenomen' },
    { gebeld_op: '2026-09-20T11:00:00Z', uitkomst: 'niet_opgenomen' },
    { gebeld_op: '2026-09-20T15:00:00Z', uitkomst: 'niet_opgenomen' },
  ], { nu: NU });
  const r = moetEscaleren(t, DREMPEL, { nu: NU });
  assert.equal(r.escaleren, false);
  assert.match(r.reden, /één ochtend/);
});

test('twee pogingen op twee dagen: nog niet', () => {
  const t = telPogingen([poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  const r = moetEscaleren(t, DREMPEL, { nu: NU });
  assert.equal(r.escaleren, false);
  assert.match(r.reden, /2 van de 3 pogingen/);
});

test('is er gesproken, dan nooit escaleren', () => {
  const t = telPogingen([
    poging(17, 'niet_opgenomen'), poging(18, 'niet_opgenomen'),
    poging(19, 'niet_opgenomen'), poging(20, 'gesproken'),
  ], { nu: NU });
  const r = moetEscaleren(t, DREMPEL, { nu: NU });
  assert.equal(r.escaleren, false);
  assert.match(r.reden, /gesproken/);
});

test('een recent inkomend bericht is ook contact — dan niet escaleren', () => {
  // Wie gisteren nog appte, is niet onbereikbaar. Een "we proberen je te
  // bereiken"-bericht is dan een belediging.
  const t = telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  const r = moetEscaleren(t, DREMPEL, { nu: NU, laatsteInbound: '2026-09-20T18:00:00Z' });
  assert.equal(r.escaleren, false);
  assert.match(r.reden, /bericht/);
});

test('een oud inkomend bericht houdt de escalatie niet tegen', () => {
  const t = telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  const r = moetEscaleren(t, DREMPEL, { nu: NU, laatsteInbound: '2026-08-01T10:00:00Z' });
  assert.equal(r.escaleren, true);
});

test('de drempel is instelbaar', () => {
  const t = telPogingen([poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  assert.equal(moetEscaleren(t, { pogingen: 2, dagen: 2 }, { nu: NU }).escaleren, true);
  assert.equal(moetEscaleren(t, { pogingen: 5, dagen: 5 }, { nu: NU }).escaleren, false);
});

test('zonder drempel gelden drie op drie', () => {
  const t = telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  assert.equal(moetEscaleren(t, {}, { nu: NU }).escaleren, true);
  const tweeDagen = telPogingen([poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU });
  assert.equal(moetEscaleren(tweeDagen, {}, { nu: NU }).escaleren, false);
});

test('elke uitkomst draagt een reden die een mens kan lezen', () => {
  const gevallen = [
    telPogingen([], { nu: NU }),
    telPogingen([poging(20, 'gesproken')], { nu: NU }),
    telPogingen([poging(18, 'niet_opgenomen'), poging(19, 'niet_opgenomen'), poging(20, 'niet_opgenomen')], { nu: NU }),
  ];
  for (const t of gevallen) {
    const r = moetEscaleren(t, DREMPEL, { nu: NU });
    assert.ok(r.reden && r.reden.length > 8, `"${r.reden}" is te kort`);
  }
});

// ── de volgorde ─────────────────────────────────────────────────────────────

test('prioriteit gaat voor, daarna wie het langst wacht', () => {
  const r = sorteerBelrij([
    { id: 'a', prioriteit: 10, aangemaakt_op: '2026-09-01' },
    { id: 'b', prioriteit: 90, aangemaakt_op: '2026-09-20' },
    { id: 'c', prioriteit: 90, aangemaakt_op: '2026-09-10' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['c', 'b', 'a']);
});

test('de volgorde is NIET op meeste pogingen', () => {
  // Anders blijft iemand die al vijf keer niet opnam bovenaan staan, terwijl
  // er onderaan iemand hangt die nog nooit gebeld is.
  const r = sorteerBelrij([
    { id: 'veel', prioriteit: 50, pogingen_totaal: 9, aangemaakt_op: '2026-09-20' },
    { id: 'nieuw', prioriteit: 50, pogingen_totaal: 0, aangemaakt_op: '2026-09-01' },
  ]);
  assert.equal(r[0].id, 'nieuw');
});

test('sorteren raakt de oorspronkelijke lijst niet aan', () => {
  const origineel = [{ id: 'a', prioriteit: 1 }, { id: 'b', prioriteit: 9 }];
  sorteerBelrij(origineel);
  assert.equal(origineel[0].id, 'a');
});

test('sorteren van niets geeft niets', () => {
  assert.deepEqual(sorteerBelrij(null), []);
  assert.deepEqual(sorteerBelrij([]), []);
});

// ── de reden in het scherm ──────────────────────────────────────────────────

test('elke bron heeft een tekst die een mens begrijpt', () => {
  for (const [bron, tekst] of Object.entries(REDEN_TEKST)) {
    assert.ok(tekst.length > 10, `"${bron}" heeft een te korte tekst`);
    assert.doesNotMatch(tekst, /_/, 'een code is geen uitleg voor wie staat te bellen');
  }
});

test('een detail wordt aan de tekst geplakt', () => {
  assert.match(redenTekst('wanbetaler', 'oudste 45 dagen te laat'), /45 dagen/);
});

test('een onbekende bron levert nog steeds iets leesbaars', () => {
  assert.equal(redenTekst('verzonnen'), 'Bellen');
});
