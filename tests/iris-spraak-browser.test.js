// tests/iris-spraak-browser.test.js
//
// De microfoon in de browser, nagerekend zonder browser.
//
// modules/iris/spraak.js is met opzet een dunne schil om SpeechRecognition:
// zuivere keuzes plus wat hak- en plakwerk. Dat betekent dat hij hier te
// beproeven is met een nagemaakte herkenner, en dat is precies de bedoeling —
// de drie fouten die een naïeve implementatie maakt (geen tussenstand, stoppen
// bij de eerste stilte, een foutcode tonen in plaats van een zin) zijn alle
// drie te vangen zonder ook maar één keer te praten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function laad() {
  const bron = readFileSync(join(ROOT, 'modules/iris/spraak.js'), 'utf8');
  const mod = { exports: {} };
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', bron)(win, mod);
  assert.equal(win.IRIS_SPRAAK, mod.exports, 'window- en module-export lopen uit elkaar');
  return mod.exports;
}

const S = laad();

/* ── De keuze tussen de twee wegen ────────────────────────────────────── */

test('met een OpenAI-sleutel gaat het naar OpenAI', () => {
  assert.equal(S.kiesRoute({ openai: true, browserKan: true }), 'openai');
  assert.equal(S.kiesRoute({ openai: true, browserKan: false }), 'openai',
    'de sleutel werkt in élke browser, ook die zonder Web Speech');
});

test('zonder sleutel luistert de browser mee', () => {
  assert.equal(S.kiesRoute({ openai: false, browserKan: true }), 'browser');
});

test('zonder allebei is er geen weg — en dat is iets anders dan een fout', () => {
  assert.equal(S.kiesRoute({ openai: false, browserKan: false }), 'geen');
  assert.equal(S.kiesRoute({}), 'geen');
  assert.equal(S.kiesRoute(null), 'geen');
});

test('alleen een echte true telt', () => {
  // Deze standen komen uit een antwoord van de server en uit een
  // browsercontrole. Een veld dat er nog niet is mag geen "ja" worden.
  assert.equal(S.kiesRoute({ openai: 'ja' }), 'geen');
  assert.equal(S.kiesRoute({ openai: 1, browserKan: 1 }), 'geen');
});

test('browserKanSpraak kijkt naar allebei de namen', () => {
  assert.equal(S.browserKanSpraak({ SpeechRecognition: function () {} }), true);
  assert.equal(S.browserKanSpraak({ webkitSpeechRecognition: function () {} }), true);
  assert.equal(S.browserKanSpraak({}), false, 'Safari en Firefox hebben die niet');
  assert.equal(S.browserKanSpraak(null), false);
  assert.equal(S.browserKanSpraak({ SpeechRecognition: 'nee' }), false);
});

/* ── Foutcodes worden zinnen ──────────────────────────────────────────── */

test('stilte is geen fout', () => {
  assert.equal(S.foutTekst('no-speech'), null);
  assert.equal(S.foutTekst('aborted'), null, 'zelf stoppen is geen fout');
  assert.equal(S.foutTekst(''), null);
});

test('geen toestemming krijgt een zin, geen code', () => {
  const t = S.foutTekst('not-allowed');
  assert.match(t, /microfoon/i);
  assert.match(t, /Typen kan wel/, 'elke melding zegt erbij dat typen blijft werken');
  assert.ok(!t.includes('not-allowed'), 'de code hoort niet op het scherm');
});

test('een onbekende code gaat wél zichtbaar door', () => {
  // Anders verdwijnt een nieuwe foutsoort in het niets en lijkt de microfoon
  // gewoon stil te staan.
  assert.match(S.foutTekst('iets-nieuws'), /iets-nieuws/);
});

/* ── Definitief en tussentijds uit elkaar houden ──────────────────────── */

const gebeurtenis = (rijen, vanaf = 0) => ({
  resultIndex: vanaf,
  results: Object.assign(rijen.map((r) => Object.assign([{ transcript: r.t }], { isFinal: r.af })), { length: rijen.length }),
});

test('definitief en tussentijds worden gescheiden', () => {
  const uit = S.leesUitkomsten(gebeurtenis([
    { t: 'verleng de toegang', af: true },
    { t: 'van Sarah', af: false },
  ]));
  assert.equal(uit.definitief, 'verleng de toegang');
  assert.equal(uit.tussentijds, 'van Sarah');
});

test('alleen het nieuwe deel telt — anders herhaalt de tekst zichzelf', () => {
  // De API levert een groeiende lijst; resultIndex zegt waar het nieuwe deel
  // begint. Vanaf nul lezen betekent dat elke zin opnieuw meegeteld wordt.
  const uit = S.leesUitkomsten(gebeurtenis([
    { t: 'oude zin', af: true },
    { t: 'nieuwe zin', af: true },
  ], 1));
  assert.equal(uit.definitief, 'nieuwe zin');
});

