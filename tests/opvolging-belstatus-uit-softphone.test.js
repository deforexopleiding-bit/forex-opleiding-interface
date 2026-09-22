// tests/opvolging-belstatus-uit-softphone.test.js
//
// DE SOFTPHONE IS DE BRON VAN WAARHEID, NIET DE VIEW.
//
// Maxim: 'als ik van scherm verander en terugkeer is de belknop weg en blijft
// hij bellen, of stopt hij terwijl dat niet mag'.
//
// De oorzaak is dat de view zijn eigen verhaal vertelde. Bij elke opbouw werd
// de kaart opnieuw getekend uit lokale gegevens, en die weten niets van een
// gesprek dat al loopt. Kom je terug op het scherm, dan staat er gewoon weer
// 'Bellen' bij iemand met wie je op dat moment aan de telefoon zit — en daar
// nog eens op drukken start een tweede oproep bovenop de eerste.
//
// Twee eisen, en de tweede is de gevaarlijkste:
//   1. bij elke opbouw getStatus() vragen en de belstatus correct tonen;
//   2. opruimen bij het verlaten van een scherm raakt ALLEEN de weergave,
//      nooit de verbinding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');

/** Een functie uit de view knippen, vanaf het lichaam tellend. */
function knip(naam) {
  const start = VIEW.indexOf('  function ' + naam + '(');
  assert.ok(start > 0, naam + ' is niet gevonden in de view');
  const lichaam = VIEW.indexOf('{', VIEW.indexOf(')', start));
  let diep = 0; let eind = -1;
  for (let n = lichaam; n < VIEW.length; n += 1) {
    const ch = VIEW[n];
    if (ch === "'" || ch === '`') { const q = VIEW.indexOf(ch, n + 1); if (q < 0) break; n = q; continue; }
    if (ch === '{') diep += 1;
    else if (ch === '}') { diep -= 1; if (diep === 0) { eind = n; break; } }
  }
  assert.ok(eind > lichaam, naam + ' loopt niet af — anker of code is stuk');
  return VIEW.slice(start, eind + 1);
}

/** De echte belStatusNu/inGesprekMet/belKnop draaien tegen een nagebootste softphone. */
function omgeving(status) {
  const ctx = createContext({
    window: { KlxSoftphone: status === undefined ? undefined : { getStatus: () => status } },
    telCijfers: (t) => String(t == null ? '' : t).replace(/\D/g, ''),
    console,
  });
  runInContext(
    'let _belNu = { actief: false, nummer: null };\n'
    + knip('belStatusNu') + '\n' + knip('inGesprekMet') + '\n' + knip('belKnop') + '\n'
    + 'const api = { belStatusNu, inGesprekMet, belKnop, zet: (v) => { _belNu = v; } };\napi;',
    ctx, { filename: 'opvolging-v2.js#belstatus' },
  );
  return runInContext('api', ctx);
}

const LOOPT = { state: 'connected', activeCustomer: { phone: '+31612345678', name: 'Sofia' } };

// ═══════════════════════════════════════════════════════════════════════════
// BIJ ELKE OPBOUW WORDT DE SOFTPHONE GEVRAAGD
// ═══════════════════════════════════════════════════════════════════════════

test('de view vraagt de belstatus op bij het opbouwen van het scherm', () => {
  const i = VIEW.indexOf('function vandaagView()');
  const blok = VIEW.slice(i, i + 500);
  assert.match(blok, /_belNu = belStatusNu\(\);/,
    'zonder dit vertelt de view weer zijn eigen verhaal');
});

test('een lopend gesprek wordt herkend', () => {
  const api = omgeving(LOOPT);
  const nu = api.belStatusNu();
  assert.equal(nu.actief, true);
  assert.equal(nu.nummer, '+31612345678');
  assert.equal(nu.naam, 'Sofia');
});

test('elke fase van een lopend gesprek telt mee', () => {
  for (const fase of ['dialing', 'ringing', 'connected']) {
    const api = omgeving({ state: fase, activeCustomer: { phone: '+31612345678' } });
    assert.equal(api.belStatusNu().actief, true, fase + ' hoort als lopend te tellen');
  }
});

