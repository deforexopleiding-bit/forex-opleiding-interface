// tests/iris-aandacht-en-ruimte.test.js
//
// De ruimte volgt de aandacht, en één ding schreeuwt (P-3 + layout).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Stond er geen gesprek open, dan deed het raster toch alsof: de lijst werd tot
// 260-320px samengeknepen en de twee kolommen ernaast stonden leeg te zijn
// omdat de indeling het zo wilde. Twee derde van het scherm deed niets,
// terwijl het enige dat er wél stond het krapst zat.
//
// En er was nergens een regel die zei wat er NÚ moest gebeuren. Je moest zelf
// door de lijst om te zien of er iets dringde.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aandachtsregel, lijstTelling, SOORTEN, DREMPEL_WACHT } from '../api/_lib/iris/aandacht.js';

// ── de ene regel ─────────────────────────────────────────────────────────────

test('geen regel als er niets aan de hand is', () => {
  // Een balk die er altijd staat, lees je na twee dagen niet meer -- en dan
  // neemt hij de plek in van iets dat wél nieuw is.
  assert.equal(aandachtsregel({}), null);
  assert.equal(aandachtsregel({ venster_bijna_dicht: 0, melding_hangt: 0, wacht_op_ons: 0 }), null);
  assert.equal(aandachtsregel(null), null);
});

test('een venster dat bijna dichtgaat wint van alles', () => {
  // De volgorde is de volgorde van onomkeerbaarheid. Dit is het enige met een
  // harde klok van buiten: over een uur kan het niet meer, en dan kan het de
  // eerstvolgende 24 uur alleen nog met een template.
  const r = aandachtsregel({ venster_bijna_dicht: 2, melding_hangt: 5, wacht_op_ons: 200 });
  assert.equal(r.soort, 'venster_bijna_dicht');
  assert.equal(r.toon, 'dringend');
  assert.equal(r.naar.filter, 'venster_bijna_dicht');
});

test('een hangende melding wint van werk dat wacht', () => {
  // Stil kapot is het ergste soort kapot: iemand vroeg om bericht, de termijn
  // is om, en de mail kwam niet aan.
  const r = aandachtsregel({ melding_hangt: 1, wacht_op_ons: 200 });
  assert.equal(r.soort, 'melding_hangt');
  assert.equal(r.naar.tab, 'opdrachten');
});

test('werk dat wacht is pas een mededeling boven een drempel', () => {
  // Anders staat er elke ochtend een regel die zegt dat er werk is, en dat
  // wist je al.
  assert.equal(aandachtsregel({ wacht_op_ons: DREMPEL_WACHT - 1 }), null);
  const r = aandachtsregel({ wacht_op_ons: DREMPEL_WACHT });
  assert.equal(r.soort, 'wacht_op_ons');
  assert.equal(r.toon, 'let_op', 'werk dat wacht is geen alarm');
});

test('enkelvoud leest als enkelvoud', () => {
  assert.match(aandachtsregel({ venster_bijna_dicht: 1 }).tekst, /één gesprek/i);
  assert.match(aandachtsregel({ venster_bijna_dicht: 2 }).tekst, /2 gesprekken/);
  assert.match(aandachtsregel({ melding_hangt: 1 }).tekst, /Eén opvolging/);
});

test('rommel in de tellingen telt als nul, niet als iets', () => {
  // Een balk die afgaat op een onleesbaar getal is een balk die vals alarm
  // geeft, en daarna negeer je hem ook als hij gelijk heeft.
  assert.equal(aandachtsregel({ venster_bijna_dicht: 'veel' }), null);
  assert.equal(aandachtsregel({ venster_bijna_dicht: -3 }), null);
  assert.equal(aandachtsregel({ melding_hangt: null, wacht_op_ons: undefined }), null);
});

test('elke regel weet waar hij heen wijst', () => {
  // Een mededeling die je zelf moet navigeren, is een mededeling die je
  // negeert.
  for (const t of [{ venster_bijna_dicht: 1 }, { melding_hangt: 1 }, { wacht_op_ons: 999 }]) {
    const r = aandachtsregel(t);
    assert.ok(r.naar && (r.naar.tab || r.naar.filter), JSON.stringify(t));
  }
});

test('SOORTEN staat in dezelfde volgorde als de voorrang', () => {
  // De lijst is documentatie; loopt hij uit de pas met de code, dan klopt de
  // uitleg niet meer met wat er gebeurt.
  const gevonden = [
    aandachtsregel({ venster_bijna_dicht: 1, melding_hangt: 1, wacht_op_ons: 999 }).soort,
    aandachtsregel({ melding_hangt: 1, wacht_op_ons: 999 }).soort,
    aandachtsregel({ wacht_op_ons: 999 }).soort,
  ];
  assert.deepEqual(gevonden, [...SOORTEN]);
});

// ── het getal boven de lijst ─────────────────────────────────────────────────