test('rommel geeft twee lege stukken, geen uitzondering', () => {
  for (const r of [null, undefined, {}, { results: null }, { results: 'tekst' }]) {
    assert.deepEqual(S.leesUitkomsten(r), { definitief: '', tussentijds: '' });
  }
});

test('samenvoegen laat geen dubbele spaties achter', () => {
  assert.equal(S.voegSamen('een', 'twee'), 'een twee');
  assert.equal(S.voegSamen('een ', ' twee'), 'een twee');
  assert.equal(S.voegSamen('', 'twee'), 'twee');
  assert.equal(S.voegSamen('een', ''), 'een');
  assert.equal(S.voegSamen('', ''), '');
});

/* ── De schil om de herkenner ─────────────────────────────────────────── */

/** Een nagemaakte SpeechRecognition die doet wat Chrome doet. */
function nepVenster() {
  const gemaakt = [];
  function Nep() {
    this.lang = null; this.continuous = false; this.interimResults = false;
    this.gestart = 0; this.gestopt = 0;
    gemaakt.push(this);
  }
  Nep.prototype.start = function () { this.gestart++; };
  Nep.prototype.stop = function () { this.gestopt++; };
  return { win: { SpeechRecognition: Nep }, gemaakt };
}

test('de herkenner staat op Vlaams, doorlopend en met tussenstand', () => {
  // Alle drie zijn nodig: zonder continuous stopt hij na één zin, zonder
  // interimResults zie je niets tot het eind, en zonder taal raadt hij Engels.
  const { win, gemaakt } = nepVenster();
  S.maakHerkenner(win);
  assert.equal(gemaakt[0].lang, 'nl-BE');
  assert.equal(gemaakt[0].continuous, true);
  assert.equal(gemaakt[0].interimResults, true);
});

test('zonder Web Speech komt er niets terug', () => {
  assert.equal(S.maakHerkenner({}), null);
  assert.equal(S.maakHerkenner(null), null);
});

test('de tekst groeit aan, de tussenstand niet', () => {
  const { win, gemaakt } = nepVenster();
  const h = S.maakHerkenner(win);
  const gezien = [];
  h.onTekst((alles, tussen) => gezien.push([alles, tussen]));
  h.start();
  const rec = gemaakt[0];

  // De echte API levert een GROEIENDE lijst; resultIndex zegt waar het nieuwe
  // deel begint. De nagemaakte doet dat hier net zo, anders beproeven we iets
  // anders dan wat Chrome stuurt.
  const A = { t: 'verleng de toegang', af: true };
  rec.onresult(gebeurtenis([A], 0));
  rec.onresult(gebeurtenis([A, { t: 'van Sarah', af: false }], 1));
  rec.onresult(gebeurtenis([A, { t: 'van Sarah', af: true }], 1));

  assert.deepEqual(gezien, [
    ['verleng de toegang', ''],
    ['verleng de toegang', 'van Sarah'],
    ['verleng de toegang van Sarah', ''],
  ]);
});

test('na een stilte begint hij opnieuw — anders valt hij ongemerkt stil', () => {
  // Chrome beëindigt een herkenning na een paar seconden zonder spraak, ook
  // met continuous. Het lampje gaat uit, de gebruiker praat door, en er komt
  // niets meer binnen.
  const { win, gemaakt } = nepVenster();
  const h = S.maakHerkenner(win);
  h.start();
  const rec = gemaakt[0];
  assert.equal(rec.gestart, 1);
  rec.onend();
  assert.equal(rec.gestart, 2, 'niet opnieuw gestart na een stilte');
  rec.onend();
  assert.equal(rec.gestart, 3);
});

test('zelf stoppen stopt ook echt', () => {
  const { win, gemaakt } = nepVenster();
  const h = S.maakHerkenner(win);
  let einde = null;
  h.onEinde((alles) => { einde = alles; });
  h.start();
  const rec = gemaakt[0];
  rec.onresult(gebeurtenis([{ t: 'klaar', af: true }], 0));
  h.stop();
  rec.onend();
  assert.equal(rec.gestart, 1, 'na met de hand stoppen mag hij niet herstarten');
  assert.equal(einde, 'klaar');
});

test('het herstarten heeft een bovengrens', () => {
  // Een herkenner die meteen weer eindigt zou anders een lus worden die de
  // tab vastzet.
  const { win, gemaakt } = nepVenster();
  const h = S.maakHerkenner(win, { maxHerstarts: 3 });
  let einde = 0;
  h.onEinde(() => { einde++; });
  h.start();
  const rec = gemaakt[0];
  for (let i = 0; i < 10; i++) rec.onend();
  assert.equal(rec.gestart, 4, '1 start + 3 herstarts');
  assert.equal(einde, 1, 'daarna is het één keer einde, niet tien keer');
});

