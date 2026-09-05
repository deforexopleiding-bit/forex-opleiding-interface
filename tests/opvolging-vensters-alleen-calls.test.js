// tests/opvolging-vensters-alleen-calls.test.js
//
// Het ochtendspraakbericht en het nabelvenster gelden ALLEEN voor de leads met
// een zoomcall op die dag — niet voor iedereen op de takenlijst.
//
// Wat er stond, live gemeten op productie: spraakBlok en nabelBlok kregen álle
// taken van de dag mee, dus ook de tien masterclass-aanmeldingen. Op het scherm
// stond '0 op tijd, 0 na 09:00, 10 geen, van 10' — tien keer rood voor mensen
// voor wie er geen spraakbericht hoort te bestaan. Dat is precies de nul waar
// deze module zich verder overal tegen verzet: een nul die eruitziet alsof er
// gemeten is.
//
// De juiste verzameling stond al op het scherm: de calls uit
// /api/opvolging-agenda, hetzelfde lijstje dat 'Calls van vandaag' toont.
//
// Twee dingen die hier stil fout kunnen gaan:
//
//  · Een ingeplande call zonder taak erachter is niet te beoordelen — er is
//    geen pogingen-historiek. Die als 'geen spraakbericht' meetellen zou een
//    oordeel zijn over iets wat niemand gemeten heeft.
//
//  · Twee calls voor dezelfde persoon mogen één lead opleveren. Zou die dubbel
//    tellen, dan zakt of stijgt de dekking om een agenda-reden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function laadView() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set,
  });
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8'),
    ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvVensterHelpers, 'de view hoort __opvVensterHelpers te zetten');
  return window.__opvVensterHelpers;
}

const { koppelCalls, callVoorTaak, telVensters } = laadView();

const DAG = '2026-09-05';

/**
 * De sandbox is een eigen realm: een array die daaruit komt heeft een andere
 * Array.prototype en struikelt over assert.deepEqual, ook als de inhoud klopt.
 * Overzetten naar een array van hier maakt de vergelijking weer eerlijk.
 */
const plat = (a) => Array.from(a || []);

/** Een taak met een spraakbericht om 08:30 en een nabelpoging om 12:30. */
const netjes = (over) => ({
  id: 'net', naam: 'Net Op Tijd', telefoon: '+32470111111',
  pogingen: [
    { soort: 'spraakbericht', resultaat: 'spraakbericht verstuurd', tijdstip: DAG + 'T06:30:00Z' },
    { soort: 'call', resultaat: 'geen gehoor', tijdstip: DAG + 'T10:30:00Z' },
  ],
  ...over,
});

/** Een masterclass-aanmelding: geen call, geen pogingen, niets fout. */
const aanmelding = (over) => ({
  id: 'aan-1', naam: 'Jan Peeters', telefoon: '+32470999999',
  reden: 'aanmelding', pogingen: [], ...over,
});

const call = (over) => ({ naam: 'Net Op Tijd', telefoon: '+32470111111', tijd: '14:00', ...over });

/** Zoekt de taak bij een call op precies dezelfde manier als het scherm. */
const zoekerOver = (taken) => (c) => taken.find((t) => callVoorTaak(t, [c])) || null;

// ═══════════════════════════════════════════════════════════════════════════
// DE VERZAMELING
// ═══════════════════════════════════════════════════════════════════════════

test('een taak zonder ingeplande call komt niet in de telling', () => {
  // De kern van de klacht: tien aanmeldingen die als 'geen spraakbericht'
  // geteld werden.
  const taken = [netjes(), aanmelding()];
  const { taken: mee } = koppelCalls({ calls: [call()], zoekTaak: zoekerOver(taken) });
  assert.deepEqual(plat(mee).map((t) => t.id), ['net']);

  const t = telVensters(mee, DAG).spraak;
  assert.equal(t.totaal, 1, 'één lead met een call, niet twee');
  assert.equal(t.niet_gedaan, 0, 'en geen enkele "geen spraakbericht"');
  assert.equal(t.op_tijd, 1);
});

test('tien aanmeldingen zonder call leveren geen enkele rode telling op', () => {
  const taken = Array.from({ length: 10 }, (_, i) =>
    aanmelding({ id: 'aan-' + i, telefoon: '+3247000000' + i }));
  const { taken: mee, zonderTaak } = koppelCalls({ calls: [], zoekTaak: zoekerOver(taken) });
  assert.deepEqual(plat(mee), []);
  assert.deepEqual(plat(zonderTaak), []);
  const t = telVensters(mee, DAG);
  assert.equal(t.spraak.totaal, 0);
  assert.equal(t.nabel.totaal, 0);
});

test('een call zonder taak telt niet mee maar wordt wel apart geteld', () => {
  // Niet te beoordelen: er is geen historiek. Als 'geen spraakbericht' tellen
  // zou een oordeel zijn over iets wat we niet gemeten hebben.
  const taken = [netjes()];
  const onbekend = call({ naam: 'Onbekend', telefoon: '+32470222222' });
  const r = koppelCalls({ calls: [call(), onbekend], zoekTaak: zoekerOver(taken) });
  assert.deepEqual(plat(r.taken).map((t) => t.id), ['net']);
  assert.equal(r.zonderTaak.length, 1);
  assert.equal(r.zonderTaak[0].telefoon, '+32470222222');
  assert.equal(telVensters(r.taken, DAG).spraak.totaal, 1);
});

