// tests/opvolging-vensters.test.js
//
// De twee vensters van het dagsysteem:
//   · een spraakbericht per lead, vóór 09:00 Amsterdamse tijd;
//   · nabellen tussen 12:00 en 13:00, voor wie een spraakbericht kreeg en niet
//     antwoordde.
//
// Waarom dit zwaar weegt: het verschil tussen 'gedaan' en 'op tijd gedaan' is
// het hele punt van deze cijfers. Wie om 16:20 belt heeft gebeld, maar niet op
// het afgesproken moment. Telt dat als gedaan, dan meet het dashboard of er
// gewerkt is in plaats van of de afspraak nagekomen is — en dan stuurt het
// nergens meer op.
//
// De tweede reden is de klok. Alles gaat in Europe/Amsterdam, nooit via
// toISOString(): dat is UTC, en dan valt een gesprek van 00:30 op de vorige dag
// en zit een spraakbericht van 08:30 's winters ineens vóór een deadline die
// het net miste. De randen daarvan staan hieronder expliciet in.
//
// De view is een klassiek browser-script; we draaien het echte bestand in een
// vm-sandbox en pakken de functies van window.__opvVensterHelpers, zodat er
// geen tweede kopie van deze logica bestaat die stil uit elkaar kan lopen.

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
  assert.ok(window.__opvVensterHelpers, 'de view hoort __opvVensterHelpers te zetten');
  return window.__opvVensterHelpers;
}

const H = laadView();

/**
 * De sandbox is een eigen realm, dus een object dat daaruit komt heeft een
 * andere Object.prototype en struikelt over assert.deepEqual. Overzetten naar
 * een gewoon object van hier maakt de vergelijking weer eerlijk.
 */
const plat = (z) => (z == null ? z : { dag: z.dag, minuut: z.minuut, tijd: z.tijd });
const { inZone, beoordeelSpraak, beoordeelNabel, beoordeelDag, telVensters,
        isSpraakVerstuurd, isAntwoord } = H;

// Zomertijd: Amsterdam is dan UTC+2. 07:00Z = 09:00 lokaal.
const spraak = (iso) => ({ soort: 'spraakbericht', resultaat: 'spraakbericht verstuurd', tijdstip: iso });
const antw   = (iso) => ({ soort: 'whatsapp', resultaat: 'antwoord ontvangen: ja', tijdstip: iso });
const call   = (iso) => ({ soort: 'call', resultaat: 'gesproken', tijdstip: iso });
const DAG = '2026-09-07';                       // maandag, zomertijd (UTC+2)
const lokaal = (hhmm) => {
  const [u, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 7, u - 2, m)).toISOString();   // UTC+2
};

// ═══════════════════════════════════════════════════════════════════════════
// DE KLOK
// ═══════════════════════════════════════════════════════════════════════════

test('inZone leest Amsterdamse tijd, niet UTC', () => {
  assert.deepEqual(plat(inZone('2026-09-07T07:00:00Z')), { dag: '2026-09-07', minuut: 540, tijd: '09:00' });
  // Winter: UTC+1. Dezelfde UTC-tijd is dan een uur eerder lokaal.
  assert.deepEqual(plat(inZone('2026-12-07T07:00:00Z')), { dag: '2026-12-07', minuut: 480, tijd: '08:00' });
});

test('een moment vlak na middernacht hoort bij de nieuwe dag, niet de vorige', () => {
  // 22:30Z op 6 september is 00:30 lokaal op de 7e. Op de UTC-dag afgaan zou
  // dit gesprek op de verkeerde dag zetten — en dan telt het bij niemand mee.
  assert.deepEqual(plat(inZone('2026-09-06T22:30:00Z')), { dag: '2026-09-07', minuut: 30, tijd: '00:30' });
  // En andersom: 23:30 lokaal op de 7e is 21:30Z, nog steeds de 7e.
  assert.equal(inZone('2026-09-07T21:30:00Z').dag, '2026-09-07');
});

