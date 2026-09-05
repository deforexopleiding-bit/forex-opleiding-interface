// tests/opvolging-korte-plaats.test.js
//
// Twee dingen die niet uit elkaar mogen lopen.
//
// 1. HET SCHEIDINGSTEKEN HOORT BUITEN esc().
//    Stond het erbinnen, dan wordt '&middot;' zelf ge-escaped en leest de
//    gebruiker letterlijk '&middot;' op zijn scherm. Die fout stond er twee
//    keer: in de groepskop boven een aanmeldblok, en in de kop van de
//    Wat-nu-modal. Beide zijn nu weg; deze test houdt ze weg.
//
// 2. DE PLAATS-REGEL BESTAAT TWEE KEER.
//    api/_lib/opvolging-aanmelding.js bepaalt hem voor het badge-label dat de
//    cron wegschrijft; de browser-view heeft een eigen kopie, want een klassiek
//    script kan niet uit een ES-module importeren. Lopen die twee uiteen, dan
//    staat er in de modal iets anders dan op de kaart, en dat merk je pas als
//    iemand het naast elkaar ziet.
//
// De regel zelf: events.location is één vrij tekstveld. Er staat soms een stad
// in en soms een volledig postadres. De stad uit zo'n adres vissen is een
// parser bouwen op één voorbeeld, dus doen we het omgekeerd — kort en zonder
// adres-kenmerken is een plaatsnaam, de rest valt weg. Weglaten is veilig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { kortePlaats as kortePlaatsServer } from '../api/_lib/opvolging-aanmelding.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8'),
    ctx, { filename: 'opvolging-v2.js' });
  return window.__opvAanmeldHelpers;
}

const V = laadView();
const ADRES = 'Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)';

// ═══════════════════════════════════════════════════════════════════════════
// DE KOP VAN DE WAT-NU-MODAL
// ═══════════════════════════════════════════════════════════════════════════

test('het scheidingsteken wordt getekend, niet als tekst getoond', () => {
  const h = V.eventKopTekst({ event_titel: 'Forex Masterclass Gent', event_plaats: 'Gent' });
  assert.ok(h.includes('&middot;'), 'het teken hoort er te staan');
  assert.doesNotMatch(h, /&amp;middot;/, 'maar niet als ge-escapete tekst');
});

test('de modal draagt niet het volledige postadres', () => {
  // Dit stond op het scherm:
  //   'Forex Masterclass Gent &middot; Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)'
  const h = V.eventKopTekst({ event_titel: 'Forex Masterclass Gent', event_plaats: ADRES });
  assert.equal(h, 'Forex Masterclass Gent');
  assert.doesNotMatch(h, /Deinsesteenweg/);
});

test('een echte plaatsnaam staat er wél bij', () => {
  assert.equal(
    V.eventKopTekst({ event_titel: 'Masterclass', event_plaats: 'Gent' }),
    'Masterclass &middot; Gent');
});

test('de kop overleeft ontbrekende velden', () => {
  assert.equal(V.eventKopTekst({ event_titel: 'Masterclass' }), 'Masterclass');
  assert.equal(V.eventKopTekst({ event_plaats: 'Gent' }), 'Gent');
  assert.equal(V.eventKopTekst({}), '');
  assert.equal(V.eventKopTekst(null), '');
});

