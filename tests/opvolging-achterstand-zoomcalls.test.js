// tests/opvolging-achterstand-zoomcalls.test.js
//
// ONAFGERONDE ZOOMCALLS BLEVEN OP HUN EIGEN DAG STAAN.
//
// Maxims regel: Dave rondt elke zoomcall af — klant geworden, wil nog beslissen
// (met datum), no-show, of geen interesse. Rondt hij er een niet af, dan staat
// die de volgende dag bovenaan: 'van gisteren, werk deze af'.
//
// Twee dingen klopten niet, allebei gemeten op 10 september:
//
//  1. ER WAS GEEN MEESCHUIVEN. /api/opvolging-agenda van 9 september gaf 3
//     calls zonder afronding (10:00 en 12:00 scheduled, 11:00 cancelled) en
//     8 september 1 (15:00). Het callsblok toont alleen de gekozen dag, en die
//     dag kijkt niemand meer terug.
//
//  2. NO-SHOW TOONDE NOOIT 'AFGEROND'. __opvCallBevestig('no_show') maakt
//     terecht een werklijstkaart (reden no_show_call, bron_ref.appointment_id)
//     — dat werkt, zie m andriese en Shudiño in de werklijst — maar schrijft
//     bewust NIETS naar de uitkomstmotor: dat outcome maakt daar een eigen
//     follow_up_lead en dan staat dezelfde persoon in twee modules te wachten
//     (waarschuwingsblok bij CALL_UITKOMST, productie-incident 20 mei).
//     Gevolg: `uitkomst` blijft leeg en de call staat eeuwig op 'Afronden →'.
//
// Punt 2 is niet alleen lelijk: zonder fix zou elke no-show vanaf nu élke dag
// als achterstand terugkomen. De twee horen dus in één PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  afrondLabelVanTaak, achterstandVenster, achterstandRij,
  ACHTERSTAND_VANAF, ACHTERSTAND_DAGEN, ACHTERSTAND_STATUS,
} from '../api/opvolging-agenda.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

// Donderdag 10 september 2026, 10:00 Amsterdamse tijd (= 08:00 UTC).
const VANDAAG = '2026-09-10';

