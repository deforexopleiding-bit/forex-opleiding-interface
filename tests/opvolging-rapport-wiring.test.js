// tests/opvolging-rapport-wiring.test.js
//
// Twee dingen die het dagrapport onzichtbaar zouden maken of stil verkeerd:
//
//  · De uitkomst-motor moet de twee nieuwe kolommen schrijven op het moment
//    dat de uitkomst valt, en ze wissen als iemand die uitkomst terugdraait.
//    Zonder dat laatste blijft een gecorrigeerde sale in het rapport staan.
//
//  · Het tabblad moet geregistreerd staan, met een tab in de shell en een
//    rechtensleutel. Op 6 september tekende de shell 'Deze view is nog niet
//    gebouwd' omdat een view niet geregistreerd werd — die vorm is stil.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const MOTOR  = lees('api/follow-up-appointment-outcome.js');
const SHELL  = lees('modules/shared/design-system/app-shell.js');
const REG    = lees('modules/shared/rbac/registry.js');
const VIEW   = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

// ═══════════════════════════════════════════════════════════════════════════
// DE MOTOR SCHRIJFT DE UITKOMST WEG
// ═══════════════════════════════════════════════════════════════════════════

test('de motor schrijft uitkomst en uitkomst_op', () => {
  assert.match(MOTOR, /async function writeUitkomst\(appointmentId, outcome\)/);
  assert.match(MOTOR, /uitkomst: outcome, uitkomst_op: new Date\(\)\.toISOString\(\)/);
});

test('de uitkomst wordt geschreven bij de status-update, niet ergens later', () => {
  // uitkomst_op moet het moment van de UITKOMST zijn. Schuift deze aanroep naar
  // een plek verderop in de afhandeling, dan is het moment van iets anders.
  const i = MOTOR.indexOf('await updateApptStatus(appointmentId, newStatus);');
  assert.ok(i > 0);
  const blok = MOTOR.slice(i, i + 400);
  assert.match(blok, /await writeUitkomst\(appointmentId, outcome\)/);
});

test('uitkomst zit NIET in dezelfde update als status', () => {
  // Zou hij dat wel doen, dan faalt de HELE update met `column "uitkomst" does
  // not exist` zolang de migratie niet gedraaid is — en dan werkt de
  // uitkomst-motor niet meer. Zie CLAUDE.md over kolom-migraties.
  const i = MOTOR.indexOf('async function updateApptStatus');
  const blok = MOTOR.slice(i, MOTOR.indexOf('}', MOTOR.indexOf('.eq(', i)));
  assert.doesNotMatch(blok, /uitkomst/);
});

test('een ontbrekende kolom is fail-soft en geen storing', () => {
  const i = MOTOR.indexOf('async function writeUitkomst');
  const blok = MOTOR.slice(i, MOTOR.indexOf('\n}\n', i));
  assert.match(blok, /isMissingColumnError\(error, 'uitkomst'\)/);
  assert.match(blok, /console\.warn/);
  // Niet throwen: de uitkomst zelf moet doorgaan.
  assert.doesNotMatch(blok, /throw /);
});

test('undo wist de uitkomst, anders blijft een teruggedraaide sale staan', () => {
  const aanroepen = MOTOR.match(/await writeUitkomst\(appointmentId, ([^)]+)\)/g) || [];
  const wissers = aanroepen.filter((a) => /null/.test(a));
  // Twee undo-paden: het onomkeerbare (best-effort) en het gewone.
  assert.equal(wissers.length, 2, 'beide undo-paden horen de uitkomst te wissen');
});

test('wissen zet ook het moment leeg, niet alleen de uitkomst', () => {
  // uitkomst leeg met een moment erbij zou lezen als 'er is iets gebeurd maar
  // we weten niet wat' — en dat is niet waar; er is niets meer.
  assert.match(MOTOR, /\{ uitkomst: null, uitkomst_op: null \}/);
});

