// tests/iris-ochtendantwoord.test.js
//
// Het logboek wordt een ochtendantwoord (D-1).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Waar je 's ochtends mee zit is één vraag: "heeft Iris vannacht iets gedaan
// dat ik moet weten?". Een chronologisch logboek dwingt je dat zelf te
// concluderen -- veertig regels lezen om erachter te komen dat er niets
// bijzonders was.
//
// Dit is geen vervanging van het logboek. Een logboek is het juiste ding als je
// iets uitzoekt en het verkeerde om 's ochtends naar te kijken. Twee vormen van
// dezelfde gegevens; de vraag bepaalt welke voorop staat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AVOND_UUR, MAX_FOUTEN, MAX_GROEPEN,
  vensterVanaf, ochtendantwoord, soortVan, kopTekst,
} from '../api/_lib/iris/ochtendantwoord.js';

// ── het venster ──────────────────────────────────────────────────────────────

test('wie \'s ochtends kijkt, ziet de avond ervoor erbij', () => {
  // Niet "sinds middernacht": wat Iris om acht uur 's avonds deed, is precies
  // wat je de volgende ochtend wilt weten.
  const v = vensterVanaf(new Date('2026-09-28T08:00:00.000Z'));
  assert.equal(v.toISOString(), '2026-09-27T18:00:00.000Z');
});

test('wie \'s avonds kijkt, ziet vanaf vanavond', () => {
  const v = vensterVanaf(new Date('2026-09-28T21:00:00.000Z'));
  assert.equal(v.toISOString(), '2026-09-28T18:00:00.000Z');
});

test('precies op het grensuur begint het venster nu', () => {
  const v = vensterVanaf(new Date(`2026-09-28T${String(AVOND_UUR).padStart(2, '0')}:00:00.000Z`));
  assert.equal(v.toISOString(), '2026-09-28T18:00:00.000Z');
});

test('het venster loopt over een maandgrens', () => {
  const v = vensterVanaf(new Date('2026-10-01T07:00:00.000Z'));
  assert.equal(v.toISOString(), '2026-09-30T18:00:00.000Z');
});

// ── het antwoord ─────────────────────────────────────────────────────────────

const NU = new Date('2026-09-28T08:00:00.000Z');
const R = (wanneer, wat, extra = {}) => ({ wanneer, wat, wie: null, fout: null, resultaat: 'ok', ...extra });

test('niets gebeurd zegt "niets gebeurd", niet "0 handelingen"', () => {
  // Een getal is een antwoord op "hoeveel", niet op "moet ik iets".
  const a = ochtendantwoord([], { nu: NU });
  assert.equal(a.totaal, 0);
  assert.match(a.kop, /niets gedaan/);
  assert.doesNotMatch(a.kop, /^0/);
});

test('alles goed zegt dat er niets aan de hand is', () => {
  const a = ochtendantwoord([
    R('2026-09-27T20:00:00Z', 'opvolging gesloten: er kwam iets binnen'),
    R('2026-09-28T03:00:00Z', 'opvolging gesloten: er kwam iets binnen'),
  ], { nu: NU });
  assert.equal(a.totaal, 2);
  assert.equal(a.mislukt, 0);
  assert.match(a.kop, /alles ging goed/);
});

test('wat er misging staat in de kop', () => {
  const a = ochtendantwoord([
    R('2026-09-28T03:00:00Z', 'mail versturen', { fout: 'SMTP weigerde' }),
    R('2026-09-28T04:00:00Z', 'opvolging gesloten'),
  ], { nu: NU });
  assert.equal(a.mislukt, 1);
  assert.match(a.kop, /Eén ervan ging mis/);
  assert.equal(a.fouten.length, 1);
  assert.equal(a.fouten[0].fout, 'SMTP weigerde');
});

