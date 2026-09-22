// tests/softphone-lijnkeuze-per-gesprek.test.js
//
// EEN HANDMATIGE LIJNKEUZE GELDT VOOR ÉÉN GESPREK.
//
// De keuze stond in localStorage, en dan wint één handmatige keuze VOOR ALTIJD
// van het landnummer. Wie ooit een keer BE koos, belde daarna elke Nederlandse
// lead over de Belgische lijn — en mensen nemen veel minder vaak op bij een
// buitenlands nummer. Dat is precies de conversie die de automatische keuze
// moest opleveren, alleen dan andersom.
//
// Het uitgaande NUMMER blijft wél onthouden. Dat is een andere vraag: welke
// lijn bij een lead hoort verschilt per lead, met welk nummer Dave belt is een
// vaste voorkeur.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const BRON = readFileSync('modules/shared/klx-softphone.js', 'utf8');

function knip(naam) {
  const start = BRON.indexOf('  function ' + naam + '(');
  assert.ok(start > 0, naam + ' is niet gevonden');
  const lichaam = BRON.indexOf('{', BRON.indexOf(')', start));
  let diep = 0; let eind = -1;
  for (let n = lichaam; n < BRON.length; n += 1) {
    const ch = BRON[n];
    if (ch === "'" || ch === '`') { const q = BRON.indexOf(ch, n + 1); if (q < 0) break; n = q; continue; }
    if (ch === '{') diep += 1;
    else if (ch === '}') { diep -= 1; if (diep === 0) { eind = n; break; } }
  }
  assert.ok(eind > lichaam, naam + ' loopt niet af');
  return BRON.slice(start, eind + 1);
}

/** De echte lijnkeuze draaien tegen een gezette staat. */
function lijnVoor(nummer, override) {
  const state = { lineOverride: override };
  const ctx = createContext({ state, console });
  runInContext(knip('detectLine') + '\n' + knip('resolveEffectiveLine')
    + '\nresolveEffectiveLine;', ctx, { filename: 'klx-softphone.js#lijn' });
  return runInContext('resolveEffectiveLine', ctx)(nummer);
}

// ═══════════════════════════════════════════════════════════════════════════
// HET LANDNUMMER BESLIST, TENZIJ IEMAND HET NU OVERSCHRIJFT
// ═══════════════════════════════════════════════════════════════════════════

test('op automatisch beslist het landnummer', () => {
  assert.equal(lijnVoor('+32470112233', 'auto'), 'be');
  assert.equal(lijnVoor('+31612345678', 'auto'), 'nl');
});

test('een handmatige keuze wint binnen het gesprek', () => {
  // Overschrijven moet blijven kunnen: de automatische keuze is een gok op het
  // landnummer, en Dave weet soms beter.
  assert.equal(lijnVoor('+31612345678', 'be'), 'be');
  assert.equal(lijnVoor('+32470112233', 'nl'), 'nl');
});

// ═══════════════════════════════════════════════════════════════════════════
// MAAR HIJ OVERLEEFT HET GESPREK NIET
// ═══════════════════════════════════════════════════════════════════════════

test('de keuze wordt nergens meer bewaard', () => {
  assert.doesNotMatch(BRON, /klx-softphone-line/,
    'zolang de keuze in localStorage staat, wint hij voor altijd van het landnummer');
});

test('de beginwaarde is gewoon automatisch', () => {
  const i = BRON.indexOf('lineOverride   :');
  const regel = BRON.slice(i, i + 120);
  assert.match(regel, /lineOverride\s+: 'auto'/,
    'de beginwaarde hoort niet meer uit localStorage te komen');
});

test('een nieuw belvenster zet de lijn terug op automatisch', () => {
  // Zonder deze regel blijft de keuze van de vorige lead staan zolang het
  // tabblad open is — hetzelfde probleem, alleen korter.
  const i = BRON.indexOf('function openSheet(');
  const blok = BRON.slice(i, i + 900);
  assert.match(blok, /state\.lineOverride\s+= 'auto';/);
});

test('het uitgaande nummer blijft WEL onthouden', () => {
  // Anders lost deze wijziging het ene probleem op door een ander te maken.
  assert.match(BRON, /klx-softphone-caller-id-/);
});

test('de keuzelijst zelf blijft bestaan en toont wat automatisch zou kiezen', () => {
  // Het label wordt een aantal regels eerder opgebouwd dan de select zelf, dus
  // vanaf autoOptLabel kijken en niet vanaf de id — anders valt de helft van
  // het onderwerp buiten het venster en bewaakt deze test niets.
  const i = BRON.indexOf('const autoOptLabel');
  const blok = BRON.slice(i, BRON.indexOf('</select>', i));
  assert.match(blok, /Lijn · automatisch/);
  assert.match(blok, /→ \$\{detectedLbl\}/,
    'op automatisch hoort te staan WELKE lijn dat wordt');
  assert.match(blok, /NL-lijn \(\+31\)/);
  assert.match(blok, /BE-lijn \(\+32\)/);
});
