// tests/opvolging-badge-label.test.js
//
// J — het etiket op een opvolgtaak, en waarom het op één plek hoort.
//
// DEZELFDE LANGE STRING, VOOR DE DERDE KEER:
//
//   'Forex Masterclass Gent Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)
//    · 23 sep 18:00'
//
// Eerst in de groepskop van het aanmeldblok, toen op de kaart, en nu in het
// Later-paneel — waar hij alle breedte opeiste en de namen afkapte tot
// 'Bryan Van ...'. Drie keer dezelfde fout op drie plekken is geen toeval maar
// een ontbrekende gedeelde helper.
//
// Twee dingen die deze test bewaakt:
//   1. Er is nog maar één plek waar het etiket gemaakt wordt, en geen enkele
//      view toont badge_label nog rauw.
//   2. De naam heeft voorrang bij het verdelen van de breedte. Hij is het
//      belangrijkste op de regel en mag nooit als eerste wegvallen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');
const VIEW   = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const AUTO   = join(ROOT, 'modules/klanten-v2/views/automatiseringen-v2.js');
const INDEX  = join(ROOT, 'modules/klanten-v2/index.html');

/** Alleen het helperbestand; het heeft met opzet nul afhankelijkheden. */
function laadHelper() {
  const window = {};
  window.window = window;
  const ctx = createContext({ window, Intl, Date, Number, String, Object, RegExp, Math, JSON });
  runInContext(readFileSync(HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  assert.ok(window.KV_V2 && window.KV_V2.helpers, 'de helper hoort zich te registreren');
  return window.KV_V2.helpers;
}

// Het echte etiket dat Jeffrey in productie zag, en de losse velden die er in
// bron_ref achter zitten.
const LANG = 'Forex Masterclass Gent Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent) · 23 sep 18:00';
const evTaak = (over) => ({
  naam: 'Bryan Van Damme', badge_label: LANG,
  bron_ref: {
    event_id: 'ev-1', event_titel: 'Forex Masterclass Gent',
    event_plaats: 'Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)',
    event_start: '2026-09-23T16:00:00Z', event_dag: '2026-09-23',
  },
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ETIKET ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('het postadres verdwijnt, de eventnaam en het moment blijven', () => {
  const H = laadHelper();
  const s = H.opvBadgeTekst(evTaak());
  assert.match(s, /Forex Masterclass Gent/);
  assert.match(s, /23 sep/);
  assert.doesNotMatch(s, /Deinsesteenweg/);
  assert.doesNotMatch(s, /9031/);
  assert.doesNotMatch(s, /\|/);
});

test('een echte plaatsnaam blijft er wél bij staan', () => {
  const H = laadHelper();
  const s = H.opvBadgeTekst(evTaak({ bron_ref: { ...evTaak().bron_ref, event_plaats: 'Gent' } }));
  assert.match(s, /Forex Masterclass Gent · Gent/);
});

test('het etiket wordt niet uit de opgeslagen tekst gepeuterd', () => {
  // De oude badgeVoorEvent plakte titel en plaats met een SPATIE aan elkaar
  // (commit dca79dde), dus achteraf is niet meer te zien waar de titel ophoudt.
  // De helper hoort dus uit bron_ref te bouwen; badge_label mag daar geen rol
  // in spelen zodra er een event achter zit.
  const H = laadHelper();
  const t = evTaak({ badge_label: 'IETS TOTAAL ANDERS' });
  assert.doesNotMatch(H.opvBadgeTekst(t), /TOTAAL ANDERS/);
});

test('zonder event blijft badge_label gewoon staan', () => {
  // 'Call 07/09' en 'Agenda doorgestuurd' zijn al kort en hebben geen bron_ref.
  const H = laadHelper();
  assert.equal(H.opvBadgeTekst({ badge_label: 'Call 07/09' }), 'Call 07/09');
  assert.equal(H.opvBadgeTekst({ badge_label: 'Agenda doorgestuurd', bron_ref: {} }), 'Agenda doorgestuurd');
});

test('niets te tonen levert een lege tekst op, geen lege badge', () => {
  const H = laadHelper();
  for (const t of [null, undefined, {}, { bron_ref: null }, { badge_label: '  ' }]) {
    assert.equal(H.opvBadgeTekst(t), '');
  }
});

test('een event zonder tijdstip verliest alleen het moment', () => {
  const H = laadHelper();
  const t = evTaak({ bron_ref: { event_titel: 'Masterclass Gent', event_plaats: 'Gent', event_start: null } });
  assert.equal(H.opvBadgeTekst(t), 'Masterclass Gent · Gent');
});

test('een onleesbaar tijdstip laat de rest heel', () => {
  const H = laadHelper();
  const t = evTaak({ bron_ref: { event_titel: 'Masterclass Gent', event_start: 'gisteren' } });
  assert.equal(H.opvBadgeTekst(t), 'Masterclass Gent');
});

test('de plaatsregel is dezelfde als op de server', () => {
  // api/_lib/opvolging-aanmelding.js past hem toe bij het schrijven, deze bij
  // het tonen. Lopen ze uiteen, dan verschilt een nieuwe kaart van een oude.
  const H = laadHelper();
  const server = readFileSync(join(ROOT, 'api/_lib/opvolging-aanmelding.js'), 'utf8');
  const i = server.indexOf('function kortePlaats');
  const blok = server.slice(i, server.indexOf('\n}', i));
  // Op de naam van de variabele mag geen test hangen; op de regels wel.
  for (const regel of [/\.length > 24/, /\[0-9\|,;\]/, /' - '/, /'\('/]) {
    assert.match(blok, regel, 'server: ' + regel);
  }
  for (const [in_, uit] of [
    ['Gent', 'Gent'],
    ['Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)', ''],
    ['Antwerpen', 'Antwerpen'],
    ['Een hele lange plaatsnaam die niet meer past', ''],
    ['', ''],
  ]) assert.equal(H.opvKortePlaats(in_), uit, JSON.stringify(in_));
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN ENKELE VIEW TOONT badge_label NOG RAUW
// ═══════════════════════════════════════════════════════════════════════════

test('opvolging-v2 toont badge_label nergens meer rechtstreeks', () => {
  const b = readFileSync(VIEW, 'utf8');
  const code = b.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.ok(!/esc\([a-z]+(\.taak)?\.badge_label\)/.test(code),
    'badge_label hoort via de gedeelde helper te lopen');
  assert.match(code, /const badgeTekst = \(t\) => H\.opvBadgeTekst\(t\)/);
});

test('automatiseringen-v2 ook niet', () => {
  const b = readFileSync(AUTO, 'utf8');
  const code = b.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.ok(!/\$\{esc\(t\.badge_label\)\}/.test(code));
  assert.match(code, /H\.opvBadgeTekst/);
});

test('de regel staat nog maar op één plek in de views', () => {
  // Twee kopieën van dezelfde regel is precies hoe dit drie keer kon misgaan.
  const view = readFileSync(VIEW, 'utf8');
  assert.ok(!/v\.length > 24/.test(view), 'de view hoort te delegeren, niet te kopiëren');
  assert.match(view, /return H\.opvKortePlaats\(location\)/);
});

test('de view weigert te starten zonder de helper', () => {
  // Stil terugvallen op badge_label zou de fout terugbrengen zonder dat iemand
  // het merkt — en dat is de hele reden dat deze PR bestaat.
  const b = readFileSync(VIEW, 'utf8');
  assert.match(b, /typeof H\.opvBadgeTekst !== 'function'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE LAADVOLGORDE IS EEN ECHTE VALKUIL
// ═══════════════════════════════════════════════════════════════════════════

test('het helperbestand staat ná _shared-v2.js en vóór beide views', () => {
  // _shared-v2.js doet `KV_V2.helpers = { ... }` en vervangt het hele object.
  // Staat het helperbestand ervóór, dan is het stil weg.
  const html = readFileSync(INDEX, 'utf8');
  const pos = (naam) => html.indexOf('views/' + naam);
  const shared = pos('_shared-v2.js');
  const helper = pos('_opvolging-badge.js');
  assert.ok(shared > 0 && helper > 0, 'beide horen geladen te worden');
  assert.ok(shared < helper, '_shared-v2.js vervangt KV_V2.helpers en moet dus eerst');
  for (const view of ['opvolging-v2.js', 'automatiseringen-v2.js']) {
    assert.ok(helper < pos(view), 'de helper hoort vóór ' + view);
  }
});

test('het helperbestand vervangt KV_V2.helpers niet maar vult het aan', () => {
  const b = readFileSync(HELPER, 'utf8');
  assert.match(b, /window\.KV_V2\.helpers = window\.KV_V2\.helpers \|\| \{\}/);
  assert.ok(!/window\.KV_V2\.helpers = \{/.test(b), 'geen objectvervanging');
});

test('het helperbestand heeft geen DOM nodig', () => {
  // Gemeten: _shared-v2.js heeft document.addEventListener nodig, en de
  // veertien vm-sandboxen van de opvolging-tests hebben dat niet. Vandaar een
  // eigen bestandje. Blijft dat zo, dan blijven die tests eenvoudig.
  // Alleen de code; het commentaar legt juist uit waaróm dit bestand bestaat en
  // noemt document.addEventListener bij naam.
  const code = readFileSync(HELPER, 'utf8').split('\n')
    .filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  for (const global of ['document', 'localStorage', 'fetch', 'setTimeout']) {
    assert.ok(!new RegExp('\\b' + global + '\\b').test(code), 'geen ' + global + ' in de helper');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE NAAM KRIJGT DE BREEDTE
// ═══════════════════════════════════════════════════════════════════════════

test('in het Later-paneel groeit de naam en krimpt het etiket', () => {
  const b = readFileSync(VIEW, 'utf8');
  const regel = (sel) => (b.match(new RegExp(sel.replace(/[.*]/g, '\\$&') + '\\{([^}]*)\\}')) || [])[1] || '';
  assert.match(regel('.opv .ltnm'), /flex:1 1 auto/, 'de naam neemt de ruimte die overblijft');
  assert.match(regel('.opv .ltrij .ltev'), /flex:0 1 auto/, 'het etiket mag krimpen');
  assert.match(regel('.opv .ltrij .ltev'), /text-overflow:ellipsis/, 'en kapt zichzelf af');
  assert.match(regel('.opv .ltrij .ltev'), /max-width:45%/, 'en nooit meer dan de helft');
});

test('het volledige etiket blijft bereikbaar als title', () => {
  const b = readFileSync(VIEW, 'utf8');
  const i = b.indexOf('const badge = badgeTekst(t)');
  assert.ok(i > 0);
  assert.match(b.slice(i, i + 600), /title="' \+ esc\(badge\) \+ '"/);
});

test('de CSS blijft gescoped onder .opv', () => {
  const b = readFileSync(VIEW, 'utf8');
  assert.ok(!/^\.lt(nm|rij|ev)/m.test(b), 'niets ongescoped');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE SERVER STUURT DE LOSSE VELDEN MEE
// ═══════════════════════════════════════════════════════════════════════════

test('het weekbalk-endpoint stuurt bron_ref mee', () => {
  // Zonder die velden heeft de helper niets om uit te bouwen en valt het Later-
  // paneel terug op badge_label — precies de string die we kwijt wilden.
  const b = readFileSync(join(ROOT, 'api/opvolging-weekbalk.js'), 'utf8');
  assert.match(b, /bron_ref: t\.bron_ref \|\| null/);
  for (const sel of (b.match(/\.select\('id,naam[^']*'/g) || [])) {
    assert.match(sel, /bron_ref/, sel);
  }
});
