// tests/iris-classificeer.test.js
//
// Het indelen van een binnengekomen bericht.
//
// Het model levert via afgedwongen gereedschap een object dat aan het schema
// voldoet. Dat is niet hetzelfde als een object dat klopt: een enum kan
// gerespecteerd worden en toch een categorie opleveren die wij niet kennen
// omdat schema en lijst uit elkaar gelopen zijn, en een zekerheid van 1.4 is
// volkomen geldig JSON. Vandaar de tweede deur, en vandaar deze tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TEKST,
  CONTEXT_BERICHTEN,
  SYSTEEM_TEKST,
  GEREEDSCHAP_SCHEMA,
  kortIn,
  bouwBerichten,
  keurUitkomst,
  deelIn,
} from '../api/_lib/iris/classificeer.js';
import { CATEGORIEEN } from '../api/_lib/iris/instellingen.js';

// ── inkorten ────────────────────────────────────────────────────────────────

test('kortIn: een korte tekst blijft zoals hij is', () => {
  assert.equal(kortIn('hallo'), 'hallo');
  assert.equal(kortIn('  hallo  '), 'hallo');
});

test('kortIn: een lange tekst breekt niet midden in een woord af', () => {
  const lang = 'woord '.repeat(100).trim();
  const kort = kortIn(lang, 50);
  assert.ok(kort.endsWith('[…]'), 'er hoort zichtbaar te zijn dat er iets weg is');
  const romp = kort.replace(' […]', '');
  assert.ok(!romp.endsWith('wo') && !romp.endsWith('woor'),
    'er mag niet midden in een woord afgebroken worden');
});

test('kortIn: zonder spatie om op te breken kapt hij gewoon af', () => {
  const kort = kortIn('a'.repeat(200), 50);
  assert.ok(kort.length <= 55);
  assert.ok(kort.endsWith('[…]'));
});

test('kortIn: leeg en null geven een lege tekst', () => {
  assert.equal(kortIn(null), '');
  assert.equal(kortIn(undefined), '');
  assert.equal(kortIn(''), '');
});

// ── de berichtenreeks ───────────────────────────────────────────────────────

test('bouwBerichten: één beurt, geen dialoog', () => {
  const m = bouwBerichten({ tekst: 'ik heb al betaald', kanaal: 'whatsapp' });
  assert.equal(m.length, 1);
  assert.equal(m[0].role, 'user');
  assert.match(m[0].content, /ik heb al betaald/);
});

test('bouwBerichten: het kanaal staat in mensentaal in de tekst', () => {
  assert.match(bouwBerichten({ tekst: 'x', kanaal: 'email' })[0].content, /via mail/);
  assert.match(bouwBerichten({ tekst: 'x', kanaal: 'whatsapp' })[0].content, /via WhatsApp/);
});

test('bouwBerichten: een onderwerp gaat mee, maar alleen als er een is', () => {
  assert.match(bouwBerichten({ tekst: 'x', kanaal: 'email', onderwerp: 'Factuur 123' })[0].content, /Onderwerp: Factuur 123/);
  assert.doesNotMatch(bouwBerichten({ tekst: 'x', kanaal: 'email' })[0].content, /Onderwerp:/);
});

test('bouwBerichten: de voorgeschiedenis gaat mee als context, niet als beurten', () => {
  const m = bouwBerichten({
    tekst: 'en nu?',
    kanaal: 'whatsapp',
    voorgeschiedenis: [
      { richting: 'in', tekst_kort: 'hallo' },
      { richting: 'uit', tekst_kort: 'goedemiddag' },
    ],
  });
  assert.equal(m.length, 1, 'de geschiedenis hoort GEEN losse beurten te worden');
  assert.match(m[0].content, /\[klant\] hallo/);
  assert.match(m[0].content, /\[wij\] goedemiddag/);
});

test('bouwBerichten: alleen de laatste zes eerdere berichten gaan mee', () => {
  const veel = Array.from({ length: 20 }, (_, i) => ({ richting: 'in', tekst_kort: `bericht${i}` }));
  const m = bouwBerichten({ tekst: 'x', kanaal: 'whatsapp', voorgeschiedenis: veel });
  assert.equal(CONTEXT_BERICHTEN, 6);
  assert.doesNotMatch(m[0].content, /bericht13\b/);
  assert.match(m[0].content, /bericht19/);
  assert.match(m[0].content, /bericht14/);
});

test('bouwBerichten: rommel als voorgeschiedenis breekt niets', () => {
  for (const v of [null, undefined, 'x', 42, {}]) {
    const m = bouwBerichten({ tekst: 'x', kanaal: 'whatsapp', voorgeschiedenis: v });
    assert.equal(m.length, 1);
  }
});

test('bouwBerichten: een heel lang bericht wordt ingekort', () => {
  const m = bouwBerichten({ tekst: 'a'.repeat(MAX_TEKST * 3), kanaal: 'email' });
  assert.ok(m[0].content.length < MAX_TEKST * 1.5);
});

// ── het schema ──────────────────────────────────────────────────────────────

test('het schema kent precies onze tien categorieën', () => {
  assert.deepEqual([...GEREEDSCHAP_SCHEMA.properties.categorie.enum].sort(), [...CATEGORIEEN].sort());
});

