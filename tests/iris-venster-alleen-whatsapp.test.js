// tests/iris-venster-alleen-whatsapp.test.js
//
// Het servicevenster hoort bij WhatsApp en nergens anders (P-1).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Op een mail van een advocaat stond "venster open nog 23u34". Dat venster is
// een regel van Meta over WhatsApp; voor mail bestaat het niet. Drie gevolgen,
// oplopend in ernst:
//
//   1. Een badge die iets beweert wat niet bestaat. Vervelend.
//   2. Het filter "venster bijna dicht" nam mailgesprekken mee, en duwde
//      daarmee een WhatsApp-gesprek dat écht bijna dicht was uit beeld. Een
//      filter dat moet tonen waar de tijd dringt, toonde het verkeerde.
//   3. En het ergste, dat pas bij het lezen van magVersturen() bleek: bij een
//      mail ouder dan 24 uur zei Iris dat er alleen nog een goedgekeurde
//      WhatsApp-template mocht. Dat is geen scheve badge maar een BLOKKADE op
//      het antwoorden — precies bij mail, waar het vaak over advocaten en
//      betalingsregelingen gaat.
//
// Nummer 3 stond niet in het verbeterplan. Die kwam bovendrijven bij het
// bouwen van nummer 1 en 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { magVersturen } from '../api/_lib/iris/venster.js';

const NU = new Date('2026-09-28T12:00:00.000Z');
const uurGeleden = (u) => new Date(NU.getTime() - u * 3600 * 1000).toISOString();
const STIL = { van: '21:00', tot: '08:00' };

// ── het venster zelf ────────────────────────────────────────────────────────

test('een mail ouder dan 24 uur mag gewoon met vrije tekst beantwoord worden', () => {
  // DIT is de blokkade die er zat. Zonder de kanaal-check kwam hier
  // vorm:'template' uit, en dan zegt het scherm dat je alleen nog een
  // goedgekeurde WhatsApp-template mag sturen — op een mail.
  const r = magVersturen({
    laatsteInbound: uurGeleden(72),
    stilleUrenInstelling: STIL,
    automatisch: false,
    kanaal: 'email',
    nu: NU,
  });
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'tekst');
});

test('een mail krijgt helemaal geen venster, ook geen dichtgeslagen', () => {
  // Uitdrukkelijk null en geen object met open:false. "Dicht" is ook een
  // bewering over een venster dat niet bestaat.
  const r = magVersturen({ laatsteInbound: uurGeleden(72), stilleUrenInstelling: STIL, kanaal: 'email', nu: NU });
  assert.equal(r.venster, null);
});

test('een mail zonder enig eerder bericht mag ook gewoon', () => {
  // Bij WhatsApp is "nog nooit iets van deze persoon gehad" een reden voor de
  // template-plicht. Bij mail is het gewoon een eerste mail.
  const r = magVersturen({ laatsteInbound: null, stilleUrenInstelling: STIL, automatisch: false, kanaal: 'email', nu: NU });
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'tekst');
});

test('voor WhatsApp verandert er niets', () => {
  const binnen = magVersturen({ laatsteInbound: uurGeleden(2), stilleUrenInstelling: STIL, automatisch: false, kanaal: 'whatsapp', nu: NU });
  assert.equal(binnen.vorm, 'tekst');
  assert.ok(binnen.venster, 'WhatsApp hoort wél een venster te hebben');

  const buiten = magVersturen({ laatsteInbound: uurGeleden(30), stilleUrenInstelling: STIL, automatisch: false, kanaal: 'whatsapp', nu: NU });
  assert.equal(buiten.vorm, 'template', 'buiten het venster blijft de template-plicht gelden');
});

test('wie het kanaal niet meegeeft, krijgt de STRENGE regels', () => {
  // De standaard is 'whatsapp'. Dat is met opzet de veilige kant: een
  // aanroeper die het vergeet, krijgt hooguit te horen dat hij een template
  // moet gebruiken terwijl het niet hoefde. Andersom — per ongeluk vrije tekst
  // buiten Meta's venster — is een weigering van Meta en een bericht dat de
  // klant nooit krijgt.
  const r = magVersturen({ laatsteInbound: uurGeleden(30), stilleUrenInstelling: STIL, automatisch: false, nu: NU });
  assert.equal(r.vorm, 'template');
});

