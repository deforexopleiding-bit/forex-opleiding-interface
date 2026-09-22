// tests/iris-tabbladen-renderen.test.js
//
// ELK TABBLAD ÉÉN KEER ECHT TEKENEN.
//
// Dit is de derde keer dat hetzelfde soort fout op het scherm van Maxim landt
// in plaats van in de testronde:
//
//   1. `opdrachtenTab`, `belrijTab` en `logboekTab` bestonden niet.
//   2. `__irisAutonomie` bestond niet.
//   3. `haalDroogtest` bestond niet — en hier ging het mis met mijn eigen
//      controle: die zocht naar `naam(`, en de aanroep stond als
//      `queueMicrotask(haalDroogtest)`. Een verwijzing zonder haakjes. De
//      controle keek dus precies langs het geval heen dat hij moest vangen.
//
// Een statische controle blijft raden hoe code eruitziet. Dit bestand raadt
// niet: het draait iris.js in een nagebootst venster en vraagt élk tabblad om
// zichzelf te tekenen. Wat er dan stuk is, valt hier om — of het nu een
// ontbrekende functie is, een verkeerde eigenschap of een tikfout in een
// tekenreeks.
//
// Geen browser nodig: het scherm levert tekenreeksen op en raakt het document
// alleen via helpers die altijd controleren of het element bestaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Een element dat alles slikt en nergens over struikelt. */
function maakEl() {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, display: '' },
    innerHTML: '', outerHTML: '', textContent: '', value: '', scrollTop: 0,
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild() {}, remove() {}, focus() {}, select() {},
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [],
  };
  el.querySelector = () => maakEl();
  return el;
}

/**
 * Draai iris.js en geef het venster terug.
 *
 * De ophaalfuncties lopen via KV.authedJson; die geeft hier een belofte terug
 * die nooit iets oplevert. Zo blijft elk tabblad in zijn laadtoestand staan —
 * precies de toestand waarin een scherm het vaakst omvalt, want dan is er nog
 * niets om te tonen.
 */
function laadIris() {
  const doc = {
    getElementById: () => maakEl(),
    querySelector: () => maakEl(),
    querySelectorAll: () => [],
    createElement: () => maakEl(),
    addEventListener() {}, removeEventListener() {},
    documentElement: maakEl(),
    body: maakEl(),
    hidden: false,
  };
  const win = {
    document: doc,
    location: { search: '', hash: '' },
    innerWidth: 1400,
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };

  // De schil, zoals iris.js 'em verwacht.
  const icons = readFileSync(join(ROOT, 'modules/shared/design-system/icons.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', icons)(win, undefined);
  win.DFO.VIEWS = {};
  win.DFO.render = () => {};

  win.KV = {
    esc: (s) => String(s == null ? '' : s),
    toast: () => {},
    // Nooit oplossen: elk tabblad blijft in de laadtoestand.
    authedJson: () => new Promise(() => {}),
  };
  win.KV_V2 = { helpers: {} };      // iris.js keert stil terug zonder deze
  win.KV_V2_ADD = () => {};
  win.AuthShared = { getAccessToken: () => Promise.resolve(null) };

  const bron = readFileSync(join(ROOT, 'modules/iris/iris.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'queueMicrotask', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', bron)(
    win, doc,
    (fn) => { try { fn(); } catch (e) { win.__microtaakFout = e; } },  // METEEN uitvoeren
    (fn) => 0, () => {}, () => 0, () => {}, (fn) => fn(), () => new Promise(() => {}),
  );
  return win;
}

/** De tabbladen zoals de tabbalk ze aanbiedt. */
function tabbladen() {
  const bron = readFileSync(join(ROOT, 'modules/iris/iris.js'), 'utf8');
  const blok = bron.slice(bron.indexOf('const TABS = ['), bron.indexOf('const FILTER_LABELS'));
  return [...blok.matchAll(/\['([a-z_]+)',/g)].map((m) => m[1]);
}

test('de weergave staat geregistreerd na het laden', () => {
  const win = laadIris();
  assert.equal(typeof win.DFO.VIEWS['iris/'], 'function');
});

test('elk tabblad tekent zichzelf zonder om te vallen', () => {
  const tabs = tabbladen();
  assert.ok(tabs.length >= 6, 'de tabbalk werd niet gevonden');

  for (const tab of tabs) {
    const win = laadIris();     // per tabblad een verse staat
    win.__irisTab(tab);
    const html = win.DFO.VIEWS['iris/']();
    assert.equal(typeof html, 'string', `tab "${tab}" gaf geen opmaak terug`);
    assert.ok(html.length > 0, `tab "${tab}" gaf een lege pagina`);
    // queueMicrotask draait hier meteen; een fout daarin (bijvoorbeeld een
    // ophaalfunctie die niet bestaat) wordt onthouden in plaats van stil
    // verdwenen te zijn.
    assert.equal(win.__microtaakFout, undefined,
      `tab "${tab}": fout in een taak die bij het tekenen wordt ingepland — ${win.__microtaakFout?.message}`);
  }
});

test('een tabblad met een gekozen gesprek tekent ook', () => {
  // De Post met een keuze loopt door draadKolom en dossierKolom, en die
  // blijven in de statische controle onaangeraakt.
  const win = laadIris();
  win.__irisTab('post');
  win.__irisKies('11111111-2222-3333-4444-555555555555');
  const html = win.DFO.VIEWS['iris/']();
  assert.match(html, /iris-post/);
  assert.equal(win.__microtaakFout, undefined);
});

test('de knoppen in de opmaak bestaan allemaal op window', () => {
  // Zelfde controle als eerder, maar nu tegen het écht geladen venster in
  // plaats van tegen de tekst van het bestand.
  const win = laadIris();
  const bron = readFileSync(join(ROOT, 'modules/iris/iris.js'), 'utf8');
  const gebruikt = new Set([...bron.matchAll(/on(?:click|input|change)="(__iris[A-Za-z]*)\(/g)].map((m) => m[1]));
  const mist = [...gebruikt].filter((n) => typeof win[n] !== 'function');
  assert.deepEqual(mist, [], 'knop in de opmaak zonder functie op window');
});
