// tests/opvolging-callsblok-knoppen.test.js
//
// DE KNOPPEN IN HET CALLSBLOK, UITGEVOERD — NIET GELEZEN.
//
// De koppeling die dit belangrijk maakt: Dave kan alleen afronden bij een call
// die hij ZIET. Mehran Jahani en Sebastian Kolodziejski kregen op 9 september
// de status no_show, verdwenen daarmee uit de dagweergave, en waren uit beeld
// voordat iemand er iets mee kon. Niet vergeten door nalatigheid — het scherm
// toonde ze niet meer.
//
// Het dagbeeld toont ze nu wél. Maar een regel die je ziet en waar je niets mee
// kunt, maakt het probleem alleen zichtbaar. De afrondknop MOET er dus staan,
// juist op een doorgehaalde regel.
//
// Mijn eerste versie deed dat verkeerd (`const knoppen = dood ? '' : …`), en een
// sabotage die de knop opnieuw achter `doorgehaald` verstopte gaf NUL rood: er
// was geen enkele test die naar de view keek. Deze wel.
//
// WAT DEZE TEST DOET. Hij knipt de echte knoppen-uitdrukking uit de view en
// VOERT HEM UIT met een nagebootste regel. Dat is meer dan een
// string-vergelijking: zet iemand de knop terug achter een grijze regel, dan
// rolt er hier geen Afronden meer uit en wordt dit rood. Wat hij NIET doet is de
// pagina in een browser openen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { knoppenVoor } from '../api/_lib/opvolging-dagbeeld.js';

const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');

/**
 * De uitdrukking `const k = …` t/m het einde van `const knoppen = …;` uit het
 * callsblok halen en uitvoeren. Op het ANKER gezocht en niet op een regelnummer,
 * zodat hij niet omvalt zodra er een regel bij komt.
 */
function rendereerKnoppen(c) {
  const start = VIEW.indexOf('const k = c.knoppen ||');
  assert.ok(start > 0, 'de knoppen-uitdrukking is niet gevonden in de view');
  // Op de sluitende ternary zoeken en NIET op de eerste puntkomma: die zit in
  // de HTML-entiteit `&rarr;` en knipt de uitdrukking midden in een string
  // doormidden. Kostte een ronde.
  const eind = VIEW.indexOf(": '');", VIEW.indexOf('k.afronden ?', start));
  assert.ok(eind > start, 'het einde van de uitdrukking is niet gevonden');
  const bron = VIEW.slice(start, eind + ": '');".length) + '\nknoppen;';
  const ctx = createContext({ c, i: 0, esc: (s) => String(s == null ? '' : s) });
  return runInContext(bron, ctx, { filename: 'opvolging-v2.js#knoppen' });
}

const MORGEN = Date.parse('2026-09-09T07:00:00Z');
const regel = (over) => {
  const a = {
    id: 'm', lead_name: 'Mehran Jahani', status: 'no_show',
    scheduled_at: '2026-09-08T16:00:00Z', eerst_gepland_op: '2026-09-08T16:00:00Z',
    lead_phone: '+32470111222', zoom_join_url: 'https://zoom.us/j/1', ...over,
  };
  return {
    naam: a.lead_name, telefoon: a.lead_phone, zoom_url: a.zoom_join_url,
    start: a.scheduled_at, doorgehaald: true,
    knoppen: knoppenVoor(a, MORGEN),
  };
};

test('een no-show van gisteren krijgt een AFRONDEN-knop, ook al is de regel grijs', () => {
  const html = rendereerKnoppen(regel());
  assert.match(html, /Afronden/, 'zonder deze knop is de no-show zichtbaar maar niet vastlegbaar');
});

test('en knoppen om na te bellen', () => {
  const html = rendereerKnoppen(regel());
  assert.match(html, /Bellen/);
  assert.match(html, /WhatsApp/);
});

test('maar geen Zoom-link bij een call die geweest is', () => {
  assert.doesNotMatch(rendereerKnoppen(regel()), /Zoom/);
});

test('bij een geannuleerde afspraak staat er geen enkele knop', () => {
  assert.equal(rendereerKnoppen(regel({ status: 'cancelled' })).trim(), '');
});

test('de view mag de knop NIET achter doorgehaald verstoppen', () => {
  // De regressie in mijn eigen eerste versie. Een doorgehaalde regel met
  // afronden:true hoort de knop te krijgen — dat is het hele punt.
  const c = regel();
  assert.equal(c.doorgehaald, true);
  assert.equal(c.knoppen.afronden, true);
  assert.match(rendereerKnoppen(c), /Afronden/);
});

test('een oudere server zonder het knoppen-veld valt terug op het oude gedrag', () => {
  // Terugval, zodat een deploy waarin de frontend voorloopt op de backend geen
  // lege actiekolom oplevert.
  const html = rendereerKnoppen({ naam: 'X', telefoon: '+32470', zoom_url: null, knoppen: undefined });
  assert.match(html, /Afronden/);
  assert.match(html, /Bellen/);
});
