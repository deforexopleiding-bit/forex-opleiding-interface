// tests/iris-droogtest.test.js
//
// De droogtest: wat zou Iris de afgelopen week zelf gedaan hebben?
//
// Dit is het scherm waar iemand naar kijkt vlak voordat hij een schakelaar
// omzet die een programma namens zijn bedrijf laat praten. De belangrijkste
// eigenschap van het advies is daarom dat het TERUGHOUDEND is: de kosten van
// een verkeerde keuze liggen niet in het midden. Een categorie te laat
// aanzetten kost wat handwerk; te vroeg aanzetten kost een bericht dat niemand
// heeft goedgekeurd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZEKER_VANAF, ONZEKER_ONDER, vatSamen, adviesVoor } from '../api/iris-droogtest.js';
import { CATEGORIEEN } from '../api/_lib/iris/instellingen.js';

const bericht = (cat, zekerheid, extra = {}) => ({
  id: Math.random().toString(36).slice(2),
  gesprek_id: 'g1',
  categorie: cat,
  zekerheid,
  samenvatting: 'Wil weten wat er open staat.',
  ontvangen_op: '2026-09-20T10:00:00Z',
  verwerkt_op: '2026-09-20T10:01:00Z',
  ...extra,
});

// ── samenvatten ─────────────────────────────────────────────────────────────

test('elke categorie komt in de samenvatting, ook als er niets binnenkwam', () => {
  const s = vatSamen([], []);
  assert.equal(s.per_categorie.length, CATEGORIEEN.length);
  for (const v of s.per_categorie) assert.equal(v.berichten, 0);
});

test('berichten worden per categorie geteld', () => {
  const s = vatSamen([bericht('facturatie', 0.9), bericht('facturatie', 0.9), bericht('lms_toegang', 0.9)], []);
  const f = s.per_categorie.find((v) => v.categorie === 'facturatie');
  assert.equal(f.berichten, 2);
  assert.equal(s.per_categorie.find((v) => v.categorie === 'lms_toegang').berichten, 1);
});

test('zeker en onzeker worden apart geteld', () => {
  const s = vatSamen([
    bericht('facturatie', 0.95),
    bericht('facturatie', 0.85),
    bericht('facturatie', 0.6),
    bericht('facturatie', 0.3),
  ], []);
  const f = s.per_categorie.find((v) => v.categorie === 'facturatie');
  assert.equal(f.zeker, 2, 'alles vanaf 0,80');
  assert.equal(f.onzeker, 1, 'alles onder 0,50');
  assert.equal(f.berichten, 4, 'het midden telt wel mee als bericht');
});

test('de grenzen liggen waar ze horen', () => {
  assert.equal(ZEKER_VANAF, 0.80);
  assert.equal(ONZEKER_ONDER, 0.50);
  const s = vatSamen([bericht('facturatie', 0.80), bericht('facturatie', 0.49)], []);
  const f = s.per_categorie.find((v) => v.categorie === 'facturatie');
  assert.equal(f.zeker, 1, 'precies 0,80 telt als zeker');
  assert.equal(f.onzeker, 1, 'precies onder 0,50 telt als onzeker');
});

test('berichten zonder categorie worden APART geteld, niet weggelaten', () => {
  // Wie niet ziet hoeveel er niet ingedeeld kon worden, mist precies de
  // berichten waar Iris moeite mee had.
  const s = vatSamen([
    bericht('facturatie', 0.9),
    bericht(null, null, { verwerkt_op: null }),
    bericht(null, null, { verwerk_fout: 'model gaf niets terug' }),
  ], []);
  assert.equal(s.zonder_categorie.berichten, 2);
  assert.equal(s.zonder_categorie.redenen['nog niet ingedeeld'], 1);
  assert.equal(s.zonder_categorie.redenen['indelen mislukt'], 1);
});

test('een verzonnen categorie valt bij "zonder categorie"', () => {
  const s = vatSamen([bericht('verzonnen', 0.9)], []);
  assert.equal(s.zonder_categorie.berichten, 1);
});

test('er komen hoogstens drie voorbeelden per categorie', () => {
  // Meer leest niemand; minder geeft geen gevoel voor wat voor berichten het
  // zijn.
  const s = vatSamen(Array.from({ length: 20 }, () => bericht('facturatie', 0.9)), []);
  assert.equal(s.per_categorie.find((v) => v.categorie === 'facturatie').voorbeelden.length, 3);
});