test('een beëindigd of foutief gesprek telt niet als lopend', () => {
  for (const fase of ['ended', 'error', undefined]) {
    const api = omgeving({ state: fase, activeCustomer: { phone: '+31612345678' } });
    assert.equal(api.belStatusNu().actief, false, fase + ' hoort niet als lopend te tellen');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KNOP ZEGT WAT ER AAN DE HAND IS
// ═══════════════════════════════════════════════════════════════════════════

test('bij de persoon in gesprek staat GEEN belknop', () => {
  const api = omgeving(LOOPT);
  api.zet(api.belStatusNu());
  const h = api.belKnop('+31612345678', "window.__opvBel('t1', 'werklijst')");
  assert.match(h, /In gesprek/);
  assert.doesNotMatch(h, /__opvBel/, 'nog een oproep starten bovenop de lopende');
});

test('bij iedereen anders staat de belknop gewoon', () => {
  const api = omgeving(LOOPT);
  api.zet(api.belStatusNu());
  const h = api.belKnop('+31699999999', "window.__opvBel('t2', 'werklijst')");
  assert.match(h, /Bellen/);
  assert.match(h, /__opvBel/);
});

test('zonder lopend gesprek staat overal gewoon de belknop', () => {
  const api = omgeving({ state: 'ended' });
  api.zet(api.belStatusNu());
  assert.match(api.belKnop('+31612345678', 'x()'), /Bellen/);
});

test('het nummer wordt op de staart vergeleken, net als elders', () => {
  // Nummers staan niet genormaliseerd in de databank: met of zonder landcode,
  // met of zonder spaties. Op exacte gelijkheid matchen zou de helft missen.
  const api = omgeving(LOOPT);
  api.zet(api.belStatusNu());
  assert.match(api.belKnop('0612345678', 'x()'), /In gesprek/);
  assert.match(api.belKnop('+31 6 12345678', 'x()'), /In gesprek/);
});

test('een te kort nummer geeft geen valse treffer', () => {
  const api = omgeving(LOOPT);
  api.zet(api.belStatusNu());
  assert.match(api.belKnop('5678', 'x()'), /Bellen/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ZONDER SOFTPHONE GEWOON DOORWERKEN
// ═══════════════════════════════════════════════════════════════════════════

test('geen softphone op de pagina breekt de lijst niet', () => {
  const api = omgeving(undefined);
  assert.equal(api.belStatusNu().actief, false);
  assert.match(api.belKnop('+31612345678', 'x()'), /Bellen/);
});

test('een getStatus die gooit breekt de lijst ook niet', () => {
  const ctx = createContext({
    window: { KlxSoftphone: { getStatus: () => { throw new Error('stuk'); } } },
    telCijfers: (t) => String(t == null ? '' : t).replace(/\D/g, ''),
    console,
  });
  runInContext('let _belNu = { actief: false };\n' + knip('belStatusNu') + '\nbelStatusNu;', ctx);
  assert.equal(runInContext('belStatusNu', ctx)().actief, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// OPRUIMEN RAAKT NOOIT DE VERBINDING
// ═══════════════════════════════════════════════════════════════════════════

test('de view hangt NERGENS op', () => {
  // Dit is de gevaarlijkste helft van de klacht: 'of stopt hij terwijl dat
  // niet mag'. Het gesprek leeft in de softphone; een scherm dat weggaat mag
  // daar niets aan doen.
  assert.doesNotMatch(VIEW, /\.hangup\(/, 'er staat een hangup() in de opvolgview');
});

test('de knop bij een lopend gesprek opent het venster, hangt niet op', () => {
  // Op de DEFINITIE ankeren, niet op de naam: de eerste treffer is de onclick
  // in de knop-HTML, en dan meet deze test een stuk opmaak in plaats van de
  // functie. Dezelfde vergissing maakte ik eerder bij __opvTerug.
  const i = VIEW.indexOf('window.__opvToonGesprek = ');
  assert.ok(i > 0, 'de definitie van __opvToonGesprek is niet gevonden');
  const blok = VIEW.slice(i, i + 700);
  assert.match(blok, /sp\.open\(/);
  assert.doesNotMatch(blok, /hangup/);
});

test('het opruimen bij het verlaten raakt alleen timers', () => {
  const i = VIEW.indexOf('function stopWaTimers');
  assert.ok(i > 0, 'stopWaTimers is niet gevonden');
  const blok = VIEW.slice(i, i + 600);
  assert.match(blok, /clearInterval/);
  assert.doesNotMatch(blok, /hangup|KlxSoftphone/,
    'opruimen mag de verbinding niet aanraken');
});
