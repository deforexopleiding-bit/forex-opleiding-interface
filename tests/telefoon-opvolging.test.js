// tests/telefoon-opvolging.test.js
//
// Telefoonnummers in de Opvolging-module — en waarom een lokaal Belgisch gsm
// NIET meer als +31 eindigt.
//
// GEMETEN op 28 september: '0475716706' (René Frederix) werd '+31475716706'
// in opvolging_taken.telefoon. Dat nummer bestaat niet; de softphone koos de
// NL-lijn en de operator weigerde na 1-2 seconden. Zie de kop van
// normaliseerOpvolging in api/_lib/phone-e164.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { normaliseerOpvolging, telefoonVoorOpvolging } from '../api/_lib/phone-e164.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE GEVALLEN UIT DE OPDRACHT
// ═══════════════════════════════════════════════════════════════════════════

test('lokaal Belgisch gsm (045-049, 10 cijfers) wordt +32', () => {
  assert.equal(normaliseerOpvolging('0475716706').telefoon, '+32475716706');
  assert.equal(normaliseerOpvolging('0476464399').telefoon, '+32476464399');
  assert.equal(normaliseerOpvolging('0471 64 42 61').telefoon, '+32471644261');
  assert.equal(normaliseerOpvolging('0495/12.34.56').telefoon, '+32495123456');
});

test('lokaal Nederlands gsm (06, 10 cijfers) wordt +31', () => {
  assert.equal(normaliseerOpvolging('0625585610').telefoon, '+31625585610');
  assert.equal(normaliseerOpvolging('06-12345678').telefoon, '+31612345678');
});

test('met + of 00 blijft de landcode staan, alleen compacter', () => {
  assert.equal(normaliseerOpvolging('+31 6 22947174').telefoon, '+31622947174');
  assert.equal(normaliseerOpvolging('+32 471 48 58 16').telefoon, '+32471485816');
  assert.equal(normaliseerOpvolging('0032471485816').telefoon, '+32471485816');
  assert.equal(normaliseerOpvolging('0031612345678').telefoon, '+31612345678');
  // Een bestaand +31 wordt NIET omgezet naar +32 — ook niet als het op een
  // Belgisch gsm lijkt. '+' is eenduidig, daar raden we niet in.
  assert.equal(normaliseerOpvolging('+31475716706').telefoon, '+31475716706');
  assert.equal(normaliseerOpvolging('+31475716706').zeker, true);
});

test('Belgisch vastnummer (0 + 8 cijfers) wordt +32', () => {
  assert.equal(normaliseerOpvolging('093123456').telefoon, '+3293123456');
  assert.equal(normaliseerOpvolging('09 312 34 56').telefoon, '+3293123456');
  assert.equal(normaliseerOpvolging('02 123 45 67').telefoon, '+3221234567');
});

test('Nederlands vastnummer (0 + 9 cijfers, niet 045-049/06) wordt +31', () => {
  assert.equal(normaliseerOpvolging('0201234567').telefoon, '+31201234567');
  assert.equal(normaliseerOpvolging('0101234567').telefoon, '+31101234567');
  // 040-044 met 10 cijfers bestaat in België niet: gsm = 045x-049x, vast =
  // 9 cijfers. Dus zeker NL (040 Eindhoven, 043 Maastricht).
  assert.equal(normaliseerOpvolging('0402123456').telefoon, '+31402123456');
  assert.equal(normaliseerOpvolging('0431234567').telefoon, '+31431234567');
});

