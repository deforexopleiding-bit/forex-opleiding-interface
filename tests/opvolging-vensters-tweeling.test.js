// tests/opvolging-vensters-tweeling.test.js
//
// api/_lib/opvolging-vensters.js EN de kopie in
// modules/klanten-v2/views/opvolging-v2.js moeten hetzelfde antwoord geven.
//
// WAAROM ER TWEE KOPIEËN ZIJN
// De view is een klassiek browser-script en geen ES-module; die kan niet uit
// api/_lib importeren. Het dagrapport rekent server-side en heeft dezelfde twee
// vensters nodig. Eén van de twee weglaten kan dus niet, en ze los laten leven
// betekent dat het scherm en het rapport op een dag verschillende dingen over
// dezelfde dinsdag gaan zeggen — precies het soort verschil dat niemand ziet
// tot Maxim en Dave er ruzie over krijgen.
//
// Dus: allebei draaien op dezelfde invoer, en de uitkomsten vergelijken.
// Zelfde patroon als tests/whatsapp-systeemtypes.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as lib from '../api/_lib/opvolging-vensters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

function laadView() {
  const window = {
    DFO   : { VIEWS: {}, render() {} },
    KV_V2 : { helpers: {} },
    KV    : { authedJson: async () => ({}) },
    addEventListener() {},
    setInterval() { return 0; },
    clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window,
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console, queueMicrotask: () => {},
    setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Intl, Set, Array, Object,
  });
  runInContext(readFileSync(BADGE_HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  const h = window.__opvVensterHelpers;
  assert.ok(h, 'de view hoort __opvVensterHelpers te zetten');
  return h;
}

const view = laadView();

/** De sandbox is een eigen realm; platslaan maakt deepEqual weer eerlijk. */
const plat = (o) => JSON.parse(JSON.stringify(o));

const DAG = '2026-09-01';
const op = (uur, min) => `${DAG}T${String(uur - 2).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`;
// −2 want Amsterdam staat begin september op UTC+2. De helpers rekenen in
// Amsterdamse tijd, dus dit is 'uur' lokaal.

// Twaalf gevallen die samen elke tak van beide functies raken.
const GEVALLEN = [
  ['niets gebeurd', []],
  ['spraak op tijd, niet nagebeld', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 30) },
  ]],
  ['spraak precies om 09:00 is te laat', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(9, 0) },
  ]],
  ['spraak om 08:59 haalt het net', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 59) },
  ]],
  ['tweede spraakbericht om 11:00 repareert de gemiste ochtend niet', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(9, 30) },
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(11, 0) },
  ]],
  ['spraak op tijd + nabellen in het venster', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 15) },
    { soort: 'call', richting: 'uit', tijdstip: op(12, 30) },
  ]],
  ['nabellen om 11:00 is te vroeg en dus te laat', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 15) },
    { soort: 'call', richting: 'uit', tijdstip: op(11, 0) },
  ]],
  ['nabellen om 13:00 valt net buiten', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 15) },
    { soort: 'call', richting: 'uit', tijdstip: op(13, 0) },
  ]],
  ['wie antwoordde hoeft niet nagebeld', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 15) },
    { soort: 'whatsapp', richting: 'in', tijdstip: op(9, 10) },
  ]],
  ['een INKOMEND spraakbericht is geen verstuurd spraakbericht', [
    { soort: 'spraakbericht', richting: 'in', tijdstip: op(8, 15) },
  ]],
  ['een rij zonder richting telt als uitgaand', [
    { soort: 'spraakbericht', tijdstip: op(8, 15) },
  ]],
  ['pogingen van een andere dag tellen niet mee', [
    { soort: 'spraakbericht', richting: 'uit', tijdstip: '2026-08-31T06:30:00Z' },
    { soort: 'call', richting: 'uit', tijdstip: '2026-08-31T10:30:00Z' },
  ]],
];

for (const [naam, pogingen] of GEVALLEN) {
  test(`tweeling · spraak · ${naam}`, () => {
    assert.deepEqual(plat(lib.beoordeelSpraak(pogingen, DAG)), plat(view.beoordeelSpraak(pogingen, DAG)));
  });
  test(`tweeling · nabellen · ${naam}`, () => {
    assert.deepEqual(plat(lib.beoordeelNabel(pogingen, DAG)), plat(view.beoordeelNabel(pogingen, DAG)));
  });
}

test('tweeling · telVensters over alle gevallen tegelijk', () => {
  const taken = GEVALLEN.map(([, pogingen], i) => ({ id: 't' + i, pogingen }));
  assert.deepEqual(plat(lib.telVensters(taken, DAG)), plat(view.telVensters(taken, DAG)));
});

test('tweeling · de drie klok-constanten zijn gelijk', () => {
  assert.equal(lib.SPRAAK_DEADLINE_UUR, view.SPRAAK_DEADLINE_UUR);
  assert.equal(lib.NABEL_VAN_UUR, view.NABEL_VAN_UUR);
  assert.equal(lib.NABEL_TOT_UUR, view.NABEL_TOT_UUR);
});

test('tweeling · de archiveerdrempel in de view is dezelfde als in de lib', () => {
  // De view leest ARCHIEF_MIN_DAGEN / ARCHIEF_MIN_WA uit eigen constanten.
  // Lopen die uiteen met de lib, dan zegt het scherm 'ok' waar het rapport
  // 'te weinig' zegt over exact dezelfde lead.
  const bron = readFileSync(VIEW, 'utf8');
  const dagen = bron.match(/const ARCHIEF_MIN_DAGEN = (\d+)/);
  const wa    = bron.match(/const ARCHIEF_MIN_WA = (\d+)/);
  assert.ok(dagen && wa, 'de twee drempels horen in de view te staan');
  assert.equal(Number(dagen[1]), lib.ARCHIEF_MIN_DAGEN);
  assert.equal(Number(wa[1]), lib.ARCHIEF_MIN_WA);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE UITKOMSTEN VAN beoordeelMoeite
// ═══════════════════════════════════════════════════════════════════════════

test('genoeg moeite is drie dagen bellen plus een WhatsApp', () => {
  assert.equal(lib.beoordeelMoeite({ bel_dagen: 3, wa_totaal: 1 }).staat, 'genoeg');
});

test('drie keer bellen op één dag is niet genoeg', () => {
  // De drempel gaat over VERSCHILLENDE dagen. Drie keer op één middag is
  // doorzetten, niet volhouden.
  assert.equal(lib.beoordeelMoeite({ bel_dagen: 1, wa_totaal: 1 }).staat, 'te_weinig');
});

test('drie dagen bellen zonder WhatsApp is niet genoeg', () => {
  assert.equal(lib.beoordeelMoeite({ bel_dagen: 3, wa_totaal: 0 }).staat, 'te_weinig');
});

test('wie tijdens de call zelf nee zei krijgt geen rood, ook met nul pogingen', () => {
  // Dit is geen vrijstelling maar een andere soort kaart. Rood zou een verwijt
  // zijn voor iets waar niets aan te doen viel.
  const m = lib.beoordeelMoeite({ bel_dagen: 0, wa_totaal: 0, reden_code: 'zoom_geen_interesse' });
  assert.equal(m.staat, 'nvt');
  assert.match(m.reden, /zelf nee/);
});

test('een andere reden_code krijgt gewoon het oordeel', () => {
  // Zonder deze test zou een uitzondering die álles vrijstelt er groen door
  // komen, en dan bewaakt de vorige test niets.
  assert.equal(lib.beoordeelMoeite({ bel_dagen: 0, wa_totaal: 0, reden_code: 'no_show' }).staat, 'te_weinig');
});
