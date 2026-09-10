// tests/klanten-v2-kv-laadvolgorde.test.js
//
// EEN VIEW DIE IETS AAN window.KV TOEVOEGT, MOET DAT HOUDEN.
//
// ── DE BREUK, GEMETEN OP PRODUCTIE OP 10 SEPTEMBER ──────────────────────
// In de live pagina (opvolging-v2.js?v=60, events-v2.js?v=57):
//
//   typeof window.KV.evKiesAnderEvent  →  'undefined'
//   Object.keys(window.KV)             →  ["$","esc","toast","authedFetch",
//                                          "authedJson","renderAvatar",
//                                          "initials","navigate","openCustomer"]
//
// events-v2.js zette `window.KV.evKiesAnderEvent` netjes. Daarna draaide
// klanten-v2.js — `<script type="module">`, dus ná élk gewoon view-script — en
// deed `window.KV = { $, esc, toast, … }`. Een NIEUW object. De functie was weg.
//
// Gevolg, en het tweede is een regressie op iets dat werkte:
//   1. Opvolging → 'Verplaatst naar een ander event' gaf de melding
//      'De eventlijst is hier niet beschikbaar'.
//   2. Eventmodule → ⋮ → 'Verplaatsen naar ander event' gooide een TypeError,
//      want __evAttMove was diezelfde functie gaan gebruiken. Vóór #1570 werkte
//      die knop gewoon.
//
// `navigate` en `openCustomer` overleefden het alleen doordat ze verderop in
// klanten-v2.js als LOSSE property worden gezet, ná de toewijzing.
//
// ── WAAROM DEZE TEST DE VOLGORDE NABOOTST ───────────────────────────────
// De bestaande tests laden events-v2.js op zichzelf. Dan bestaat de functie
// gewoon, en is alles groen — precies zoals het was toen dit naar productie
// ging. Wat je moet testen is de PAGINA: views eerst, klanten-v2.js als
// laatste, in de volgorde die index.html voorschrijft.
//
// De les erachter is breder dan deze ene functie: elk view-script dat iets aan
// KV hangt loopt hetzelfde risico. Daarom controleert de laatste test het
// patroon zelf, niet alleen de uitkomst.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'modules/klanten-v2/index.html');

/**
 * De pagina nabootsen: de twee views die het aangaat, daarna klanten-v2.js.
 *
 * klanten-v2.js is een ES-module met top-level imports; die kunnen we in een
 * vm-context niet uitvoeren. We knippen daarom precies het stuk eruit dat
 * window.KV zet — dat is wat deze test over gaat — en draaien dat met de
 * helpers als lokale variabelen. Wat er verder in dat bestand gebeurt doet
 * hier niet ter zake; het gaat om de TOEWIJZING en het MOMENT.
 */
/** Een element dat alles slikt wat een overlay ermee doet. */
function nepElement() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    appendChild: () => el, removeChild: () => el, remove() {}, focus() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => nepElement(), querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
    innerHTML: '', textContent: '', value: '',
  };
  return el;
}

function laadPagina() {
  const window = {
    DFO: { VIEWS: {}, render() {} },
    KV_V2: { helpers: {} },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
  };
  window.window = window;
  const ctx = createContext({
    window,
    console: { debug() {}, log() {}, warn() {}, error() {} },
    // Een DOM-dubbelganger die volledig genoeg is om de overlay te laten
    // bouwen. Niet om het venster te tonen — om te bewijzen dat de aanroep
    // dáár aankomt in plaats van om te vallen op een functie die niet bestaat.
    document: {
      getElementById: () => null,
      querySelector : () => null,
      createElement : () => nepElement(),
      head: nepElement(),
      body: nepElement(),
      addEventListener() {},
      removeEventListener() {},
    },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    Date, Math, Number, String, Boolean, Array, Object, JSON, RegExp, Intl, Set, Map, Promise,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  });

  // 1 · De views, in de volgorde van index.html.
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js'), 'utf8'), ctx);
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/events-v2.js'), 'utf8'), ctx);
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8'), ctx);

  // 2 · En dan klanten-v2.js — als laatste, want het is een module.
  //
  // Dat bestand heeft top-level imports en kan dus niet als geheel in een
  // vm-context draaien. We knippen precies de toewijzing aan window.KV eruit;
  // dát is wat deze test over gaat. De regex pakt allebei de vormen — de kale
  // `window.KV = { … };` en de `Object.assign(…)` — zodat de test niet omvalt
  // op zijn eigen knipwerk in plaats van op de fout die hij moet vinden.
  const shell = readFileSync(join(ROOT, 'modules/klanten-v2/klanten-v2.js'), 'utf8');
  const m = shell.match(/^window\.KV = (?:Object\.assign\(window\.KV \|\| \{\}, )?\{[\s\S]*?^\}\)?;$/m);
  assert.ok(m, 'klanten-v2.js hoort window.KV in één statement te zetten');
  runInContext(
    'const $ = () => null, esc = (s) => s, toast = () => {}, authedFetch = () => {},\n' +
    '      authedJson = () => {}, renderAvatar = () => {}, initials = () => {};\n' +
    m[0],
    ctx,
  );
  // De twee die verderop als losse property worden gezet.
  runInContext('window.KV.navigate = () => {}; window.KV.openCustomer = () => {};', ctx);

  return window;
}

// ═══════════════════════════════════════════════════════════════════════════
// DE VOLGORDE IN index.html — de aanname waar deze test op rust
// ═══════════════════════════════════════════════════════════════════════════