test('resultaat "fout" telt ook als mislukt, ook zonder fouttekst', () => {
  // Twee manieren om te zeggen dat iets misging, en allebei tellen ze.
  const a = ochtendantwoord([R('2026-09-28T03:00:00Z', 'x', { resultaat: 'fout' })], { nu: NU });
  assert.equal(a.mislukt, 1);
});

test('WAT BUITEN HET VENSTER VALT TELT NIET MEE', () => {
  // Dit is de val. Zonder de filtering op `wanneer` zou het antwoord over de
  // laatste vijfhonderd regels gaan in plaats van over vannacht -- en dan zegt
  // "3 gingen mis" niets over de nacht die je net gemist hebt.
  const a = ochtendantwoord([
    R('2026-09-25T10:00:00Z', 'oud', { fout: 'van drie dagen terug' }),
    R('2026-09-28T03:00:00Z', 'nieuw'),
  ], { nu: NU });
  assert.equal(a.totaal, 1);
  assert.equal(a.mislukt, 0);
});

test('rommel in de regels wordt overgeslagen', () => {
  assert.equal(ochtendantwoord([null, {}, { wanneer: 'onzin' }], { nu: NU }).totaal, 0);
  assert.equal(ochtendantwoord(null, { nu: NU }).totaal, 0);
});

test('Iris en de medewerkers worden apart geteld', () => {
  // "Er is vannacht van alles gebeurd" is iets anders als jij het zelf deed.
  const a = ochtendantwoord([
    R('2026-09-28T03:00:00Z', 'a'),
    R('2026-09-28T04:00:00Z', 'b', { wie: 'u1' }),
  ], { nu: NU });
  assert.equal(a.door_iris, 1);
  assert.equal(a.door_mensen, 1);
});

// ── de groepen ───────────────────────────────────────────────────────────────

test('dezelfde soort handeling wordt één regel met een aantal', () => {
  // Dat is wat een log een antwoord maakt: "opvolging gesloten × 4" in plaats
  // van vier regels die je zelf optelt.
  const a = ochtendantwoord([
    R('2026-09-28T01:00:00Z', 'opvolging gesloten: er kwam iets binnen'),
    R('2026-09-28T02:00:00Z', 'opvolging gesloten: er kwam iets anders binnen'),
    R('2026-09-28T03:00:00Z', 'indeling met de hand gewijzigd'),
  ], { nu: NU });
  const g = a.groepen.find((x) => x.wat === 'opvolging gesloten');
  assert.equal(g.aantal, 2);
  assert.equal(g.laatste, '2026-09-28T02:00:00Z');
});

test('WAT MISGING STAAT BOVENAAN, ook als het er één van de veertig is', () => {
  // Dat is de hele reden dat je kijkt. Een groep met één fout erin is
  // belangrijker dan een groep met veertig keer "gelukt".
  const veel = Array.from({ length: 40 }, (_, i) =>
    R(`2026-09-28T0${(i % 5) + 1}:00:00Z`, 'gelukte handeling'));
  const a = ochtendantwoord([...veel, R('2026-09-28T02:30:00Z', 'zeldzaam ding', { fout: 'kapot' })], { nu: NU });
  assert.equal(a.groepen[0].wat, 'zeldzaam ding');
  assert.equal(a.groepen[0].mislukt, 1);
});

test('de lijsten zijn begrensd, en het antwoord zegt hoeveel er niet in staan', () => {
  const fouten = Array.from({ length: 12 }, (_, i) =>
    R('2026-09-28T03:00:00Z', 'soort ' + i, { fout: 'stuk' }));
  const a = ochtendantwoord(fouten, { nu: NU });
  assert.equal(a.fouten.length, MAX_FOUTEN);
  assert.equal(a.mislukt, 12, 'het TOTAAL blijft eerlijk, ook al staan er vijf uitgeschreven');
  assert.ok(a.groepen.length <= MAX_GROEPEN);
});

// ── de soort ─────────────────────────────────────────────────────────────────

