// tests/iris-toon.test.js
//
// De poort waar elk bericht van Iris langs moet.
//
// De regels staan ook in de instructie aan het model, want een model dat weet
// wat de bedoeling is schrijft beter. Maar een instructie kan overtuigd worden
// — door een creatieve klant, of door helemaal niets als het model
// hallucineert. Een `if` kan dat niet. Daarom staan ze hier nóg een keer, als
// controle achteraf, en daarom staat hier zoveel test op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONTBREEKT,
  MAX_WA,
  MAX_MAIL,
  ONDERTEKENING,
  JURIDISCHE_WOORDEN,
  VERKOOP_WOORDEN,
  TOON_INSTRUCTIE,
  keurTekst,
  zetOndertekening,
  ontbrekend,
} from '../api/_lib/iris/toon.js';

// ── ontbrekende gegevens ────────────────────────────────────────────────────

test('een tekst met [invullen] vertrekt niet', () => {
  const r = keurTekst(`Je factuur van ${ONTBREEKT} staat nog open.`);
  assert.equal(r.mag, false);
  assert.equal(r.blokkades.length, 1);
  assert.match(r.blokkades[0], /invullen/);
});

test('[invullen] blokkeert OOK als een mens op Verstuur drukt', () => {
  // Dit is de enige controle die altijd blokkeert. Een mens die op Verstuur
  // drukt heeft de tekst gelezen, maar [invullen] betekent dat Iris een
  // gegeven niet hád — en dan moet iemand het invullen, niet wegklikken.
  const r = keurTekst(`Bedrag: ${ONTBREEKT}`, { doorMens: true });
  assert.equal(r.mag, false);
});

test('ontbrekend zet er netjes bij wat er ontbrak', () => {
  const t = ontbrekend('openstaand bedrag');
  assert.ok(t.includes(ONTBREEKT));
  assert.match(t, /openstaand bedrag/);
  assert.equal(keurTekst(t).mag, false);
});

test('ontbrekend zonder toelichting werkt ook', () => {
  assert.equal(ontbrekend(), ONTBREEKT);
});

// ── leeg en te lang ─────────────────────────────────────────────────────────

test('een lege tekst vertrekt niet', () => {
  for (const v of ['', '   ', '\n\n', null, undefined]) {
    assert.equal(keurTekst(v).mag, false, `${JSON.stringify(v)} hoorde geblokkeerd te worden`);
  }
});

test('een WhatsApp-bericht boven Meta s grens vertrekt niet', () => {
  const r = keurTekst('a'.repeat(MAX_WA + 1), { kanaal: 'whatsapp' });
  assert.equal(r.mag, false);
  assert.match(r.blokkades[0], /maximum/);
});

test('een mail mag langer zijn dan een WhatsApp-bericht', () => {
  const lang = 'a'.repeat(MAX_WA + 500);
  assert.equal(keurTekst(lang, { kanaal: 'whatsapp' }).mag, false);
  assert.equal(keurTekst(lang, { kanaal: 'email' }).mag, true);
  assert.ok(MAX_MAIL > MAX_WA);
});

// ── juridische dreiging ─────────────────────────────────────────────────────

test('een dreiging met een deurwaarder vertrekt niet automatisch', () => {
  const r = keurTekst('Betaal binnen 5 dagen of we sturen een deurwaarder.');
  assert.equal(r.mag, false);
  assert.match(r.blokkades[0], /deurwaarder/);
});

test('elk juridisch woord wordt herkend', () => {
  for (const woord of JURIDISCHE_WOORDEN) {
    const r = keurTekst(`Wij overwegen ${woord} in te schakelen.`);
    assert.equal(r.mag, false, `"${woord}" hoorde geblokkeerd te worden`);
  }
});

test('hoofdletters helpen niet om eromheen te komen', () => {
  assert.equal(keurTekst('Wij schakelen een DEURWAARDER in.').mag, false);
  assert.equal(keurTekst('Wij schakelen een Deurwaarder in.').mag, false);
});

test('bij een mens is een juridisch woord een waarschuwing, geen blokkade', () => {
  // Maxim kan per dossier besluiten dat die zin erin hoort. Dat is zijn keuze,
  // en de software hoort daar niet dwars voor te gaan liggen — wel hem erop
  // te wijzen.
  const r = keurTekst('Bij uitblijven van betaling dragen wij over aan een incassobureau.', { doorMens: true });
  assert.equal(r.mag, true);
  assert.equal(r.waarschuwingen.length, 1);
  assert.match(r.waarschuwingen[0], /incassobureau/);
});

test('een gewone tekst over betalen is geen dreiging', () => {
  const r = keurTekst('Zou je kunnen laten weten wanneer het je lukt om te betalen?');
  assert.equal(r.mag, true);
  assert.deepEqual(r.waarschuwingen, []);
});

// ── de neutrale herinnering ─────────────────────────────────────────────────

test('een neutrale herinnering noemt geen bedrag', () => {
  const r = keurTekst('Je hebt nog € 450,00 openstaan.', { neutraleHerinnering: true });
  assert.ok(r.waarschuwingen.some((w) => /bedrag/.test(w)));
});

test('een neutrale herinnering noemt geen factuurnummer', () => {
  const r = keurTekst('Het gaat om factuur F-2026-0012.', { neutraleHerinnering: true });
  assert.ok(r.waarschuwingen.some((w) => /factuurnummer/.test(w)));
});

