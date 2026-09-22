// tests/iris-zoekfilter.test.js
//
// Zoekwoorden veilig in een PostgREST-filter zetten.
//
// PostgREST bouwt .or() op als één tekenreeks waarin de komma de scheiding is
// tussen voorwaarden. Zoeken op "Janssen, Jan" hakte die tekenreeks in tweeën
// en gaf een 400 — en dat ziet er voor de gebruiker uit als "zoeken is kapot".
//
// Erger dan de foutmelding is wat eronder zit: wie zijn eigen zoekterm in een
// querytaal kan schrijven, kan die querytaal sturen. De RLS-policy staat er
// nog achter, dus ver komt dat niet — maar "niet erg" is geen reden om het te
// laten staan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { veiligZoekwoord, contactZoekFilter } from '../api/_lib/iris/zoekfilter.js';

// ── opschonen ───────────────────────────────────────────────────────────────

test('een gewone naam blijft een gewone naam', () => {
  assert.equal(veiligZoekwoord('Jan Janssen'), 'Jan Janssen');
});

test('de komma gaat eruit — dat is de scheiding in or()', () => {
  assert.equal(veiligZoekwoord('Janssen, Jan'), 'Janssen Jan');
});

test('haakjes gaan eruit — dat is de groepering', () => {
  assert.equal(veiligZoekwoord('Jan (Janssen)'), 'Jan Janssen');
});

test('de punt gaat eruit — dat scheidt kolom, operator en waarde', () => {
  assert.equal(veiligZoekwoord('J. Janssen'), 'J Janssen');
});

test('aanhalingstekens, accolades en de backslash gaan eruit', () => {
  const r = veiligZoekwoord('a"b{c}d\\e\'f');
  for (const c of ['"', '{', '}', '\\', "'"]) {
    assert.ok(!r.includes(c), `"${c}" bleef staan in ${r}`);
  }
});

test('een poging om een tweede voorwaarde in te smokkelen wordt onschadelijk', () => {
  // Zo'n invoer zou zonder opschoning een extra or-tak opleveren.
  const r = veiligZoekwoord('x,customer_id.not.is.null');
  assert.ok(!r.includes(','));
  assert.ok(!r.includes('.'));
});

test('sterretjes en procenten gaan eruit — die zijn jokers in ilike', () => {
  // Zoeken op "%" zou anders alles vinden.
  assert.equal(veiligZoekwoord('%'), '');
  assert.equal(veiligZoekwoord('*'), '');
});

test('dubbele spaties worden er één', () => {
  assert.equal(veiligZoekwoord('Jan,,,Janssen'), 'Jan Janssen');
});

test('een eindeloos lange zoekterm wordt afgekapt', () => {
  assert.ok(veiligZoekwoord('a'.repeat(500)).length <= 80);
});

test('leeg en null geven een lege tekst', () => {
  for (const v of ['', '   ', null, undefined, ',,,', '()']) {
    assert.equal(veiligZoekwoord(v), '', `${JSON.stringify(v)} hoorde leeg te worden`);
  }
});

test('een mailadres overleeft de opschoning', () => {
  assert.equal(veiligZoekwoord('jan@example.com', 200), 'jan@example com',
    'de punt gaat eruit — dat is onvermijdelijk, en de cs-match werkt op hele waarden');
});

// ── het filter ──────────────────────────────────────────────────────────────

test('een naam levert alleen een naam-voorwaarde op', () => {
  const f = contactZoekFilter('Jan Janssen');
  assert.match(f, /weergavenaam\.ilike\.%Jan Janssen%/);
  assert.doesNotMatch(f, /emails/, 'op een naam hoeft niet in de e-mailarray gezocht te worden');
});

test('iets met een apenstaartje zoekt ook in de e-mailadressen', () => {
  const f = contactZoekFilter('jan@example');
  assert.match(f, /emails\.cs/);
});

test('een lege zoekterm geeft NULL, geen leeg filter', () => {
  // Een leeg filter matcht alles — het tegenovergestelde van wat iemand
  // bedoelde die iets intypte.
  assert.equal(contactZoekFilter(''), null);
  assert.equal(contactZoekFilter('   '), null);
  assert.equal(contactZoekFilter(',,,'), null);
  assert.equal(contactZoekFilter(null), null);
});

test('het filter bevat na opschoning hoogstens één scheidende komma', () => {
  // Twee voorwaarden, dus één komma. Meer zou betekenen dat er iets
  // doorgeglipt is.
  for (const zoek of ['Jan, Janssen', 'a(b)c', 'x,y,z@q.nl', '"; drop"']) {
    const f = contactZoekFilter(zoek);
    if (!f) continue;
    assert.ok((f.match(/,/g) || []).length <= 1, `"${zoek}" gaf ${f}`);
  }
});

test('een adres met een komma erin breekt het filter niet', () => {
  // normaliseerEmail laat `a,b@c.nl` door (het voldoet aan de vorm). Zonder
  // opschoning zou die komma de or-tekenreeks in tweeën hakken.
  const f = contactZoekFilter('a,b@c.nl');
  assert.ok((f.match(/,/g) || []).length <= 1);
});
