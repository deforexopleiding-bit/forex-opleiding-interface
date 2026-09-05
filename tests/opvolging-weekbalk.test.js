// tests/opvolging-weekbalk.test.js
//
// De weekbalk boven Daves takenlijst.
//
// Wat hier stil fout kan gaan, en waarom het uitmaakt:
//
//  · De balk toonde ma t/m vr van de ISO-week van vandaag. Op zaterdag 5 sep
//    2026 stond er dus ma 31/08 t/m vr 04/09: vandaag ontbrak en volgende week
//    was nergens te bereiken. Dave werkt op zaterdag, dus die dag hoort erbij.
//
//  · Zondag is de uitzondering: die werkweek is voorbij en Dave werkt niet, dus
//    dan opent de balk op de komende week. Wie dat vergeet ziet op zondag een
//    balk vol verleden.
//
//  · De offset is de enige bron voor wat de balk toont. Zou de balk bij het
//    tekenen naar de gekozen dag toe springen, dan kon je met de pijl geen
//    andere week meer bekijken — hij sprong meteen terug. Vandaar dat het
//    meeschuiven bij de dagkeuze gebeurt (weekOffsetVoorDag) en niet bij het
//    tekenen.
//
// De view is een klassiek browser-script; we draaien het echte bestand in een
// vm-sandbox en pakken de functies van window.__opvWeekHelpers, zodat er geen
// tweede kopie van deze logica bestaat die stil uit elkaar kan lopen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

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
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvWeekHelpers, 'de view hoort __opvWeekHelpers te zetten');
  return window.__opvWeekHelpers;
}

const H = laadView();
const { bepaalWeek, basisMaandag, weekOffsetVoorDag, WEEKDAG_LABELS,
        WEEK_MIN_OFFSET, WEEK_MAX_OFFSET } = H;

/**
 * De sandbox is een eigen realm, dus objecten die daaruit komen hebben een
 * andere Object.prototype en struikelen over assert.deepEqual. Overzetten naar
 * een gewoon object van hier maakt de vergelijking weer eerlijk.
 */
const plat = (w) => ({
  maandag: w.maandag,
  dagen: Array.from(w.dagen),
  label: w.label,
  bevatVandaag: w.bevatVandaag,
});

/** De weekdag van een datum, 0 = zondag. */
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();

// ═══════════════════════════════════════════════════════════════════════════
// ZES DAGEN, MET ZATERDAG
// ═══════════════════════════════════════════════════════════════════════════

