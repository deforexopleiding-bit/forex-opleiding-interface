// tests/softphone-hoorbaar-overgaan.test.js
//
// DAVE MOET HET HOREN OVERGAAN.
//
// De beltoon startte pas bij Establishing, en daar zitten seconden tussen: de
// INVITE moet de deur uit, Voys moet hem doorzetten, en pas als er een 180
// Ringing terugkomt wisselt SIP.js van staat. In die stilte denkt Dave dat er
// niets gebeurt. Maxims klacht was letterlijk dat hij pas iets hoorde als er
// werd opgenomen of de voicemail begon.
//
// En het venster hielp niet mee: `dialing` werd NERGENS gezet, dus tijdens het
// verbinden toonde het nog de vorige toestand — 'Beëindigd' van het gesprek
// daarvoor, of 'Klaar'.
//
// ── WAT HIER BEWEZEN WORDT ────────────────────────────────────────────────
// De volgorde in de echte belfunctie: primen in de klik, toon starten bij het
// versturen, en stoppen bij early media, bij opnemen en bij het einde. Dat is
// leesbaar uit de brontekst omdat het over VOLGORDE gaat; de labels worden wel
// echt uitgevoerd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const BRON = readFileSync('modules/shared/klx-softphone.js', 'utf8');

/** De positie van een stukje code, met een duidelijke fout als het weg is. */
const op = (naald, wat) => {
  const i = BRON.indexOf(naald);
  assert.ok(i > 0, wat + ' is niet gevonden: ' + naald);
  return i;
};

// ═══════════════════════════════════════════════════════════════════════════
// DE TOON BEGINT BIJ HET VERSTUREN, NIET BIJ ESTABLISHING
// ═══════════════════════════════════════════════════════════════════════════

test('de beltoon start vóór inviter.invite(), niet erna', () => {
  const start = op('      ringback.start();\n      try {', 'de start bij het versturen');
  const invite = op('        await inviter.invite();', 'de invite');
  assert.ok(start < invite, 'de toon hoort al te klinken als de INVITE vertrekt');
});

test('de AudioContext wordt in de klik geprimed, vóór die start', () => {
  // Een context die buiten een gebruikersgebaar ontstaat mag door de browser
  // stilgehouden worden. Zonder dit primen is het starten een lege belofte.
  const primen = op('await ringback.primen()', 'het primen in de klik');
  const start  = op('      ringback.start();\n      try {', 'de start bij het versturen');
  assert.ok(primen < start);
});

test('het primen staat vóór de armeerperiode, dus echt in de klik', () => {
  const primen = op('await ringback.primen()', 'het primen');
  const wacht  = op('await new Promise((r) => setTimeout(r, ARMEER_MS))', 'de armeerperiode');
  assert.ok(primen < wacht);
});

test('een mislukte invite laat geen oscillator achter', () => {
  // NAUW AFBAKENEN. Een venster van een paar honderd tekens reikt tot de
  // buitenste catch van placeCall, die óók ringback.stop() doet — en dan matcht
  // deze test terwijl de binnenste weg is. Dat gaf bij de sabotageronde nul
  // rood: vals groen. Daarom precies het blok tussen de start en de return.
  const i = op('      ringback.start();\n      try {', 'de start');
  const eind = BRON.indexOf('return { ok: true, line };', i);
  assert.ok(eind > i, 'het einde van het invite-blok is niet gevonden');
  const blok = BRON.slice(i, eind);
  assert.match(blok, /catch \(e\) \{[^}]*ringback\.stop\(\);[^}]*throw e;/,
    'de invite hoort in een eigen try te zitten die de toon uitzet');
});

// ═══════════════════════════════════════════════════════════════════════════
// EN HIJ STOPT OP ALLE DRIE DE MANIEREN WAAROP HET AFLOOPT
// ═══════════════════════════════════════════════════════════════════════════

test('early media zet de lokale toon uit — anders dubbele audio', () => {
  const i = op("if (s === 'Establishing')", 'de Establishing-tak');
  const blok = BRON.slice(i, i + 900);
  assert.match(blok, /if \(hasEarlyMedia\) \{[\s\S]{0,200}ringback\.stop\(\);/);
});

test('opnemen zet de toon uit', () => {
  const i = op("} else if (s === 'Established') {", 'de Established-tak');
  assert.match(BRON.slice(i, i + 200), /ringback\.stop\(\)/);
});

test('het einde van de call zet de toon uit', () => {
  const i = op("} else if (s === 'Terminated') {", 'de Terminated-tak');
  assert.match(BRON.slice(i, i + 200), /ringback\.stop\(\)/);
});

test('en de poll blijft kijken of er alsnog early media komt', () => {
  const i = op("if (s === 'Establishing')", 'de Establishing-tak');
  const blok = BRON.slice(i, i + 900);
  assert.match(blok, /_earlyMediaPollTimer = setInterval/);
  assert.match(blok, /ringback\.stop\(\);\s*\n\s*_stopEarlyMediaPoll\(\);/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE FASEN STAAN ER, EN OVERAL DEZELFDE WOORDEN
// ═══════════════════════════════════════════════════════════════════════════

/** De echte label-uitdrukking uit renderSheet draaien. */
function labelVoor(lastState) {
  const start = op('    const stateLabel =', 'de labels');
  const eind = BRON.indexOf("'Klaar';", start) + "'Klaar';".length;
  const bron = BRON.slice(start, eind).replace('const stateLabel =', 'const stateLabel =');
  const ctx = createContext({ st: lastState, state: { lastError: 'iets' } });
  runInContext(bron + '\nstateLabel;', ctx, { filename: 'klx-softphone.js#label' });
  return runInContext('stateLabel', ctx);
}

test('het venster toont Verbinden… → Gaat over… → In gesprek', () => {
  assert.equal(labelVoor('dialing'), 'Verbinden…');
  assert.equal(labelVoor('ringing'), 'Gaat over…');
  assert.equal(labelVoor('connected'), 'In gesprek');
});

test('de fase dialing wordt ook echt gezet', () => {
  // Hij stond in de labels maar werd nergens toegekend, dus tijdens het
  // verbinden toonde het venster nog de vorige toestand.
  assert.match(BRON, /state\.lastState = 'dialing';/);
  const zet = op("state.lastState = 'dialing';", 'de toekenning');
  const wacht = op('await new Promise((r) => setTimeout(r, ARMEER_MS))', 'de armeerperiode');
  assert.ok(zet < wacht, 'de fase hoort te staan vóór er gewacht wordt, niet erna');
});

test('de callbar gebruikt dezelfde drie woorden', () => {
  assert.match(BRON, /updateCallbarStatus\('Verbinden…'/);
  assert.match(BRON, /updateCallbarStatus\('Gaat over…'/);
  assert.match(BRON, /updateCallbarStatus\('In gesprek'/);
});

test('venster en callbar lopen niet uiteen', () => {
  // 'Verbonden' in het venster naast 'In gesprek' in de balk laat iemand zich
  // afvragen of dat twee verschillende dingen zijn.
  assert.equal(labelVoor('connected'), 'In gesprek');
  assert.match(BRON, /updateCallbarStatus\('In gesprek'/);
});
