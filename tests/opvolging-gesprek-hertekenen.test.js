// tests/opvolging-gesprek-hertekenen.test.js
//
// O — het gesprekspaneel glitchte, en de oorzaak was er een van dezelfde
// familie als de rest van deze week: er werd onvoorwaardelijk hertekend.
//
// GEMETEN. Met het paneel open lopen er twee timers van vijf seconden
// (fetchWaStatus en fetchGesprek). Allebei eindigden ze op render(), en
// render() zet via DFO.render() `c.innerHTML` van het hele contentblok
// opnieuw — ook als er niets veranderd is, en dat is bij verreweg de meeste
// rondes zo. Daar kwamen alle klachten uit voort:
//
//   · het springen — de shell zet na het vervangen van de DOM de paginascroll
//     terug;
//   · het vanzelf dichtvallen — een klik die tussen mousedown en het einde van
//     de hertekening zijn element kwijtraakt landt op de scrim, en de scrim
//     sloot op mousedown zodra het doelwit hijzelf was;
//   · een half getypt bericht dat om de vijf seconden gewist werd, want de
//     textarea had geen waarde uit de staat.
//
// Deze tests kijken naar het GEDRAG, niet naar het bestaan van functies. Er is
// een DOM-dubbelganger die genoeg kan om een hertekening na te spelen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