test('de soort is het stuk vóór de dubbele punt', () => {
  assert.equal(soortVan('opvolging gesloten: er kwam iets binnen'), 'opvolging gesloten');
  assert.equal(soortVan('indeling met de hand gewijzigd'), 'indeling met de hand gewijzigd');
});

test('een rare regel valt niet om', () => {
  // Zonder de i>0-check zou een regel die met een dubbele punt begint een lege
  // soort geven, en dan staat er een naamloze groep in het antwoord.
  assert.equal(soortVan(':begint met een dubbele punt'), ':begint met een dubbele punt');
  assert.equal(soortVan(''), 'onbekend');
  assert.equal(soortVan(null), 'onbekend');
});

test('enkelvoud leest als enkelvoud', () => {
  assert.match(kopTekst(1, 0), /Eén handeling/);
  assert.match(kopTekst(3, 1), /Eén ervan/);
  assert.match(kopTekst(3, 2), /2 ervan/);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const LOG = readFileSync(new URL('../api/iris-log.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');

test('het endpoint haalt ruimer op voor de ochtendvorm', () => {
  // Een nacht met veel verkeer mag niet stilletjes afgekapt worden op honderd
  // regels, want dan valt het antwoord te laag uit.
  assert.match(LOG, /const ochtend = String\(q\.vorm \|\| ''\) === 'ochtend';/);
  assert.match(LOG, /ochtend\s*\n\s*\? 500/);
});

test('het endpoint begrenst de opvraging op hetzelfde venster', () => {
  // Anders rekent het antwoord over regels die er niet in horen.
  assert.match(LOG, /if \(ochtend\) vraag = vraag\.gte\('wanneer', vensterVanaf\(new Date\(\)\)\.toISOString\(\)\)/);
});

test('het antwoord gebruikt de GEMASKEERDE regels', () => {
  // Niet de ruwe rijen: dan zou een fouttekst met een telefoonnummer erin het
  // scherm alsnog bereiken langs de samenvatting.
  assert.match(LOG, /ochtendantwoord\(items\)/);
});

test('het scherm zet het antwoord voorop en houdt het logboek', () => {
  assert.match(SCHERM, /vorm: 'ochtend',/, 'de ochtendvorm hoort de standaard te zijn');
  assert.match(SCHERM, /function ochtendBlok\(a\)/);
  assert.match(SCHERM, /window\.__irisLogVorm = \(v\)/);
  // Het logboek zelf blijft bestaan.
  assert.match(SCHERM, /__irisLogFouten\(\)/);
});

test('wat misging staat in het scherm boven wat er gebeurde', () => {
  const i = SCHERM.indexOf('function ochtendBlok(a)');
  const blok = SCHERM.slice(i, SCHERM.indexOf('function dossiersTab', i));
  const fout = blok.indexOf('Dit ging mis');
  const rest = blok.indexOf('Wat er gebeurde');
  assert.ok(fout > 0 && rest > fout, 'de foutenbak hoort boven de groepen te staan');
  // En het aantal dat niet uitgeschreven is, wordt genoemd.
  assert.match(blok, /a\.mislukt > a\.fouten\.length/);
});

// ── het versieconflict ───────────────────────────────────────────────────────

test('wanbetalers-v2.js staat hoger dan de twee openstaande PR\'s', () => {
  // #1682 en #1683 zetten allebei ?v=63 op dezelfde regel; die twee botsen bij
  // het mergen. Deze tak zet 64, zodat de uitkomst hetzelfde is ongeacht in
  // welke volgorde ze binnenkomen -- en niemand achteraf een cache-probleem
  // hoeft te debuggen dat een versienummer was.
  const m = INDEX.match(/wanbetalers-v2\.js\?v=(\d+)/);
  assert.ok(m, 'het script hoort een versienummer te hebben');
  assert.ok(Number(m[1]) >= 64, `?v=${m[1]} is niet hoger dan de 63 van #1682 en #1683`);
});
