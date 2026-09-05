// tests/opvolging-call-modal.test.js
//
// De vier uitkomsten van een zoomcall — klant geworden, wil nog beslissen,
// no-show, geen interesse — hebben vanaf het begin niet gewerkt. De
// Afronden-knop bij 'Calls van vandaag' deed niets.
//
// De oorzaak stond in de eerste vier regels van modalHtml():
//
//     const m = _ui.modal; if (!m) return '';
//     const t = zoekTaak(m.taakId); if (!t) return '';
//
// __opvCallAfrond zet { soort: 'call-afrond', callIndex: i } — zonder taakId,
// want een call in de agenda hoeft nog helemaal geen taak te hebben. Dat is
// niet uitzonderlijk maar juist het normale geval bij een eerste gesprek.
// zoekTaak(undefined) gaf null, de functie stopte, en de takken eronder werden
// nooit bereikt.
//
// Geen console-fout, geen venster, geen spoor. Precies de vorm van de
// scrim-bug: niets gaat stuk, er komt geen melding, en het werkt niet.
//
// Daarom draait deze test het echte viewbestand, opent de vensters via dezelfde
// handlers die de knoppen aanroepen, en kijkt of er iets uitkomt. Een test die
// alleen de bronregels leest zou deze fout niet gevonden hebben — de code zag
// er correct uit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

function laadView() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set,
  });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvModalHaak, 'de view hoort __opvModalHaak te zetten');
  return window;
}

const CALL = { naam: 'Jan Peeters', telefoon: '+32470123456', tijd: '14:00', start: '2026-09-06T12:00:00Z' };

/** Verse view per test: _ui.modal is gedeelde staat en mag niet doorlekken. */
function opstelling({ calls = [CALL], taken = [] } = {}) {
  const w = laadView();
  w.__opvModalHaak.zetCalls(calls);
  w.__opvModalHaak.zetTaken(taken);
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════
// DE KNOP DOET WEER IETS
// ═══════════════════════════════════════════════════════════════════════════

test('Afronden opent een venster, ook zonder taak achter de call', () => {
  const w = opstelling();
  w.__opvCallAfrond(0);
  assert.deepEqual(w.__opvModalHaak.huidigeModal().soort, 'call-afrond');
  const h = w.__opvModalHaak.modalHtml();
  assert.notEqual(h, '', 'dit was een lege string — de knop deed niets');
  assert.match(h, /Call met Jan Peeters afronden/);
});

test('de vier uitkomsten staan erin', () => {
  const w = opstelling();
  w.__opvCallAfrond(0);
  const h = w.__opvModalHaak.modalHtml();
  for (const u of ['klant_geworden', 'wil_nog_beslissen', 'no_show', 'geen_interesse']) {
    assert.ok(h.includes("__opvCallUitkomst('" + u + "')"), u + ' hoort een knop te hebben');
  }
});

test('elke uitkomst opent zijn eigen vervolgvenster', () => {
  const verwacht = {
    klant_geworden:    /Klant geworden/,
    wil_nog_beslissen: /Wil nog beslissen/,
    no_show:           /No-show/,
    geen_interesse:    /Geen interesse/,
  };
  for (const [u, re] of Object.entries(verwacht)) {
    const w = opstelling();
    w.__opvCallAfrond(0);
    w.__opvCallUitkomst(u);
    const h = w.__opvModalHaak.modalHtml();
    assert.notEqual(h, '', u + ' gaf een leeg venster');
    assert.match(h, re);
    assert.match(h, /Jan Peeters/, u + ' hoort te zeggen over wie het gaat');
  }
});

test('het venster draagt de scrim-klasse waarmee hij zichtbaar is', () => {
  // De andere helft van dezelfde les: zonder `on` staat het venster er wel maar
  // is het onzichtbaar. Twee stille fouten in één keten is er één te veel.
  const w = opstelling();
  w.__opvCallAfrond(0);
  assert.match(w.__opvModalHaak.modalHtml(), /class="scrim on"/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TAAK-GUARD GELDT NOG WEL WAAR HIJ HOORT
// ═══════════════════════════════════════════════════════════════════════════

test('een venster dat een taak nodig heeft blijft leeg zonder die taak', () => {
  const w = opstelling({ taken: [] });
  w.__opvWatNu('bestaat-niet');
  assert.equal(w.__opvModalHaak.modalHtml(), '',
    'de guard hoort te blijven gelden voor de takken die echt een taak lezen');
});

test('met de taak erbij opent datzelfde venster wel', () => {
  const taak = { id: 'tk-1', naam: 'Jan Peeters', reden: 'no_show_call', due: '2026-09-06', pogingen: [] };
  const w = opstelling({ taken: [taak] });
  w.__opvWatNu('tk-1');
  assert.match(w.__opvModalHaak.modalHtml(), /Wat nu met Jan Peeters/);
});

test('een call-index die niet bestaat geeft netjes niets', () => {
  const w = opstelling({ calls: [] });
  w.__opvCallAfrond(3);
  assert.equal(w.__opvModalHaak.modalHtml(), '', 'geen venster, en ook geen crash');
});

// ═══════════════════════════════════════════════════════════════════════════
// EN GEEN VIJFDE SOORT DIE STIL SNEUVELT
// ═══════════════════════════════════════════════════════════════════════════

test('elk venster dat zonder taakId geopend wordt staat in MODAL_ZONDER_TAAK', () => {
  // Dit is de eigenlijke bewaking. Zet iemand later een nieuw venster op zonder
  // taakId, dan sneuvelt dat op precies dezelfde manier — stil. Deze test leest
  // alle plekken waar een venster geopend wordt en vergelijkt ze met de lijst.
  const bron = readFileSync(VIEW, 'utf8');
  const w = laadView();
  const uitgezonderd = new Set(Array.from(w.__opvModalHaak.MODAL_ZONDER_TAAK));

  const opens = bron.match(/_ui\.modal = \{[^}]*\}/g) || [];
  assert.ok(opens.length >= 5, 'de vensters horen gevonden te worden, gevonden: ' + opens.length);

  for (const open of opens) {
    const soort = (open.match(/soort:\s*'([^']+)'/) || [])[1];
    if (!soort) continue;                       // { soort: welke, ... } — dynamisch, zie hieronder
    const heeftTaak = /taakId\s*:/.test(open);
    if (!heeftTaak) {
      assert.ok(uitgezonderd.has(soort),
        "venster '" + soort + "' wordt zonder taakId geopend maar staat niet in MODAL_ZONDER_TAAK — " +
        'die valt straks stil op de taak-guard in modalHtml()');
    }
  }
});

test('de dynamische opener geeft het taakId door', () => {
  // __opvActie opent kiesdag/archiveer/inplannen met een variabele soort; die
  // kan de test hierboven niet lezen, dus hier apart: hij hoort taakId mee te
  // geven, anders geldt hetzelfde probleem voor drie vensters tegelijk.
  const bron = readFileSync(VIEW, 'utf8');
  assert.match(bron, /_ui\.modal = \{ soort: welke, taakId: m\.taakId \}/);
});

test('modalHtml handelt de taakloze vensters af vóór de guard', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function modalHtml(');
  const kop = bron.slice(i, i + 500);
  const guard = kop.indexOf('zoekTaak(m.taakId)');
  const vroeg = kop.indexOf('MODAL_ZONDER_TAAK.has(m.soort)');
  assert.ok(vroeg > 0 && guard > 0, 'beide horen in de kop van modalHtml te staan');
  assert.ok(vroeg < guard, 'de taakloze vensters horen vóór de taak-guard afgehandeld te worden');
});