test('geen toestemming stopt het herstarten meteen', () => {
  // Anders blijft hij dertig keer opnieuw vragen om iets wat geweigerd is.
  const { win, gemaakt } = nepVenster();
  const h = S.maakHerkenner(win);
  const fouten = [];
  h.onFout((tekst) => fouten.push(tekst));
  h.start();
  const rec = gemaakt[0];
  rec.onerror({ error: 'not-allowed' });
  rec.onend();
  assert.equal(rec.gestart, 1);
  assert.equal(fouten.length, 1);
  assert.match(fouten[0], /microfoon/i);
});

test('stilte meldt niets maar blijft wel luisteren', () => {
  const { win, gemaakt } = nepVenster();
  const h = S.maakHerkenner(win);
  const fouten = [];
  h.onFout((t) => fouten.push(t));
  h.start();
  const rec = gemaakt[0];
  rec.onerror({ error: 'no-speech' });
  rec.onend();
  assert.deepEqual(fouten, [], 'stilte is geen melding waard');
  assert.equal(rec.gestart, 2, 'en hij hoort gewoon door te luisteren');
});

/* ── De bedrading in het scherm ───────────────────────────────────────── */

const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

test('iris.js vraagt de weg op en kiest daarna zelf', () => {
  const b = lees('modules/iris/iris.js');
  assert.match(b, /haal\('\/api\/iris-transcribe'\)/, 'de weg wordt nergens opgevraagd');
  assert.match(b, /j && j\.openai === true \? 'openai' : 'browser'/,
    'een lossere lezing maakt van een ontbrekend veld per ongeluk de OpenAI-weg');
  assert.match(b, /kiesRoute\(\{ openai: route === 'openai', browserKan:/);
});

test('een mislukte opvraging valt terug op de browser, niet op niets', () => {
  // Een microfoon die niets doet omdat een opvraging faalde, is erger dan een
  // microfoon die het via de browser probeert.
  const b = lees('modules/iris/iris.js');
  const fn = b.slice(b.indexOf('async function haalSpraakRoute()'));
  const body = fn.slice(0, fn.indexOf('\n  /** De gekozen weg'));
  assert.ok(body.includes("catch"), 'de opvraging vangt niets op');
  const naCatch = body.slice(body.indexOf('catch'));
  assert.match(naCatch, /st\.route = 'browser';/, 'een mislukte opvraging laat de weg leeg');
});

test('beide microfoons nemen dezelfde weg', () => {
  const b = lees('modules/iris/iris.js');
  const keren = (b.match(/spraakWeg\(await haalSpraakRoute\(\)\)/g) || []).length;
  assert.equal(keren, 2, 'de Post en de Opdrachten horen allebei langs de wegkeuze');
});

test('de tussenstand gaat in het veld, niet via een hertekening', () => {
  // Een hertekening bij elk woord gooit de cursor eruit en laat het veld
  // springen. Daar waarschuwt __irisInstructie in dit bestand zelf al voor.
  const b = lees('modules/iris/iris.js');
  assert.match(b, /getElementById\('irisInstructie'\)/);
  assert.match(b, /getElementById\('irisOpdrachtVeld'\)/);
});

test('inspreken vult aan, het wist niet wat er stond', () => {
  const b = lees('modules/iris/iris.js');
  assert.match(b, /const beginTekst = S\.schrijf\.instructie\[gesprek\] \|\| '';/);
  assert.match(b, /const beginTekst = st\.nieuw \|\| '';/);
});

test('index.html laadt spraak.js vóór iris.js', () => {
  const html = lees('modules/klanten-v2/index.html');
  const sp = html.indexOf('iris/spraak.js');
  const ir = html.indexOf('iris/iris.js');
  assert.ok(sp > -1 && ir > -1);
  assert.ok(sp < ir, 'iris.js valt terug op "kan niet meeluisteren" als spraak.js later komt');
  assert.match(html, /iris\/spraak\.js\?v=\d+/);
  assert.match(html, /iris\/iris\.js\?v=\d+/);
});

test('het endpoint vertelt de weg en noemt het ontbreken geen storing', () => {
  const b = lees('api/iris-transcribe.js');
  assert.match(b, /if \(req\.method === 'GET'\) \{/);
  assert.match(b, /res\.status\(200\)\.json\(\{ route: spraakRoute\(\), openai: openaiBeschikbaar\(\) \}\)/);
  // De oude tekst zei "niet geconfigureerd" — dat leest als een fout van Maxim.
  assert.ok(!b.includes('OPENAI_API_KEY niet geconfigureerd'), 'de oude foutmelding staat er nog');
  assert.match(b, /een keuze, geen storing/);
});
