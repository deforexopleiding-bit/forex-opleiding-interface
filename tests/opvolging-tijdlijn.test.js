// tests/opvolging-tijdlijn.test.js
//
// De tijdlijn met heatmap. Gebouwd om de gemeten dag van 7 september heen, en
// om de drie manieren waarop dit ontwerp stil fout gaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bouwTijdlijn, staafHoogte, spreid, minutenInZone,
  REFERENTIE_SEC, BREEDTE, MARGE, KLEUR,
} from '../api/_lib/opvolging-tijdlijn.js';

const call = (uurUtc, min, res, duur) => ({
  soort: 'call', richting: 'uit', duur_sec: duur, resultaat: res,
  tijdstip: `2026-09-07T${String(uurUtc).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 · VASTE SCHAAL — dagen moeten vergelijkbaar zijn
// ═══════════════════════════════════════════════════════════════════════════

test('de staafhoogte hangt aan een VASTE referentie, niet aan de langste call van die dag', () => {
  // Schalen op het dagmaximum laat een dag met een langste gesprek van 30
  // seconden er precies zo uitzien als een dag met 90. In een rapport dat je
  // dag na dag naast elkaar legt is dat waardeloos.
  const dagA = bouwTijdlijn({ pogingen: [call(8, 0, 'gesproken', 30)], afspraken: [], dag: '2026-09-07' });
  const dagB = bouwTijdlijn({ pogingen: [call(8, 0, 'gesproken', 90)], afspraken: [], dag: '2026-09-08' });
  const hoogteVan = (svg) => Number(svg.match(/height="([\d.]+)" rx="1.5"/)[1]);
  assert.notEqual(hoogteVan(dagA.svg), hoogteVan(dagB.svg),
    'twee verschillende gespreksduren horen twee verschillende hoogtes te geven');
  assert.equal(hoogteVan(dagA.svg).toFixed(1), staafHoogte(30).h.toFixed(1));
  assert.equal(hoogteVan(dagB.svg).toFixed(1), staafHoogte(90).h.toFixed(1));
});

test('de formule is 9 + 73 maal de wortel van duur gedeeld door 120', () => {
  assert.equal(staafHoogte(0).h, 9);
  assert.equal(staafHoogte(REFERENTIE_SEC).h.toFixed(3), (9 + 73).toFixed(3));
  assert.equal(staafHoogte(30).h.toFixed(3), (9 + 73 * Math.sqrt(0.25)).toFixed(3));
});

test('boven de referentie wordt afgekapt, met een driehoekje dat dat zegt', () => {
  assert.equal(staafHoogte(200).afgekapt, true);
  assert.equal(staafHoogte(200).h, staafHoogte(REFERENTIE_SEC).h, 'geklemd op de maximale hoogte');
  const t = bouwTijdlijn({ pogingen: [call(8, 0, 'gesproken', 200)], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, /<polygon/, 'er hoort een driehoekje te staan');
  assert.match(t.svg, /afgekapt: 200 s/);
});

test('de hulplijnen op 30 en 60 seconden staan er altijd, ook op een stille dag', () => {
  // Zonder die lijnen is de schaal niet te lezen.
  const t = bouwTijdlijn({ pogingen: [], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, />30s</);
  assert.match(t.svg, />60s</);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · NIETS VALT STIL VAN DE AS
// ═══════════════════════════════════════════════════════════════════════════

test('een belpoging om 22:10 valt niet van de as maar verruimt hem', () => {
  const laat = call(20, 10, 'gesproken', 30);      // 22:10 lokaal
  const t = bouwTijdlijn({ pogingen: [laat], afspraken: [], dag: '2026-09-07' });
  assert.ok(t.verruimd, 'het venster hoort verruimd te zijn');
  assert.equal(t.venster.tot, '23:00');
  assert.match(t.verruimd.reden, /verruimd/);
});

test('binnen het venster blijft de as gewoon 09:00 tot 21:00', () => {
  const t = bouwTijdlijn({ pogingen: [call(8, 30, 'gesproken', 30)], afspraken: [], dag: '2026-09-07' });
  assert.equal(t.verruimd, null);
  assert.equal(t.venster.van, '09:00');
  assert.equal(t.venster.tot, '21:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · BOTSINGEN — zes calls in zeven minuten
// ═══════════════════════════════════════════════════════════════════════════

test('staven die op dezelfde pixel vallen worden uit elkaar geschoven', () => {
  const xs = spreid([100, 101, 102, 103, 104, 105]);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] - xs[i - 1] >= 7 - 1e-9, `afstand ${xs[i] - xs[i - 1]} is te klein`);
  }
});

test('een groep die de rechterrand raakt schuift als geheel terug', () => {
  const rand = BREEDTE - MARGE;
  const xs = spreid([rand - 2, rand - 1, rand]);
  assert.ok(xs[xs.length - 1] <= rand + 1e-9, 'niets mag buiten de as vallen');
  assert.ok(xs[0] < rand - 2, 'de hele groep is teruggeschoven');
});

test('zes calls in zeven minuten leveren zes zichtbare staven op', () => {
  const zes = [0, 1, 2, 3, 5, 7].map((m) => call(8, m, 'gesproken', 20));
  const t = bouwTijdlijn({ pogingen: zes, afspraken: [], dag: '2026-09-07' });
  assert.equal((t.svg.match(/rx="1.5"/g) || []).length, 6, 'geen enkele call mag achter een andere verdwijnen');
});

// ═══════════════════════════════════════════════════════════════════════════
// ÉÉN OORDEEL, EN GEEN NUL WAAR DE LENGTE ONBEKEND IS
// ═══════════════════════════════════════════════════════════════════════════

test('gesproken zonder geregistreerde lengte wordt gestippeld met een vraagteken, nooit nul', () => {
  const t = bouwTijdlijn({ pogingen: [call(8, 0, 'gesproken', null)], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, /stroke-dasharray="2 2"/);
  assert.match(t.svg, />\?</);
  assert.match(t.svg, /lengte niet geregistreerd/);
  // EN DE HOOGTE. Een sabotage-ronde liet zien dat de stippellijn en het
  // vraagteken blijven staan ook als de staaf op nul-hoogte getekend wordt —
  // dan beweert het beeld alsnog 'een gesprek van nul seconden'. De hoogte
  // hoort duidelijk boven die van een nul-duur te liggen.
  const h = Number(t.svg.match(/height="([\d.]+)" rx="1.5"/)[1]);
  assert.ok(h > staafHoogte(0).h + 10, 'een onbekende lengte mag niet als nul getekend worden, was ' + h);
});

test('een niet-opgenomen call is een hol streepje ONDER de lijn, zonder duur', () => {
  const t = bouwTijdlijn({ pogingen: [call(8, 0, 'niet opgenomen', 43)], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, /fill="none" stroke="#C22B3E"/);
  assert.doesNotMatch(t.svg, /43 s/, '43 seconden overgaan mag nergens als duur staan');
  // Positief geformuleerd, want de negatieve vorm hierboven bleek te zwak: de
  // 43 wordt al in de datalaag weggehaald, dus 'staat er geen 43' zou ook waar
  // zijn als de tekencode wél een duur toonde. Dit toetst wat er WEL staat.
  assert.match(t.svg, /— niet opgenomen<\/title>/);
  assert.doesNotMatch(t.svg, /null s/, 'en zeker geen lege duur');
});

test('een onbekend resultaat krijgt zijn eigen teken, niet stil een gesprek', () => {
  const t = bouwTijdlijn({ pogingen: [call(8, 0, 'iets nieuws', 30)], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, /resultaat onbekend/);
  assert.doesNotMatch(t.svg, new RegExp('fill="' + KLEUR.gesprek + '"'), 'geen groene staaf op een gok');
});

test('WhatsApp staat boven en onder de lijn, uitgaand en antwoord apart', () => {
  const t = bouwTijdlijn({ pogingen: [
    { soort: 'whatsapp', richting: 'uit', tijdstip: '2026-09-07T08:00:00Z' },
    { soort: 'whatsapp', richting: 'in',  tijdstip: '2026-09-07T09:00:00Z' },
  ], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, /antwoord van de lead/);
  assert.match(t.svg, /— uitgaand</);
});

test('een geannuleerde zoomcall staat er gearceerd en doorgestreept op', () => {
  const t = bouwTijdlijn({ pogingen: [], dag: '2026-09-07', afspraken: [
    { scheduled_at: '2026-09-07T14:00:00Z', duration_minutes: 30, status: 'cancelled', lead_name: 'X' },
  ] });
  assert.match(t.svg, /\(vervallen\)/);
  assert.match(t.svg, /stroke-dasharray="3 2"/);
});

// ═══════════════════════════════════════════════════════════════════════════
// STATISCHE SVG — geen tekenopdracht
// ═══════════════════════════════════════════════════════════════════════════

test('de tijdlijn is opmaak, geen script', () => {
  // Zou de browser hem na het laden tekenen, dan is de printweergave leeg of
  // half — en dat valt pas op als iemand een PDF opslaat.
  const t = bouwTijdlijn({ pogingen: [call(8, 0, 'gesproken', 30)], afspraken: [], dag: '2026-09-07' });
  assert.match(t.svg, /^<svg viewBox="0 0 1000 300" width="100%"/);
  assert.doesNotMatch(t.svg, /<script/i);
  assert.doesNotMatch(t.svg, /onload|onclick/i);
});

test('het uur komt uit Amsterdamse tijd, niet uit de ISO-tekst', () => {
  assert.equal(minutenInZone('2026-09-07T08:11:00Z'), 10 * 60 + 11);
  assert.equal(minutenInZone('2026-12-07T08:11:00Z'), 9 * 60 + 11, 'wintertijd');
});
