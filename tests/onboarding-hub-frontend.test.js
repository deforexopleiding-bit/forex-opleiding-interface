// tests/onboarding-hub-frontend.test.js
//
// WAT HIER MIS GING. De hersync-knop ging live en viel meteen om met
// `Cannot read properties of undefined (reading 'authedJson')`. Ik had
// `window.KV.authedJson(...)` geschreven — een idioom uit
// modules/klanten-v2, waar `window.KV` in klanten-v2.js wordt gezet. Die
// pagina laadt dat script niet, dus `window.KV` is daar `undefined`. De twee
// knoppen ernaast gebruiken `window.AgentShared.apiFetch` en werkten wél.
//
// Serverside tests vingen dit niet: het endpoint was in orde, de knop kwam er
// nooit. Vandaar deze twee soorten controle:
//
//   1. GLOBALS — elke `window.X.` die een pagina gebruikt moet geleverd
//      worden door een script dat die pagina ook echt laadt. Dit is de test
//      die de fout had gevangen vóór de deploy.
//   2. TELLERS — een mislukte ronde toont GEEN nullen. Vier keer nul plus een
//      foutregel ziet er identiek uit als een geslaagde droogloop op een lege
//      spiegel; wie alleen naar de cijfers keek dacht dat er niets te doen
//      was. Dat is het patroon dat we deze week aan het uitroeien zijn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const PAGINA = 'modules/onboarding-hub.html';
const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');

// ══════════════════════════════════════════════════════════════════════════
// 1) GLOBALS — gebruikt de pagina alleen wat ze ook laadt?
// ══════════════════════════════════════════════════════════════════════════

/** De <script src="..."> die deze pagina binnenhaalt, in volgorde. */
function geladenScripts(html) {
  const uit = [];
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const ruw = m[1];
    const src = ruw.split('?')[0];
    if (/^https?:/.test(src)) continue;      // externe bundels laten we met rust
    uit.push({ ruw, pad: src.replace(/^\//, ''), absoluut: src.startsWith('/') });
  }
  return uit;
}

/** Welke `window.X = ...` globals zet een bestand? */
function gezetteGlobals(bron) {
  const uit = new Set();
  const re = /window\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(bron))) uit.add(m[1]);
  return uit;
}

/** Welke `window.X.` globals LEEST een bestand? */
function gelezenGlobals(bron) {
  const uit = new Set();
  const re = /window\.([A-Za-z_$][\w$]*)\s*\./g;
  let m;
  while ((m = re.exec(bron))) uit.add(m[1]);
  return uit;
}

// Dingen die de browser zelf levert; die hoeft geen script te zetten.
const BROWSER_EIGEN = new Set([
  'location', 'localStorage', 'sessionStorage', 'document', 'history',
  'navigator', 'console', 'crypto', 'performance', 'screen', 'parent',
  'top', 'frames', 'indexedDB', 'matchMedia', 'getComputedStyle',
]);

test('GLOBALS — elke window.X die de pagina leest wordt ook door de pagina geladen', () => {
  const html = lees(PAGINA);

  const beschikbaar = new Set(BROWSER_EIGEN);
  // Wat de pagina zelf zet telt ook mee.
  for (const g of gezetteGlobals(html)) beschikbaar.add(g);
  // En wat de scripts zetten die ze binnenhaalt.
  const paginaMap = path.dirname(path.resolve(process.cwd(), PAGINA));
  for (const src of geladenScripts(html)) {
    // Zowel /modules/... (vanaf de wortel) als shared/... (naast de pagina).
    const kandidaten = [
      path.resolve(process.cwd(), src.absoluut ? src.pad : src.pad),
      path.resolve(paginaMap, src.pad),
    ];
    const p = kandidaten.find((k) => existsSync(k));
    assert.ok(p, 'onboarding-hub.html laadt ' + src.ruw + ', maar dat bestand '
      + 'bestaat niet — dan is elke global die het zou zetten er ook niet');
    for (const g of gezetteGlobals(readFileSync(p, 'utf8'))) beschikbaar.add(g);
  }

  const ontbreekt = [];
  for (const g of gelezenGlobals(html)) {
    if (!beschikbaar.has(g)) ontbreekt.push(g);
  }

  assert.deepEqual(ontbreekt, [],
    'de pagina leest window.' + ontbreekt.join(', window.')
    + ' maar laadt geen script dat dat zet — dat is precies de fout waarmee '
    + 'de hersync-knop omviel (window.KV bestaat, maar in modules/klanten-v2)');
});