test('de balk toont zes dagen, maandag tot en met zaterdag', () => {
  const w = plat(bepaalWeek({ nu: '2026-09-05', offset: 0 }));
  assert.equal(w.dagen.length, 6);
  assert.equal(dow(w.dagen[0]), 1, 'de eerste is een maandag');
  assert.equal(dow(w.dagen[5]), 6, 'de laatste is een zaterdag');
  assert.deepEqual(Array.from(WEEKDAG_LABELS), ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za']);
});

test('de dagen liggen aaneengesloten achter de maandag', () => {
  const w = plat(bepaalWeek({ nu: '2026-09-05', offset: 0 }));
  assert.deepEqual(w.dagen, [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
  ]);
  assert.equal(w.maandag, '2026-08-31');
});

// ═══════════════════════════════════════════════════════════════════════════
// BIJ OFFSET 0 ZIT VANDAAG IN DE BALK — BEHALVE OP ZONDAG
// ═══════════════════════════════════════════════════════════════════════════

test('op elke werkdag zit vandaag bij offset 0 in de balk', () => {
  // Een hele week aflopen, want de fout die dit moet vangen ontstond juist op
  // de dag die er niet in zat.
  for (const nu of ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
    const w = plat(bepaalWeek({ nu, offset: 0 }));
    assert.ok(w.dagen.includes(nu), nu + ' hoort in de balk te staan');
    assert.equal(w.bevatVandaag, true);
    assert.equal(w.label, 'Deze week');
  }
});

test('zaterdag 5 september 2026 staat er wél in — dat was de klacht', () => {
  const w = plat(bepaalWeek({ nu: '2026-09-05', offset: 0 }));
  assert.ok(w.dagen.includes('2026-09-05'));
});

test('op zondag opent de balk op de komende week', () => {
  // Dave werkt niet op zondag. De week die dan telt is die van morgen.
  const w = plat(bepaalWeek({ nu: '2026-09-06', offset: 0 }));
  assert.equal(w.maandag, '2026-09-07');
  assert.equal(w.dagen[0], '2026-09-07');
  assert.equal(w.dagen[5], '2026-09-12');
  assert.equal(w.bevatVandaag, false, 'zondag zit zelf niet in de balk');
  assert.equal(w.label, 'Week van 7 sep', 'en heet dan niet "Deze week"');
});

test('basisMaandag schuift alleen op zondag door', () => {
  assert.equal(basisMaandag('2026-09-05'), '2026-08-31', 'zaterdag → deze week');
  assert.equal(basisMaandag('2026-09-06'), '2026-09-07', 'zondag → volgende week');
  assert.equal(basisMaandag('2026-09-07'), '2026-09-07', 'maandag → zichzelf');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE PIJLEN
// ═══════════════════════════════════════════════════════════════════════════

test('offset +1 levert de maandag erna', () => {
  const nu = plat(bepaalWeek({ nu: '2026-09-05', offset: 0 }));
  const na = plat(bepaalWeek({ nu: '2026-09-05', offset: 1 }));
  assert.equal(nu.maandag, '2026-08-31');
  assert.equal(na.maandag, '2026-09-07');
  assert.equal(na.dagen[5], '2026-09-12', 'en zaterdag schuift mee');
  assert.equal(na.bevatVandaag, false);
  assert.equal(na.label, 'Week van 7 sep');
});

test('offset -1 levert de maandag ervoor', () => {
  const w = plat(bepaalWeek({ nu: '2026-09-05', offset: -1 }));
  assert.equal(w.maandag, '2026-08-24');
  assert.equal(w.label, 'Week van 24 aug');
});

test('de zomertijdgrens verschuift de week niet', () => {
  // In de nacht van 24 op 25 oktober 2026 gaat de klok terug. Rekenen op
  // UTC-noon houdt de dagen heel; rekenen op middernacht zou hier een dag
  // verspringen.
  const w = plat(bepaalWeek({ nu: '2026-10-24', offset: 1 }));
  assert.deepEqual(w.dagen, [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN GEKOZEN DAG BUITEN DE WEEK
// ═══════════════════════════════════════════════════════════════════════════

test('een dag in de getoonde week laat de balk staan', () => {
  assert.equal(weekOffsetVoorDag({ nu: '2026-09-05', d: '2026-09-02' }), 0);
  assert.equal(weekOffsetVoorDag({ nu: '2026-09-05', d: '2026-09-05' }), 0);
});

test('een dag buiten de week schuift de balk mee', () => {
  assert.equal(weekOffsetVoorDag({ nu: '2026-09-05', d: '2026-09-09' }), 1, 'volgende week');
  assert.equal(weekOffsetVoorDag({ nu: '2026-09-05', d: '2026-08-26' }), -1, 'vorige week');
  assert.equal(weekOffsetVoorDag({ nu: '2026-09-05', d: '2026-10-06' }), 5);
});

test('de offset die eruit komt zet die dag ook echt in beeld', () => {
  // Het contract tussen de twee functies: wat weekOffsetVoorDag teruggeeft,
  // moet bepaalWeek die dag laten tonen. Anders schuift de balk wel, maar naar
  // de verkeerde week.
  const nu = '2026-09-05';
  for (const d of ['2026-08-24', '2026-09-01', '2026-09-05', '2026-09-09', '2026-10-06']) {
    const off = weekOffsetVoorDag({ nu, d });
    assert.ok(bepaalWeek({ nu, offset: off }).dagen.includes(d),
      d + ' hoort zichtbaar te zijn bij offset ' + off);
  }
});

test('een zondag als gekozen dag schuift naar de week erna', () => {
  // Zondag staat in geen enkele balk. Doorschuiven naar de week erna is het
  // eerste wat Dave dan wél kan aanklikken; blijven staan op de week ervoor
  // zou de keuze onzichtbaar maken.
  const off = weekOffsetVoorDag({ nu: '2026-09-05', d: '2026-09-06' });
  assert.equal(off, 1);
  assert.equal(bepaalWeek({ nu: '2026-09-05', offset: off }).maandag, '2026-09-07');
});

test('zonder dag blijft de balk waar hij is', () => {
  assert.equal(weekOffsetVoorDag({ nu: '2026-09-05', d: null }), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE GRENZEN
// ═══════════════════════════════════════════════════════════════════════════

test('de pijlen hebben een begrenzing zodat je niet in het niets belandt', () => {
  assert.ok(WEEK_MIN_OFFSET < 0 && WEEK_MAX_OFFSET > 0);
  assert.ok(WEEK_MAX_OFFSET - WEEK_MIN_OFFSET >= 8, 'ruim genoeg om mee te werken');
});

test('de balk blijft ook op een verre offset zes aaneengesloten dagen tonen', () => {
  for (const off of [WEEK_MIN_OFFSET, -3, 0, 3, WEEK_MAX_OFFSET]) {
    const w = plat(bepaalWeek({ nu: '2026-09-05', offset: off }));
    assert.equal(w.dagen.length, 6);
    assert.equal(dow(w.dagen[0]), 1);
    assert.equal(dow(w.dagen[5]), 6);
  }
});
