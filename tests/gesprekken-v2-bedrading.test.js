// tests/gesprekken-v2-bedrading.test.js
//
// De aansluitingen tussen de vlag, de endpoints en het scherm.
//
// De rekensommen zelf staan in gesprekken-v2-venster-en-status.test.js. Wat
// hier bewaakt wordt is saaier en breekt makkelijker: dat het scherm de
// gegevens die het nodig heeft ook echt KRIJGT, dat het hulpscript geladen
// wordt vóór het scherm dat het gebruikt, en vooral — dat alles wat nieuw is
// achter de vlag zit.
//
// Die laatste is de belofte uit de audit (sectie 7): "Die vlag uit betekent:
// het bestaande scherm, byte-identiek gedrag." Een belofte zonder test is een
// voornemen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const SCHERM = 'modules/klanten-v2/views/wanbetalers-v2.js';
const INDEX  = 'modules/klanten-v2/index.html';
const LIJST  = 'api/inbox-conversations-list.js';
const DRAAD  = 'api/inbox-thread-unified.js';

/* ── De gegevens moeten er zijn ───────────────────────────────────────── */

test('de draad stuurt failed_reason mee — anders is G9 onmogelijk', () => {
  const b = lees(DRAAD);
  assert.match(b, /select\('id, direction[^']*failed_reason/, 'failed_reason ontbreekt in de select');
  assert.match(b, /failed_reason: m\.failed_reason/, 'failed_reason komt niet in de meta terecht');
});

test('de draad stuurt last_inbound_at mee — anders is G3 onmogelijk', () => {
  const b = lees(DRAAD);
  // can_send_text is een ja/nee. Aftellen kan alleen met het tijdstip zelf.
  assert.match(b, /last_inbound_at: conv\.last_inbound_at/);
});

test('de lijst stuurt de vlag mee', () => {
  const b = lees(LIJST);
  assert.match(b, /import \{ gesprekkenV2Aan \} from '\.\/_lib\/gesprekken-vlag\.js'/);
  // Beide 200-antwoorden, ook de tak waar geen module-config is. Anders staat
  // de vlag daar op undefined en gedraagt het scherm zich per tak anders.
  const treffers = b.match(/vlaggen: \{ gesprekken_v2: gesprekkenV2Aan\(\) \}/g) || [];
  assert.equal(treffers.length, 2, 'niet elk 200-antwoord draagt de vlag');
});

/* ── Het scherm moet ze gebruiken, en alleen achter de vlag ───────────── */

test('het scherm leest de vlag uit het antwoord, strikt', () => {
  const b = lees(SCHERM);
  assert.match(b, /st\.v2 = j\?\.vlaggen\?\.gesprekken_v2 === true;/,
    'een lossere vergelijking laat undefined of "false" doorglippen');
});