test('GLOBALS — de hersync-knop gebruikt dezelfde weg als de knoppen ernaast', () => {
  const html = lees(PAGINA);
  // Alle drie de knoppen op dit tabblad horen via AgentShared.apiFetch te gaan.
  for (const endpoint of ['/api/onboarding-lms-backfill-run',
    '/api/onboarding-spiegel-sync-run']) {
    const i = html.indexOf(endpoint);
    assert.ok(i > -1, endpoint + ' wordt nergens aangeroepen');
    const ervoor = html.slice(Math.max(0, i - 200), i);
    assert.match(ervoor, /AgentShared\.apiFetch/,
      endpoint + ' wordt niet via AgentShared.apiFetch aangeroepen');
  }
});

test('GLOBALS — apiFetch levert een Response, dus de body moet er nog uit', () => {
  const html = lees(PAGINA);
  const i = html.indexOf('/api/onboarding-spiegel-sync-run');
  const erna = html.slice(i, i + 400);
  assert.match(erna, /\.json\(\)/,
    'de uitkomst van apiFetch wordt als geparseerde JSON behandeld; '
    + 'dat was de tweede helft van dezelfde fout');
});

// ══════════════════════════════════════════════════════════════════════════
// 2) TELLERS — een mislukte ronde toont geen nullen
// ══════════════════════════════════════════════════════════════════════════

/**
 * Haal één functie uit het scriptblok en maak 'm aanroepbaar. De functies
 * staan in een IIFE en zijn dus privé; we knippen ze eruit op accolade-balans
 * zodat we ze ECHT kunnen draaien in plaats van hun broncode te bekijken.
 */
function pakFunctie(html, naam) {
  const start = html.indexOf('function ' + naam + '(');
  assert.ok(start > -1, 'functie ' + naam + ' niet gevonden');
  let diepte = 0, i = html.indexOf('{', start);
  const open = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') diepte++;
    else if (html[i] === '}') { diepte--; if (diepte === 0) break; }
  }
  assert.ok(i < html.length, 'accolades van ' + naam + ' lopen niet rond');
  const body = html.slice(open + 1, i);
  const args = html.slice(html.indexOf('(', start) + 1, html.indexOf(')', start));

  // Minimale omgeving: de functie schrijft in innerHTML en gebruikt esc.
  const host = { innerHTML: '' };
  const document = { getElementById: () => host };
  const window = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'args_' + naam,
    'return (function (' + args + ') {' + body + '});')(document, window);
  return { fn, host };
}

function render(naam, data, tweede) {
  const { fn, host } = pakFunctie(lees(PAGINA), naam);
  fn(data, tweede);
  return host.innerHTML;
}

test('TELLERS — hersync: een mislukte ronde toont streepjes, geen nullen', () => {
  // Exact het geval van productie: transportfout, dus niets geteld.
  const html = render('spiegelRender',
    { ok: false, error: "Cannot read properties of undefined (reading 'authedJson')" },
    true);
  assert.ok(!/<strong>0<\/strong>/.test(html),
    'een mislukte ronde toont nog steeds een 0 — dat is niet te onderscheiden '
    + 'van een geslaagde droogloop op een lege spiegel');
  assert.match(html, /—/, 'er hoort een streepje te staan waar niets gemeten is');
  assert.match(html, /Niet uitgevoerd/, 'de kop hoort te zeggen dat er niets geteld is');
  assert.match(html, /authedJson/, 'de foutmelding zelf hoort zichtbaar te blijven');
});

test('TELLERS — hersync: een GESLAAGDE ronde met echte nullen toont wél 0', () => {
  // De andere kant van dezelfde regel: nul is een geldige meting.
  const html = render('spiegelRender',
    { ok: true, verwacht: 0, aanwezig: 0, geschreven: 0, afwezig: 0,
      overtollig_verwijderd: 0, mislukt: 0, errors: [] },
    false);
  assert.match(html, /<strong>0<\/strong>/,
    'een gemeten nul hoort gewoon als 0 te verschijnen');
  assert.ok(!/Niet uitgevoerd/.test(html));
});

test('TELLERS — inhaalslag: dezelfde regel geldt daar ook', () => {
  const html = render('lmsRender', { ok: false, error: 'databank weg' }, false);
  assert.ok(!/<strong>0<\/strong>/.test(html),
    'de inhaalslag toont bij een mislukking nog nullen');
  assert.match(html, /—/);
});

test('TELLERS — hersync toont de reden per onboarding, niet alleen een totaal', () => {
  const html = render('spiegelRender',
    { ok: true, verwacht: 2, aanwezig: 0, geschreven: 1, mislukt: 1,
      errors: [{ onboarding_id: 'ob-1', error: 'tabel bestaat niet' }] },
    false);
  assert.match(html, /Waarom het misging/);
  assert.match(html, /ob-1/);
  assert.match(html, /tabel bestaat niet/);
});
