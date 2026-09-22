// tests/gesprekken-werkfilters.test.js
//
// De drie filters die op de werkstand leunen (G5-rest), en de bedrading
// eromheen.
//
// Het gemene geval dat hier vastligt: als een MENS antwoordt vanuit het
// scherm, moet het gesprek uit "wacht op ons" verdwijnen. Deed het dat niet,
// dan blijft het filter gesprekken tonen die je net beantwoord hebt — en een
// filter dat je eigen werk niet ziet, leer je binnen een dag te negeren.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../modules/shared/gesprekken-v2.js', import.meta.url), 'utf8');
const win = {};
const mod = { exports: {} };
new Function('window', 'module', src)(win, mod);
const G = mod.exports;

const LIJST = readFileSync(new URL('../api/inbox-conversations-list.js', import.meta.url), 'utf8');
const SEND  = readFileSync(new URL('../api/inbox-send.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');

const G1 = { id: '1', customer_id: 'k', iris_status: 'wacht_op_ons' };
const G2 = { id: '2', customer_id: 'k', iris_status: 'wacht_op_klant' };
const G3 = { id: '3', customer_id: 'k', iris_status: 'wacht_op_klant', belofte_vandaag: true };
const G4 = { id: '4', customer_id: 'k', iris_status: null };
const ALLE = [G1, G2, G3, G4];

// ── de filters ──────────────────────────────────────────────────────────────

test('wacht op ons toont alleen wat op ons wacht', () => {
  assert.deepEqual(G.focusFilter(ALLE, ALLE, 'wacht_op_ons').map((c) => c.id), ['1']);
});

test('wacht op klant toont alleen wat op de klant wacht', () => {
  assert.deepEqual(G.focusFilter(ALLE, ALLE, 'wacht_op_klant').map((c) => c.id), ['2', '3']);
});

test('belofte vandaag hangt aan de belofte zelf, niet aan een status', () => {
  // Er bestaat een status 'belofte_loopt' in de tabel, maar die wordt door
  // niets gezet. Een filter daarop zou altijd leeg zijn, en dat leert je
  // binnen een dag dat het scherm niet klopt.
  assert.deepEqual(G.focusFilter(ALLE, ALLE, 'belofte_vandaag').map((c) => c.id), ['3']);
  // En het bewijs dat het filter er niet stiekem tóch op leunt: een gesprek
  // met die status maar zonder belofte valt er niet in.
  const schijn = { id: '9', customer_id: 'k', iris_status: 'belofte_loopt' };
  assert.equal(G.focusFilter([schijn], [schijn], 'belofte_vandaag').length, 0);
});

test('een gesprek zonder stand valt in geen van de drie', () => {
  // Niet-weten is geen status. Zou een gesprek zonder stand in "wacht op ons"
  // vallen, dan zou de lijst werk beweren dat er misschien niet is.
  for (const m of ['wacht_op_ons', 'wacht_op_klant', 'belofte_vandaag']) {
    assert.equal(G.focusFilter([G4], [G4], m).length, 0, m);
  }
});

test('de teller op de knop komt uit hetzelfde filter als wat je ziet', () => {
  // Twee keer dezelfde regel uitschrijven is precies hoe teller en lijst uit
  // de pas gaan lopen.
  const tel = G.focusTelling(ALLE, ALLE);
  assert.equal(tel.wacht_op_ons, G.focusFilter(ALLE, ALLE, 'wacht_op_ons').length);
  assert.equal(tel.wacht_op_klant, G.focusFilter(ALLE, ALLE, 'wacht_op_klant').length);
  assert.equal(tel.belofte_vandaag, G.focusFilter(ALLE, ALLE, 'belofte_vandaag').length);
});

test('de drie standen zijn bekend, een verzonnen stand niet', () => {
  for (const m of ['wacht_op_ons', 'wacht_op_klant', 'belofte_vandaag']) {
    assert.equal(G.leesFocus(m), m);
  }
  assert.equal(G.leesFocus('belofte_morgen'), 'geen');
});

// ── de bedrading ────────────────────────────────────────────────────────────

test('de lijst haalt de werkstand op achter de vlag', () => {
  assert.match(LIJST, /if \(gesprekkenV2Aan\(\)\) \{[\s\S]{0,400}iris_gesprekken/);
});

test('de lijst leest de beloftes, niet de ongebruikte status', () => {
  assert.match(LIJST, /from\('iris_beloftes'\)/);
  assert.match(LIJST, /\.eq\('status', 'actief'\)/);
  // Niet "het woord komt nergens voor" — het staat in de uitleg waaróm we het
  // niet gebruiken. Wel: er wordt nergens op gefilterd.
  assert.doesNotMatch(LIJST, /\.eq\(\s*'status',\s*'belofte_loopt'\s*\)/);
  assert.doesNotMatch(LIJST, /\.in\([^)]*belofte_loopt/);
});

test('een fout in de werkstand laat de lijst staan die je al had', () => {
  // Een halve uitkomst zou erger zijn dan geen: dan verbergt een filter een
  // gesprek omdat het toevallig in het blok zat dat misging.
  const i = LIJST.indexOf('werkstand overgeslagen');
  assert.ok(i > 0, 'er hoort een faalzachte tak met een logregel te zijn');
});

test('een antwoord van een MENS zet het gesprek op wacht-op-klant', () => {
  // Zonder dit blijft "wacht op ons" gesprekken tonen die je net beantwoord
  // hebt. Dat is het hele filter kapot.
  assert.match(SEND, /status: 'wacht_op_klant'/);
  assert.match(SEND, /werkSleutel\(convId\)/);
});

test('dat overschrijft nooit een stand die een mens bewust koos', () => {
  const i = SEND.indexOf("status: 'wacht_op_klant'");
  const body = SEND.slice(i, i + 900);
  assert.match(body, /\.in\('status', \['nieuw', 'wacht_op_ons'\]\)/,
    "'geregeld' en een lopende belofte horen te blijven staan");
});

test('het bijwerken mag de verzending nooit omvergooien', () => {
  // Het bericht is op dat moment al bij Meta.
  const i = SEND.indexOf("status: 'wacht_op_klant'");
  const body = SEND.slice(i - 200, i + 1200);
  assert.match(body, /catch \(wEx\)/);
});

test('de drie knoppen staan in het scherm, met een teller', () => {
  for (const m of ['wacht_op_ons', 'wacht_op_klant', 'belofte_vandaag']) {
    assert.ok(SCHERM.includes(`focusBtn('${m}'`), `knop ${m} ontbreekt`);
    assert.ok(SCHERM.includes(`tel.${m}`), `teller ${m} ontbreekt`);
  }
});

test('elke stand heeft een lege tekst die bij dat filter past', () => {
  // "Geen wanbetaler-gesprekken" onder het filter "belofte vandaag" leest als
  // "er zijn geen wanbetalers", en dat is iets heel anders.
  const i = SCHERM.indexOf('const LEEG = {');
  assert.ok(i > 0, 'er hoort een opzoeklijst te zijn, geen geneste vraagtekens');
  const body = SCHERM.slice(i, i + 700);
  for (const m of ['wacht_op_ons', 'wacht_op_klant', 'belofte_vandaag', 'niet_gekoppeld', 'venster_bijna_dicht']) {
    assert.ok(body.includes(m + ':'), `lege tekst voor ${m} ontbreekt`);
  }
});
