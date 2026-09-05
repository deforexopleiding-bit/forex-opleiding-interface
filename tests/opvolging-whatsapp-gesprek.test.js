// tests/opvolging-whatsapp-gesprek.test.js
//
// Het WhatsApp-gesprek in het CRM zelf, in plaats van wa.me in een nieuw
// tabblad. Drie dingen die hier zwaar wegen:
//
//  1. HET PRIVACYFILTER BLIJFT DE EERSTE REGEL.
//     De brug stuurt nu ook de tekst van UITGAANDE berichten mee. Dat mag
//     alleen omdat leadlijst.mag() daarvóór staat: alles buiten de leadlijst
//     wordt volledig genegeerd en nergens gelogd, groepen ook. Daves
//     privégesprekken verlaten de telefoon niet. Die volgorde is geen detail
//     maar de hele grens, dus die staat hieronder als test.
//
//  2. EEN KNOP DIE STIL NIETS DOET IS ERGER DAN GEEN KNOP.
//     Ligt de brug eruit of is hij niet gekoppeld, dan gaat het tekstveld op
//     slot mét de reden. Dezelfde regel als bij de vensters: liever uitleg dan
//     iets dat werkend lijkt.
//
//  3. EEN LEEG GESPREK IS GEEN STILTE.
//     Van vóór dit paneel bestaat er geen historiek. Een leeg scherm zou lezen
//     alsof er niets gezegd is; het paneel zegt dat het hier begint.

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
  assert.ok(window.__opvGesprekHelpers, 'de view hoort __opvGesprekHelpers te zetten');
  return window.__opvGesprekHelpers;
}

/** Verse view per test: _gesprek en _wa zijn gedeelde staat. */
function opstelling({ gesprek = {}, wa = {} } = {}) {
  const H = laadView();
  H.zetWa(Object.assign({ error: null, data: { verbonden: true, ziet_uitgaand: true } }, wa));
  H.zetGesprek(Object.assign({
    open: true, nummer: '32470123456', taakId: 'tk-1', naam: 'Jan Peeters',
    laden: false, error: null, code: null, berichten: [], verzendt: false, optimistisch: [],
  }, gesprek));
  return H;
}

const bericht = (over) => ({
  id: 'b1', richting: 'in', tekst: 'Hoi, ik kom donderdag',
  media_type: 'chat', tijdstip: '2026-09-05T10:30:00Z', ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// HET PRIVACYFILTER STAAT VOOROP
// ═══════════════════════════════════════════════════════════════════════════

test('de brug filtert op het ontvangende nummer vóór hij iets bouwt', () => {
  // Dit is de grens. Zou bouwUitgaandeGebeurtenis() vóór leadlijst.mag() staan,
  // dan bestaat er een pad waarlangs de tekst van een privégesprek in een
  // object terechtkomt — en daarmee mogelijk in een log.
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js'), 'utf8');
  const i = bron.indexOf("client.on('message_create'");
  assert.ok(i > 0, 'de message_create-handler hoort te bestaan');
  const blok = bron.slice(i, i + 1200);
  const filter = blok.indexOf('leadlijst.mag(');
  const bouw = blok.indexOf('bouwUitgaandeGebeurtenis(');
  assert.ok(filter > 0 && bouw > 0);
  assert.ok(filter < bouw, 'het filter hoort vóór het bouwen te staan');
});

test('ook bij inkomend blijft het filter de eerste regel', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js'), 'utf8');
  const i = bron.indexOf("client.on('message'");
  const blok = bron.slice(i, i + 900);
  assert.ok(blok.indexOf('leadlijst.mag(') < blok.indexOf('msg.body'),
    'de tekst hoort pas aangeraakt te worden nadat het filter door is');
});

test('groepen vallen af, ook los van de leadlijst', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/gebeurtenis.js'), 'utf8');
  const i = bron.indexOf('export function bouwUitgaandeGebeurtenis');
  assert.match(bron.slice(i, i + 400), /isGroep\(naar\)/,
    'een tweede slot op groepen, ook als de leadlijst ooit iets doorlaat');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE WEBHOOK SCHRIJFT NAAST DE POGING EEN GESPREKSREGEL
// ═══════════════════════════════════════════════════════════════════════════

test('alleen echte berichten worden een gespreksregel, geen statussen', () => {
  // 'afgeleverd' en 'gelezen' zijn statussen op een bericht dat er al staat.
  // Die als regel opnemen zou hetzelfde bericht drie keer in de chat zetten.
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');
  const i = bron.indexOf('async function bewaarGesprekRegel');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /richting = soort === 'antwoord_ontvangen' \? 'in' : soort === 'uitgaand' \? 'uit' : null/);
  assert.match(blok, /if \(!richting\) return;/, 'de rest valt eruit');
});

test('de gespreksregel is fail-soft en idempotent', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');
  const i = bron.indexOf('async function bewaarGesprekRegel');
  const blok = bron.slice(i, i + 1400);
  assert.match(blok, /error\.code !== '23505'/,
    'een dubbele bericht_id is geen fout maar het bewijs dat de regel er al stond');
  assert.match(blok, /catch \(e\)[\s\S]*console\.warn/,
    'een fout hier mag de poging-telling niet meesleuren');
  assert.doesNotMatch(blok, /console\.(warn|error|log)\([^)]*tekst/,
    'nooit de tekst zelf in een log');
});