test('een bericht zonder samenvatting wordt geen voorbeeld', () => {
  const s = vatSamen([bericht('facturatie', 0.9, { samenvatting: null })], []);
  assert.equal(s.per_categorie.find((v) => v.categorie === 'facturatie').voorbeelden.length, 0);
});

test('concepten worden aan hun gesprek gekoppeld', () => {
  const s = vatSamen(
    [bericht('facturatie', 0.9, { gesprek_id: 'g1' }), bericht('facturatie', 0.9, { gesprek_id: 'g2' })],
    [{ gesprek_id: 'g1', status: 'klaar' }],
  );
  assert.equal(s.per_categorie.find((v) => v.categorie === 'facturatie').concepten, 1);
});

test('rommel als invoer breekt niets', () => {
  for (const v of [null, undefined, 'x', 42]) {
    const s = vatSamen(v, v);
    assert.equal(s.per_categorie.length, CATEGORIEEN.length);
  }
});

test('null-berichten in de lijst worden overgeslagen', () => {
  const s = vatSamen([null, bericht('facturatie', 0.9), undefined], []);
  assert.equal(s.per_categorie.find((v) => v.categorie === 'facturatie').berichten, 1);
});

// ── het advies ──────────────────────────────────────────────────────────────

test('zonder berichten valt er niets te adviseren', () => {
  const a = adviesVoor({ berichten: 0, zeker: 0, onzeker: 0 });
  assert.equal(a.stand, 'uit');
  assert.match(a.uitleg, /te weinig|niets/i);
});

test('minder dan vijf berichten is te weinig om op te varen', () => {
  const a = adviesVoor({ berichten: 3, zeker: 3, onzeker: 0 });
  assert.equal(a.stand, 'concept');
  assert.match(a.uitleg, /te weinig/);
  assert.notEqual(a.kan_zelf, true);
});

test('veel onzekerheid betekent concept, ook bij veel berichten', () => {
  const a = adviesVoor({ berichten: 100, zeker: 70, onzeker: 30 });
  assert.equal(a.stand, 'concept');
  assert.match(a.uitleg, /niet zeker/);
  assert.notEqual(a.kan_zelf, true);
});

test('weinig zekerheid betekent ook concept', () => {
  const a = adviesVoor({ berichten: 100, zeker: 50, onzeker: 5 });
  assert.equal(a.stand, 'concept');
  assert.match(a.uitleg, /70%/);
});

test('een goede score adviseert NOG STEEDS concept — met een zetje erbij', () => {
  // Het advies is nooit "zet hem op zelf". Het is "dit ziet er goed uit, lees
  // de voorbeelden na en beslis zelf". Een programma dat adviseert zichzelf
  // meer bevoegdheid te geven, is een programma waarvan je het advies niet
  // meer los kunt zien van wat het voor zichzelf wil.
  const a = adviesVoor({ berichten: 100, zeker: 92, onzeker: 2 });
  assert.equal(a.stand, 'concept');
  assert.equal(a.kan_zelf, true);
  assert.match(a.uitleg, /lees de voorbeelden na/);
});

test('het advies noemt altijd een percentage of een aantal', () => {
  // Het geval zonder berichten valt hier buiten: er is dan niets te tellen,
  // en "0 van de 0" is geen mededeling maar een schijnprecisie.
  const gevallen = [
    { berichten: 3, zeker: 3, onzeker: 0 },
    { berichten: 100, zeker: 70, onzeker: 30 },
    { berichten: 100, zeker: 50, onzeker: 5 },
    { berichten: 100, zeker: 92, onzeker: 2 },
  ];
  for (const g of gevallen) {
    const a = adviesVoor(g);
    assert.ok(/\d/.test(a.uitleg), `"${a.uitleg}" noemt geen getal`);
  }
});

test('het advies is nooit leeg en nooit een code', () => {
  for (const g of [null, undefined, {}, { berichten: 7, zeker: 7, onzeker: 0 }]) {
    const a = adviesVoor(g);
    assert.ok(a.uitleg && a.uitleg.length > 20, 'een advies hoort een zin te zijn');
    assert.ok(['uit', 'concept', 'zelf'].includes(a.stand));
  }
});

test('adviesVoor geeft NOOIT "zelf" terug', () => {
  // Er is geen invoer waarbij deze functie zelf besluit dat Iris autonoom mag.
  // Dat blijft een menselijke beslissing, en die staat hier niet in code.
  const uitersten = [
    { berichten: 1000, zeker: 1000, onzeker: 0 },
    { berichten: 10000, zeker: 10000, onzeker: 0 },
  ];
  for (const g of uitersten) {
    assert.notEqual(adviesVoor(g).stand, 'zelf');
  }
});