test('een neutrale herinnering noemt geen vervaldatum', () => {
  const r = keurTekst('De vervaldatum was 12-09-2026.', { neutraleHerinnering: true });
  assert.ok(r.waarschuwingen.some((w) => /vervaldatum/.test(w)));
});

test('een echt neutrale herinnering komt er schoon doorheen', () => {
  const r = keurTekst('We hebben nog niets van je gehoord. Lukt het om even te reageren?', { neutraleHerinnering: true });
  assert.equal(r.mag, true);
  assert.deepEqual(r.waarschuwingen, []);
});

test('buiten een neutrale herinnering mag een bedrag gewoon', () => {
  const r = keurTekst('Er staat nog € 450,00 open op factuur F-2026-0012.');
  assert.equal(r.mag, true);
  assert.deepEqual(r.waarschuwingen, []);
});

// ── verkooppraat ────────────────────────────────────────────────────────────

test('verkooppraat levert een waarschuwing op', () => {
  for (const woord of VERKOOP_WOORDEN) {
    const r = keurTekst(`Trouwens, ${woord}!`);
    assert.ok(r.waarschuwingen.length > 0, `"${woord}" hoorde een waarschuwing te geven`);
  }
});

test('verkooppraat blokkeert niet — het is een kwestie van toon, geen fout', () => {
  assert.equal(keurTekst('Er is nu korting op de vervolgmodule.').mag, true);
});

// ── de ondertekening ────────────────────────────────────────────────────────

test('een mail krijgt de ondertekening van het bedrijf', () => {
  const s = zetOndertekening('Dank voor je bericht.', { kanaal: 'email' });
  assert.match(s, new RegExp(ONDERTEKENING));
  assert.match(s, /Met vriendelijke groet/);
});

test('een WhatsApp-bericht krijgt géén ondertekening', () => {
  // Een chat is geen brief. Een handtekening onder elk berichtje leest als
  // een automaat.
  const s = zetOndertekening('Dank voor je bericht.', { kanaal: 'whatsapp' });
  assert.equal(s, 'Dank voor je bericht.');
});

test('een mens die zijn eigen naam kiest, houdt die', () => {
  const s = zetOndertekening('Dank je.', { kanaal: 'email', eigenNaam: 'Maxim' });
  assert.match(s, /Maxim/);
  assert.doesNotMatch(s, new RegExp(ONDERTEKENING));
});

test('een groet die het model er zelf onder zette, wordt weggehaald', () => {
  const s = zetOndertekening('Dank je.\n\nMet vriendelijke groet,\nIris', { kanaal: 'email' });
  assert.doesNotMatch(s, /Iris/, 'Iris is de naam van het gereedschap, niet van een medewerker');
  assert.match(s, new RegExp(ONDERTEKENING));
});

test('een kale naam onderaan wordt ook weggehaald', () => {
  const s = zetOndertekening('Dank je.\n\n— Joost', { kanaal: 'email' });
  assert.doesNotMatch(s, /Joost/);
});

test('een lege tekst blijft leeg, er komt geen handtekening onder niets', () => {
  assert.equal(zetOndertekening('', { kanaal: 'email' }), '');
  assert.equal(zetOndertekening('   ', { kanaal: 'email' }), '');
});

test('de tekst zelf blijft ongemoeid', () => {
  const s = zetOndertekening('Regel een.\nRegel twee.', { kanaal: 'email' });
  assert.match(s, /Regel een\.\nRegel twee\./);
});

// ── de instructie aan het model ─────────────────────────────────────────────

test('de instructie noemt het merkteken voor een ontbrekend gegeven letterlijk', () => {
  assert.ok(TOON_INSTRUCTIE.includes(ONTBREEKT));
});

test('de instructie verbiedt het verzinnen van feiten en het dreigen', () => {
  assert.match(TOON_INSTRUCTIE, /Verzin NOOIT/);
  assert.match(TOON_INSTRUCTIE, /Dreig nooit/);
});

test('de instructie zegt dat er niet met een persoonsnaam ondertekend wordt', () => {
  assert.match(TOON_INSTRUCTIE, /Onderteken niet/);
});

test('de instructie legt uit WAAROM [invullen] beter is dan verzinnen', () => {
  // Een regel zonder reden wordt eerder genegeerd dan een regel met.
  assert.match(TOON_INSTRUCTIE, /verzonnen bedrag/);
});

// ── het geheel ──────────────────────────────────────────────────────────────

test('een net bericht komt er zonder blokkade en zonder waarschuwing doorheen', () => {
  const tekst = 'Dank je wel voor je bericht. Er staat nog € 450,00 open op factuur F-2026-0012, ' +
    'die vervallen is op 12-09-2026. Lukt het om die deze week te voldoen? Laat gerust weten als ' +
    'het niet in één keer gaat, dan kijken we samen naar een oplossing.';
  const r = keurTekst(tekst, { kanaal: 'whatsapp' });
  assert.equal(r.mag, true);
  assert.deepEqual(r.blokkades, []);
  assert.deepEqual(r.waarschuwingen, []);
});

test('meerdere problemen worden allemaal gemeld, niet alleen het eerste', () => {
  const r = keurTekst(`${ONTBREEKT} ` + 'a'.repeat(MAX_WA + 10), { kanaal: 'whatsapp' });
  assert.equal(r.mag, false);
  assert.ok(r.blokkades.length >= 2, 'wie één probleem oplost wil meteen weten of er nog meer zijn');
});