/** Een textarea die genoeg kan: waarde, focus, selectie. */
function nepTextarea() {
  return { id: 'opv-wa-tekst', value: '', selectionStart: 0, selectionEnd: 0,
    focus() { this._doc.activeElement = this; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
}

/** Een draad met scrollpositie. */
function nepDraad({ scrollTop = 0, scrollHeight = 1000, clientHeight = 300 } = {}) {
  return { scrollTop, scrollHeight, clientHeight };
}

function laadView({ textarea = null, draad = null } = {}) {
  const doc = {
    activeElement: null,
    getElementById: (id) => (id === 'opv-wa-tekst' ? textarea : null),
    querySelector: (sel) => (sel.includes('wchat') ? draad : null),
    head: { appendChild() {} }, createElement: () => ({ style: {} }),
  };
  if (textarea) textarea._doc = doc;
  let hertekend = 0;
  const window = {
    DFO: { VIEWS: {}, S: { tab: 'Vandaag' }, render() { hertekend += 1; } },
    KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: doc, queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set, Map,
  });
  runInContext(readFileSync(BADGE, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  return { window, doc, tellingen: () => hertekend, H: window.__opvHertekenHelpers,
           G: window.__opvGesprekHelpers };
}

const bericht = (over) => ({ id: 'b1', richting: 'in', tekst: 'Hoi', media_type: 'chat',
  tijdstip: '2026-09-06T10:30:00Z', ...over });

/** Een geopend gesprek met een gekoppelde brug. */
function metGesprek(w, over = {}) {
  w.G.zetWa({ error: null, data: { verbonden: true, ziet_uitgaand: true } });
  w.G.zetGesprek(Object.assign({
    open: true, nummer: '32470123456', taakId: 'tk-1', naam: 'Jan',
    laden: false, error: null, code: null, berichten: [bericht()], verzendt: false,
    optimistisch: [], concept: '',
  }, over));
}

// ═══════════════════════════════════════════════════════════════════════════
// EEN · ALLEEN HERTEKENEN ALS ER IETS VERANDERD IS
// ═══════════════════════════════════════════════════════════════════════════

test('een tweede identiek antwoord levert dezelfde vingerafdruk op', () => {
  const w = laadView();
  metGesprek(w);
  const eerste = w.H.huidigeViewHtml();
  const tweede = w.H.huidigeViewHtml();
  assert.equal(typeof eerste, 'string');
  assert.ok(eerste.length > 100, 'er hoort echt iets getekend te worden');
  assert.equal(eerste, tweede, 'zonder verandering hoort de HTML gelijk te zijn');
});

test('en dan wordt er niet hertekend', () => {
  const w = laadView();
  metGesprek(w);
  w.H.render();                       // eerste ronde: tekent
  const na1 = w.tellingen();
  w.H.render(); w.H.render(); w.H.render();
  assert.equal(w.tellingen(), na1, 'drie identieke rondes horen niets te doen');
  assert.ok(na1 >= 1, 'de eerste ronde hoort wél te tekenen');
});

test('een bericht erbij verandert de vingerafdruk wél', () => {
  const w = laadView();
  metGesprek(w);
  const voor = w.H.huidigeViewHtml();
  w.G.zetGesprek({ berichten: [bericht(), bericht({ id: 'b2', tekst: 'En nog iets' })] });
  assert.notEqual(w.H.huidigeViewHtml(), voor);
});

test('en dan wordt er wél hertekend', () => {
  const w = laadView();
  metGesprek(w);
  w.H.render();
  const na1 = w.tellingen();
  w.G.zetGesprek({ berichten: [bericht(), bericht({ id: 'b2', tekst: 'Nieuw' })] });
  w.H.render();
  assert.equal(w.tellingen(), na1 + 1);
});

test('een optimistische bubbel telt ook als verandering', () => {
  const w = laadView();
  metGesprek(w);
  const voor = w.H.huidigeViewHtml();
  w.G.zetGesprek({ optimistisch: [{ richting: 'uit', tekst: 'net verstuurd', media_type: 'chat', tijdstip: 'x' }] });
  assert.notEqual(w.H.huidigeViewHtml(), voor);
});

test('een foutstaat ook', () => {
  const w = laadView();
  metGesprek(w);
  const voor = w.H.huidigeViewHtml();
  w.G.zetGesprek({ error: 'Netwerkfout', berichten: null });
  assert.notEqual(w.H.huidigeViewHtml(), voor);
});

test('een veranderde brugstatus die het scherm toont ook', () => {
  const w = laadView();
  metGesprek(w);
  const voor = w.H.huidigeViewHtml();
  w.G.zetWa({ error: null, data: { verbonden: false, ziet_uitgaand: true } });
  assert.notEqual(w.H.huidigeViewHtml(), voor, 'het lampje en het invoerveld hangen hieraan');
});

test('een tijdstempel die alleen in het antwoord opschuift verandert niets', () => {
  // Dit is de valkuil bij een vingerafdruk over het rúwe antwoord: dan telt elke
  // ronde als verandering en heb je niets opgelost. De vingerafdruk is daarom
  // de getekende HTML zelf.
  const w = laadView();
  metGesprek(w);
  const voor = w.H.huidigeViewHtml();
  w.G.zetWa({ error: null, data: { verbonden: true, ziet_uitgaand: true, opgehaald_op: '2026-09-06T11:00:00Z' } });
  assert.equal(w.H.huidigeViewHtml(), voor, 'staat nergens op het scherm, dus geen verandering');
});

// ═══════════════════════════════════════════════════════════════════════════
// TWEE · HET CONCEPT OVERLEEFT EEN HERTEKENING
// ═══════════════════════════════════════════════════════════════════════════

test('wat getypt is komt in de staat terecht, niet alleen in de DOM', () => {
  const ta = nepTextarea();
  const w = laadView({ textarea: ta });
  metGesprek(w);
  // De textarea meldt elke aanslag; de staat is daarna de waarheid.
  assert.match(w.H.huidigeViewHtml(), /oninput="window.__opvGesprekTyp/);
  w.window.__opvGesprekTyp('Hallo Jan, ik bel je zo even over');
  ta.value = '';                      // de DOM kwijt
  w.H.herstelConcept();               // ...en uit de staat terug
  assert.equal(ta.value, 'Hallo Jan, ik bel je zo even over');
});

test('het concept overleeft een hertekening', () => {
  const ta = nepTextarea();
  const w = laadView({ textarea: ta });
  metGesprek(w);
  w.window.__opvGesprekTyp('Een lange zin die nog niet verstuurd is');
  ta.value = '';                       // de hertekening wist het veld
  w.G.zetGesprek({ berichten: [bericht(), bericht({ id: 'b2' })] });   // iets veranderde
  w.H.render();
  assert.equal(ta.value, 'Een lange zin die nog niet verstuurd is');
});

test('het concept staat NIET in de HTML', () => {
  // Zo verandert typen de vingerafdruk niet, en hoeft de tekst nergens ontsnapt
  // te worden — wat bij een </textarea> in een bericht anders misgaat.
  const w = laadView({ textarea: nepTextarea() });
  metGesprek(w, { concept: 'GEHEIMEZIN</textarea><script>' });
  const h = w.H.huidigeViewHtml();
  assert.doesNotMatch(h, /GEHEIMEZIN/);
});

test('typen alleen veroorzaakt geen hertekening', () => {
  const w = laadView({ textarea: nepTextarea() });
  metGesprek(w);
  w.H.render();
  const na1 = w.tellingen();
  w.window.__opvGesprekTyp('aan het typen');
  w.H.render();
  assert.equal(w.tellingen(), na1, 'er is niets te zien veranderd');
});

test('focus en cursorpositie worden teruggezet', () => {
  const ta = nepTextarea();
  const w = laadView({ textarea: ta });
  metGesprek(w, { concept: 'halverwege een zin' });
  ta.value = 'halverwege een zin';
  ta.selectionStart = 5; ta.selectionEnd = 5;
  w.doc.activeElement = ta;
  const voor = w.H.bewaarPaneelStaat();
  ta.value = ''; ta.selectionStart = 0; w.doc.activeElement = null;   // hertekend
  w.H.herstelPaneelStaat(voor);
  assert.equal(w.doc.activeElement, ta, 'de cursor hoort terug in het veld');
  assert.equal(ta.selectionStart, 5);
});

test('een cursor voorbij het einde van de tekst breekt niets', () => {
  const ta = nepTextarea();
  const w = laadView({ textarea: ta });
  metGesprek(w, { concept: 'kort' });
  w.doc.activeElement = ta;
  w.H.herstelPaneelStaat({ focus: true, selStart: 999, selEnd: 999, draadTop: null, onderaan: true });
  assert.ok(ta.selectionStart <= 'kort'.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// DRIE · DE DRAAD SPRINGT NIET MEER
// ═══════════════════════════════════════════════════════════════════════════

test('onderaan gestaan → naar het nieuwste bericht', () => {
  assert.equal(isOnderaanVia(laadView(), { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 }), true);
});

test('omhoog gescrold → blijven waar je was', () => {
  assert.equal(isOnderaanVia(laadView(), { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 }), false);
});

function isOnderaanVia(w, maten) { return w.H.isOnderaan(maten); }

test('een halve regel speling telt nog als onderaan', () => {
  const w = laadView();
  const marge = w.H.DRAAD_ONDERAAN_MARGE;
  assert.equal(w.H.isOnderaan({ scrollTop: 700 - marge, scrollHeight: 1000, clientHeight: 300 }), true);
  assert.equal(w.H.isOnderaan({ scrollTop: 700 - marge - 1, scrollHeight: 1000, clientHeight: 300 }), false);
});

test('zonder maten geldt onderaan — dan is er niets om te bewaren', () => {
  const w = laadView();
  assert.equal(w.H.isOnderaan({}), true);
  assert.equal(w.H.isOnderaan(), true);
});

test('stond je onderaan, dan scrolt de draad mee naar beneden', () => {
  const draad = nepDraad({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });
  const w = laadView({ draad });
  const voor = w.H.bewaarPaneelStaat();
  draad.scrollTop = 0; draad.scrollHeight = 1200;    // hertekend, bericht erbij
  w.H.herstelPaneelStaat(voor);
  assert.equal(draad.scrollTop, 1200, 'het nieuwste bericht hoort in beeld te komen');
});

test('was je omhoog gescrold, dan blijf je daar', () => {
  // Dit is de klacht: een binnenkomend bericht mag je niet wegtrekken uit iets
  // dat je aan het teruglezen bent.
  const draad = nepDraad({ scrollTop: 120, scrollHeight: 1000, clientHeight: 300 });
  const w = laadView({ draad });
  const voor = w.H.bewaarPaneelStaat();
  draad.scrollTop = 0; draad.scrollHeight = 1200;
  w.H.herstelPaneelStaat(voor);
  assert.equal(draad.scrollTop, 120, 'de leespositie hoort te blijven staan');
});

// ═══════════════════════════════════════════════════════════════════════════
// VIER · HET PANEEL VALT NIET MEER DICHT VAN EEN KLIK DIE ER NIET VOOR WAS
// ═══════════════════════════════════════════════════════════════════════════
//
// DIT IS DE BUG DIE DAVE VOELT.

test('mousedown op de scrim, mouseup IN het paneel: NIET sluiten', () => {
  const w = laadView();
  assert.equal(w.H.magSluiten(true, false), false);
});

test('mousedown in het paneel, mouseup op de scrim: ook niet', () => {
  const w = laadView();
  assert.equal(w.H.magSluiten(false, true), false);
});

test('allebei op de scrim: wél sluiten', () => {
  const w = laadView();
  assert.equal(w.H.magSluiten(true, true), true);
});

test('een losse mouseup zonder gezien neergaan sluit niet', () => {
  const w = laadView();
  assert.equal(w.H.magSluiten(undefined, true), false);
  assert.equal(w.H.magSluiten(null, true), false);
});

test('de handlers doen dit ook echt, en het paneel blijft open', () => {
  // Niet alleen de pure regel: de weg erlangs.
  const w = laadView();
  metGesprek(w);
  const scrim = {};
  // Neergaan op de scrim...
  w.window.__opvScrimNeer({ target: scrim, currentTarget: scrim });
  // ...maar loslaten op iets binnen het paneel.
  w.window.__opvScrimOp({ target: { anders: true }, currentTarget: scrim }, 'gesprek');
  assert.equal(w.G.gesprekPaneelHtml().length > 100, true, 'het paneel hoort nog open te staan');
});

test('en een echte achtergrondklik sluit hem wél', () => {
  const w = laadView();
  metGesprek(w);
  const scrim = {};
  w.window.__opvScrimNeer({ target: scrim, currentTarget: scrim });
  w.window.__opvScrimOp({ target: scrim, currentTarget: scrim }, 'gesprek');
  assert.equal(w.G.gesprekPaneelHtml(), '', 'dicht');
});

test('een oude neergang blijft niet hangen', () => {
  // Anders sluit de eerstvolgende klik op de scrim alsnog, uren later.
  const w = laadView();
  metGesprek(w);
  const scrim = {};
  w.window.__opvScrimNeer({ target: scrim, currentTarget: scrim });
  w.window.__opvScrimOp({ target: { anders: true }, currentTarget: scrim }, 'gesprek');
  // Nu alleen nog een mouseup, zonder nieuwe mousedown.
  w.window.__opvScrimOp({ target: scrim, currentTarget: scrim }, 'gesprek');
  assert.ok(w.G.gesprekPaneelHtml().length > 100, 'nog steeds open');
});

test('de scrim luistert naar allebei de gebeurtenissen', () => {
  const w = laadView();
  metGesprek(w);
  const h = w.G.gesprekPaneelHtml();
  assert.match(h, /onmousedown="window.__opvScrimNeer\(event\)"/);
  assert.match(h, /onmouseup="window.__opvScrimOp\(event, 'gesprek'\)"/);
  assert.doesNotMatch(h, /onmousedown="if\(event\.target===this\)/, 'de oude regel hoort weg te zijn');
});

test('het kruisje blijft staan', () => {
  const w = laadView();
  metGesprek(w);
  assert.match(w.G.gesprekPaneelHtml(), /__opvGesprekSluit\(\)">&times;/);
});

test('Escape sluit niet terwijl er een half bericht in het veld staat', () => {
  const ta = nepTextarea();
  const w = laadView({ textarea: ta });
  metGesprek(w);
  ta.value = 'half getypte zin';
  w.doc.activeElement = ta;
  assert.equal(w.H.magEscapeSluiten(), false);
  ta.value = '';
  assert.equal(w.H.magEscapeSluiten(), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN DE OVERIGE VENSTERS VOLGEN DEZELFDE REGEL
// ═══════════════════════════════════════════════════════════════════════════

test('alle drie de overlays gebruiken de twee-delige sluitregel', () => {
  const bron = readFileSync(VIEW, 'utf8');
  assert.equal((bron.match(/onmousedown="window\.__opvScrimNeer\(event\)"/g) || []).length, 3);
  assert.ok(!/onmousedown="if\(event\.target===this\)/.test(bron), 'nergens meer de oude regel');
});
