// tests/iris-belrij-voortgang-en-bellen.test.js
//
// De belrij zegt waar je staat, en je kunt er vanaf bellen (B-1 + B-2).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// B-1. In de kop stond "Escaleren na 3 pogingen in 3 dagen". Dat is de REGEL,
//      niet de stand. Bij een rij die daar nog niet is, moest je zelf de
//      pogingen tellen en de regel erop toepassen -- en dat doet niemand.
//
// B-2. De lijst was een lijst; het nummer moest je overnemen. Een belknop
//      scheelt per telefoontje een handeling en een kans op een typefout.
//
// En onderweg bleek er een derde ding: de "escaleren"-badge las
// `r.escalatie.moet`, terwijl het endpoint `{ escaleren, reden }` teruggeeft.
// Die badge is dus nooit één keer op het scherm verschenen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voortgang, nummerAfgeschermd, moetEscaleren, telPogingen } from '../api/_lib/iris/belrij.js';

const DREMPEL = { pogingen: 3, dagen: 3 };

// ── de stand per rij ─────────────────────────────────────────────────────────

test('de stand zegt pogingen EN dagen', () => {
  // De dagen zijn het halve punt: drie keer bellen op één ochtend is geen drie
  // dagen proberen. Zonder dat getal ziet iemand die vanochtend drie keer
  // probeerde eruit alsof hij klaar is om te escaleren.
  const v = voortgang({ niet_opgenomen: 3, dagen_niet_opgenomen: 1 }, DREMPEL);
  assert.equal(v.tekst, '3 van 3 pogingen · 1 van 3 dagen');
  assert.equal(v.klaar, false, 'drie keer op één dag is niet klaar');
});

test('klaar is pas klaar als allebei gehaald zijn', () => {
  assert.equal(voortgang({ niet_opgenomen: 3, dagen_niet_opgenomen: 3 }, DREMPEL).klaar, true);
  assert.equal(voortgang({ niet_opgenomen: 2, dagen_niet_opgenomen: 3 }, DREMPEL).klaar, false);
});

test('nul pogingen leest als nul en niet als leeg', () => {
  const v = voortgang({}, DREMPEL);
  assert.equal(v.tekst, '0 van 3 pogingen · 0 van 3 dagen');
});

test('de drempel komt uit de instellingen, met een verdedigbare terugval', () => {
  const v = voortgang({ niet_opgenomen: 1 }, { pogingen: 5, dagen: 4 });
  assert.match(v.tekst, /1 van 5 pogingen/);
  assert.match(v.tekst, /0 van 4 dagen/);
  // Geen drempel meegegeven: drie en drie, gelijk aan moetEscaleren.
  assert.equal(voortgang({}, {}).nodig_pogingen, 3);
  assert.equal(voortgang({}, null).nodig_dagen, 3);
});

test('DE STAND EN DE ESCALATIE REKENEN HETZELFDE', () => {
  // Twee plekken die hetzelfde moeten weten lopen een keer uit de pas. Als de
  // rij "3 van 3 pogingen · 3 van 3 dagen" zegt en de badge blijft weg, of
  // andersom, dan gelooft niemand meer wat er staat.
  const gevallen = [
    { niet_opgenomen: 0, dagen_niet_opgenomen: 0 },
    { niet_opgenomen: 2, dagen_niet_opgenomen: 2 },
    { niet_opgenomen: 3, dagen_niet_opgenomen: 1 },
    { niet_opgenomen: 3, dagen_niet_opgenomen: 3 },
    { niet_opgenomen: 9, dagen_niet_opgenomen: 5 },
  ];
  for (const t of gevallen) {
    const v = voortgang(t, DREMPEL);
    const e = moetEscaleren(t, DREMPEL, {});
    assert.equal(v.klaar, e.escaleren, JSON.stringify(t));
  }
});

test('wie gesproken is, escaleert niet — ook niet met tien pogingen', () => {
  const telling = { niet_opgenomen: 9, dagen_niet_opgenomen: 5, laatste_contact: '2026-09-20T10:00:00Z' };
  assert.equal(moetEscaleren(telling, DREMPEL, {}).escaleren, false);
  // De STAND toont dan nog steeds de pogingen -- dat is geen tegenspraak maar
  // twee verschillende vragen: hoe vaak geprobeerd, en moet het hogerop.
  assert.equal(voortgang(telling, DREMPEL).pogingen, 9);
});

// ── het nummer ───────────────────────────────────────────────────────────────

test('het nummer op het scherm is afgeschermd', () => {
  // Genoeg om te zien dat je de juiste rij te pakken hebt, te weinig om iets
  // mee te doen -- en het staat dus ook niet in een schermafdruk die iemand
  // doorstuurt.
  assert.equal(nummerAfgeschermd('+32 470 12 34 56'), '•••• 3456');
  assert.equal(nummerAfgeschermd('0470123456'), '•••• 3456');
});