test('de motor schrijft geen uitkomst bij verzetten of annuleren', () => {
  // Die twee delegeren naar een ander endpoint en zetten newStatus niet; de
  // uitkomst hoort dan ook niet gezet te worden. De aanroep staat binnen
  // `if (newStatus)`, dus dit controleert dat die guard er nog omheen zit.
  const i = MOTOR.indexOf('if (newStatus) {');
  const j = MOTOR.indexOf('await writeUitkomst(appointmentId, outcome)');
  assert.ok(i > 0 && j > i, 'de schrijf hoort binnen de newStatus-guard te staan');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET TABBLAD BESTAAT ÉN IS BEREIKBAAR
// ═══════════════════════════════════════════════════════════════════════════

test('de shell kent een vierde tab Rapport', () => {
  assert.match(SHELL, /tabs: \['Vandaag', 'Dashboard', 'Afgerond', 'Rapport'\]/);
});

test('de tab hangt aan een eigen rechtensleutel', () => {
  assert.match(SHELL, /'opvolging\/Rapport' *: *'opvolging\.rapport\.view'/);
  assert.match(REG, /key:'opvolging\.rapport\.view'/);
});

test('de view registreert opvolging/Rapport', () => {
  const bron = readFileSync(VIEW, 'utf8');
  assert.match(bron, /window\.DFO\.VIEWS\['opvolging\/Rapport'\] = rapportView;/);
});

test('ook de noodregistratie dekt Rapport', () => {
  // registreerOntbrekend registreert de views als de module niet compleet
  // geladen is. Ontbreekt Rapport daar, dan tekent de shell voor dat ene
  // tabblad 'Deze view is nog niet gebouwd' — een melding die niets zegt over
  // wat er echt aan de hand is.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function registreerOntbrekend');
  const blok = bron.slice(i, bron.indexOf('\n  }', i));
  assert.match(blok, /VIEWS\['opvolging\/Rapport'\] = scherm/);
});

test('de view tekent het rapport zonder te tellen', () => {
  // Het rekenwerk hoort in het endpoint. Telt het scherm zelf mee, dan kunnen
  // scherm en rapport verschillende dingen zeggen over dezelfde dinsdag.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function rapportView()');
  const j = bron.indexOf('window.__opvVensterHelpers', i);
  const blok = bron.slice(i, j);
  assert.ok(blok.length > 500, 'de rapportView hoort hier te staan');
  assert.doesNotMatch(blok, /ARCHIEF_MIN_DAGEN|SPRAAK_DEADLINE_UUR/,
    'de drempels komen mee uit het endpoint, niet uit de eigen constanten');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE PERIODEKEUZE REKENT IN AMSTERDAMSE TIJD
// ═══════════════════════════════════════════════════════════════════════════

function laadView() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval() { return 0; }, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window,
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console, queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Intl, Set, Array, Object,
  });
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js'), 'utf8'), ctx, { filename: 'badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  return window;
}

test('de periodekeuze gebruikt Intl en niet toISOString', () => {
  // toISOString is UTC. Rond middernacht levert dat 'gisteren' op voor wat
  // hier nog vandaag is, en dan gaat het rapport over de verkeerde dag.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('const vandaagNL =');
  assert.ok(i > 0, 'de rapport-tab hoort een eigen dagbepaling te hebben');
  const blok = bron.slice(i, i + 300);
  assert.match(blok, /Europe\/Amsterdam/);
  assert.doesNotMatch(blok, /toISOString/);
});

test('de vier vaste periodes en de eigen reeks zitten in de knoppenrij', () => {
  const bron = readFileSync(VIEW, 'utf8');
  for (const k of ['vandaag', 'gisteren', 'deze_week', 'vorige_week', 'eigen']) {
    assert.ok(bron.includes("'" + k + "'"), 'periode ' + k + ' ontbreekt');
  }
});

test('een eigen reeks met het einde vóór het begin wordt geweigerd', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('window.__opvRapportEigen');
  const blok = bron.slice(i, i + 600);
  assert.match(blok, /tot < van/);
});

test('de view laadt zonder te struikelen en registreert vier tabs', () => {
  const w = laadView();
  assert.deepEqual(
    Object.keys(w.DFO.VIEWS).sort(),
    ['opvolging/Afgerond', 'opvolging/Dashboard', 'opvolging/Rapport', 'opvolging/Vandaag'],
  );
});