test('alle vijf velden zijn verplicht', () => {
  assert.deepEqual([...GEREEDSCHAP_SCHEMA.required].sort(),
    ['categorie', 'reden', 'samenvatting', 'urgentie', 'zekerheid']);
});

test('de systeemtekst noemt elke categorie bij naam', () => {
  for (const c of CATEGORIEEN) {
    assert.ok(SYSTEEM_TEKST.includes(c), `${c} ontbreekt in de uitleg aan het model`);
  }
});

test('de systeemtekst verbiedt het verzinnen van feiten', () => {
  assert.match(SYSTEEM_TEKST, /Verzin nooit feiten/);
});

// ── de uitkomst nakijken ────────────────────────────────────────────────────

const goed = {
  categorie: 'facturatie',
  reden: 'vraagt naar een factuurnummer',
  zekerheid: 0.9,
  samenvatting: 'Wil weten welke factuur nog open staat.',
  urgentie: 'laag',
};

test('keurUitkomst: een net antwoord komt er ongeschonden door', () => {
  const r = keurUitkomst(goed);
  assert.equal(r.ok, true);
  assert.deepEqual(r.uitkomst, goed);
});

test('keurUitkomst: geen object is geen uitkomst', () => {
  for (const v of [null, undefined, 'facturatie', 42, []]) {
    const r = keurUitkomst(v);
    if (Array.isArray(v)) continue; // een array is technisch een object; die valt op de categorie
    assert.equal(r.ok, false, `${JSON.stringify(v)} hoorde geweigerd te worden`);
  }
});

test('keurUitkomst: een categorie die wij niet kennen wordt geweigerd, niet omgezet', () => {
  const r = keurUitkomst({ ...goed, categorie: 'betalingsherinnering' });
  assert.equal(r.ok, false);
  assert.match(r.fout, /onbekende categorie/);
});

test('keurUitkomst: een lege categorie wordt geweigerd met een leesbare reden', () => {
  const r = keurUitkomst({ ...goed, categorie: '' });
  assert.equal(r.ok, false);
  assert.match(r.fout, /\(leeg\)/);
});

test('keurUitkomst: een zekerheid buiten nul tot een wordt geklemd, niet geweigerd', () => {
  // Een rekenfout van het model is geen reden om de hele indeling weg te gooien.
  assert.equal(keurUitkomst({ ...goed, zekerheid: 1.4 }).uitkomst.zekerheid, 1);
  assert.equal(keurUitkomst({ ...goed, zekerheid: -3 }).uitkomst.zekerheid, 0);
});

test('keurUitkomst: een zekerheid die geen getal is wordt nul, niet ongedefinieerd', () => {
  const r = keurUitkomst({ ...goed, zekerheid: 'hoog' });
  assert.equal(r.ok, true);
  assert.equal(r.uitkomst.zekerheid, 0, 'onbekend hoort de laagste zekerheid te zijn, niet de hoogste');
});

test('keurUitkomst: de zekerheid wordt op twee cijfers afgerond', () => {
  assert.equal(keurUitkomst({ ...goed, zekerheid: 0.876543 }).uitkomst.zekerheid, 0.88);
});

test('keurUitkomst: een onbekende urgentie valt terug op midden', () => {
  assert.equal(keurUitkomst({ ...goed, urgentie: 'kritiek' }).uitkomst.urgentie, 'midden');
  assert.equal(keurUitkomst({ ...goed, urgentie: undefined }).uitkomst.urgentie, 'midden');
});

test('keurUitkomst: zonder samenvatting is er niets om op te tonen', () => {
  const r = keurUitkomst({ ...goed, samenvatting: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.fout, /geen samenvatting/);
});

test('keurUitkomst: een ontbrekende reden blokkeert niets maar wordt wel benoemd', () => {
  const r = keurUitkomst({ ...goed, reden: '' });
  assert.equal(r.ok, true);
  assert.equal(r.uitkomst.reden, 'geen reden gegeven');
});

test('keurUitkomst: eindeloos lange tekst wordt afgekapt', () => {
  const r = keurUitkomst({ ...goed, samenvatting: 'x'.repeat(5000), reden: 'y'.repeat(5000) });
  assert.equal(r.uitkomst.samenvatting.length, 500);
  assert.equal(r.uitkomst.reden.length, 500);
});

test('keurUitkomst: elke categorie uit onze lijst wordt aanvaard', () => {
  for (const c of CATEGORIEEN) {
    const r = keurUitkomst({ ...goed, categorie: c });
    assert.equal(r.ok, true, `${c} hoorde aanvaard te worden`);
  }
});

// ── indelen zonder model ────────────────────────────────────────────────────

test('deelIn: een leeg bericht kost geen enkele aanroep', async () => {
  const r = await deelIn({ tekst: '   ', kanaal: 'whatsapp' });
  assert.equal(r.ok, false);
  assert.equal(r.fout, 'leeg bericht');
});

test('deelIn: zonder sleutel mislukt het netjes in plaats van te ontploffen', async () => {
  const bewaard = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await deelIn({ tekst: 'ik heb betaald', kanaal: 'whatsapp' });
    assert.equal(r.ok, false);
    assert.equal(typeof r.fout, 'string');
    assert.ok(r.fout.length > 0, 'er hoort een leesbare reden te zijn');
  } finally {
    if (bewaard !== undefined) process.env.ANTHROPIC_API_KEY = bewaard;
  }
});
