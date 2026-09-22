// tests/iris-scherm-volledig.test.js
//
// DRIE TABBLADEN DIE OMVIELEN ZODRA JE EROP KLIKTE.
//
// modules/iris/iris.js riep `opdrachtenTab()`, `belrijTab()` en `logboekTab()`
// aan. Geen van drieën bestond. Het bestand is syntactisch in orde — een
// aanroep van een functie die er niet is, is pas een fout op het moment dat
// hij uitgevoerd wordt. Dus: `node --check` zweeg, de bundel laadde, het
// scherm tekende, en de fout wachtte tot iemand op Opdrachten klikte.
//
// Erger nog: `logboekTab()` stond in de `else`-tak van de tabkeuze, en die
// vangt élke onbekende tab. Een verkeerde waarde in `S.tab` gaf dus niet een
// leeg scherm maar een uitzondering.
//
// Dit is het soort fout dat geen enkele test in dit repo zou vangen, omdat we
// het scherm niet in een browser draaien. Een statische controle kan het wél:
// loop alle aanroepen na en eis dat elke naam ergens in het bestand
// gedefinieerd staat. Dat is geen typecontrole, maar het vangt precies deze
// klasse — een renderer die nooit geschreven is, of eentje die bij een
// hernoeming achterbleef.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Namen die van buiten komen: taal, browser, en de globals die Iris gebruikt. */
const VAN_BUITEN = new Set([
  // sleutelwoorden die vóór een haakje staan
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await',
  'function', 'async', 'else', 'do', 'in', 'of', 'delete', 'void', 'yield',
  // ingebouwd
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date',
  'Promise', 'Set', 'Map', 'Error', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
  // browser
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch',
  'queueMicrotask', 'encodeURIComponent', 'decodeURIComponent', 'Blob',
  'FormData', 'URLSearchParams', 'console', 'MediaRecorder', 'SpeechRecognition',
  'webkitSpeechRecognition', 'requestAnimationFrame',
  // stukjes CSS die toevallig op een aanroep lijken
  'minmax', 'calc', 'var', 'rgba', 'translateY', 'scale',
]);

/**
 * Elke naam die in dit bestand als `naam(` wordt aangeroepen, zonder punt
 * ervoor, en niet van buiten komt.
 */
function ongedefinieerdeAanroepen(pad) {
  const bron = readFileSync(join(ROOT, pad), 'utf8');
  const code = bron.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const gedefinieerd = new Set();
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) gedefinieerd.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) gedefinieerd.add(m[1]);
  // Parameters van pijlfuncties en gewone functies: die worden ook aangeroepen
  // (bv. een meegegeven opmaak-functie), en zijn hier geen vondst.
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const stuk of m[1].split(',')) {
      const naam = stuk.trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(naam)) gedefinieerd.add(naam);
    }
  }
  for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) {
    for (const stuk of m[1].split(',')) {
      const naam = stuk.trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(naam)) gedefinieerd.add(naam);
    }
  }

  // Woorden die vóór een aanroep mogen staan. Alles ertussen is Nederlandse
  // tekst in een tooltip ("Iris weet het niet zeker (…)"), en dat is geen
  // aanroep. Zonder deze regel meldt de controle zinnen als vondst en gaat
  // niemand er nog naar kijken — een controle die krijst is er geen.
  const WOORD_ERVOOR = new Set([
    'return', 'await', 'new', 'typeof', 'else', 'do', 'of', 'in', 'case',
    'yield', 'void', 'delete', 'instanceof',
  ]);

  const mist = new Set();
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(([^)]{0,3})\)?/g)) {
    const naam = m[1];
    // "poging(en)" en "bericht(en)" zijn Nederlands, geen aanroep. Er bestaat
    // geen functie die je met een kale `en` aanroept, dus dit kost niets.
    if (m[2] === 'en' || m[2] === 's') continue;
    if (gedefinieerd.has(naam) || VAN_BUITEN.has(naam)) continue;
    if (naam.startsWith('__iris')) continue;     // staan op window, via onclick-tekst
    const ervoor = code.slice(0, m.index);
    if (/[.\w$]$/.test(ervoor)) continue;        // eigenschap (x.foo) of deel van een naam
    const laatsteWoord = ervoor.match(/([A-Za-z_$][\w$]*)\s*$/);
    if (laatsteWoord && !WOORD_ERVOOR.has(laatsteWoord[1])) continue;
    mist.add(naam);
  }
  return [...mist];
}

test('iris.js roept geen functie aan die niet bestaat', () => {
  const mist = ongedefinieerdeAanroepen('modules/iris/iris.js');
  assert.deepEqual(mist, [],
    'aangeroepen maar nergens gedefinieerd — dit valt pas om als iemand erop klikt:\n  ' + mist.join('\n  '));
});

test('elk tabblad uit TABS heeft een renderer', () => {
  // De tabbalk en de tekenkeuze zijn twee lijsten die uit elkaar kunnen lopen.
  // Een knop die naar een tab wijst die nergens getekend wordt, geeft een leeg
  // scherm of erger — en dat merk je alleen door te klikken.
  const bron = readFileSync(join(ROOT, 'modules/iris/iris.js'), 'utf8');
  const tabsBlok = bron.slice(bron.indexOf('const TABS = ['), bron.indexOf('const FILTER_LABELS'));
  const tabs = [...tabsBlok.matchAll(/\['([a-z_]+)',/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 6, 'de TABS-lijst werd niet gevonden');

  const keuze = bron.slice(bron.indexOf('function irisView()'));
  for (const t of tabs) {
    if (t === 'post' || t === 'dossiers') continue;   // die tekenen kolommen, geen eigen tab-functie
    const verwacht = t + 'Tab(';
    assert.ok(keuze.includes(verwacht) || bron.includes(verwacht),
      `tab "${t}" staat in de tabbalk maar wordt nergens getekend`);
  }
});

test('elk tabblad met een eigen lijst haalt die ook op', () => {
  // Een tabblad dat nooit ophaalt blijft leeg zonder dat er iets misgaat, en
  // dat is precies het soort stilte waar je een uur naar zoekt.
  const bron = readFileSync(join(ROOT, 'modules/iris/iris.js'), 'utf8');
  const wissel = bron.slice(bron.indexOf('window.__irisTab ='));
  const body = wissel.slice(0, wissel.indexOf('\n  };'));
  for (const [tab, haler] of [
    ['instellingen', 'haalInstellingen'],
    ['opdrachten', 'haalOpdrachten'],
    ['belrij', 'haalBelrij'],
    ['logboek', 'haalLogboek'],
  ]) {
    assert.ok(body.includes(`'${tab}'`) && body.includes(haler + '()'),
      `tabwissel naar "${tab}" haalt niets op`);
  }
});
