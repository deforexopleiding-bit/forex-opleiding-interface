// tests/opvolging-ronde-tweeling.test.js
//
// Het rondelabel op de aanmeldkaart bestaat twee keer: server-side in
// api/_lib/opvolging-aanmelding.js en als tweeling in de browser-view, want
// een <script>-view kan niet uit api/_lib importeren.
//
// TWEE KOPIEËN DIE UIT ELKAAR LOPEN IS EEN LEUGEN OP HET SCHERM. Deze test
// draait de ECHTE browserfunctie — uit het echte bestand, in een vm met een
// nagebootste browser — en legt hem naast de server-versie. Niet de brontekst
// lezen: dat is de alibi-vorm uit docs/opvolging-module.md, die zou groen staan
// zonder één regel uit te voeren.
//
// De aanleiding: Maxim dacht dat 'Bevestigd' de kaart liet verdwijnen, terwijl
// de code hem doorschuift naar event min vier. Het etiket zegt wat de code doet;
// zodra die twee uiteenlopen is het etiket erger dan geen etiket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bepaalRonde, WAKKER_DAGEN_VOOR_EVENT } from '../api/_lib/opvolging-aanmelding.js';

/** De browserfunctie echt uitvoeren, uit het echte bestand. */
function browserRonde() {
  const bron = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  const m = bron.match(/function bepaalRonde\(eventDag, nuDag\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'bepaalRonde niet gevonden in de browser-view — is hij hernoemd?');
  const wakker = bron.match(/const WAKKER_DAGEN_VOOR_EVENT = (\d+);/);
  assert.ok(wakker, 'WAKKER_DAGEN_VOOR_EVENT niet gevonden in de browser-view');
  const ctx = vm.createContext({ Date, Number });
  vm.runInContext(`const WAKKER_DAGEN_VOOR_EVENT = ${wakker[1]};\n${m[0]}`, ctx);
  assert.equal(Number(wakker[1]), WAKKER_DAGEN_VOOR_EVENT,
    'de browser hanteert een ander aantal dagen dan de server');
  return (eventDag, nuDag) => vm.runInContext(
    `bepaalRonde(${JSON.stringify(eventDag)}, ${JSON.stringify(nuDag)})`, ctx);
}

const GEVALLEN = [
  // [eventDag, vandaag, verwachte ronde]
  ['2026-09-20', '2026-09-07', 'A'],   // ver weg — opwarmronde
  ['2026-09-20', '2026-09-15', 'A'],   // dag vóór de grens
  ['2026-09-20', '2026-09-16', 'B'],   // exact event min vier
  ['2026-09-20', '2026-09-18', 'B'],   // erna
  ['2026-09-08', '2026-09-07', 'B'],   // morgen: A en B vielen samen
  ['2026-09-07', '2026-09-07', 'B'],   // vandaag
];

test('server en browser noemen exact dezelfde ronde', () => {
  const browser = browserRonde();
  for (const [eventDag, vandaag, verwacht] of GEVALLEN) {
    const s = bepaalRonde({ eventDag, vandaag });
    const b = browser(eventDag, vandaag);
    assert.equal(s.ronde, verwacht, `server zit fout op ${eventDag} / ${vandaag}`);
    // Via JSON: het vm-object komt uit een ander realm, en strict deepEqual
    // struikelt dan over de prototypes in plaats van over de inhoud.
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(s)),
      `tweeling loopt uiteen op ${eventDag} / ${vandaag}`);
  }
});

test('de opwarmronde noemt de dag waarop de kaart terugkomt — event min vier', () => {
  const r = bepaalRonde({ eventDag: '2026-09-20', vandaag: '2026-09-07' });
  assert.equal(r.terug_op, '2026-09-16');
  assert.equal(r.laatste, false);
});

test('de bevestigingsronde is de laatste en noemt geen terugkomdatum', () => {
  const r = bepaalRonde({ eventDag: '2026-09-20', vandaag: '2026-09-17' });
  assert.equal(r.laatste, true);
  assert.equal(r.terug_op, null);
});

test('zonder eventdag geen etiket — een verzonnen ronde is erger dan geen ronde', () => {
  const browser = browserRonde();
  assert.equal(bepaalRonde({ eventDag: null, vandaag: '2026-09-07' }), null);
  assert.equal(browser(null, '2026-09-07'), null);
  assert.equal(browser('rommel', '2026-09-07'), null);
});

// ── En het strookje komt echt op de kaart, niet alleen in de functie ────────
// De 'hulpfunctie'-val: bepaalRonde kan perfect kloppen terwijl de kaart hem
// nooit aanroept. Daarom hier de aanroep zelf.

test('de aanmeldkaart roept het rondestrookje aan, en andere taken niet', () => {
  const bron = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  // LET OP DE VAL: /rondeStrook\(t, nuDag\)/ matcht ook de DEFINITIE
  // 'function rondeStrook(t, nuDag)'. Dat is de definitie-vorm uit
  // docs/opvolging-module.md, en hij zou hier drie treffers geven waarvan er
  // maar twee aanroepen zijn. Daarom matcht dit op de bewaakte aanroep zelf.
  const bewaakt = [...bron.matchAll(/t\.reden === 'aanmelding' \? rondeStrook\(t, nuDag\) : ''/g)];
  assert.equal(bewaakt.length, 2,
    'zowel de rustige als de volledige kaart moet het strookje tekenen, achter een reden-check');
  assert.equal((bron.match(/function rondeStrook\(/g) || []).length, 1,
    'precies één definitie');
});