test('opvolging_pogingen blijft de telling', () => {
  // De tekst hoort niet langer in resultaat geplakt te worden als bron voor het
  // gesprek; dat veld is 500 tekens en heeft geen richting.
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');
  assert.match(bron, /opvolging_wa_berichten/, 'het gesprek gaat naar de eigen tabel');
  assert.match(bron, /const volledigeTekst/, 'volledige tekst voor het gesprek');
  assert.match(bron, /slice\(0, 500\)/, 'en een korte samenvatting voor de historiek-regel');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET PANEEL
// ═══════════════════════════════════════════════════════════════════════════

test('het paneel is zichtbaar: scrim mét on', () => {
  // Zonder `on` staat het venster er wel maar is het onzichtbaar — de globale
  // .scrim heeft opacity:0 en pointer-events:none. Die les kostte een testronde.
  const H = opstelling();
  assert.match(H.gesprekPaneelHtml(), /class="scrim on rechts"/);
});

test('dicht paneel levert niets op', () => {
  assert.equal(opstelling({ gesprek: { open: false } }).gesprekPaneelHtml(), '');
});

test('inkomend links, uitgaand rechts, met het tijdstip erbij', () => {
  const H = opstelling();
  const inkomend = H.gesprekBubbel(bericht(), false);
  const uitgaand = H.gesprekBubbel(bericht({ richting: 'uit', tekst: 'Top, tot dan' }), false);
  assert.match(inkomend, /class="wbrij in"/);
  assert.match(uitgaand, /class="wbrij uit"/);
  assert.match(inkomend, /Hoi, ik kom donderdag/);
  assert.match(inkomend, /class="wtijd"/);
});

test('een spraakbericht zonder tekst wordt benoemd, niet leeg getoond', () => {
  const H = opstelling();
  const h = H.gesprekBubbel(bericht({ tekst: null, media_type: 'ptt' }), false);
  assert.match(h, /spraakbericht/);
});

test('de tekst van een lead wordt ge-escaped', () => {
  const H = opstelling();
  const h = H.gesprekBubbel(bericht({ tekst: '<script>alert(1)</script>' }), false);
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
});

test('een optimistische bubbel is herkenbaar als nog niet verstuurd', () => {
  const H = opstelling();
  const h = H.gesprekBubbel(bericht({ richting: 'uit' }), true);
  assert.match(h, /wbub bezig/);
  assert.match(h, /versturen/);
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN KNOP DIE STIL NIETS DOET
// ═══════════════════════════════════════════════════════════════════════════

test('met een gekoppelde brug kan er verstuurd worden', () => {
  const H = opstelling();
  assert.equal(H.gesprekKanVersturen().mag, true);
  assert.match(H.gesprekPaneelHtml(), /id="opv-wa-tekst"/);
  assert.match(H.gesprekPaneelHtml(), /__opvGesprekStuur/);
});

test('brug onbereikbaar: veld op slot met de reden erbij', () => {
  const H = opstelling({ wa: { error: 'timeout', data: null } });
  const k = H.gesprekKanVersturen();
  assert.equal(k.mag, false);
  assert.match(k.reden, /niet bereikbaar/);
  const h = H.gesprekPaneelHtml();
  assert.match(h, /disabled/);
  assert.doesNotMatch(h, /__opvGesprekStuur/, 'geen knop die niets doet');
});

test('brug niet gekoppeld: zelfde behandeling, andere reden', () => {
  const H = opstelling({ wa: { error: null, data: { verbonden: false } } });
  const k = H.gesprekKanVersturen();
  assert.equal(k.mag, false);
  assert.match(k.reden, /niet gekoppeld/);
});

test('status nog onbekend telt niet als gekoppeld', () => {
  // Anders staat het veld open in de seconde vóór de eerste statusronde, en
  // verdwijnt een bericht in het niets.
  const H = opstelling({ wa: { error: null, data: null } });
  assert.equal(H.gesprekKanVersturen().mag, false);
});

test('zonder telefoonnummer valt er niets te versturen', () => {
  const H = opstelling({ gesprek: { nummer: null } });
  const k = H.gesprekKanVersturen();
  assert.equal(k.mag, false);
  assert.match(k.reden, /geen telefoonnummer/);
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN LEEG GESPREK IS GEEN STILTE
// ═══════════════════════════════════════════════════════════════════════════

test('zonder berichten zegt het paneel dat er geen historiek is', () => {
  // De tekst zelf is bijgesteld toen 'Historiek ophalen' erbij kwam: het lege
  // blok legt nu uit dat de brug niets bewaarde én biedt aan het van het
  // toestel te halen. De bedoeling is dezelfde gebleven — uitleg in plaats van
  // een lege chat die als stilte leest — dus daar toetst dit op, niet op de
  // exacte woorden.
  const H = opstelling({ gesprek: { berichten: [] } });
  const h = H.gesprekPaneelHtml();
  assert.match(h, /Nog geen berichten in het systeem/);
  assert.match(h, /bewaarde tot nu toe niets/);
  assert.doesNotMatch(h, /class="wchat"/, 'geen lege chat die als stilte leest');
});

test('met berichten staat de chat er gewoon', () => {
  const H = opstelling({ gesprek: { berichten: [bericht(), bericht({ id: 'b2', richting: 'uit' })] } });
  const h = H.gesprekPaneelHtml();
  assert.match(h, /class="wchat"/);
  assert.doesNotMatch(h, /geen historiek/i);
});

test('een fout bij het ophalen is geen leeg gesprek', () => {
  const H = opstelling({ gesprek: { berichten: null, error: 'HTTP 500' } });
  const h = H.gesprekPaneelHtml();
  assert.match(h, /niet op te halen/);
  assert.doesNotMatch(h, /geen historiek/i);
});

test('een ontbrekende tabel wordt als configuratiefout benoemd', () => {
  const H = opstelling({ gesprek: { berichten: null, error: 'x', code: 'TABEL_ONTBREEKT' } });
  assert.match(H.gesprekPaneelHtml(), /migratie moet nog draaien/);
});

test('het wa.me-linkje blijft staan als uitgang', () => {
  const H = opstelling();
  assert.match(H.gesprekPaneelHtml(), /https:\/\/wa\.me\/32470123456/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TIMER — DEZELFDE VALKUIL ALS BIJ DE QR
// ═══════════════════════════════════════════════════════════════════════════

test('open gesprek ververst elke vijf seconden', () => {
  const H = opstelling();
  const t = H.bepaalWaTimers({ gemount: true, paneelOpen: false, verbonden: true, gesprekOpen: true });
  assert.equal(t.gesprekMs, H.WA_POLL_GESPREK_MS);
  assert.equal(t.gesprekMs, 5000);
});

test('dicht gesprek: geen timer', () => {
  const H = opstelling();
  const t = H.bepaalWaTimers({ gemount: true, paneelOpen: false, verbonden: true, gesprekOpen: false });
  assert.equal(t.gesprekMs, null);
});

test('weg van het scherm is alles uit, ook het gesprek', () => {
  // De shell kent geen afscheidshaak; het levensteken is het enige dat ons
  // vertelt dat de view weg is. Zou dit blijven lopen, dan pollt een verlaten
  // scherm eeuwig door.
  const H = opstelling();
  const t = H.bepaalWaTimers({ gemount: false, paneelOpen: true, verbonden: true, gesprekOpen: true });
  assert.equal(t.gesprekMs, null);
  assert.equal(t.statusMs, null);
  assert.equal(t.qrMs, null);
});

test('de gesprekstimer wordt per timer verzoend, niet blind herstart', () => {
  // Precies de QR-bug: herstelWaTimers draait elke statusronde, dus om de vijf
  // seconden met het paneel open. Blind stoppen en herstarten laat een timer
  // van vijf seconden net wel afgaan, maar dat is geluk — de afspraak is dat
  // een timer die al goed loopt met rust gelaten wordt.
  const bron = readFileSync(VIEW, 'utf8');
  assert.match(bron, /zetTimer\('gesprek', *'gesprekMs', *wens\.gesprekMs/);
});

test('sluiten ruimt de timer meteen op', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('window.__opvGesprekSluit = ');
  const blok = bron.slice(i, i + 400);
  assert.match(blok, /_gesprek\.open = false/);
  assert.match(blok, /herstelWaTimers\(\)/);
});

test('stopWaTimers ruimt ook de gesprekstimer op', () => {
  // Die functie hangt aan beforeunload en aan het wegnavigeren.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function stopWaTimers');
  const blok = bron.slice(i, i + 500);
  assert.match(blok, /_waTimers\.gesprek/);
  assert.match(blok, /gesprekMs = null/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KNOPPEN, EN DE POGING
// ═══════════════════════════════════════════════════════════════════════════

test('beide WhatsApp-knoppen openen het paneel, niet wa.me', () => {
  const bron = readFileSync(VIEW, 'utf8');
  for (const naam of ['__opvWa', '__opvCallWa']) {
    const i = bron.indexOf('window.' + naam + ' =');
    assert.ok(i > 0, naam + ' hoort te bestaan');
    const blok = bron.slice(i, i + 700);
    assert.match(blok, /opengesprek\(/, naam + ' hoort het paneel te openen');
    assert.doesNotMatch(blok, /window\.open\(/, naam + ' hoort geen tabblad meer te openen');
  }
});

test('geen van beide schrijft nog zelf een poging weg', () => {
  // __opvWa deed dat wel ('WhatsApp geopend') en __opvCallWa niet. Dat verschil
  // klopte al niet, en die rij telde bovendien een bericht dat misschien nooit
  // verstuurd is — een tabblad openen is geen contact. De poging ontstaat nu op
  // één plek: de webhook, zodra de brug meldt dat het bericht echt weg is.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function opengesprek');
  const blok = bron.slice(i, bron.indexOf('window.__opvGesprekStuur'));
  assert.doesNotMatch(blok, /opvolging-poging/,
    'geen poging bij het openen van het gesprek');
  assert.doesNotMatch(blok, /WhatsApp geopend/);
});

test('de send-endpoint schrijft de poging ook niet', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-send.js'), 'utf8');
  assert.doesNotMatch(bron, /from\('opvolging_pogingen'\)/,
    'die rij hoort pas te ontstaan als de brug meldt dat het bericht vertrokken is');
});