test('BEWUSTE AFWEGING: 046/047x/049x met 10 cijfers wordt +32, ook al bestaat dat in NL', () => {
  // 0475 is ook Roermond, 046 Sittard. Onze leads zijn overwegend Vlaams en
  // een NL-lead geeft vrijwel altijd een 06-nummer op. Deze test pint de
  // keuze vast zodat hij niet stil omdraait.
  assert.equal(normaliseerOpvolging('0461234567').telefoon, '+32461234567');
  assert.equal(normaliseerOpvolging('0475123456').telefoon, '+32475123456');
  assert.equal(normaliseerOpvolging('0475123456').zeker, false, 'een aanname, geen zekerheid');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · TWIJFEL = RAUW LATEN (EN LOGGEN)
// ═══════════════════════════════════════════════════════════════════════════

test('fout aantal cijfers: onveranderd, geen e164', () => {
  for (const n of ['3147979884', '+3147979884', '06-1234', '04757167061', '+324712']) {
    const r = normaliseerOpvolging(n);
    assert.equal(r.telefoon, n, n + ' hoort onveranderd te blijven');
    assert.equal(r.e164, null, n);
  }
});

test('zonder 0, + of 00 wordt niet geraden', () => {
  // '31612345678' kan een vergeten + zijn — maar ook iets anders.
  const r = normaliseerOpvolging('31612345678');
  assert.equal(r.telefoon, '31612345678');
  assert.equal(r.e164, null);
});

test('leeg of null is geen nummer en geen twijfel', () => {
  for (const n of [null, undefined, '', '   ']) {
    assert.equal(normaliseerOpvolging(n).telefoon, null);
  }
});

test('ander land met + blijft zoals het is', () => {
  assert.equal(normaliseerOpvolging('+49 151 12345678').telefoon, '+4915112345678');
});

test('telefoonVoorOpvolging logt bij twijfel en NIET bij een geldige omzetting', () => {
  const oud = console.warn;
  const regels = [];
  console.warn = (...a) => regels.push(a);
  try {
    assert.equal(telefoonVoorOpvolging('+3147979884', { bron: 'test' }), '+3147979884');
    assert.equal(regels.length, 1, 'twijfel hoort gelogd te worden');
    assert.equal(regels[0][1].bron, 'test');
    assert.equal(regels[0][1].telefoon, '+3147979884');

    assert.equal(telefoonVoorOpvolging('0475716706', { bron: 'test' }), '+32475716706');
    assert.equal(telefoonVoorOpvolging(null, { bron: 'test' }), null);
    assert.equal(regels.length, 1, 'geen log bij omzetting of leeg nummer');
  } finally {
    console.warn = oud;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · LANDVELD VAN DE BRON GAAT VOOR
// ═══════════════════════════════════════════════════════════════════════════

test('een landveld beslist boven de regel', () => {
  // Met landveld NL is 0475… een Roermonds vastnummer, geen Belgisch gsm.
  assert.equal(normaliseerOpvolging('0475123456', { land: 'NL' }).telefoon, '+31475123456');
  assert.equal(normaliseerOpvolging('0475123456', { land: 'Nederland' }).zeker, true);
  assert.equal(normaliseerOpvolging('093123456', { land: 'België' }).telefoon, '+3293123456');
  assert.equal(normaliseerOpvolging('0471644261', { land: 'be' }).telefoon, '+32471644261');
});

test('landveld met fout aantal cijfers: rauw laten', () => {
  const r = normaliseerOpvolging('093123456', { land: 'NL' });
  assert.equal(r.telefoon, '093123456');
  assert.equal(r.e164, null);
});

test('landveld negeert een + (de landcode in het nummer wint)', () => {
  assert.equal(normaliseerOpvolging('+32471644261', { land: 'NL' }).telefoon, '+32471644261');
});

test('onbekend landveld valt terug op de regel', () => {
  assert.equal(normaliseerOpvolging('0475716706', { land: 'DE' }).telefoon, '+32475716706');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE SOFTPHONE KIEST DEZELFDE LIJN
// ═══════════════════════════════════════════════════════════════════════════

const KERN = (() => {
  const ctx = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readFileSync(join(ROOT, 'modules/shared/belvenster-kern.js'), 'utf8'), ctx);
  return ctx.window.BelvensterKern;
})();

test('spiegel: lijnVoorLokaalNummer volgt normaliseerOpvolging', () => {
  const gevallen = [
    '0475716706', '0476464399', '0451234567', '0491234567', '0461234567',
    '0625585610', '0201234567', '0402123456', '0431234567',
    '093123456', '021234567',
    '06-1234', '04757167061', '0',
  ];
  for (const n of gevallen) {
    const r = normaliseerOpvolging(n);
    const verwacht = r.e164 ? (r.e164.startsWith('+32') ? 'be' : 'nl') : null;
    assert.equal(KERN.lijnVoorLokaalNummer(n), verwacht, n);
  }
});

test('kiesLijn: lokaal Belgisch gsm gaat via de Belgische lijn, zonder zekerheid te claimen', () => {
  const k = KERN.kiesLijn('0475716706');
  assert.equal(k.lijn, 'be');
  assert.equal(k.zeker, false);
  assert.match(KERN.lijnUitleg(k), /zonder landcode/);
  assert.match(KERN.lijnUitleg(k), /Belgische lijn aangenomen/);
  assert.equal(KERN.kiesLijn('0612345678').lijn, 'nl');
});

test('klx-softphone detectLine gebruikt de kern-regel voor lokale nummers', () => {
  const bron = readFileSync(join(ROOT, 'modules/shared/klx-softphone.js'), 'utf8');
  const fn = bron.slice(bron.indexOf('function detectLine('), bron.indexOf('function digitsFor('));
  assert.match(fn, /kern\.lijnVoorLokaalNummer/);
});

test('klx-softphone detectLine: lokaal 047… via BE, 06… via NL, +31 blijft NL', () => {
  const bron = readFileSync(join(ROOT, 'modules/shared/klx-softphone.js'), 'utf8');
  const fn = bron.slice(bron.indexOf('function detectLine('), bron.indexOf('function digitsFor('));
  const ctx = vm.createContext({ KERN });
  const detectLine = vm.runInContext(fn + '\ndetectLine;', ctx);
  assert.equal(detectLine('0475716706'), 'be');
  assert.equal(detectLine('093123456'), 'be');
  assert.equal(detectLine('0625585610'), 'nl');
  assert.equal(detectLine('+32471644261'), 'be');
  assert.equal(detectLine('+31475716706'), 'nl', 'een bestaande +31 wordt niet overruled');
  assert.equal(detectLine('06-1234'), 'nl', 'twijfel valt terug op de standaardlijn');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · ELK SCHRIJFPAD NAAR opvolging_taken NORMALISEERT
// ═══════════════════════════════════════════════════════════════════════════

test('elk insert-pad van opvolging_taken zet het nummer via telefoonVoorOpvolging', () => {
  for (const f of [
    'api/cron-opvolging-zoom-opwarm.js',
    'api/cron-opvolging-zoom-nabel.js',
    'api/cron-opvolging-annuleringen.js',
    'api/cron-opvolging-aanmeldingen.js',
    'api/opvolging-taak-create.js',
    'api/opvolging-aanmelding-actie.js',
    'api/_lib/events-complete-core.js',
  ]) {
    const bron = readFileSync(join(ROOT, f), 'utf8');
    assert.match(bron, /telefoon\s*:\s*telefoonVoorOpvolging\(/, f + ' zet telefoon niet via de helper');
  }
});

test('het nummer wordt genormaliseerd vóór het naar GHL gaat', () => {
  // De lus: rauw nummer → GHL vult NL in → poll leest +31 terug → opwarm-cron.
  const bron = readFileSync(join(ROOT, 'api/_lib/create-appointment-from-lead.js'), 'utf8');
  const i = bron.indexOf('lead_phone: telefoonVoorOpvolging(');
  const j = bron.indexOf('resolveGhlContactId(lead)', bron.indexOf('export async function createAppointmentForLead'));
  assert.ok(i > 0, 'createAppointmentForLead normaliseert lead_phone niet');
  assert.ok(i < j, 'normaliseren moet vóór de GHL-contactkoppeling');
});