test('twee calls voor dezelfde persoon leveren één lead op', () => {
  const taken = [netjes()];
  const r = koppelCalls({
    calls: [call({ tijd: '10:00' }), call({ tijd: '15:00' })],
    zoekTaak: zoekerOver(taken),
  });
  assert.equal(r.taken.length, 1, 'anders telt die lead dubbel in de dekking');
  assert.equal(telVensters(r.taken, DAG).spraak.totaal, 1);
});

test('zonder calls is er niets om over te tellen', () => {
  const r = koppelCalls({ calls: [], zoekTaak: () => null });
  assert.deepEqual(plat(r.taken), []);
  assert.deepEqual(plat(r.zonderTaak), []);
});

test('koppelCalls valt niet over rommel', () => {
  assert.deepEqual(plat(koppelCalls({ calls: null, zoekTaak: () => null }).taken), []);
  assert.deepEqual(plat(koppelCalls({ calls: [call()] }).taken), [], 'geen zoeker → niets gekoppeld');
  assert.equal(koppelCalls({ calls: [call()] }).zonderTaak.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KOPPELING OP NUMMER
// ═══════════════════════════════════════════════════════════════════════════

test('de koppeling matcht op de laatste negen cijfers', () => {
  // Nummers staan inconsistent in de database: met of zonder landcode, met of
  // zonder spaties. Zelfde regel als taakVoorNummer al hanteert.
  const t = { telefoon: '0470 11 11 11' };
  assert.ok(callVoorTaak(t, [call({ telefoon: '+32470111111' })]));
  assert.ok(callVoorTaak({ telefoon: '+32470111111' }, [call({ telefoon: '0470111111' })]));
});

test('een andere lead matcht niet', () => {
  assert.equal(callVoorTaak({ telefoon: '+32470999999' }, [call()]), null);
});

test('zonder nummer is er niets te koppelen', () => {
  assert.equal(callVoorTaak({ telefoon: null }, [call()]), null);
  assert.equal(callVoorTaak({ telefoon: '+32470111111' }, [call({ telefoon: null })]), null);
  assert.equal(callVoorTaak(null, [call()]), null);
  assert.equal(callVoorTaak({ telefoon: '+32470111111' }, null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLING ZELF BLIJFT WERKEN
// ═══════════════════════════════════════════════════════════════════════════

test('over de juiste verzameling telt de dekking gewoon door', () => {
  const opTijd = netjes();
  const teLaat = netjes({
    id: 'laat', telefoon: '+32470333333',
    pogingen: [{ soort: 'spraakbericht', resultaat: 'spraakbericht verstuurd', tijdstip: DAG + 'T08:00:00Z' }],
  });
  const t = telVensters([opTijd, teLaat], DAG).spraak;
  assert.equal(t.totaal, 2);
  assert.equal(t.op_tijd, 1, '08:30 Amsterdamse tijd');
  assert.equal(t.te_laat, 1, '10:00 Amsterdamse tijd, dus na 09:00');
  assert.equal(t.niet_gedaan, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BLOKKEN GEBRUIKEN DIE VERZAMELING OOK ECHT
// ═══════════════════════════════════════════════════════════════════════════

test('spraakBlok en nabelBlok rekenen over de calls, niet over alle taken', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const blok = (naam) => {
    const i = bron.indexOf('function ' + naam + '(');
    assert.ok(i > 0, naam + ' hoort te bestaan');
    return bron.slice(i, i + 1400);
  };
  for (const naam of ['spraakBlok', 'nabelBlok']) {
    assert.match(blok(naam), /vensterBron\(dag\)/, naam + ' hoort de calls als bron te nemen');
    assert.match(blok(naam), /telVensters\(bron\.taken, dag\)/,
      naam + ' hoort over bron.taken te tellen, niet over de taken-parameter');
  }
});

test('het dashboard rekent over dezelfde verzameling', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const i = bron.indexOf('function vensterDashboardBlok(');
  const blok = bron.slice(i, i + 1600);
  assert.match(blok, /telVensters\(bron\.taken, dag\)/);
  assert.doesNotMatch(blok, /telVensters\(st\.data\.taken/,
    'de oude aanroep over alle open taken hoort weg te zijn');
});

test('de venster-etiketten op de kaart hangen aan een call op die dag', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  for (const naam of ['vensterBadges', 'vensterAfwijking']) {
    const i = bron.indexOf('function ' + naam + '(');
    assert.ok(i > 0, naam + ' hoort te bestaan');
    assert.match(bron.slice(i, i + 400), /heeftCallOpDag\(t, dag\)/,
      naam + ' hoort alleen iets te tonen bij een lead met een call die dag');
  }
});

test('de uitleg zegt dat het over de leads met een zoomcall gaat', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.doesNotMatch(bron, /Elke lead die vandaag op de lijst staat hoort/,
    'de oude zin beloofde het aan iedereen op de lijst');
  assert.match(bron, /Elke lead die vandaag een <b>zoomcall<\/b> heeft staan/);
});

test('bij een onbereikbare agenda staat er uitleg en geen nul', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const i = bron.indexOf('function vensterLeegBlok(');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1400);
  for (const staat of ['geen_brug', 'laden', 'agenda_fout', 'geen_calls']) {
    assert.ok(blok.includes(staat), 'vensterLeegBlok hoort ' + staat + ' af te handelen');
  }
  assert.match(blok, /nogNietGemeten\(/, 'geen dekkingsbalk met nullen bij een fout');
  assert.doesNotMatch(blok, /dekkingsBalk\(/);
});