test('een getal boven de lijst, en niets bij een lege lijst', () => {
  assert.equal(lijstTelling(0), null);
  assert.equal(lijstTelling(1), '1 gesprek');
  assert.equal(lijstTelling(42), '42 gesprekken');
  assert.equal(lijstTelling(42, 3), '42 gesprekken · 3 dringt');
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const POST = readFileSync(new URL('../api/iris-post.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');

test('de tellingen zijn head-queries en halen geen rijen op', () => {
  // De balk staat op élke tab en ververst bij elke poll. Zonder head:true is
  // dat het verschil tussen een regel tekst en een halve megabyte.
  const i = POST.indexOf('async function geefAandacht');
  assert.ok(i > 0);
  const blok = POST.slice(i, POST.indexOf('\n}', i));
  const heads = blok.match(/head: true/g) || [];
  assert.equal(heads.length, 3, 'drie tellingen, drie head-queries');
  assert.doesNotMatch(blok, /\.select\('\*'\)/);
});

test('de venstertelling kijkt alleen naar WhatsApp', () => {
  // Voor mail bestaat het venster niet (P-1). Mail meetellen zou de balk laten
  // afgaan op een deadline die er niet is.
  const i = POST.indexOf('async function geefAandacht');
  const blok = POST.slice(i, POST.indexOf('\n}', i));
  assert.match(blok, /\.eq\('kanaal', 'whatsapp'\)/);
});

test('de werktelling gebruikt hetzelfde filter als de lijst', () => {
  // Spam telt niet mee, want spam is geen werk (P-2). Twee tellingen die
  // verschillend rekenen, geven een balk die iets anders zegt dan de lijst.
  const i = POST.indexOf('async function geefAandacht');
  const blok = POST.slice(i, POST.indexOf('\n}', i));
  assert.match(blok, /\.or\(werkbakCategorieFilter\(\)\)/);
});

test('een ontbrekende opvolgingentabel is geen storing', () => {
  // De migratie van 28 september is misschien nog niet gedraaid. Dan is het
  // getal nul, en blijft de rest van de balk werken.
  const i = POST.indexOf('async function geefAandacht');
  const blok = POST.slice(i, POST.indexOf('\n}', i));
  assert.match(blok, /42P01/);
});

test('de grens voor "bijna dicht" komt uit venster.js en staat niet twee keer', () => {
  assert.match(POST, /BIJNA_DICHT_MINUTEN/);
  // Geen tweede getal dat hetzelfde zou moeten betekenen.
  const i = POST.indexOf('async function geefAandacht');
  const blok = POST.slice(i, POST.indexOf('\n}', i));
  assert.doesNotMatch(blok, /\b120\b/);
});

// ── de ruimte ────────────────────────────────────────────────────────────────

test('zonder keuze is de lijst het scherm', () => {
  assert.match(SCHERM, /\.iris-post:not\(\.heeft-keuze\)\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(SCHERM, /\.iris-post:not\(\.heeft-keuze\) \.iris-post-draad,[\s\S]{0,80}\.iris-post-dossier\{display:none\}/);
});

test('in de brede stand mag de samenvatting doorlopen', () => {
  // Die heeft Iris toch al geschreven. In de smalle kolom zou diezelfde regel
  // de rij twee keer zo hoog maken voor tekst die je dan afkapt.
  assert.match(SCHERM, /\.iris-post:not\(\.heeft-keuze\) \.iris-rij-samenvatting\{/);
  assert.match(SCHERM, /class="iris-rij-samenvatting"/, 'de rij hoort die klasse te dragen');
  assert.match(SCHERM, /class="iris-rij"/);
});

test('de balk staat boven de inhoud en op elke tab', () => {
  // Boven ${binnen}, dus buiten de tab-keuze -- niet per tab opnieuw bedacht.
  const i = SCHERM.indexOf('${aandachtBalk()}');
  const j = SCHERM.indexOf('${binnen}', i);
  assert.ok(i > 0 && j > i, 'de balk hoort vóór de tabinhoud te staan');
});

test('de balk verdwijnt als er niets is en als tellen mislukt', () => {
  const i = SCHERM.indexOf('function aandachtBalk()');
  const blok = SCHERM.slice(i, i + 600);
  assert.match(blok, /if \(!r \|\| !r\.tekst\) return '';/);
  // En bij een fout wordt de regel gewist in plaats van blijven staan.
  const h = SCHERM.indexOf('async function haalAandacht');
  assert.match(SCHERM.slice(h, h + 900), /st\.regel = null;[\s\S]{0,120}console\.warn/);
});

test('de poll ververst de balk mee', () => {
  // Een balk die een uur achterloopt is een balk die liegt.
  const i = SCHERM.indexOf('function startPoll()');
  const blok = SCHERM.slice(i, SCHERM.indexOf('function stopPoll', i));
  assert.match(blok, /haalAandacht\(\);/);
});

test('het getal boven de lijst komt van het totaal, niet van de geladen pagina', () => {
  // De lijst toont er vijftig van de driehonderd; "3 dringt" over een halve
  // lijst is erger dan geen getal.
  const i = SCHERM.indexOf('function lijstTelling()');
  assert.ok(i > 0);
  const blok = SCHERM.slice(i, i + 1400);
  assert.match(blok, /st\.totaal/);
  assert.match(blok, /S\.aandacht\.tellingen/);
  assert.doesNotMatch(blok, /st\.items\.length/);
});
