// tests/iris-log.test.js
//
// Het logboek, en wat er NIET in mag staan.
//
// De regel: geen volledige telefoonnummers en geen berichtteksten. Alleen
// id's, tellingen en korte omschrijvingen. Een logboek wordt ergens anders
// bewaard en doorgezocht dan de berichten zelf, dus is elke tekst die er
// stiekem in kruipt een tweede plek waar hij kan lekken.
//
// Het endpoint dwingt dat af bij het UITLEZEN, niet alleen bij het schrijven.
// Niet omdat de schrijvers van vandaag het fout doen, maar omdat er in de
// toekomst een schrijver bijkomt die deze regel niet gelezen heeft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskeer, kortRegel, veiligeDetails } from '../api/iris-log.js';

// ── nummers maskeren ────────────────────────────────────────────────────────

test('een telefoonnummer wordt gemaskeerd, met de laatste vier cijfers zichtbaar', () => {
  // Vier cijfers zijn genoeg om te herkennen welk nummer het was als je het al
  // weet, en te weinig om het te achterhalen als je het niet weet.
  assert.equal(maskeer('gebeld naar +31612345678'), 'gebeld naar …5678');
});

test('nummers met spaties, streepjes en haakjes worden ook gevonden', () => {
  for (const nr of ['+31 6 1234 5678', '06-12345678', '+32 (470) 12.34.56', '0470 123 456']) {
    const r = maskeer(`gebeld naar ${nr}`);
    assert.doesNotMatch(r, /\d{7}/, `"${nr}" bleef leesbaar: ${r}`);
    assert.match(r, /…\d{4}/);
  }
});

test('meerdere nummers in één regel worden allemaal gemaskeerd', () => {
  const r = maskeer('van +31612345678 naar +32470123456');
  assert.doesNotMatch(r, /\d{7}/);
  assert.equal((r.match(/…/g) || []).length, 2);
});

test('een kort getal is geen telefoonnummer', () => {
  // Bedragen, aantallen en jaartallen moeten gewoon leesbaar blijven.
  assert.equal(maskeer('3 pogingen'), '3 pogingen');
  assert.equal(maskeer('factuur 2026'), 'factuur 2026');
  assert.equal(maskeer('450,00 euro'), '450,00 euro');
});

test('lege en null-invoer geeft een lege tekst', () => {
  assert.equal(maskeer(''), '');
  assert.equal(maskeer(null), '');
  assert.equal(maskeer(undefined), '');
});

test('een tekst zonder nummers blijft ongemoeid', () => {
  const t = 'concept geschreven voor gesprek over een betaalafspraak';
  assert.equal(maskeer(t), t);
});

// ── inkorten ────────────────────────────────────────────────────────────────

test('een logregel is een regel, geen alinea', () => {
  const r = kortRegel('a'.repeat(500));
  assert.ok(r.length <= 200);
  assert.ok(r.endsWith('…'));
});

test('een korte regel blijft heel', () => {
  assert.equal(kortRegel('concept geschreven'), 'concept geschreven');
});

test('inkorten maskeert ook', () => {
  assert.doesNotMatch(kortRegel('gebeld naar +31612345678'), /\d{7}/);
});

// ── de details ──────────────────────────────────────────────────────────────

test('getallen en booleans komen door — dat zijn tellingen', () => {
  const d = veiligeDetails({ verstuurd: 3, gelukt: true, tekens: 142 });
  assert.deepEqual(d, { verstuurd: 3, gelukt: true, tekens: 142 });
});

test('een lange tekst wordt vervangen door zijn LENGTE, niet door zijn inhoud', () => {
  // Dit is de kern: een detail-blob die ooit een berichttekst bevat, komt zo
  // het scherm niet op.
  const d = veiligeDetails({ body: 'Beste Jan, '.repeat(50) });
  assert.doesNotMatch(JSON.stringify(d), /Beste Jan/);
  assert.match(String(d.body), /tekens/);
});

test('een korte tekst mag blijven staan, maar wordt wel gemaskeerd', () => {
  assert.equal(veiligeDetails({ bron: 'spraak' }).bron, 'spraak');
  assert.doesNotMatch(String(veiligeDetails({ naar: '+31612345678' }).naar), /\d{7}/);
});

test('een array wordt een aantal, geen inhoud', () => {
  const d = veiligeDetails({ facturen: ['F-001', 'F-002', 'F-003'] });
  assert.equal(d.facturen, '3 item(s)');
  assert.doesNotMatch(JSON.stringify(d), /F-001/);
});

test('een genest object wordt niet uitgeklapt', () => {
  const d = veiligeDetails({ klant: { naam: 'Jan Janssen', email: 'jan@example.com' } });
  assert.equal(d.klant, '{…}');
  assert.doesNotMatch(JSON.stringify(d), /jan@example/);
});

test('rommel geeft null, geen crash', () => {
  assert.equal(veiligeDetails(null), null);
  assert.equal(veiligeDetails('tekst'), null);
  assert.equal(veiligeDetails(42), null);
  assert.equal(veiligeDetails([1, 2, 3]), null);
});

test('een leeg detail-object geeft null in plaats van een leeg object', () => {
  assert.equal(veiligeDetails({}), null);
});

test('een echte logregel uit het verzendpad lekt niets', () => {
  // Dit is de vorm die iris-verstuur.js wegschrijft.
  const d = veiligeDetails({ tekens: 142, template: 'aanmaning_dag7' });
  assert.equal(d.tekens, 142);
  assert.equal(d.template, 'aanmaning_dag7');
});

test('een logregel met een stiekeme berichttekst erin lekt hem NIET', () => {
  // Zo'n regel bestaat vandaag niet, maar de schrijver van morgen leest deze
  // regel niet — dus houdt het uitleespad hem tegen.
  const d = veiligeDetails({
    tekens: 142,
    per_ongeluk_de_hele_tekst: 'Beste Jan, je factuur F-2026-0012 van € 450,00 is vervallen op 12-09-2026 en wij verzoeken u vriendelijk.',
  });
  assert.doesNotMatch(JSON.stringify(d), /F-2026-0012/);
  assert.doesNotMatch(JSON.stringify(d), /450,00/);
});
