// tests/opvolging-rapport-print.test.js
//
// De printweergave van het dagrapport (fase 3).
//
// TWEE DINGEN DIE HIER NOOIT MOGEN GEBEUREN.
//
// 1. EEN TWEEDE BEREKENING. Elk cijfer in de PDF komt uit hetzelfde antwoord
//    als het scherm. Zou de printweergave zelf gaan tellen of een eigen
//    drempel hanteren, dan staat er over een maand iets anders in de PDF dan op
//    het scherm en weet niemand welke van de twee liegt.
//
// 2. EEN PUBLIEKE ROUTE. Dit rapport toont namen van leads. De pagina doet
//    requireAuth vóór er iets opgehaald of getoond wordt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRINT = readFileSync(join(ROOT, 'modules/klanten-v2/rapport-print.html'), 'utf8');
const VIEW  = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
const API   = readFileSync(join(ROOT, 'api/opvolging-rapport.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// GEEN TWEEDE BEREKENING
// ═══════════════════════════════════════════════════════════════════════════

test('de printweergave hanteert geen eigen drempels', () => {
  // De gespreksgrens, de venstertijden en de archiveerdrempel komen alle drie
  // uit d.drempels. Een getal dat hier hardcoded staat gaat op een dag afwijken
  // van het scherm.
  assert.match(PRINT, /d\.drempels\.gesprek_min_sec/);
  assert.match(PRINT, /d\.drempels\.spraak_voor_uur/);
  assert.match(PRINT, /d\.drempels\.nabel_van_uur/);
  // Geen eigen constante met een secondegrens of een uurgrens.
  assert.doesNotMatch(PRINT, /GESPREK_MIN|MIN_SEC\s*=\s*\d/);
  assert.doesNotMatch(PRINT, /SPRAAK_DEADLINE|NABEL_VAN_UUR\s*=/);
});

test('de printweergave telt niets zelf uit de ruwe pogingen', () => {
  // Het endpoint levert de tellingen. Zou hier een filter over pogingen staan,
  // dan is dat een tweede definitie van wat meetelt.
  assert.doesNotMatch(PRINT, /isMoeite|isContact|isGesprek/);
  assert.doesNotMatch(PRINT, /\.filter\([^)]*soort\s*===\s*'call'/);
  assert.doesNotMatch(PRINT, /richting\s*!==\s*'in'/);
});

test('de meetregel staat er letterlijk in, met de grens uit het endpoint', () => {
  // Het belangrijkste zinnetje van het rapport: als Dave een cijfer betwist
  // moet de regel er zwart op wit bij staan.
  const i = PRINT.indexOf('class="meetregel"');
  assert.ok(i > 0, 'de meetregel hoort te bestaan');
  const blok = PRINT.slice(i, i + 500);
  assert.match(blok, /gesprek/);
  assert.match(blok, /d\.drempels\.gesprek_min_sec/);
  assert.match(blok, /poging/);
});

test('elk veld dat de print leest, bestaat in het antwoord van het endpoint', () => {
  // Een tikfout in een veldnaam levert geen fout op maar een leeg vakje —
  // precies de stille vorm waar dit rapport niet in mag trappen.
  const velden = [
    'periode', 'drempels', 'aandacht', 'dekking', 'vensters', 'zoomcalls', 'archief', 'volume',
  ];
  for (const v of velden) {
    assert.match(PRINT, new RegExp('\\bd\\.' + v + '\\b'), 'print leest d.' + v);
    assert.match(API, new RegExp('\\b' + v + '\\s*[:,]'), 'endpoint levert ' + v + ' niet');
  }
});

test('ernst en label komen uit het endpoint, niet uit de opmaak', () => {
  // De kleur en het kadertje per bevinding zijn een beoordeling. Die hoort op
  // één plek te staan, naast waar de bevindingen ontstaan.
  assert.match(PRINT, /a\.ernst/);
  assert.match(PRINT, /a\.label/);
  assert.match(API, /BEVINDING_SOORTEN/);
  assert.match(API, /function metErnst/);
  // Geen eigen mapping in de printweergave.
  assert.doesNotMatch(PRINT, /soort\s*===\s*'niet_behandeld'/);
});

test('elke bevindingssoort die het endpoint maakt heeft een ernst en een label', () => {
  // Anders valt een soort terug op de standaard en ziet niemand dat er een
  // categorie bij is gekomen.
  const soorten = [...API.matchAll(/soort:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const gedekt = [...API.matchAll(/^\s{2}([a-z_]+)\s*:\s*\{ ernst:/gm)].map((m) => m[1]);
  const missend = [...new Set(soorten)].filter((s) => !gedekt.includes(s));
  assert.deepEqual(missend, [], 'zonder ernst/label: ' + missend.join(', '));
});

// ═══════════════════════════════════════════════════════════════════════════
// NIET PUBLIEK
// ═══════════════════════════════════════════════════════════════════════════

test('er wordt niets opgehaald voordat de sessie is gecontroleerd', () => {
  // OP DE AANROEP ZOEKEN, NIET OP HET WOORD. Een eerdere versie deed
  // indexOf('requireAuth') en vond daarmee de zin in het commentaar bovenaan
  // het bestand. Die staat altijd vóór de fetch, dus de test slaagde ook toen
  // ik de auth-blok expres ná het ophalen zette. Hij bewaakte het commentaar in
  // plaats van de code — precies de vorm die we deze week al vier keer hadden.
  const auth = PRINT.indexOf('AuthShared.requireAuth(');
  const fetchIdx = PRINT.indexOf("fetch('/api/opvolging-rapport");
  assert.ok(auth > 0, 'de aanroep AuthShared.requireAuth() hoort te bestaan');
  assert.ok(fetchIdx > 0, 'de fetch hoort te bestaan');
  assert.ok(auth < fetchIdx, 'requireAuth hoort vóór de fetch te staan');
  // En het renderen mag er ook niet vóór komen.
  assert.ok(auth < PRINT.indexOf('toon(bouw(data))'), 'er mag niets getekend worden vóór de auth');
});

test('de fetch stuurt de Bearer-token mee', () => {
  assert.match(PRINT, /Authorization: 'Bearer ' \+ token/);
});

test('een 403 wordt eerlijk gemeld en niet als leeg rapport afgedrukt', () => {
  const i = PRINT.indexOf('if (!resp.ok)');
  assert.ok(i > 0);
  const blok = PRINT.slice(i, i + 400);
  assert.match(blok, /melding\(/);
  assert.match(blok, /return;/);
});

test('de knop opent de printweergave met dezelfde periode als het scherm', () => {
  const i = VIEW.indexOf('window.__opvRapportPdf');
  assert.ok(i > 0, 'de knop-handler hoort te bestaan');
  const blok = VIEW.slice(i, i + 700);
  // Dezelfde periodeReeks als het scherm gebruikt — niet zelf van/tot bedenken.
  assert.match(blok, /periodeReeks\(_ui\.rapportPeriode, _ui\.rapportEigen\)/);
  assert.match(blok, /rapport-print\.html\?van=/);
});

test('de knop heet Rapport als PDF en staat bij de periodekiezer', () => {
  const i = VIEW.indexOf('function periodeKiezer');
  const j = VIEW.indexOf('\n  }', i);
  const blok = VIEW.slice(i, j);
  assert.match(blok, /Rapport als PDF/);
  assert.match(blok, /__opvRapportPdf/);
});

// ═══════════════════════════════════════════════════════════════════════════
// PAPIERREGELS
// ═══════════════════════════════════════════════════════════════════════════

test('de pagina is op A4 gezet met de afgesproken marges', () => {
  assert.match(PRINT, /@page\s*\{\s*size:\s*A4;\s*margin:\s*16mm 14mm 18mm;\s*\}/);
});

test('achtergronden worden niet weggedrukt', () => {
  // Zonder print-color-adjust verdwijnen de gekleurde randen van de
  // bevindingen, en dat is het enige dat de ernst zichtbaar maakt.
  assert.match(PRINT, /-webkit-print-color-adjust:\s*exact/);
  assert.match(PRINT, /print-color-adjust:\s*exact/);
});

test('niets valt halverwege een pagina doormidden', () => {
  // Let op de selector-escape: 'tr' is geen klasse, dus er mag geen punt of
  // backslash voor. Een eerdere versie bouwde daar '\tr' van — een tab plus
  // een r — en die matchte natuurlijk nooit.
  for (const sel of ['\\.tegels', '\\.bev', '\\btr', '\\.balk']) {
    const re = new RegExp(sel + '[^{]*\\{[^}]*break-inside:\\s*avoid');
    assert.match(PRINT, re, sel + ' mist break-inside:avoid');
  }
});

test('getalkolommen krijgen tabular-nums én padding', () => {
  const i = PRINT.indexOf('.getalkolom{');
  assert.ok(i > 0);
  const blok = PRINT.slice(i, PRINT.indexOf('}', i));
  assert.match(blok, /tabular-nums/);
  // Zonder padding plakt de tijd tegen de kolom ernaast.
  assert.match(blok, /padding-left:\s*\d+px/);
});

test('er staat een voettekst op elke pagina', () => {
  assert.match(PRINT, /\.voet\{position:fixed/);
  assert.match(PRINT, /class="voet"/);
});

test('statuskleur staat nooit alleen — er hoort altijd een woord bij', () => {
  // Dit wordt ook zwart-wit geprint. Een bolletje zonder tekst is dan niets.
  const i = PRINT.indexOf('function sectieZoomcalls');
  const blok = PRINT.slice(i, PRINT.indexOf('function sectieArchief'));
  assert.match(blok, /class="legende"/, 'de bolletjes horen een legende te hebben');
  assert.match(blok, /moet nog plaatsvinden/);
  assert.match(blok, /geannuleerd/);
});

test('er komt geen PDF-bibliotheek of headless browser aan te pas', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  for (const verboden of ['puppeteer', 'playwright', 'jspdf', 'html-pdf', 'chrome-aws-lambda']) {
    assert.ok(!deps.includes(verboden), verboden + ' hoort hier niet bij te komen');
  }
  assert.match(PRINT, /window\.print\(\)/);
});
