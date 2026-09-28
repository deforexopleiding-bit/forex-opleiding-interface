// tests/gesprekken-microfoon.test.js
//
// De microfoon in de gesprekken-module (gat G1).
//
// ── DE TWEE DINGEN DIE HIER ECHT TOE DOEN ────────────────────────────────────
//
// 1. Het is DEZELFDE microfoon als die van Iris, niet een tweede. Een tweede
//    implementatie betekent dat een verbetering aan de ene kant de andere niet
//    bereikt — en dat merk je pas als iemand klaagt dat het "in het andere
//    scherm wél werkt". Daarom controleren we hier dat dit scherm alleen
//    window.IRIS_SPRAAK aanroept en nergens zelf een herkenner opbouwt.
//
// 2. Er wordt NOOIT automatisch verstuurd. De tekst landt in het veld en blijft
//    daar tot iemand op Verstuur drukt. Inspreken is een manier van typen, geen
//    manier van versturen; dat onderscheid is het verschil tussen een handige
//    knop en een knop waar je bang voor bent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');
const PAGINA = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');

/** Het blok van de microfoon-handler, precies afgebakend. */
function micHandler() {
  const i = SCHERM.indexOf('window.__wbxInboxMic =');
  assert.ok(i > 0, 'de microfoon-handler hoort te bestaan');
  const eind = SCHERM.indexOf('function _inboxCtxHtml', i);
  assert.ok(eind > i, 'het einde van het blok hoort vindbaar te zijn');
  return SCHERM.slice(i, eind);
}

// ── één microfoon, niet twee ────────────────────────────────────────────────

test('het scherm gebruikt de microfoon van Iris en bouwt er geen eigen', () => {
  const blok = micHandler();
  assert.match(blok, /window\.IRIS_SPRAAK/);
  assert.match(blok, /SP\.maakHerkenner\(window/);
  // De browser-API's horen hier NIET te staan: die zitten in spraak.js.
  assert.doesNotMatch(SCHERM, /webkitSpeechRecognition/,
    'een eigen herkenner opbouwen is precies de tweede implementatie die we niet willen');
  assert.doesNotMatch(SCHERM, /new SpeechRecognition/);
});

test('spraak.js wordt geladen vóór het scherm dat hem gebruikt', () => {
  const spraak = PAGINA.indexOf('iris/spraak.js');
  const wanbetalers = PAGINA.indexOf('views/wanbetalers-v2.js');
  const iris = PAGINA.indexOf('iris/iris.js');
  assert.ok(spraak > 0 && wanbetalers > 0 && iris > 0);
  assert.ok(spraak < wanbetalers, 'spraak.js hoort vóór wanbetalers-v2.js te staan');
  assert.ok(spraak < iris, 'en nog steeds vóór iris.js');
});

// ── nooit vanzelf versturen ─────────────────────────────────────────────────

test('de microfoon verstuurt nooit uit zichzelf', () => {
  // Dit is de belangrijkste controle van dit bestand. Zou een spraakherkenner
  // ooit "verstuur" of "klaar" als commando gaan opvatten, dan gaat er een
  // bericht weg dat niemand heeft nagelezen.
  const blok = micHandler();
  assert.doesNotMatch(blok, /__wbxInboxSend/);
  assert.doesNotMatch(blok, /inbox-send/);
  assert.doesNotMatch(blok, /_wbxWaTekstVerstuur/);
  assert.doesNotMatch(blok, /apiPost/);
});

test('de tekst landt in het veld, niet ergens anders', () => {
  const blok = micHandler();
  assert.match(blok, /c\.text = tekst/);
  assert.match(blok, /getElementById\('wbxComposeTxt'\)/);
});

test('wat er al stond blijft staan', () => {
  // Je spreekt iets bij; je gooit niets weg. Zou de opname het veld leegmaken,
  // dan verlies je wat je net getypt had, en dat merk je pas als het weg is.
  const blok = micHandler();
  assert.match(blok, /const beginTekst = c\.text \|\| '';/);
  assert.match(blok, /voegSamen\(beginTekst, alles\)/);
});

test('de tussenstand is zichtbaar tijdens het praten', () => {
  // Een microfoon die pas na afloop iets toont, voelt als een microfoon die
  // stuk is — en dan ga je harder praten of opnieuw beginnen.
  const blok = micHandler();
  assert.match(blok, /h\.onTekst\(\(alles, tussentijds\)/);
  assert.match(blok, /voegSamen\(SP\.voegSamen\(beginTekst, alles\), tussentijds\)/);
});

test('de tussenstand gaat rechtstreeks het veld in, niet via een hertekening', () => {
  // Hertekenen verzet de cursor en laat het veld onder je handen springen
  // terwijl je nog aan het praten bent.
  // Precies de helper afbakenen en niet een blok van zoveel tekens: anders
  // meet je de code eronder mee en betrapt de controle de verkeerde regel.
  // (Dezelfde fout die ik eerder in de cron-test maakte.)
  const i = SCHERM.indexOf('const schrijfInVeld = (tekst) => {');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const eind = SCHERM.indexOf('\n    };', i);
  assert.ok(eind > i, 'het einde van de helper hoort vindbaar te zijn');
  const body = SCHERM.slice(i, eind);
  assert.doesNotMatch(body, /DFO\?\.render/,
    'hertekenen verzet de cursor terwijl je nog aan het praten bent');
  assert.match(body, /el\.value !== tekst/);
});

// ── de knop zelf ────────────────────────────────────────────────────────────

test('de knop staat achter de vlag', () => {
  const i = SCHERM.indexOf('function _inboxMicHtml');
  const body = SCHERM.slice(i, i + 300);
  assert.match(body, /const gv = _gv2\(\);/);
  assert.match(body, /if \(!gv\) return '';/);
});

test('een browser die niet kan luisteren krijgt geen knop', () => {
  // Een knop die niets doet, laat je twijfelen aan je microfoon in plaats van
  // aan je browser.
  const i = SCHERM.indexOf('function _inboxMicHtml');
  const body = SCHERM.slice(i, i + 700);
  assert.match(body, /browserKanSpraak\(window\)/);
  assert.match(body, /return '';/);
});

test('tijdens het opnemen is de knop de stopknop', () => {
  const blok = micHandler();
  assert.match(blok, /if \(_ui\.inbox\.spraakHerkenner\)/);
  assert.match(blok, /\.stop\(\)/);
});

test('niets verstaan wordt gezegd in plaats van stil overgeslagen', () => {
  const blok = micHandler();
  assert.match(blok, /Er is niets verstaan/);
});

test('de knop staat in de rij bij het tekstvak', () => {
  assert.match(SCHERM, /const micBtn = _inboxMicHtml\(\);/);
  assert.match(SCHERM, /\$\{micBtn\}\$\{attachBtn\}/);
});
