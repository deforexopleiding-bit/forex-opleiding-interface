// tests/opvolging-verplaats-polish.test.js
//
// DRIE DINGEN DIE UIT DE PRODUCTIETEST VAN 10 SEPTEMBER KWAMEN.
//
// De verplaatsing zelf werkte (gemeten: oude rij op switched_to_other_event,
// nieuwe rij aangemeld + bevestigd, precies één nieuwe kaart). Wat er naast
// stond klopte niet:
//
//  1. IS_TEST GING VERLOREN. De insertRow in _lib/event-attendee-move-core.js
//     nam de proefvlag van de bronrij niet over, dus werd een verplaatste
//     testdeelnemer een ECHTE aanmelding op het doel-event (gemeten:
//     is_test=false). Hij telde daarna mee in de capaciteit, in de dagbeelden
//     en in het rapport, en de automations gingen op hem af. Een test die
//     zichzelf in productie verandert is het ergste soort test.
//
//  2. DE KEUZELIJST TOONDE VOORBIJE EVENTS. Alles met status draft of
//     published, dus ook het event van 9 september — dat stond zelfs bovenaan.
//     Iemand daarheen verplaatsen levert een aanmelding op voor een middag die
//     niet meer komt: uit elk dagbeeld verdwenen, geen belronde meer, en
//     niemand die het merkt tot de lead zelf belt.
//
//  3. GEEN TEKEN VAN LEVEN. Na 'Verplaatsen' bleef het Wat-nu-venster ±5
//     seconden onveranderd staan. Dave zag niets gebeuren, en een tweede klik
//     zou een tweede verplaatsing sturen — dus een tweede deelnemer op het
//     doel-event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_EV  = join(ROOT, 'modules/klanten-v2/views/events-v2.js');
const VIEW_OPV = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE    = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

/** De code zonder commentaar — een test hoort naar wat er DRAAIT te kijken. */
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

function laadViews() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}), toast() {} },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      createElement: () => ({ style: {}, appendChild() {} }),
      head: { appendChild() {} }, addEventListener() {},
    },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    Date, Math, Number, String, Boolean, Array, Object, JSON, RegExp, Intl, Set, Map, Promise,
  });
  runInContext(readFileSync(BADGE, 'utf8'), ctx);
  runInContext(readFileSync(VIEW_EV, 'utf8'), ctx);
  runInContext(readFileSync(VIEW_OPV, 'utf8'), ctx);
  return window;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · EEN PROEFRIJ BLIJFT EEN PROEFRIJ
// ═══════════════════════════════════════════════════════════════════════════

test('de nieuwe rij neemt is_test over van de bron', () => {
  const kern = readFileSync(join(ROOT, 'api/_lib/event-attendee-move-core.js'), 'utf8');

  // In de SELECT van de bronrij, anders is source.is_test altijd undefined.
  const iSel = kern.indexOf("customer_id, deal_id, assessment_response_id, source, automation_enabled");
  assert.ok(iSel > 0);
  assert.match(kern.slice(iSel, iSel + 120), /is_test/, 'de bronrij moet de vlag meelezen');

  // En in de INSERT.
  const iIns = kern.indexOf('const insertRow = {');
  assert.ok(iIns > 0);
  const blok = kern.slice(iIns, kern.indexOf('};', iIns));
  assert.match(blok, /is_test:\s*source\.is_test === true/,
    '=== true, want een ontbrekende kolom is geen proefrij');
});

test('de teruggegeven rij draagt is_test, zodat de aanroeper het weet', () => {
  // Zonder dit kan verplaatsNaarEvent de vlag niet doorgeven aan de nieuwe
  // opvolgkaart en staat een testdeelnemer alsnog als echt werk in de lijst.
  const kern = readFileSync(join(ROOT, 'api/_lib/event-attendee-move-core.js'), 'utf8');
  const i = kern.indexOf('.insert(insertRow)');
  assert.ok(i > 0);
  assert.match(kern.slice(i, i + 600), /is_test/);
});