test('_gesprekkenV2 eist én de vlag én het geladen hulpscript', () => {
  const b = lees(SCHERM);
  const fn = b.slice(b.indexOf('function _gesprekkenV2()'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /_live\.inbox\.convs\.v2 === true/);
  assert.match(body, /window\.GESPREKKEN_V2/);
});

test('het hulpscript wordt nergens buiten de poort om aangeroepen', () => {
  // Dit is de byte-identiek-belofte, mechanisch nagelopen. In plaats van te
  // gokken hoe ver een aanroep van zijn poort af mag staan, loopt álles via
  // _gv2(): die geeft het hulpscript terug óf niets. Daardoor hoort
  // `window.GESPREKKEN_V2` in dit bestand op precies twee plekken te staan —
  // de poort zelf en _gv2() — en is een derde vindplaats per definitie een
  // aanroep die de vlag omzeilt.
  const code = lees(SCHERM)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const treffers = (code.match(/window\.GESPREKKEN_V2/g) || []).length;
  assert.equal(treffers, 3, 'verwacht: 2× in _gesprekkenV2() + 1× in _gv2()');
  assert.match(code, /function _gv2\(\) \{\s*return _gesprekkenV2\(\) \? window\.GESPREKKEN_V2 : null;/);
});

test('de oude 24u-badge staat er nog, als terugval', () => {
  // Vlag uit, of geen last_inbound_at bekend: dan hoort er letterlijk te staan
  // wat er altijd stond. Verdwijnt deze tekst, dan is de terugval weg.
  const b = lees(SCHERM);
  assert.match(b, /24u-venster open — vrije tekst mag/);
  assert.match(b, /24u-venster verlopen — alleen templates/);
});

/* ── Laadvolgorde ─────────────────────────────────────────────────────── */

test('index.html laadt het hulpscript vóór het scherm dat het gebruikt', () => {
  const html = lees(INDEX);
  const hulp = html.indexOf('shared/gesprekken-v2.js');
  const scherm = html.indexOf('views/wanbetalers-v2.js');
  assert.ok(hulp > -1, 'het hulpscript wordt niet geladen');
  assert.ok(scherm > -1);
  assert.ok(hulp < scherm, 'gesprekken-v2.js moet vóór wanbetalers-v2.js staan');
});

test('beide scripts dragen een v-nummer', () => {
  const html = lees(INDEX);
  assert.match(html, /shared\/gesprekken-v2\.js\?v=\d+/);
  assert.match(html, /views\/wanbetalers-v2\.js\?v=\d+/);
});

/* ── G5-deels · de focus-standen ──────────────────────────────────────── */

test('de focus-stand begint uit', () => {
  const b = lees(SCHERM);
  assert.match(b, /focusFilter:\s*'geen',/, "een andere beginstand filtert de lijst zonder dat iemand erom vroeg");
});

test('de focus-stand werkt alleen achter de vlag', () => {
  const b = lees(SCHERM);
  // Zonder de poort zou een oude bladwijzer of een blijven-hangen waarde de
  // lijst ook met de vlag uit kunnen versmallen.
  // `gv` is null zodra de vlag uit staat (of wanneer de teller expres zonder
  // stand rekent), en dan blijft de stand 'geen'.
  assert.match(b, /const gv = negeerFocus \? null : _gv2\(\);/);
  assert.match(b, /const focusModus = gv \? \(_ui\.inbox\.focusFilter \|\| 'geen'\) : 'geen';/);
});

test('het zoeken gebeurt vóór de wanbetaler-poort', () => {
  // Anders doet een zoekterm niets in de stand "niet gekoppeld": die stand
  // kijkt naar de volledige lijst, en die was dan nog ongefilterd.
  const b = lees(SCHERM);
  const fn = b.slice(b.indexOf('function _selectVisibleInboxItems'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  const zoek = body.indexOf('_ui.inbox.searchQ');
  const poort = body.indexOf("'is_debtor' in c");
  assert.ok(zoek > -1 && poort > -1);
  assert.ok(zoek < poort, 'de zoekfilter staat nog ná de wanbetaler-poort');
});

test('nog eens klikken zet de stand weer uit', () => {
  // Een filter waar je alleen uit komt door een andere knop te zoeken, blijft
  // per ongeluk aan staan — en dan lijkt de lijst gewoon leeg.
  const b = lees(SCHERM);
  assert.match(b, /_ui\.inbox\.focusFilter === gewenst\) \? 'geen' : gewenst/);
});

test('de tellers tellen zichzelf niet mee', () => {
  const b = lees(SCHERM);
  assert.match(b, /_selectVisibleInboxItems\(alle, \{ negeerFocus: true \}\)/);
});

test('de lege-lijst-tekst hoort bij de gekozen stand', () => {
  const b = lees(SCHERM);
  assert.match(b, /Geen gesprekken zonder klantkoppeling\./);
  assert.match(b, /Geen wanbetaler-gesprekken in dit filter\./, 'de oude tekst hoort te blijven voor de gewone lijst');
});
