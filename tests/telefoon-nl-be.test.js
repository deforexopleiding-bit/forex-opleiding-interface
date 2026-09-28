// tests/telefoon-nl-be.test.js
//
// Telefoonnummers in de Opvolging-module — en waarom een lokaal Belgisch gsm
// NIET meer als +31 eindigt.
//
// GEMETEN op 28 september: '0475716706' (René Frederix) werd '+31475716706'
// in opvolging_taken.telefoon. Dat nummer bestaat niet; de softphone koos de
// NL-lijn en de operator weigerde na 1-2 seconden. Zie de kop van
// normaliseerNlBe in api/_lib/phone-e164.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { normaliseerNlBe, telefoonNlBe } from '../api/_lib/phone-e164.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE GEVALLEN UIT DE OPDRACHT
// ═══════════════════════════════════════════════════════════════════════════

test('lokaal Belgisch gsm (045-049, 10 cijfers) wordt +32', () => {
  assert.equal(normaliseerNlBe('0475716706').telefoon, '+32475716706');
  assert.equal(normaliseerNlBe('0476464399').telefoon, '+32476464399');
  assert.equal(normaliseerNlBe('0471 64 42 61').telefoon, '+32471644261');
  assert.equal(normaliseerNlBe('0495/12.34.56').telefoon, '+32495123456');
});

test('lokaal Nederlands gsm (06, 10 cijfers) wordt +31', () => {
  assert.equal(normaliseerNlBe('0625585610').telefoon, '+31625585610');
  assert.equal(normaliseerNlBe('06-12345678').telefoon, '+31612345678');
});

test('met + of 00 blijft de landcode staan, alleen compacter', () => {
  assert.equal(normaliseerNlBe('+31 6 22947174').telefoon, '+31622947174');
  assert.equal(normaliseerNlBe('+32 471 48 58 16').telefoon, '+32471485816');
  assert.equal(normaliseerNlBe('0032471485816').telefoon, '+32471485816');
  assert.equal(normaliseerNlBe('0031612345678').telefoon, '+31612345678');
  // Een bestaand +31 wordt NIET omgezet naar +32 — ook niet als het op een
  // Belgisch gsm lijkt. '+' is eenduidig, daar raden we niet in.
  assert.equal(normaliseerNlBe('+31475716706').telefoon, '+31475716706');
  assert.equal(normaliseerNlBe('+31475716706').zeker, true);
});

test('Belgisch vastnummer (0 + 8 cijfers) wordt +32', () => {
  assert.equal(normaliseerNlBe('093123456').telefoon, '+3293123456');
  assert.equal(normaliseerNlBe('09 312 34 56').telefoon, '+3293123456');
  assert.equal(normaliseerNlBe('02 123 45 67').telefoon, '+3221234567');
});

test('Nederlands vastnummer (0 + 9 cijfers, niet 045-049/06) wordt +31', () => {
  assert.equal(normaliseerNlBe('0201234567').telefoon, '+31201234567');
  assert.equal(normaliseerNlBe('0101234567').telefoon, '+31101234567');
  // 040-044 met 10 cijfers bestaat in België niet: gsm = 045x-049x, vast =
  // 9 cijfers. Dus zeker NL (040 Eindhoven, 043 Maastricht).
  assert.equal(normaliseerNlBe('0402123456').telefoon, '+31402123456');
  assert.equal(normaliseerNlBe('0431234567').telefoon, '+31431234567');
});