test('geen of een onbruikbaar nummer geeft niets', () => {
  assert.equal(nummerAfgeschermd(null), null);
  assert.equal(nummerAfgeschermd(''), null);
  assert.equal(nummerAfgeschermd('abc'), null);
  assert.equal(nummerAfgeschermd('12'), null);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const ENDPOINT = readFileSync(new URL('../api/iris-belrij.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');

/**
 * Alleen de code, zonder commentaar.
 *
 * Een test die op proza afgaat, meet niets: de regel is weg, de zin die
 * vertelt dat hij weg is blijft staan, en de test slaat alarm op zijn eigen
 * uitleg. Zelfde helper als in tests/iris-venster-alleen-whatsapp.test.js.
 */
function zonderCommentaar(bron) {
  return bron
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((r) => r.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

test('de rij draagt zijn eigen stand mee', () => {
  assert.match(ENDPOINT, /voortgang: voortgang\(telling, instellingen\.escalatie\)/);
  assert.match(ENDPOINT, /telefoon_kort: nummerAfgeschermd/);
});

test('DE ESCALEREN-BADGE LEEST HET JUISTE VELD', () => {
  // Dit was de stille bug. moetEscaleren geeft { escaleren, reden } terug; het
  // scherm las `.moet`, en dat bestaat niet -- dus die badge is nooit één keer
  // verschenen.
  assert.match(SCHERM, /r\.escalatie && r\.escalatie\.escaleren/);
  // Op de CODE, niet op de uitleg hierboven -- die noemt het oude veld.
  assert.doesNotMatch(zonderCommentaar(SCHERM), /r\.escalatie\.moet/);
});

test('het scherm toont de stand per rij', () => {
  const i = SCHERM.indexOf('const stand = r.voortgang');
  assert.ok(i > 0, 'de stand hoort per rij getekend te worden');
  assert.match(SCHERM.slice(i, i + 500), /r\.voortgang\.tekst/);
});

test('de belknop hergebruikt de bestaande softphone', () => {
  // Een tweede softphone zou betekenen dat een wijziging aan de SIP-kant op
  // twee plekken door moet -- dezelfde afweging als bij de microfoon.
  const i = SCHERM.indexOf('window.__irisBel =');
  assert.ok(i > 0);
  const blok = SCHERM.slice(i, i + 1200);
  assert.match(blok, /window\.KlxSoftphone/);
  assert.match(blok, /sp\.open\(\{/);
  assert.match(blok, /source: 'iris-belrij'/);
  // Geen eigen SIP-code in deze module.
  assert.doesNotMatch(SCHERM, /new SIP\.|UserAgent\(/);
});

test('de softphone staat al in de schil', () => {
  // Zonder dit script is KlxSoftphone er niet en valt de knop altijd terug.
  assert.match(INDEX, /klx-softphone\.js/);
});

test('zonder softphone zegt de knop het en valt hij terug', () => {
  // Stil niets doen zou betekenen dat je twee keer drukt en dan zelf gaat
  // zoeken waar het nummer stond.
  const i = SCHERM.indexOf('window.__irisBel =');
  const blok = SCHERM.slice(i, i + 1400);
  assert.match(blok, /toast\(/);
  assert.match(blok, /'tel:'/);
});

test('de knop geeft een INDEX door, geen telefoonnummer', () => {
  // Twee redenen: een string in een HTML-attribuut is de bekende val, en een
  // telefoonnummer hoort niet in de opmaak waar een schermafdruk hem meeneemt.
  const i = SCHERM.indexOf('function belKnop(r, i)');
  assert.ok(i > 0);
  const blok = SCHERM.slice(i, i + 1400);
  assert.match(blok, /__irisBel\(\$\{i\}\)/);
  assert.doesNotMatch(blok, /onclick="__irisBel\('/);
  assert.doesNotMatch(blok, /\$\{r\.telefoon\}/, 'het volle nummer hoort niet in de opmaak');
});

test('een rij zonder nummer krijgt geen knop die niets doet', () => {
  const i = SCHERM.indexOf('function belKnop(r, i)');
  const blok = SCHERM.slice(i, i + 500);
  assert.match(blok, /if \(!r \|\| !r\.telefoon\)/);
  assert.match(blok, /geen nummer/);
});

test('de knop waarschuwt als er vandaag al gebeld is', () => {
  // Een lijst die dat niet zegt, levert precies het telefoontje op dat de klant
  // twee keer krijgt.
  const i = SCHERM.indexOf('function belKnop(r, i)');
  const blok = SCHERM.slice(i, i + 1200);
  assert.match(blok, /mag_vandaag_nog === false/);
});