test('onleesbare tijdstippen leveren null, geen rare dag', () => {
  for (const raar of [null, undefined, '', 'gisteren', {}]) assert.equal(inZone(raar), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET SPRAAKBERICHT — DEADLINE 09:00
// ═══════════════════════════════════════════════════════════════════════════

test('vóór 09:00 is op tijd', () => {
  const o = beoordeelSpraak([spraak(lokaal('08:30'))], DAG);
  assert.equal(o.staat, 'op_tijd');
  assert.equal(o.tijd, '08:30');
});

test('precies 09:00 is te laat — de deadline is vóór negen', () => {
  // Expliciet vastgelegd omdat het de rand is waar twee lezingen mogelijk zijn.
  // Wil je 09:00:00 nog goedrekenen, dan is dit de test die je omzet.
  assert.equal(beoordeelSpraak([spraak(lokaal('09:00'))], DAG).staat, 'te_laat');
  assert.equal(beoordeelSpraak([spraak(lokaal('08:59'))], DAG).staat, 'op_tijd');
  assert.equal(beoordeelSpraak([spraak(lokaal('09:01'))], DAG).staat, 'te_laat');
});

test('geen spraakbericht is niet_gedaan', () => {
  assert.equal(beoordeelSpraak([], DAG).staat, 'niet_gedaan');
  assert.equal(beoordeelSpraak([call(lokaal('08:00'))], DAG).staat, 'niet_gedaan');
});

test('een tweede spraakbericht maakt een gemiste ochtend niet goed', () => {
  // Het eerste van de dag telt. Anders wist een berichtje om 11:00 de gemiste
  // deadline uit en klopt de dekking niet meer.
  const o = beoordeelSpraak([spraak(lokaal('09:30')), spraak(lokaal('11:00'))], DAG);
  assert.equal(o.staat, 'te_laat');
  assert.equal(o.tijd, '09:30');
});

test('een spraakbericht van een andere dag telt niet mee', () => {
  const gisteren = new Date(Date.UTC(2026, 8, 6, 6, 0)).toISOString();
  assert.equal(beoordeelSpraak([spraak(gisteren)], DAG).staat, 'niet_gedaan');
});

test('een ontvangen spraakbericht is geen verstuurd spraakbericht', () => {
  // De lead die zelf inspreekt is geen bewijs dat Dave iets gestuurd heeft.
  const ontvangen = { soort: 'spraakbericht', resultaat: 'spraakbericht ontvangen', tijdstip: lokaal('08:00') };
  assert.equal(isSpraakVerstuurd(ontvangen), false);
  assert.equal(beoordeelSpraak([ontvangen], DAG).staat, 'niet_gedaan');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET NABELVENSTER — 12:00 TOT 13:00
// ═══════════════════════════════════════════════════════════════════════════

const metSpraak = (...rest) => [spraak(lokaal('08:00')), ...rest];

test('bellen binnen het venster is op tijd', () => {
  const o = beoordeelNabel(metSpraak(call(lokaal('12:30'))), DAG);
  assert.equal(o.staat, 'op_tijd');
  assert.equal(o.tijd, '12:30');
});

test('de randen van het venster: 12:00 telt mee, 13:00 niet meer', () => {
  assert.equal(beoordeelNabel(metSpraak(call(lokaal('12:00'))), DAG).staat, 'op_tijd');
  assert.equal(beoordeelNabel(metSpraak(call(lokaal('12:59'))), DAG).staat, 'op_tijd');
  assert.equal(beoordeelNabel(metSpraak(call(lokaal('13:00'))), DAG).staat, 'te_laat');
  assert.equal(beoordeelNabel(metSpraak(call(lokaal('11:59'))), DAG).staat, 'te_laat');
});

test('om 16:20 bellen telt als te laat, niet als gedaan', () => {
  // Het voorbeeld uit de opdracht. Dit is waarom het venster bestaat.
  const o = beoordeelNabel(metSpraak(call(lokaal('16:20'))), DAG);
  assert.equal(o.staat, 'te_laat');
  assert.equal(o.tijd, '16:20');
});

test('wie geantwoord heeft hoeft niet nagebeld', () => {
  const o = beoordeelNabel(metSpraak(antw(lokaal('09:15'))), DAG);
  assert.equal(o.staat, 'niet_nodig');
  assert.equal(o.reden, 'heeft geantwoord');
});

test('zonder spraakbericht is nabellen niet aan de orde', () => {
  const o = beoordeelNabel([call(lokaal('12:30'))], DAG);
  assert.equal(o.staat, 'niet_nodig');
  assert.equal(o.reden, 'geen spraakbericht');
});

test('spraakbericht gehad, niet geantwoord, niet gebeld → niet_gedaan', () => {
  assert.equal(beoordeelNabel(metSpraak(), DAG).staat, 'niet_gedaan');
});

test('het eerste gesprek van de dag bepaalt het oordeel', () => {
  // Eerst te vroeg, daarna binnen het venster: dat blijft te laat. Anders kun
  // je een gemist venster witwassen door later nog eens te bellen.
  const o = beoordeelNabel(metSpraak(call(lokaal('10:00')), call(lokaal('12:30'))), DAG);
  assert.equal(o.staat, 'te_laat');
  assert.equal(o.tijd, '10:00');
});

test('een gesprek van een andere dag telt niet mee', () => {
  const morgen = new Date(Date.UTC(2026, 8, 8, 10, 30)).toISOString();   // 12:30 lokaal op de 8e
  assert.equal(beoordeelNabel(metSpraak(call(morgen)), DAG).staat, 'niet_gedaan');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TIJDZONESPRONGEN
// ═══════════════════════════════════════════════════════════════════════════

test('op de dag dat de klok vooruit gaat blijft het venster lokaal kloppen', () => {
  // 29 maart 2026: om 02:00 springt de klok naar 03:00. Voor die sprong is
  // Amsterdam UTC+1, erna UTC+2. Beide kanten moeten juist gelezen worden.
  const dag = '2026-03-29';
  assert.equal(inZone('2026-03-29T00:30:00Z').tijd, '01:30', 'vóór de sprong: UTC+1');
  assert.equal(inZone('2026-03-29T07:00:00Z').tijd, '09:00', 'na de sprong: UTC+2');

  // 06:59Z is 08:59 lokaal → net op tijd. 07:00Z is 09:00 → te laat.
  assert.equal(beoordeelSpraak([spraak('2026-03-29T06:59:00Z')], dag).staat, 'op_tijd');
  assert.equal(beoordeelSpraak([spraak('2026-03-29T07:00:00Z')], dag).staat, 'te_laat');

  // Wie de offset vast op +1 zou zetten, leest 10:30Z als 11:30 en zou dit
  // gesprek buiten het venster plaatsen. Lokaal is het 12:30.
  const pg = [spraak('2026-03-29T06:00:00Z'), call('2026-03-29T10:30:00Z')];
  assert.equal(beoordeelNabel(pg, dag).staat, 'op_tijd');
  assert.equal(beoordeelNabel(pg, dag).tijd, '12:30');
});

test('op de dag dat de klok terug gaat ook', () => {
  // 25 oktober 2026: om 03:00 terug naar 02:00. Erna is Amsterdam UTC+1.
  const dag = '2026-10-25';
  assert.equal(inZone('2026-10-25T00:30:00Z').tijd, '02:30', 'vóór de sprong: nog UTC+2');
  assert.equal(inZone('2026-10-25T11:30:00Z').tijd, '12:30', 'na de sprong: UTC+1');

  const pg = [spraak('2026-10-25T07:00:00Z'), call('2026-10-25T11:30:00Z')];
  assert.equal(beoordeelSpraak(pg, dag).staat, 'op_tijd', '08:00 lokaal');
  assert.equal(beoordeelNabel(pg, dag).staat, 'op_tijd', '12:30 lokaal');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLING VOOR HET DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

test('telVensters telt per uitkomst, en laat het nabellen alleen over wie het nodig had', () => {
  const taken = [
    { pogingen: metSpraak(call(lokaal('12:15'))) },                    // spraak ok, nabel ok
    { pogingen: metSpraak(call(lokaal('16:20'))) },                    // spraak ok, nabel te laat
    { pogingen: metSpraak() },                                          // spraak ok, niet gebeld
    { pogingen: [spraak(lokaal('09:30')), call(lokaal('12:30'))] },     // spraak te laat, nabel ok
    { pogingen: [] },                                                   // niets
    { pogingen: metSpraak(antw(lokaal('09:00'))) },                     // geantwoord → niet nodig
  ];
  const t = telVensters(taken, DAG);

  assert.equal(t.spraak.totaal, 6);
  assert.equal(t.spraak.op_tijd, 4);
  assert.equal(t.spraak.te_laat, 1);
  assert.equal(t.spraak.niet_gedaan, 1);

  // De zesde had geen nabellen nodig en zakt dus niet in de noemer — anders
  // zou 'goed werk doen' de dekking omlaag halen.
  assert.equal(t.nabel.totaal, 4);
  assert.equal(t.nabel.op_tijd, 2);
  assert.equal(t.nabel.te_laat, 1);
  assert.equal(t.nabel.niet_gedaan, 1);
  assert.equal(t.nabel.niet_nodig, 2, 'de lege taak en degene die antwoordde');
});

test('lege of rommelige invoer levert nullen, geen uitzondering', () => {
  for (const raar of [null, undefined, [], [null], [{}]]) {
    const t = telVensters(raar, DAG);
    assert.ok(t.spraak.totaal >= 0);
    assert.ok(t.nabel.totaal >= 0);
  }
  assert.deepEqual(beoordeelDag(null, DAG).spraak.staat, 'niet_gedaan');
});

test('isAntwoord onderscheidt inkomend van uitgaand', () => {
  assert.equal(isAntwoord(antw(lokaal('09:00'))), true);
  assert.equal(isAntwoord({ soort: 'spraakbericht', resultaat: 'spraakbericht ontvangen', tijdstip: lokaal('09:00') }), true);
  assert.equal(isAntwoord({ soort: 'whatsapp', resultaat: 'WhatsApp verstuurd', tijdstip: lokaal('09:00') }), false);
  assert.equal(isAntwoord(call(lokaal('09:00'))), false);
});