test('de stille uren gelden WEL voor mail', () => {
  // Die gaan over wanneer WIJ iemand lastigvallen, niet over wat Meta
  // toestaat. Iris die uit zichzelf om drie uur 's nachts mailt, is net zo
  // ongewenst als Iris die dan appt.
  const nacht = new Date('2026-09-28T02:00:00.000Z');
  const r = magVersturen({
    laatsteInbound: uurGeleden(1),
    stilleUrenInstelling: { van: '21:00', tot: '08:00' },
    automatisch: true,
    kanaal: 'email',
    nu: nacht,
  });
  assert.equal(r.mag, false, 'een automatisch bericht hoort de stille uren te respecteren');
});

test('een mens mag in de stille uren wél mailen', () => {
  const nacht = new Date('2026-09-28T02:00:00.000Z');
  const r = magVersturen({
    laatsteInbound: uurGeleden(1),
    stilleUrenInstelling: { van: '21:00', tot: '08:00' },
    automatisch: false,
    kanaal: 'email',
    nu: nacht,
  });
  assert.equal(r.mag, true);
});

// ── de bedrading ────────────────────────────────────────────────────────────

const POST = readFileSync(new URL('../api/iris-post.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const VERZEND = readFileSync(new URL('../api/_lib/iris/verzend.js', import.meta.url), 'utf8');

/**
 * Alleen de code, zonder commentaar.
 *
 * Twee keer eerder in deze reeks pinde ik per ongeluk een test op mijn eigen
 * uitleg in plaats van op de logica: de regel was weg, de zin die vertelde dát
 * hij weg was bleef staan, en de test sloeg alarm. Een test die op proza
 * afgaat, meet niets.
 */
function zonderCommentaar(bron) {
  return bron
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((r) => r.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

test('de lijst rekent het venster alleen uit voor WhatsApp', () => {
  assert.match(POST, /gesprek\.kanaal === 'whatsapp'\s*\?\s*vensterStand/);
});

test('het filter "venster bijna dicht" kijkt alleen naar WhatsApp', () => {
  // Dit is de vondst die het meeste kostte: een mailgesprek in dit filter
  // duwt een echt dringend WhatsApp-gesprek uit beeld.
  const i = POST.indexOf("filter === 'venster_bijna_dicht'");
  const blok = POST.slice(i, i + 1400);
  assert.match(blok, /\.eq\('kanaal', 'whatsapp'\)/);
});

test('het detail geeft het kanaal door aan magVersturen', () => {
  // Zonder dit krijgt een mail de WhatsApp-regels opgelegd — inclusief de
  // template-plicht, en dat blokkeert het antwoorden.
  const i = POST.indexOf('const verzendbaar = magVersturen({');
  const blok = POST.slice(i, i + 500);
  assert.match(blok, /kanaal: gesprek\.kanaal/);
});

test('het scherm toont het merkteken alleen bij WhatsApp', () => {
  // Tweede sluiting naast de server: een oud antwoord uit de cache, of een
  // toekomstige aanroeper die het veld zelf vult, mag er niet doorheen.
  const i = SCHERM.indexOf('function vensterMerk(v, kanaal)');
  assert.ok(i > 0, 'vensterMerk hoort het kanaal te kennen');
  const blok = SCHERM.slice(i, i + 900);
  assert.match(blok, /if \(kanaal !== undefined && kanaal !== 'whatsapp'\) return '';/);
});

test('beide plekken in het scherm geven het kanaal mee', () => {
  assert.match(SCHERM, /vensterMerk\(r\.venster, r\.kanaal\)/, 'de lijstrij');
  assert.match(SCHERM, /vensterMerk\(v, g\.kanaal\)/, 'de gesprekskop');
});

test('er is nog maar ÉÉN plek die weet dat mail geen venster heeft', () => {
  // verzend.js had een eigen regel (het kanaal vergelijken met 'email' en dan
  // de vorm zelf op tekst zetten) náást dezelfde regel in magVersturen. Twee
  // plekken die hetzelfde moeten weten, lopen een keer uit de pas.
  //
  // Let op het stripje: de uitleg hierboven noemt die oude regel, en zonder
  // zonderCommentaar() zou deze test op zijn eigen toelichting afgaan.
  const code = zonderCommentaar(VERZEND);
  assert.doesNotMatch(code, /kanaal\s*===\s*'email'/);
  assert.match(code, /const vorm = v\.vorm;/, 'de vorm komt uit magVersturen en nergens anders vandaan');
  // Niet op opmaak pinnen maar op de aanroep zelf: het blok van magVersturen
  // hoort het kanaal door te geven.
  const i = VERZEND.indexOf('magVersturen({');
  assert.ok(i > 0, 'magVersturen hoort aangeroepen te worden');
  const blok = VERZEND.slice(i, VERZEND.indexOf('});', i));
  assert.match(blok, /\bkanaal\b/, 'het kanaal hoort doorgegeven te worden');
});