test('de nieuwe opvolgkaart neemt de vlag over van de nieuwe deelnemer', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  assert.match(bron, /const isTest = !!\(uitkomst\.body\.new_attendee && uitkomst\.body\.new_attendee\.is_test === true\)/);
  assert.match(bron, /maakBevestigdeKaart\(\{[\s\S]{0,200}isTest,/);

  const i = bron.indexOf('async function maakBevestigdeKaart');
  const blok = bron.slice(i, i + 2800);
  assert.match(blok, /is_test\s*:\s*isTest === true/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · ALLEEN EVENTS DIE NOG MOETEN KOMEN
// ═══════════════════════════════════════════════════════════════════════════

const NU = Date.parse('2026-09-10T12:00:00Z');
const ev = (id, iso) => ({ id, title: 'Masterclass ' + id, starts_at: iso });

test('een voorbij event valt uit de keuzelijst', () => {
  // Dit is het geval dat gemeten werd: het event van 9 september stond in de
  // lijst, en zelfs bovenaan.
  const T = laadViews().__evMoveHelpers.toekomstigeEvents;
  const lijst = T([
    ev('gisteren', '2026-09-09T17:00:00Z'),
    ev('straks',   '2026-09-23T17:00:00Z'),
  ], 'huidig', NU);

  assert.equal(lijst.length, 1);
  assert.equal(lijst[0].id, 'straks');
});

test('de lijst staat chronologisch — de eerstvolgende is meestal de bedoeling', () => {
  const T = laadViews().__evMoveHelpers.toekomstigeEvents;
  const lijst = T([
    ev('okt', '2026-10-05T17:00:00Z'),
    ev('sep', '2026-09-23T17:00:00Z'),
    ev('nov', '2026-11-02T17:00:00Z'),
  ], 'huidig', NU);
  assert.equal(lijst.map((e) => e.id).join(','), 'sep,okt,nov');
});

test('het huidige event valt er nog steeds uit', () => {
  const T = laadViews().__evMoveHelpers.toekomstigeEvents;
  const lijst = T([ev('huidig', '2026-09-26T17:00:00Z'), ev('ander', '2026-09-23T17:00:00Z')], 'huidig', NU);
  assert.equal(lijst.map((e) => e.id).join(','), 'ander');
});

test('een event zonder bruikbare datum valt eruit', () => {
  // Die kun je niet plaatsen, dus ook niet aanbieden.
  const T = laadViews().__evMoveHelpers.toekomstigeEvents;
  const lijst = T([
    ev('leeg', null), ev('rommel', 'binnenkort'), ev('goed', '2026-09-23T17:00:00Z'),
  ], 'huidig', NU);
  assert.equal(lijst.map((e) => e.id).join(','), 'goed');
});

test('blijft er niets over, dan is de lijst leeg en volgt de bestaande melding', () => {
  const w = laadViews();
  const T = w.__evMoveHelpers.toekomstigeEvents;
  // Lengte, niet deepEqual: de array komt uit een andere vm-realm en heeft
  // daar een eigen Array-prototype.
  assert.equal(T([ev('gisteren', '2026-09-09T17:00:00Z')], 'huidig', NU).length, 0);
  assert.equal(T(null, 'huidig', NU).length, 0);

  // De melding zelf stond er al en blijft ongewijzigd.
  const ev2 = readFileSync(VIEW_EV, 'utf8');
  assert.match(ev2, /if \(!events\.length\)/);
  assert.match(ev2, /Geen ander event beschikbaar/);
});

test('de keuzelijst gebruikt de filter — voor allebei de modules, want één functie', () => {
  const bron = readFileSync(VIEW_EV, 'utf8');
  const i = bron.indexOf('window.__evKiesAnderEvent = async');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1200);
  assert.match(blok, /events = _evToekomstigeEvents\(j\?\.items, eventId\)/);
  // De oude, ongefilterde vorm mag niet terugkomen.
  assert.doesNotMatch(zonderUitleg(blok), /\.filter\(\(e\) => e\.id !== eventId\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · BEZIG — een zichtbaar teken, en geen tweede klik
// ═══════════════════════════════════════════════════════════════════════════

test('verplaatsen zet bezig vóór de aanroep en laat hem altijd weer los', () => {
  const view = readFileSync(VIEW_OPV, 'utf8');
  const i = view.indexOf('window.__opvVerplaatsNaarEvent = async');
  assert.ok(i > 0);
  const blok = view.slice(i, view.indexOf('\n  };', i));

  // Op slot NA de keuzelijst (annuleren mag niets blokkeren) en VÓÓR de post.
  const iKies = blok.indexOf('__evKiesAnderEvent');
  const iSlot = blok.indexOf('_ui.bezig = true;');
  const iPost = blok.indexOf("post('/api/opvolging-aanmelding-actie'");
  assert.ok(iKies > 0 && iSlot > iKies && iPost > iSlot,
    'volgorde: keuzelijst → bezig → aanroep');

  // En weer los, ook als het misgaat.
  assert.match(blok, /\} finally \{[\s\S]*?_ui\.bezig = false;[\s\S]*?render\(\);/,
    'zonder finally zit Dave na een fout vast in een venster zonder werkende knoppen');
});

test('het venster toont dat er iets gebeurt en zet de opties uit', () => {
  const view = readFileSync(VIEW_OPV, 'utf8');
  assert.match(view, /const bezig = !!_ui\.bezig;/);
  assert.match(view, /Bezig met verplaatsen&hellip;/);

  // Alle vier de uitgangen krijgen de vlag mee, niet alleen de verplaatsknop:
  // zolang er iets loopt hoort er niets anders klikbaar te zijn.
  const i = view.indexOf("const bezig = !!_ui.bezig;");
  const blok = view.slice(i, i + 1600);
  const metVlag = (blok.match(/\)", bezig\)|\)', bezig\)/g) || []).length;
  assert.equal(metVlag, 4, 'vier opties, vier keer de bezig-vlag');
});

test('opt() maakt een uitgeschakelde knop zonder onclick', () => {
  const view = readFileSync(VIEW_OPV, 'utf8');
  const i = view.indexOf('const opt = (em, bg, titel, sub, actie, uit)');
  assert.ok(i > 0, 'opt hoort een uit-vlag te kennen');
  const blok = view.slice(i, i + 500);
  assert.match(blok, /uit \? '' : actie/, 'geen onclick als hij uit staat');
  assert.match(blok, /disabled/);
});

test('bevestigen en afmelden hebben dezelfde guard — een tweede klik telt niet twee keer', () => {
  // 'bevestigd' twee keer zou twee pogingen en twee notitieregels opleveren.
  const view = readFileSync(VIEW_OPV, 'utf8');
  const i = view.indexOf('window.__opvAanmeldBevestig = async');
  assert.ok(i > 0);
  const blok = view.slice(i, view.indexOf('\n  };', i));

  assert.match(blok, /if \(!m \|\| _ui\.bezig\) return;/, 'de guard aan de deur');
  const iSlot = blok.indexOf('_ui.bezig = true;');
  const iPost = blok.indexOf("post('/api/opvolging-aanmelding-actie'");
  assert.ok(iSlot > 0 && iPost > iSlot, 'op slot vóór de eerste await');
  assert.match(blok, /\} finally \{[\s\S]*?_ui\.bezig = false;/);
});