test('klanten-v2.js staat als module ná de view-scripts in index.html', () => {
  // Verandert dat ooit, dan is deze hele test-opzet niet meer waarheidsgetrouw
  // en hoort hij mee te veranderen.
  const html = readFileSync(INDEX, 'utf8');
  const iEvents  = html.indexOf('views/events-v2.js');
  const iOpv     = html.indexOf('views/opvolging-v2.js');
  const iShell   = html.indexOf('klanten-v2.js?v=');
  assert.ok(iEvents > 0 && iOpv > 0 && iShell > 0);
  assert.ok(iShell > iEvents, 'de shell staat ná events-v2.js');
  assert.ok(iShell > iOpv, 'de shell staat ná opvolging-v2.js');
  assert.match(html.slice(iShell - 60, iShell), /type="module"/,
    'en hij is een module, dus hij draait sowieso als laatste');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BREUK ZELF — dit is wat er op productie stond
// ═══════════════════════════════════════════════════════════════════════════

test('na de volledige pagina bestaat de keuzelijst nog', () => {
  // DE TEST DIE HET GEMIST HAD. Los ingeladen bestond de functie wel; het ging
  // pas stuk toen de shell erna draaide.
  const w = laadPagina();
  assert.equal(typeof w.__evKiesAnderEvent, 'function',
    'de globale hoort elke herschrijving van KV te overleven');
  assert.equal(typeof w.KV.evKiesAnderEvent, 'function',
    'en de KV-alias hoort er ook nog te staan');
});

test('de helpers uit de shell staan er ook — aanvullen is geen vervangen', () => {
  const w = laadPagina();
  for (const k of ['$', 'esc', 'toast', 'authedFetch', 'authedJson', 'renderAvatar', 'initials']) {
    assert.equal(typeof w.KV[k], 'function', k);
  }
  // De twee die als losse property gezet worden overleefden de breuk al, maar
  // horen er na de fix natuurlijk nog steeds te staan.
  assert.equal(typeof w.KV.navigate, 'function');
  assert.equal(typeof w.KV.openCustomer, 'function');
});

test('de eventmodule bereikt de keuzelijst — dit was de regressie', async () => {
  // __evAttMove werkte vóór #1570 en gooide erna een TypeError, want de functie
  // die hij was gaan gebruiken bestond na de shell niet meer.
  //
  // We vervangen de keuzelijst door een opnemer en kijken of de aanroep dáár
  // aankomt. Dat is precies wat er stukging; het venster zelf tekenen zou een
  // volledige DOM vragen en niets extra's bewijzen.
  const w = laadPagina();
  assert.equal(typeof w.__evAttMove, 'function');

  let geroepenMet = null;
  w.__evKiesAnderEvent = async (opties) => { geroepenMet = opties; return null; };
  await w.__evAttMove('att-1', 'ev-1');

  // Per veld, niet deepEqual: het object komt uit een andere vm-realm en heeft
  // daar een eigen Object-prototype.
  assert.ok(geroepenMet, 'de keuzelijst hoort aangeroepen te worden');
  assert.equal(geroepenMet.eventId, 'ev-1',
    'met het huidige event, zodat dat uit de lijst valt');
});

test('de aanmeldkaart in Opvolging doet niets zonder open kaart', async () => {
  // De handler leest _ui.modal. Zonder open kaart hoort hij te stoppen — en
  // vooral: hij mag niet omvallen. Dat het GOEDE pad de keuzelijst bereikt
  // staat vast in de bron-test hieronder; die weg openen vraagt de hele
  // kaart-render en bewijst niets extra's over deze breuk.
  const w = laadPagina();
  assert.equal(typeof w.__opvVerplaatsNaarEvent, 'function');

  let geroepen = false;
  w.__evKiesAnderEvent = async () => { geroepen = true; return null; };
  await w.__opvVerplaatsNaarEvent();
  assert.equal(geroepen, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET PATROON — zodat de volgende toevoeging aan KV niet weer sneuvelt
// ═══════════════════════════════════════════════════════════════════════════

test('klanten-v2.js VULT window.KV aan en vervangt hem niet', () => {
  const shell = readFileSync(join(ROOT, 'modules/klanten-v2/klanten-v2.js'), 'utf8');
  assert.match(shell, /window\.KV = Object\.assign\(window\.KV \|\| \{\}, \{/,
    'een kale toewijzing gooit weg wat een view net had toegevoegd');
});

test('de aanroepers gebruiken de globale, niet de KV-alias', () => {
  // De alias mag bestaan, maar wie ervan afhangt hangt weer af van de
  // laadvolgorde. Dat is precies wat hier misging.
  const ev  = readFileSync(join(ROOT, 'modules/klanten-v2/views/events-v2.js'), 'utf8');
  const opv = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');

  assert.match(ev,  /const target = await window\.__evKiesAnderEvent\(\{ eventId \}\)/);
  assert.match(opv, /await window\.__evKiesAnderEvent\(\{ eventId: ev\.event_id \|\| null/);
  assert.match(opv, /typeof window\.__evKiesAnderEvent !== 'function'/,
    'en de guard kijkt naar dezelfde naam als de aanroep');
});

test('de eventlijst wordt pas bij de klik opgehaald, niet bij het laden', () => {
  // Op laadmoment bestaat window.KV nog niet — dit script draait vóór de shell.
  // authedJson vasthouden bij het definiëren zou dus altijd undefined opleveren.
  const ev = readFileSync(join(ROOT, 'modules/klanten-v2/views/events-v2.js'), 'utf8');
  const i = ev.indexOf('window.__evKiesAnderEvent = async');
  assert.ok(i > 0);
  const blok = ev.slice(i, i + 900);
  assert.match(blok, /const haal = window\.KV && window\.KV\.authedJson;/);
  assert.match(blok, /typeof haal !== 'function'/, 'en dat wordt gecontroleerd, niet aangenomen');
});
