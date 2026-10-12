// tests/iris-spam-uit-de-werkbak.test.js
//
// Spam hoort niet in "wacht op ons" (P-2).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// `spam` is een echte categorie -- reclame, phishing, onzin -- en templates.js
// geeft er terecht geen enkele antwoordsjabloon voor. Iris zag dus prima dat
// "Meta for Business" geen klant is. En dan zette cron-iris-werk de status
// alsnog op `wacht_op_ons`, want dat deed hij voor élk ingedeeld inkomend
// bericht, ongeacht de categorie.
//
// Daarmee was het verschil tussen een triage-hulp en gewoon een tweede inbox
// precies één regel code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GEEN_WERK,
  CATEGORIEEN,
  hoortInWerkbak,
  werkbakCategorieFilter,
} from '../api/_lib/iris/instellingen.js';
import { bepaalIndeling, BEWUSTE_STANDEN } from '../api/_lib/iris/indeling.js';

// ── de lijst zelf ────────────────────────────────────────────────────────────

test('GEEN_WERK bevat alleen categorieën die echt bestaan', () => {
  // Een typefout hier zou stil niets doen: de categorie komt nooit voor, dus
  // het filter werkt nooit, en niemand merkt het tot iemand de werkbak weer
  // vol spam ziet staan.
  for (const c of GEEN_WERK) assert.ok(CATEGORIEEN.includes(c), `${c} is geen categorie`);
});

test('bounce_systeem staat er met opzet NIET bij', () => {
  // Een onbestelbare mail ziet eruit als ruis, maar betekent vaak dat een adres
  // dood is. Dat is werk, geen reclame. Deze test is er zodat "die hoort er ook
  // wel bij" een bewuste beslissing wordt en geen losse hand.
  assert.ok(!GEEN_WERK.includes('bounce_systeem'));
});

// ── hoortInWerkbak ───────────────────────────────────────────────────────────

test('spam hoort niet in de werkbak, gewoon werk wel', () => {
  assert.equal(hoortInWerkbak('spam'), false);
  assert.equal(hoortInWerkbak('facturatie'), true);
  assert.equal(hoortInWerkbak('opzeg_klacht_juridisch'), true);
});

test('een gesprek zonder categorie hoort er WÉL in', () => {
  // Nog-niet-ingedeeld is geen reden om iets te verbergen. Dat is de veilige
  // kant: te veel tonen kost aandacht, te weinig tonen kost een klant.
  assert.equal(hoortInWerkbak(null), true);
  assert.equal(hoortInWerkbak(''), true);
  assert.equal(hoortInWerkbak(undefined), true);
  assert.equal(hoortInWerkbak('   '), true);
});

test('een onbekende categorie hoort er ook in', () => {
  // Als er ooit een categorie bijkomt en deze lijst achterloopt, moet het
  // gesprek zichtbaar blijven -- niet stilletjes verdwijnen.
  assert.equal(hoortInWerkbak('iets_nieuws'), true);
});

// ── het PostgREST-filter, waar de echte val zit ──────────────────────────────

test('het werkbakfilter laat rijen ZONDER categorie uitdrukkelijk door', () => {
  // DIT is de val. `.not('categorie','in','(spam)')` wordt in SQL
  // `NOT (categorie IN ('spam'))`, en dat is NULL voor een rij zonder
  // categorie -- dus die rij valt weg. Precies de nog-niet-ingedeelde
  // gesprekken, die het hardst op iemand wachten.
  const f = werkbakCategorieFilter();
  assert.ok(f.includes('categorie.is.null'), 'zonder deze tak verdwijnt "nieuw" uit de werkbak');
  assert.ok(f.includes('categorie.not.in.(spam)'));
});

test('het werkbakfilter wordt uit GEEN_WERK gebouwd, niet uit een losse tekst', () => {
  assert.equal(werkbakCategorieFilter(['a', 'b']), 'categorie.is.null,categorie.not.in.(a,b)');
});

// ── bepaalIndeling: de weg terug ─────────────────────────────────────────────

test('van spam terug naar werk zet de status op wacht_op_ons', () => {
  // Anders komt het gesprek nergens terug: Iris liet de status op 'nieuw'
  // staan, en 'nieuw' is een stand die niemand aanklikt.
  const r = bepaalIndeling({ huidigeCategorie: 'spam', huidigeStatus: 'nieuw' }, 'facturatie');
  assert.equal(r.ok, true);
  assert.equal(r.velden.categorie, 'facturatie');
  assert.equal(r.velden.status, 'wacht_op_ons');
  assert.equal(r.verandert, true);
});

test('naar spam toe blijft de status staan', () => {
  // Het categoriefilter haalt het gesprek al uit de werkbak. De status ergens
  // anders heen duwen zou informatie weggooien die klopte.
  const r = bepaalIndeling({ huidigeCategorie: 'facturatie', huidigeStatus: 'wacht_op_ons' }, 'spam');
  assert.equal(r.ok, true);
  assert.equal(r.velden.categorie, 'spam');
  assert.equal(r.velden.status, undefined, 'de status hoort niet aangeraakt te worden');
});

