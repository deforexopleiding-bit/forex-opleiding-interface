// tests/opvolging-whatsapp-historiek.test.js
//
// De geschiedenis van het toestel ophalen. Drie dingen die hier zwaar wegen:
//
//  1. HET PRIVACYFILTER BLIJFT DE EERSTE REGEL — ook bij lezen. Een leesroute
//     is net zo goed een weg naar buiten: wie de brug om het gesprek van een
//     willekeurig nummer kan vragen, kan Daves privécontacten uitlezen. Vandaar
//     dat leadlijst.mag() in wa.historiek() vóór de chatstore staat, en er bij
//     een weigering ook niets gelogd wordt.
//
//  2. DE BRUG SCHRIJFT NIET. Ze geeft terug; het CRM beslist wat het bewaart.
//     Zo blijft er één plek waar rijen ontstaan, en die is idempotent op
//     bericht_id — twee keer ophalen levert geen dubbele draad op.
//
//  3. WAT TERUGKOMT IS NIET NOODZAKELIJK ALLES, en het paneel zegt dat.
//     WhatsApp synct maar een beperkt venster naar een gekoppeld apparaat, en
//     deze brug hangt er pas kort aan. Een halve draad tonen alsof het het hele
//     gesprek is, is precies het soort stille onwaarheid waar deze module zich
//     verder overal tegen verzet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bouwHistoriekBericht } from '../services/whatsapp-brug/lib/gebeurtenis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