function laadView(iso = VANDAAG + 'T08:00:00Z') {
  const vast = Date.parse(iso);
  class VasteDate extends Date {
    constructor(...a) { if (a.length === 0) super(vast); else super(...a); }
    static now() { return vast; }
  }
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
    Date: VasteDate, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set, Map,
  });
  runInContext(readFileSync(BADGE_HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  return window;
}

const H = () => laadView().__opvAchterstandHelpers;
const N = () => laadView().__opvNuHelpers;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE AFRONDING DIE ALLEEN ALS WERKLIJSTKAART BESTAAT
// ═══════════════════════════════════════════════════════════════════════════

test('een no-show-kaart telt als afgerond, met de werklijst erbij in het label', () => {
  const v = afrondLabelVanTaak({ reden: 'no_show_call' });
  assert.equal(v.code, 'no_show_call');
  assert.equal(v.label, 'niet gekomen · in je werklijst');
});

test("'wil nog beslissen' en 'geen interesse' krijgen hun eigen woorden", () => {
  assert.equal(afrondLabelVanTaak({ reden: 'wil_nog_beslissen' }).label, 'wil nog beslissen');
  // Die kaart draagt reden 'afgemeld'; het onderscheid zit in reden_code.
  const gi = afrondLabelVanTaak({ reden: 'afgemeld', reden_code: 'zoom_geen_interesse' });
  assert.equal(gi.code, 'zoom_geen_interesse');
  assert.equal(gi.label, 'geen interesse');
});

test('reden_code wint van reden — anders leest een geen-interesse-kaart als iets anders', () => {
  const v = afrondLabelVanTaak({ reden: 'no_show_call', reden_code: 'zoom_geen_interesse' });
  assert.equal(v.label, 'geen interesse');
});

test('een kaart die niets afrondt levert null op', () => {
  // Een gewone opvolgtaak bij een call (bv. handmatig aangemaakt) is geen
  // uitkomst. Die als 'Afgerond' tonen zou een uitkomst suggereren die niemand
  // heeft vastgelegd — dezelfde fout als een GHL-status napraten.
  for (const t of [null, {}, { reden: 'agenda_gestuurd' }, { reden: '' }, { reden_code: 'iets_anders' }]) {
    assert.equal(afrondLabelVanTaak(t), null, JSON.stringify(t));
  }
});

test('de motor wordt niet aangeraakt — alleen gelezen uit opvolging_taken', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-agenda.js'), 'utf8');
  const i = bron.indexOf('async function hangAfrondUitTaak');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2200);
  assert.match(blok, /from\('opvolging_taken'\)/);
  assert.doesNotMatch(blok, /follow_up_appointments/, 'geen schrijf- of leesactie op de afsprakenrij');
  assert.doesNotMatch(blok, /follow-up-appointment-outcome/);
  // Alleen waar er nog GEEN echte uitkomst staat: Daves eigen afrondknop wint.
  assert.match(blok, /c\.afrond\.toon === 'knop'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · HET VENSTER — twee weken terug, nooit vóór ACHTERSTAND_VANAF
// ═══════════════════════════════════════════════════════════════════════════

test('het venster loopt tot het begin van vandaag, niet tot nu', () => {
  // Anders zou een call van vanochtend 09:00 al als achterstand van "eerdere
  // dagen" gelden, en die hoort gewoon in het blok van vandaag.
  const { totIso } = achterstandVenster(VANDAAG);
  assert.equal(totIso, '2026-09-09T22:00:00.000Z', 'middernacht Amsterdam = 22:00 UTC in de zomer');
});

test('nooit vóór ACHTERSTAND_VANAF — de afrondknop bestond er niet', () => {
  // Twee weken terug vanaf 10 september is 27 augustus, maar de knop bestond
  // pas op 8 september. Alles daarvoor zou een aanklacht zijn over een periode
  // waarin er niets te drukken viel.
  assert.equal(ACHTERSTAND_VANAF, '2026-09-08');
  const { vanIso } = achterstandVenster(VANDAAG);
  assert.equal(vanIso, '2026-09-07T22:00:00.000Z', 'begin van 8 september in Amsterdam');
});

test('de twee-wekengrens bijt zodra ACHTERSTAND_VANAF ver genoeg achter ons ligt', () => {
  const laat = '2026-10-01';
  const { vanIso } = achterstandVenster(laat);
  const dagen = (Date.parse('2026-09-30T22:00:00.000Z') - Date.parse(vanIso)) / 86400000;
  assert.equal(dagen, ACHTERSTAND_DAGEN);
});

test('op ACHTERSTAND_VANAF zelf is het venster leeg — geen negatieve reeks', () => {
  assert.equal(achterstandVenster(ACHTERSTAND_VANAF).leeg, true);
  assert.equal(achterstandVenster(VANDAAG).leeg, false);
});

test('geannuleerde en verzette calls staan niet in de statuslijst — die zijn niet gevoerd', () => {
  assert.deepEqual(ACHTERSTAND_STATUS, ['scheduled', 'in_progress', 'completed', 'no_show']);
  for (const weg of ['cancelled', 'verplaatst', 'wacht_op_reschedule', 'verwijderd']) {
    assert.equal(ACHTERSTAND_STATUS.includes(weg), false, weg);
  }
});

test('de query filtert op lege uitkomst, is_test en zonder-opvolgtaak', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-agenda.js'), 'utf8');
  const i = bron.indexOf('async function leesAchterstand');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 3500);
  assert.match(blok, /\.is\('uitkomst', null\)/);
  assert.match(blok, /\.in\('status', ACHTERSTAND_STATUS\)/);
  assert.match(blok, /a\.is_test !== true/);
  assert.match(blok, /!metTaak\.has\(String\(a\.id\)\)/,
    'een call met een werklijstkaart IS afgerond en mag niet meeschuiven');
});