test('een lopende belofte wordt niet overschreven', () => {
  // belofte_loopt en geregeld zijn standen die een mens bewust gezet heeft.
  // Die terugdraaien omdat een categorie verandert, wist dat werk uit.
  for (const stand of BEWUSTE_STANDEN) {
    const r = bepaalIndeling({ huidigeCategorie: 'spam', huidigeStatus: stand }, 'betaalafspraak');
    assert.equal(r.velden.status, undefined, `${stand} hoort te blijven staan`);
  }
});

test('van het ene werk naar het andere raakt de status niet aan', () => {
  // Een gesprek waar wij al op geantwoord hebben (wacht_op_klant) mag niet
  // terug naar wacht_op_ons springen omdat iemand het label bijstelt.
  const r = bepaalIndeling({ huidigeCategorie: 'facturatie', huidigeStatus: 'wacht_op_klant' }, 'betaalafspraak');
  assert.equal(r.velden.status, undefined);
});

test('een nog niet ingedeeld gesprek met de hand indelen zet het op wacht_op_ons', () => {
  const r = bepaalIndeling({ huidigeCategorie: null, huidigeStatus: 'nieuw' }, 'lms_support');
  assert.equal(r.velden.status, 'wacht_op_ons');
});

test('een onbekende categorie wordt geweigerd, niet weggeschreven', () => {
  // De CHECK op iris_gesprekken zou hem ook weigeren, maar dan met een
  // databankfout in het scherm in plaats van een leesbaar antwoord.
  const r = bepaalIndeling({ huidigeCategorie: 'spam', huidigeStatus: 'nieuw' }, 'geen_idee');
  assert.equal(r.ok, false);
  assert.match(r.reden, /onbekende categorie/);
});

test('een lege categorie wordt geweigerd', () => {
  assert.equal(bepaalIndeling({ huidigeCategorie: 'spam', huidigeStatus: 'nieuw' }, '').ok, false);
  assert.equal(bepaalIndeling({ huidigeCategorie: 'spam', huidigeStatus: 'nieuw' }, null).ok, false);
});

test('dezelfde categorie nogmaals zetten meldt dat er niets verandert', () => {
  const r = bepaalIndeling({ huidigeCategorie: 'spam', huidigeStatus: 'nieuw' }, 'spam');
  assert.equal(r.ok, true);
  assert.equal(r.verandert, false);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const CRON = readFileSync(new URL('../api/cron-iris-werk.js', import.meta.url), 'utf8');
const POST = readFileSync(new URL('../api/iris-post.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');

test('de cron zet de status alleen als de categorie in de werkbak hoort', () => {
  // Niet op de eerste `if (bericht.gesprek_id)` mikken: dat is het ophalen van
  // de voorgeschiedenis, honderd regels hoger.
  const i = CRON.indexOf("const velden = {");
  assert.ok(i > 0, 'de update hoort uit losse velden opgebouwd te worden');
  const blok = CRON.slice(i, i + 700);
  assert.match(blok, /hoortInWerkbak\(uit\.uitkomst\.categorie\)/);
  // De categorie wordt WEL altijd geschreven -- het gesprek verdwijnt niet,
  // het staat alleen niet tussen het werk.
  assert.match(blok, /categorie: uit\.uitkomst\.categorie/);
});

test('de oude vorm -- status als vast veld in de update -- is weg', () => {
  // Zo stond het er: `status: 'wacht_op_ons',` gewoon tussen de andere velden,
  // zonder dat er ergens naar de categorie gekeken werd. Deze test vangt
  // precies dat terugkerende patroon; de vorige vangt of de voorwaarde er is.
  assert.doesNotMatch(CRON, /^\s*status: 'wacht_op_ons',$/m);
});

test('het werkbakfilter in de lijst gebruikt de or-vorm', () => {
  const i = POST.indexOf("if (filter === 'wacht_op_ons')");
  const blok = POST.slice(i, i + 900);
  assert.match(blok, /\.or\(werkbakCategorieFilter\(\)\)/);
});

test('er is een filter om de spam alsnog te bekijken', () => {
  assert.match(POST, /'spam',/, 'spam hoort in FILTERS te staan');
  const i = POST.indexOf("filter === 'spam'");
  assert.ok(i > 0, 'het filter hoort ook afgehandeld te worden');
  assert.match(POST.slice(i, i + 400), /\.in\('categorie', \[\.\.\.GEEN_WERK\]\)/);
});

test('het scherm kent het filter en de knop terug', () => {
  assert.match(SCHERM, /spam: 'Spam',/, 'de filterpil');
  assert.match(SCHERM, /function indelingKnop\(g\)/);
  assert.match(SCHERM, /window\.__irisIndeling = async/);
  // De knop moet er in de gesprekskop echt staan, niet alleen bestaan.
  assert.match(SCHERM, /\$\{indelingKnop\(g\)\}/);
});

test('de lijst wordt herladen na een correctie', () => {
  // Zonder die herlading blijft het gesprek in een filter staan waar het niet
  // meer hoort, en dan vertrouw je de lijst de volgende keer ook niet.
  const i = SCHERM.indexOf('window.__irisIndeling = async');
  const blok = SCHERM.slice(i, i + 900);
  assert.match(blok, /S\.lijst\.opgehaald = false;/);
  assert.match(blok, /haalLijst\(\);/);
});