const NU = Date.parse('2026-09-06T12:00:00Z');
const msg = (over) => ({
  id: { _serialized: 'true_32470111222@c.us_ABC' },
  fromMe: false, from: '32470111222@c.us', to: '32499999999@c.us',
  body: 'Hoi, ik kom donderdag', type: 'chat',
  timestamp: Math.floor(Date.parse('2026-09-03T08:15:00Z') / 1000),
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VORM VAN EEN OPGEHAALD BERICHT
// ═══════════════════════════════════════════════════════════════════════════

test('een inkomend bericht wordt richting "in"', () => {
  const b = bouwHistoriekBericht(msg(), NU);
  assert.equal(b.richting, 'in');
  assert.equal(b.tekst, 'Hoi, ik kom donderdag');
  assert.equal(b.media_type, 'chat');
  assert.equal(b.bericht_id, 'true_32470111222@c.us_ABC');
  assert.equal(b.tijdstip, '2026-09-03T08:15:00.000Z');
});

test('een eigen bericht wordt richting "uit"', () => {
  const b = bouwHistoriekBericht(msg({ fromMe: true }), NU);
  assert.equal(b.richting, 'uit');
});

test('er gaat GEEN soort mee', () => {
  // Een historisch bericht is geen gebeurtenis die nu plaatsvindt. Zou dit als
  // 'uitgaand' of 'antwoord_ontvangen' binnenkomen, dan telde een gesprek van
  // vorige week vandaag mee als moeite in de dekking.
  const b = bouwHistoriekBericht(msg(), NU);
  assert.equal('soort' in b, false);
  assert.deepEqual(Object.keys(b).sort(),
    ['bericht_id', 'media_type', 'richting', 'tekst', 'tijdstip']);
});

test('een groep levert niets op', () => {
  assert.equal(bouwHistoriekBericht(msg({ from: '123-456@g.us' }), NU), null);
  assert.equal(bouwHistoriekBericht(msg({ fromMe: true, to: '123-456@g.us' }), NU), null);
});

test('rommel levert netjes niets op in plaats van een halve rij', () => {
  assert.equal(bouwHistoriekBericht(null, NU), null);
  assert.equal(bouwHistoriekBericht({}, NU), null);
});

test('een bericht zonder tekst wordt een lege string', () => {
  for (const raar of [null, undefined, 0, {}]) {
    assert.equal(bouwHistoriekBericht(msg({ body: raar }), NU).tekst, '', String(raar));
  }
});

test('zonder bruikbare timestamp valt het terug op nu, niet op 1970', () => {
  for (const raar of [null, undefined, 0, -1, 'gisteren']) {
    assert.equal(bouwHistoriekBericht(msg({ timestamp: raar }), NU).tijdstip,
      '2026-09-06T12:00:00.000Z', String(raar));
  }
});

test('een heel lang bericht wordt afgekapt op 4000 tekens', () => {
  assert.equal(bouwHistoriekBericht(msg({ body: 'x'.repeat(9000) }), NU).tekst.length, 4000);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET FILTER STAAT VOOROP, OOK BIJ LEZEN
// ═══════════════════════════════════════════════════════════════════════════

test('wa.historiek filtert vóór hij de chatstore aanraakt', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js'), 'utf8');
  const i = bron.indexOf('async historiek(');
  assert.ok(i > 0, 'de methode hoort te bestaan');
  const blok = bron.slice(i, i + 2000);
  const filter = blok.indexOf('leadlijst.mag(');
  const chat = blok.indexOf('getChatById(');
  assert.ok(filter > 0 && chat > 0);
  assert.ok(filter < chat, 'het filter hoort vóór het openen van de chat te staan');
});

test('groepen worden ook hier geweigerd', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js'), 'utf8');
  const i = bron.indexOf('async historiek(');
  assert.match(bron.slice(i, i + 2000), /chat\.isGroup/);
});

test('een geweigerd nummer krijgt 403 zonder uitleg', () => {
  // Of een nummer bekend is, is zelf ook informatie. Zelfde behandeling als
  // bij /send.
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  const i = bron.indexOf("app.get('/historiek'");
  assert.ok(i > 0, 'de route hoort te bestaan');
  const blok = bron.slice(i, i + 1400);
  assert.match(blok, /NIET_TOEGESTAAN[\s\S]*403[\s\S]*Niet toegestaan/);
  assert.doesNotMatch(blok, /console\.(log|warn)\([^)]*nummer/, 'nooit het nummer loggen bij een weigering');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BRUG GEEFT TERUG, HET CRM SCHRIJFT
// ═══════════════════════════════════════════════════════════════════════════

test('de brug schrijft zelf niets weg', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js'), 'utf8');
  const i = bron.indexOf('async historiek(');
  const blok = bron.slice(i, i + 2000);
  assert.doesNotMatch(blok, /webhook\.duw/, 'ophalen is lezen; het CRM beslist wat het bewaart');
});

test('het CRM schrijft per rij en laat een dubbele bericht_id door', () => {
  // Eén insert met alle rijen zou op de eerste dubbele id de hele batch
  // weigeren, en dan komt er bij een tweede ophaalronde nooit meer iets binnen.
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-historiek.js'), 'utf8');
  assert.match(bron, /for \(const m of berichten\)/, 'per rij, niet als één batch');
  assert.match(bron, /error\.code === '23505'/, 'een dubbele id is geen fout');
  assert.match(bron, /continue/);
});

test('het CRM raakt de poging-telling niet aan', () => {
  // Een gesprek van vorige week is geen moeite van vandaag; die rijen zouden
  // de dekking in Afgerond vervuilen.
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-historiek.js'), 'utf8');
  assert.doesNotMatch(bron, /from\('opvolging_pogingen'\)/,
    'de tabel mag genoemd worden in een comment, maar niet bevraagd');
});

test('alles mislukt wordt een fout, niet een stille nul', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-historiek.js'), 'utf8');
  assert.match(bron, /fouten\.length && nieuw === 0/);
  assert.match(bron, /OPSLAAN_MISLUKT/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET PANEEL ZEGT WAT HET OPGEHAALD HEEFT EN VANAF WANNEER
// ═══════════════════════════════════════════════════════════════════════════

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
  assert.ok(window.__opvGesprekHelpers, 'de view hoort __opvGesprekHelpers te zetten');
  return window.__opvGesprekHelpers;
}

const H = laadView();

function paneel({ gesprek = {}, wa = {} } = {}) {
  const V = laadView();
  V.zetWa(Object.assign({ error: null, data: { verbonden: true, ziet_uitgaand: true } }, wa));
  V.zetGesprek(Object.assign({
    open: true, nummer: '32470123456', taakId: 'tk-1', naam: 'Jan Peeters',
    laden: false, error: null, code: null, berichten: [], verzendt: false,
    optimistisch: [], haalt: false, melding: null, meldingSoort: null,
  }, gesprek));
  return V;
}

test('de melding noemt het aantal én vanaf wanneer', () => {
  // Die datum is het hele punt: het verschil tussen 'dit is het gesprek' en
  // 'dit is wat WhatsApp naar dit apparaat gestuurd heeft'.
  const t = H.beschrijfHistoriek({ opgehaald: 12, nieuw: 12, oudste: '2026-09-03T08:15:00Z', mogelijk_meer: false });
  assert.match(t, /12 berichten opgehaald/);
  assert.match(t, /Allemaal nieuw/);
  assert.match(t, /oudste bericht dat WhatsApp doorgaf is van 03\/09/);
});

test('de melding zegt eerlijk dat er méér kan zijn dan dit', () => {
  const t = H.beschrijfHistoriek({ opgehaald: 5, nieuw: 5, oudste: '2026-09-03T08:15:00Z', mogelijk_meer: false });
  assert.match(t, /beperkt venster/, 'een gekoppeld apparaat krijgt niet alles');
  assert.match(t, /op Daves toestel kan meer staan/);
});

test('liep de lijst tot aan de grens, dan zegt hij dat er mogelijk meer is', () => {
  const t = H.beschrijfHistoriek({ opgehaald: 50, nieuw: 50, oudste: '2026-09-01T08:00:00Z', mogelijk_meer: true });
  assert.match(t, /mogelijk meer/);
});

test('een tweede ophaalronde meldt dat er niets nieuws bij zat', () => {
  const t = H.beschrijfHistoriek({ opgehaald: 12, nieuw: 0, oudste: '2026-09-03T08:15:00Z' });
  assert.match(t, /stonden er allemaal al/);
});

test('gedeeltelijk nieuw wordt ook als zodanig gemeld', () => {
  const t = H.beschrijfHistoriek({ opgehaald: 12, nieuw: 3, oudste: '2026-09-03T08:15:00Z' });
  assert.match(t, /3 daarvan waren nieuw/);
});

test('niets opgehaald wordt gezegd, met de reden', () => {
  const t = H.beschrijfHistoriek({ opgehaald: 0, nieuw: 0, melding: 'WhatsApp kent op dit apparaat geen gesprek met dit nummer.' });
  assert.match(t, /geen gesprek met dit nummer/);
  assert.doesNotMatch(t, /opgehaald\./, 'geen zin die suggereert dat er iets binnenkwam');
});

test('geen antwoord is ook een antwoord', () => {
  assert.match(H.beschrijfHistoriek(null), /geen antwoord/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEE KNOPPEN
// ═══════════════════════════════════════════════════════════════════════════

test('een leeg gesprek toont "Historiek ophalen"', () => {
  const V = paneel({ gesprek: { berichten: [] } });
  const h = V.gesprekPaneelHtml();
  assert.match(h, /Historiek ophalen/);
  assert.match(h, /__opvGesprekHistoriek/);
  assert.doesNotMatch(h, /Ouder ophalen/, 'die hoort pas boven een bestaande draad');
});

test('een gevuld gesprek toont "Ouder ophalen" bovenaan de draad', () => {
  const V = paneel({ gesprek: { berichten: [{ id: 'b1', richting: 'in', tekst: 'hoi', tijdstip: '2026-09-06T09:00:00Z' }] } });
  const h = V.gesprekPaneelHtml();
  assert.match(h, /Ouder ophalen/);
  assert.ok(h.indexOf('wouder') < h.indexOf('wchat'), 'de knop hoort bóven de berichten te staan');
  assert.doesNotMatch(h, /Historiek ophalen/);
});

test('tijdens het ophalen staat de knop op slot', () => {
  const V = paneel({ gesprek: { berichten: [], haalt: true } });
  const h = V.gesprekPaneelHtml();
  assert.match(h, /disabled/);
  assert.match(h, /Bezig/);
});

test('het lege blok belooft geen volledige geschiedenis', () => {
  const V = paneel({ gesprek: { berichten: [] } });
  assert.match(V.gesprekPaneelHtml(), /beperkt venster/);
});

test('de melding blijft boven de draad staan', () => {
  const V = paneel({
    gesprek: {
      berichten: [{ id: 'b1', richting: 'in', tekst: 'hoi', tijdstip: '2026-09-06T09:00:00Z' }],
      melding: '12 berichten opgehaald.', meldingSoort: 'ok',
    },
  });
  const h = V.gesprekPaneelHtml();
  assert.match(h, /12 berichten opgehaald/);
  assert.ok(h.indexOf('12 berichten opgehaald') < h.indexOf('wchat'));
});

test('een mislukte ophaalronde ziet er anders uit dan een geslaagde', () => {
  const fout = paneel({ gesprek: { berichten: [], melding: 'Ophalen is niet gelukt: 503', meldingSoort: 'fout' } });
  assert.match(fout.gesprekPaneelHtml(), /warn2/);
  const ok = paneel({ gesprek: { berichten: [], melding: '12 berichten opgehaald.', meldingSoort: 'ok' } });
  assert.doesNotMatch(ok.historiekMelding(), /warn2/);
});