test('een titel met een < erin wordt nog steeds ge-escaped', () => {
  // De entity mag dan buiten esc() staan, de gebruikersinvoer erbinnen.
  const h = V.eventKopTekst({ event_titel: '<script>x</script>', event_plaats: 'Gent' });
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEE KOPIEËN VAN DE PLAATS-REGEL
// ═══════════════════════════════════════════════════════════════════════════

test('view en server oordelen hetzelfde over een plaats', () => {
  const gevallen = [
    'Gent', 'Den Haag', 'Antwerpen', 'Brussel',
    ADRES,
    'Deinsesteenweg 108', 'Drongen (Gent)', 'Belgie - Drongen', 'Gent, Belgie',
    '9031 Drongen', 'Een hele lange locatieomschrijving zonder cijfers',
    '', '   ', null, undefined,
  ];
  for (const g of gevallen) {
    assert.equal(V.kortePlaats(g), kortePlaatsServer(g),
      'view en server lopen uiteen op ' + JSON.stringify(g));
  }
});

test('de regel zelf: kort en zonder adres-kenmerken', () => {
  assert.equal(V.kortePlaats('Gent'), 'Gent');
  assert.equal(V.kortePlaats(' Gent '), 'Gent', 'spaties eromheen tellen niet mee');
  assert.equal(V.kortePlaats(ADRES), '');
  assert.equal(V.kortePlaats('Deinsesteenweg 108'), '', 'cijfers');
  assert.equal(V.kortePlaats('Drongen (Gent)'), '', 'haakjes');
  assert.equal(V.kortePlaats('Gent, Belgie'), '', 'komma');
  assert.equal(V.kortePlaats('Belgie - Drongen'), '', 'streepje met spaties');
  assert.equal(V.kortePlaats('Een hele lange locatieomschrijving'), '', 'te lang');
  assert.equal(V.kortePlaats(null), '');
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN DERDE PLEK
// ═══════════════════════════════════════════════════════════════════════════

test('nergens in de view staat nog een entity binnen esc()', () => {
  // De fout is twee keer op dezelfde manier ontstaan: iemand zet een hele
  // regel tekst met scheidingsteken in één esc(). Deze test vindt een derde.
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const treffers = bron.match(/esc\([^)]*&[a-z]+;[^)]*\)/g) || [];
  assert.deepEqual(treffers, [], 'entity binnen esc() gevonden');
  const numeriek = bron.match(/esc\([^)]*&#\d+;[^)]*\)/g) || [];
  assert.deepEqual(numeriek, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE WEEKBALK PAST OP ÉÉN REGEL
// ═══════════════════════════════════════════════════════════════════════════

test('de zes tegels staan in een grid van zes gelijke kolommen', () => {
  // Het was een flexrij met min-width per tegel. Bij zes tegels paste dat niet
  // meer en viel zaterdag op een eigen regel over de volle breedte. Een grid
  // met minmax(0,1fr) kan niet afbreken: de kolommen krimpen mee.
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(bron, /\.opv \.wkbar \.wk\{[^}]*grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(bron, /\.opv \.wkbar \.wkd\{[^}]*min-width:0/,
    'zonder min-width:0 houdt de tegel zichzelf breed en loopt het grid over');
  assert.doesNotMatch(bron, /\.opv \.wkd\{[^}]*min-width:104px/,
    'de oude min-width hoort weg te zijn');
});

test('de vandaag-tegel verandert niet van vorm', () => {
  // Alleen kleur en een ring om de rand; niets dat ruimte inneemt, anders
  // springt die ene tegel eruit tussen de vijf andere.
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const regel = (sel) => (bron.match(new RegExp('\\' + sel + '\\{([^}]*)\\}')) || [])[1] || '';
  for (const sel of ['.opv .wkd.nu .l', '.opv .wkd.on', '.opv .wkd.oud']) {
    const decl = regel(sel);
    assert.ok(decl, sel + ' hoort te bestaan');
    assert.doesNotMatch(decl, /(^|;)\s*(width|min-width|max-width|padding|margin|font-size|flex)\s*:/,
      sel + ' hoort geen afmeting te veranderen');
  }
});

test('de vandaag-markering kan los verdwijnen zonder de datum mee te nemen', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(bron, /<span class="vd">vandaag<\/span>/);
  assert.match(bron, /\.opv \.wkd \.l \.vd\{display:none\}|\.vd\{display:none\}/,
    'op een smal scherm hoort alleen de markering te verdwijnen');
});