test('kan de takenlijst niet gelezen worden, dan komt er GEEN halve achterstand', () => {
  // Zonder die lezing weten we niet welke calls al afgerond zijn, en dan zou
  // Dave kaarten terugkrijgen die hij gisteren heeft weggewerkt.
  const bron = readFileSync(join(ROOT, 'api/opvolging-agenda.js'), 'utf8');
  const i = bron.indexOf('achterstand: taken lezen (soft)');
  assert.ok(i > 0, 'de waarschuwing hoort te bestaan');
  assert.match(bron.slice(i, i + 120), /return \[\];/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE RIJ — zelfde vorm als een gepland-call
// ═══════════════════════════════════════════════════════════════════════════

const afspraak = (over) => ({
  id: 'ap-1', lead_name: 'Sander', lead_phone: '+32470111222', lead_email: null,
  scheduled_at: '2026-09-09T13:00:00Z', status: 'scheduled', ...over,
});

test('een achterstandsrij draagt zijn eigen dag en dezelfde knoppen', () => {
  const r = achterstandRij(afspraak());
  assert.equal(r.dag, '2026-09-09');
  assert.equal(r.tijd, '15:00');
  assert.equal(r.naam, 'Sander');
  assert.deepEqual(r.knoppen, { afronden: true, bellen: true, whatsapp: true, zoom: false });
  assert.deepEqual(r.afrond, { toon: 'knop', vastgelegd: null });
});

test('geen Zoom-knop: die call is geweest', () => {
  const r = achterstandRij(afspraak({ zoom_join_url: 'https://zoom.us/j/1' }));
  assert.equal(r.knoppen.zoom, false);
  assert.equal(r.zoom_url, null);
});

test('zonder nummer geen bel- en WhatsApp-knop', () => {
  const r = achterstandRij(afspraak({ lead_phone: null }));
  assert.equal(r.knoppen.bellen, false);
  assert.equal(r.knoppen.whatsapp, false);
  assert.equal(r.knoppen.afronden, true, 'afronden kan altijd');
});

test('wa staat op null — de vensters rekenen niet met de achterstand', () => {
  // Die hoort bij een andere dag. Hem meetellen zou het spraakvenster van
  // vandaag laten zakken door een call van gisteren.
  assert.equal(achterstandRij(afspraak()).wa, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · callOp — twee reeksen, en 'a<n>' is de achterstand
// ═══════════════════════════════════════════════════════════════════════════

test("callOp('a0') pakt de achterstand en niet de calls van vandaag", () => {
  const h = H();
  h.zetCalls(VANDAAG, [{ naam: 'Vandaag', telefoon: '1' }]);
  h.zetAchterstand(VANDAAG, [{ naam: 'Gisteren', telefoon: '2', dag: '2026-09-09' }]);

  assert.equal(h.callOp(0).naam, 'Vandaag');
  assert.equal(h.callOp('a0').naam, 'Gisteren');
  assert.equal(h.callOp('a1'), null, 'buiten de reeks is null, geen crash');
  assert.equal(h.callOp('a'), null);
});

test('de view indexeert _calls.data nergens meer rechtstreeks', () => {
  // Eén gedeelde nummering breekt zodra er een rij bij komt — dan rondt Dave
  // de verkeerde persoon af.
  const bron = readFileSync(VIEW, 'utf8');
  assert.doesNotMatch(bron, /\(_calls\.data \|\| \[\]\)\[m\.callIndex\]/);
  assert.match(bron, /const c = callOp\(m\.callIndex\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · HET ETIKET — de dag van de call, niet de dag op het scherm
// ═══════════════════════════════════════════════════════════════════════════

test('een kaart uit een achterstandscall krijgt de dag van die call', () => {
  const h = H();
  assert.equal(h.callBadgeDag({ dag: '2026-09-08' }), '2026-09-08');
});

test('een call van vandaag houdt de dag van het scherm', () => {
  const h = H();
  assert.equal(h.callBadgeDag({}), VANDAAG);
  assert.equal(h.callBadgeDag(null), VANDAAG);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · HET BLOK — zichtbaar, met dag en tijd, en weg als er niets is
// ═══════════════════════════════════════════════════════════════════════════

test('zonder achterstand staat er niets', () => {
  const h = H();
  h.zetAchterstand(VANDAAG, []);
  assert.equal(h.achterstandBlok(), '');
});

test('het blok noemt het aantal, de uitleg en de knoppen per rij', () => {
  const h = H();
  h.zetAchterstand(VANDAAG, [
    achterstandRij(afspraak({ id: 'ap-1', lead_name: 'Sander', scheduled_at: '2026-09-09T13:00:00Z' })),
    achterstandRij(afspraak({ id: 'ap-2', lead_name: 'Mehran', scheduled_at: '2026-09-07T13:00:00Z' })),
  ]);
  const h1 = h.achterstandBlok();

  assert.match(h1, /Nog af te ronden &mdash; van eerdere dagen/);
  assert.match(h1, /<span class="n">2<\/span>/);
  assert.match(h1, /Rond deze eerst af/);
  assert.match(h1, /Sander/);
  assert.match(h1, /Mehran/);
  assert.match(h1, /__opvCallAfrond\('a0'\)/);
  assert.match(h1, /__opvCallAfrond\('a1'\)/);
  assert.match(h1, /__opvCallBel\('a0'\)/);
  assert.match(h1, /__opvCallWa\('a0'\)/);
});

test('gisteren heet gisteren, eerder krijgt een datum', () => {
  const h = H();
  assert.equal(h.achterstandDag('2026-09-09'), 'gisteren');
  assert.equal(h.achterstandDag('2026-09-07'), '07/09');
  assert.equal(h.achterstandDag(null), '');
});

test('het blok staat BOVEN de calls van vandaag', () => {
  // Wat blijft liggen gaat vóór wat er nog aan komt.
  const bron = readFileSync(VIEW, 'utf8');
  const a = bron.indexOf('h += achterstandBlok();');
  const c = bron.indexOf('h += callsBlok(dag);');
  assert.ok(a > 0 && c > 0);
  assert.ok(a < c, 'achterstandBlok hoort eerst getekend te worden');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE NU-DOEN-BALK
// ═══════════════════════════════════════════════════════════════════════════

const nuBasis = (over) => ({
  dag: VANDAAG, nu: VANDAAG, minuut: 10 * 60, brugZiet: true,
  calls: [], callsStaat: 'ok', vensterTaken: [], openTaken: 0, achterstand: 0, ...over,
});

test('achterstand komt in de balk, oranje, met het aantal erin', () => {
  const { bepaalNuDoen } = N();
  const a = bepaalNuDoen(nuBasis({ achterstand: 3 }));
  assert.equal(a.soort, 'achterstand');
  assert.equal(a.telaat, true);
  assert.match(a.titel, /3 zoomcall\(s\) van eerdere dagen nog afronden/);
  assert.match(a.uitleg, /Gesproken maar zonder uitkomst\. Die eerst\./);
});

test('een call die nu bezig is gaat vóór de achterstand — daar zit iemand op te wachten', () => {
  const { bepaalNuDoen } = N();
  const a = bepaalNuDoen(nuBasis({
    achterstand: 3,
    calls: [{ naam: 'Nu bezig', start: VANDAAG + 'T08:00:00Z' }],   // 10:00 Amsterdam
  }));
  assert.equal(a.soort, 'call_bezig');
});

test('de achterstand gaat vóór de twee vensters', () => {
  const { bepaalNuDoen } = N();
  const a = bepaalNuDoen(nuBasis({
    achterstand: 1,
    // Een taak zonder enige poging: het spraakvenster zou hier aanslaan.
    vensterTaken: [{ id: 't1', pogingen: [] }],
  }));
  assert.equal(a.soort, 'achterstand');
});

test('zonder achterstand blijft de balk doen wat hij deed', () => {
  const { bepaalNuDoen } = N();
  const a = bepaalNuDoen(nuBasis({ achterstand: 0, vensterTaken: [{ id: 't1', pogingen: [] }] }));
  assert.equal(a.soort, 'spraak');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · DE BEDRADING — de view vraagt er alleen op vandaag om
// ═══════════════════════════════════════════════════════════════════════════

test('achterstand=1 gaat alleen mee als de gekozen dag vandaag is', () => {
  const bron = readFileSync(VIEW, 'utf8');
  assert.match(bron, /const vraagAchterstand = dag === vandaag\(\);/);
  assert.match(bron, /\(vraagAchterstand \? '&achterstand=1' : ''\)/);
  assert.match(bron, /st\.achterstand = vraagAchterstand \? \(j\.achterstand \|\| \[\]\) : \[\];/);
});

test('de server leest de achterstand alleen op verzoek', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-agenda.js'), 'utf8');
  assert.match(bron, /const achterstandGevraagd = String\(q\.achterstand \|\| ''\) === '1';/);
  assert.match(bron, /achterstandGevraagd \? await leesAchterstand\(\) : \[\]/);
  assert.match(bron, /\.\.\.\(achterstandGevraagd \? \{ achterstand \} : \{\}\)/);
});

test('leegTakenCache wist ook de achterstand', () => {
  // Na afronden verdwijnt de rij; zou de cache blijven staan, dan komt hij bij
  // de eerstvolgende render gewoon terug.
  const bron = readFileSync(VIEW, 'utf8');
  const treffers = bron.match(/_calls\.data = null; _calls\.key = null; _calls\.error = null; _calls\.achterstand = \[\];/g);
  assert.ok(treffers && treffers.length >= 2, 'op elke plek waar de cache leeg gaat');
});
