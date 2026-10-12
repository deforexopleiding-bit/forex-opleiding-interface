// tests/iris-doel.test.js
//
// Op wie slaat een stap? — en vooral: wanneer weigert Iris te gokken.
//
// Een plan noemt mensen zoals een mens dat doet: "Andy De Landtsheer
// (andy@dl-interieur.be)". Een opvolging hangt aan een gesprek. Die omzetting
// is de plek waar een stille vergissing ontstaat die je pas maanden later
// ziet — als er een herinnering naar de verkeerde persoon loopt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haalHerkenningspunten, telefoonVormen, naamUit } from '../api/_lib/iris/doel.js';

// ── wat staat er in de tekst ────────────────────────────────────────────────

test('het adres uit een wie-regel wordt gevonden en kleingemaakt', () => {
  const r = haalHerkenningspunten('Andy De Landtsheer (Andy@DL-Interieur.BE)');
  assert.deepEqual(r.emails, ['andy@dl-interieur.be']);
});

test('de oorspronkelijke vraag telt mee, niet alleen de stap', () => {
  // De stap zegt soms alleen "Andy"; het adres stond in wat Maxim insprak.
  const r = haalHerkenningspunten('Andy', 'Hou het mailgesprek met andy@dl-interieur.be in de gaten');
  assert.deepEqual(r.emails, ['andy@dl-interieur.be']);
});

test('een adres met cijfers erin wordt geen telefoonnummer', () => {
  // Zonder de adressen eerst weg te halen, leest "jan1980@x.nl" als een
  // cijferreeks en gaat Iris op een nummer zoeken dat niet bestaat.
  const r = haalHerkenningspunten('Jan (jan19800101@voorbeeld.nl)');
  assert.deepEqual(r.emails, ['jan19800101@voorbeeld.nl']);
  assert.deepEqual(r.telefoons, []);
});

test('een nummer met spaties en streepjes wordt één reeks', () => {
  const r = haalHerkenningspunten('bel Marcel op 06-44 56 24 26');
  assert.equal(r.telefoons.length, 1);
  assert.equal(r.telefoons[0].replace(/\D/g, ''), '0644562426');
});

test('iets wat te kort is om een nummer te zijn, telt niet mee', () => {
  // "binnen 3 dagen" en "factuur 2026" mogen geen zoekopdracht op een
  // telefoonnummer worden.
  const r = haalHerkenningspunten('verwittig me als hij binnen 3 dagen niet reageert op factuur 2026');
  assert.deepEqual(r.telefoons, []);
});

test('niets erin geeft niets terug', () => {
  assert.deepEqual(haalHerkenningspunten(null, undefined, ''), { emails: [], telefoons: [] });
});

// ── de vormen van één nummer ────────────────────────────────────────────────

test('een nationaal nummer wordt in beide landcodes gezocht', () => {
  // De databank houdt E.164 met een plus aan; wat een mens typt is 06…
  // Zonder deze omzetting mist de opvraging precies het normale geval.
  const v = telefoonVormen('06 44 56 24 26');
  assert.ok(v.includes('+31644562426'));
  assert.ok(v.includes('+32644562426'));
});

test('er komt nooit een +0-nummer uit', () => {
  // '+0644…' is de nationale vorm met een plus ervoor geplakt. Dat treft
  // nooit en maakt de opvraging alleen langer.
  for (const ruw of ['06 44 56 24 26', '0475123456', '0032475123456', '+31644562426']) {
    for (const v of telefoonVormen(ruw)) {
      assert.ok(!v.startsWith('+0'), `${ruw} gaf ${v}`);
    }
  }
});

test('0032… en +32… komen op hetzelfde uit', () => {
  assert.deepEqual(telefoonVormen('0032 475 123456'), ['+32475123456']);
  assert.deepEqual(telefoonVormen('+32475123456'), ['+32475123456']);
});

// ── de naam ─────────────────────────────────────────────────────────────────

test('de naam komt zonder het adres erachter', () => {
  assert.equal(naamUit('Andy De Landtsheer (andy@dl-interieur.be)'), 'Andy De Landtsheer');
});

test('een te korte naam geeft null', () => {
  // Een ilike op twee letters geeft de halve tabel terug. Dan is "precies één
  // gesprek" nooit waar en is de opvraging voor niets gedaan.
  for (const rommel of ['', '  ', 'Jo', '(x@y.nl)', null]) {
    assert.equal(naamUit(rommel), null, String(rommel));
  }
});

// ── en de regel in de code ──────────────────────────────────────────────────

const ACTIE = readFileSync(new URL('../api/iris-actie.js', import.meta.url), 'utf8');
const ZOEKER = ACTIE.slice(
  ACTIE.indexOf('async function zoekDoelGesprek'),
  ACTIE.indexOf('Het hele plan van een opdracht uitvoeren'),
);

test('de volgorde is adres, dan nummer, dan naam', () => {
  // Een adres is uniek genoeg om op te handelen; een naam nooit. Zou de naam
  // vooraan staan, dan wint de slechtste aanwijzing van de beste.
  const iMail = ZOEKER.indexOf("contactenOp('emails'");
  const iTel  = ZOEKER.indexOf("contactenOp('telefoons'");
  const iNaam = ZOEKER.indexOf("ilike('weergavenaam'");
  assert.ok(iMail > 0 && iTel > iMail && iNaam > iTel, 'adres, dan nummer, dan naam');
});

test('er wordt geteld op GESPREKKEN, niet op contacten', () => {
  // In productie bestaan dubbele contacten: dezelfde persoon, hetzelfde
  // adres, twee rijen, allebei in hetzelfde gesprek. Tellen op contacten zou
  // daar "twee treffers, dus vragen" van maken terwijl het één draad is.
  assert.match(ZOEKER, /const gesprekkenVan = async \(contactIds\)/);
  assert.match(ZOEKER, /\[\.\.\.new Set\(\(data \|\| \[\]\)\.map\(\(g\) => g\.id\)\)\]/);
  assert.match(ZOEKER, /if \(g\.length === 1\) return \{ gesprekId: g\[0\]/);
});

test('nul of meer dan één gesprek is een vraag, geen keuze', () => {
  assert.match(ZOEKER, /if \(g\.length > 1\) return \{ gesprekId: null/);
  assert.match(ACTIE, /error: 'doel_onbekend'/);
  assert.match(ACTIE, /past bij \$\{gevonden\.kandidaten\} gesprekken/);
});

test('er wordt NOOIT een contact aangemaakt', () => {
  // Een contact verzinnen op grond van een stuk tekst is een persoon
  // verzinnen. Alleen lezen hier.
  assert.doesNotMatch(ZOEKER, /\.insert\(|\.upsert\(|\.update\(/);
});

test('hoe het gesprek gevonden is, komt in het verloop', () => {
  // Anders is later niet na te gaan of een opvolging op de juiste persoon
  // loopt — en dat is precies de vraag die je over een maand stelt.
  assert.match(ACTIE, /gesprek_gevonden_op: doelHoe/);
});