test('BEWUSTE AFWEGING: 046/047x/049x met 10 cijfers wordt +32, ook al bestaat dat in NL', () => {
  // 0475 is ook Roermond, 046 Sittard. Onze leads zijn overwegend Vlaams en
  // een NL-lead geeft vrijwel altijd een 06-nummer op. Deze test pint de
  // keuze vast zodat hij niet stil omdraait.
  assert.equal(normaliseerNlBe('0461234567').telefoon, '+32461234567');
  assert.equal(normaliseerNlBe('0475123456').telefoon, '+32475123456');
  assert.equal(normaliseerNlBe('0475123456').zeker, false, 'een aanname, geen zekerheid');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · TWIJFEL = RAUW LATEN (EN LOGGEN)
// ═══════════════════════════════════════════════════════════════════════════

test('fout aantal cijfers: onveranderd, geen e164', () => {
  for (const n of ['3147979884', '+3147979884', '06-1234', '04757167061', '+324712']) {
    const r = normaliseerNlBe(n);
    assert.equal(r.telefoon, n, n + ' hoort onveranderd te blijven');
    assert.equal(r.e164, null, n);
  }
});

test('zonder 0, + of 00 en zonder herkenbare vorm wordt niet geraden', () => {
  for (const n of ['201234567', '12345678', '4412345678', '321234567']) {
    const r = normaliseerNlBe(n);
    assert.equal(r.telefoon, n, n);
    assert.equal(r.e164, null, n);
  }
});

test('leeg of null is geen nummer en geen twijfel', () => {
  for (const n of [null, undefined, '', '   ']) {
    assert.equal(normaliseerNlBe(n).telefoon, null);
  }
});

test('ander land met + blijft zoals het is', () => {
  assert.equal(normaliseerNlBe('+49 151 12345678').telefoon, '+4915112345678');
});

test('telefoonNlBe logt bij twijfel en NIET bij een geldige omzetting', () => {
  const oud = console.warn;
  const regels = [];
  console.warn = (...a) => regels.push(a);
  try {
    assert.equal(telefoonNlBe('+3147979884', { bron: 'test' }), '+3147979884');
    assert.equal(regels.length, 1, 'twijfel hoort gelogd te worden');
    assert.equal(regels[0][1].bron, 'test');
    assert.equal(regels[0][1].telefoon, '+3147979884');

    assert.equal(telefoonNlBe('0475716706', { bron: 'test' }), '+32475716706');
    assert.equal(telefoonNlBe(null, { bron: 'test' }), null);
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
  assert.equal(normaliseerNlBe('0475123456', { land: 'NL' }).telefoon, '+31475123456');
  assert.equal(normaliseerNlBe('0475123456', { land: 'Nederland' }).zeker, true);
  assert.equal(normaliseerNlBe('093123456', { land: 'België' }).telefoon, '+3293123456');
  assert.equal(normaliseerNlBe('0471644261', { land: 'be' }).telefoon, '+32471644261');
});

test('landveld met fout aantal cijfers: rauw laten', () => {
  const r = normaliseerNlBe('093123456', { land: 'NL' });
  assert.equal(r.telefoon, '093123456');
  assert.equal(r.e164, null);
});

test('landveld negeert een + (de landcode in het nummer wint)', () => {
  assert.equal(normaliseerNlBe('+32471644261', { land: 'NL' }).telefoon, '+32471644261');
});

test('onbekend landveld valt terug op de regel', () => {
  assert.equal(normaliseerNlBe('0475716706', { land: 'DE' }).telefoon, '+32475716706');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE SOFTPHONE KIEST DEZELFDE LIJN
// ═══════════════════════════════════════════════════════════════════════════

const KERN = (() => {
  const ctx = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readFileSync(join(ROOT, 'modules/shared/belvenster-kern.js'), 'utf8'), ctx);
  return ctx.window.BelvensterKern;
})();

test('spiegel: lijnVoorLokaalNummer volgt normaliseerNlBe', () => {
  const gevallen = [
    '0475716706', '0476464399', '0451234567', '0491234567', '0461234567',
    '0625585610', '0201234567', '0402123456', '0431234567',
    '093123456', '021234567',
    '06-1234', '04757167061', '0',
  ];
  for (const n of gevallen) {
    const r = normaliseerNlBe(n);
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

test('elk insert-pad van opvolging_taken zet het nummer via telefoonNlBe', () => {
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
    assert.match(bron, /telefoon\s*:\s*telefoonNlBe\(/, f + ' zet telefoon niet via de helper');
  }
});

test('het nummer wordt genormaliseerd vóór het naar GHL gaat', () => {
  // De lus: rauw nummer → GHL vult NL in → poll leest +31 terug → opwarm-cron.
  const bron = readFileSync(join(ROOT, 'api/_lib/create-appointment-from-lead.js'), 'utf8');
  const i = bron.indexOf('lead_phone: telefoonNlBe(');
  const j = bron.indexOf('resolveGhlContactId(lead)', bron.indexOf('export async function createAppointmentForLead'));
  assert.ok(i > 0, 'createAppointmentForLead normaliseert lead_phone niet');
  assert.ok(i < j, 'normaliseren moet vóór de GHL-contactkoppeling');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · leads.telefoon_e164 — DE GEVALLEN UIT DE TWEEDE METING
// ═══════════════════════════════════════════════════════════════════════════

test('leads.telefoon_e164: elk gemeten foutpatroon komt nu goed uit', () => {
  const gevallen = {
    '+32470085329'  : '+32470085329',   // expliciete +32 blijft +32
    '0032471134787' : '+32471134787',   // 00 = +
    '00310633298551': '+31633298551',   // 00 + trunk-nul na de landcode
    '+310682610365' : '+31682610365',   // trunk-nul na +31 eraf
    '+32 0478 12 34 56': '+32478123456',
    '31 0612348963' : '+31612348963',   // landcode zonder +, met trunk-nul
    '31612345678'   : '+31612345678',   // landcode zonder +
    '32470085329'   : '+32470085329',
    '470497423'     : '+32470497423',   // Belgisch gsm zonder 0
    '465705330'     : '+32465705330',
    '612345678'     : '+31612345678',   // Nederlands gsm zonder 0
    '0475716706'    : '+32475716706',
  };
  for (const [in_, uit] of Object.entries(gevallen)) {
    assert.equal(normaliseerNlBe(in_).telefoon, uit, in_);
  }
});

test('+32 met een onmogelijke vorm blijft rauw', () => {
  // 9 cijfers na +32 moet een gsm (4x) zijn; 7 cijfers is te kort.
  for (const n of ['+32123456789', '+321234567', '+3104757167']) {
    assert.equal(normaliseerNlBe(n).e164, null, n);
    assert.equal(normaliseerNlBe(n).telefoon, n, n);
  }
});

test('elk pad dat leads.telefoon_e164 zet, gebruikt de gedeelde helper', () => {
  const lib = readFileSync(join(ROOT, 'api/_lib/lms-provisioning.js'), 'utf8');
  assert.match(lib, /telefoonNlBe\(/, 'lms-provisioning.telefoonE164 hoort de helper te gebruiken');
  assert.doesNotMatch(lib, /import[^;]*normalizePhoneE164/, 'de oude NL-default mag er niet meer in');

  for (const f of ['api/public-opstartsessie-book.js', 'api/toegang-aanvraag-start.js']) {
    const bron = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(bron, /function telefoonE164/, f + ' heeft nog een eigen kopie');
    assert.match(bron, /telefoonNlBe\(/, f);
  }
  for (const f of [
    'api/lead-bijwerken.js', 'api/lead-handmatig-toevoegen.js',
    'api/leadsonderhoud-opstartsessie-create.js', 'api/public-opstartsessie-book.js',
  ]) {
    const bron = readFileSync(join(ROOT, f), 'utf8');
    assert.match(bron, /telefoon_e164\s*:\s*telefoonE164\(/, f + ' zet telefoon_e164 niet via de helper');
  }
});

test('lms-provisioning.telefoonE164 gedraagt zich als de helper', async (t) => {
  // lms-provisioning importeert supabase.js; die is hier niet nodig.
  t.mock.module(join(ROOT, 'api/supabase.js'), { namedExports: { supabaseAdmin: {} } });
  const { telefoonE164 } = await import('../api/_lib/lms-provisioning.js');
  assert.equal(telefoonE164('0475716706'), '+32475716706');
  assert.equal(telefoonE164('0032471134787'), '+32471134787');
  assert.equal(telefoonE164(''), null);
  assert.equal(telefoonE164(null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE SQL-SPIEGEL (docs/sql-migrations/2026-09-28-leads-telefoon-e164-…)
// ═══════════════════════════════════════════════════════════════════════════
// Er is hier geen Postgres. Bij het schrijven is de functie lokaal gedraaid en
// op 20.000 willekeurige invoeren naast normaliseerNlBe gelegd: 0 verschillen.
// Wat hier blijft: de controlegevallen uit het SQL-bestand moeten in JS
// dezelfde uitkomst geven, en de trigger moet alleen de COALESCE-tak raken.

const MIGRATIE = readFileSync(
  join(ROOT, 'docs/sql-migrations/2026-09-28-leads-telefoon-e164-normaliseren.sql'), 'utf8');

function controlegevallen() {
  const blok = MIGRATIE.slice(
    MIGRATIE.indexOf('-- CONTROLEGEVALLEN-BEGIN'), MIGRATIE.indexOf('-- CONTROLEGEVALLEN-EINDE'));
  const rijen = [...blok.matchAll(/\(\s*'([^']*)'\s*,\s*(NULL|'([^']*)')\s*\)/g)];
  return rijen.map((m) => [m[1], m[2] === 'NULL' ? null : m[3]]);
}

test('SQL-controlegevallen geven in JS dezelfde uitkomst', () => {
  const gevallen = controlegevallen();
  assert.ok(gevallen.length >= 20, 'de controlegevallen zijn niet gevonden: ' + gevallen.length);
  for (const [invoer, verwacht] of gevallen) {
    assert.equal(normaliseerNlBe(invoer).telefoon, verwacht, JSON.stringify(invoer));
  }
});

test('SQL-controlegevallen dekken elk gemeten foutpatroon', () => {
  const invoer = controlegevallen().map(([i]) => i);
  for (const n of ['0475716706', '470497423', '+32470085329', '0032471134787',
    '00310633298551', '+310682610365', '31 0612348963', '465705330', '3147979884']) {
    assert.ok(invoer.includes(n), n + ' ontbreekt in de SQL-controlegevallen');
  }
});

test('de trigger leidt telefoon_e164 alleen af als de schrijver hem niet zelf zet', () => {
  const zonderCommentaar = MIGRATIE.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  // INSERT: alleen bij ontbrekende telefoon_e164.
  assert.match(zonderCommentaar, /IF NEW\.telefoon_e164 IS NOT NULL OR NEW\.telefoon IS NULL/);
  // UPDATE: alleen als telefoon verandert én telefoon_e164 gelijk blijft.
  assert.match(zonderCommentaar,
    /IF NEW\.telefoon IS NOT DISTINCT FROM OLD\.telefoon\s+OR NEW\.telefoon_e164 IS DISTINCT FROM OLD\.telefoon_e164/);
  assert.match(zonderCommentaar, /BEFORE INSERT OR UPDATE OF telefoon, telefoon_e164 ON public\.leads/);
  // Geen UPDATE op bestaande rijen in de migratie zelf.
  assert.doesNotMatch(zonderCommentaar, /^\s*UPDATE\s+public\.leads/im,
    'de migratie mag bestaande rijen niet aanraken');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · WANBETALERS-SOFTPHONE (finance.html) KIEST DEZELFDE LIJN
// ═══════════════════════════════════════════════════════════════════════════

test('finance.html laadt de kern en _wbxDetectLine volgt dezelfde regel', () => {
  const html = readFileSync(join(ROOT, 'modules/finance.html'), 'utf8');
  assert.match(html, /<script src="\/modules\/shared\/belvenster-kern\.js\?v=\d+"><\/script>/);
  const start = html.indexOf('function _wbxDetectLine(');
  const fn = html.slice(start, html.indexOf('function _wbxDigitsFor(', start));
  const ctx = vm.createContext({ window: { BelvensterKern: KERN } });
  const detect = vm.runInContext(fn + '\n_wbxDetectLine;', ctx);
  assert.equal(detect('0475716706'), 'be');
  assert.equal(detect('0625585610'), 'nl');
  assert.equal(detect('+32471644261'), 'be');
  assert.equal(detect('+31475716706'), 'nl');
  // Zonder kern (script niet geladen): het oude gedrag, geen crash.
  const zonder = vm.runInContext(fn + '\n_wbxDetectLine;', vm.createContext({ window: {} }));
  assert.equal(zonder('0475716706'), 'nl');
});
