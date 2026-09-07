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
import { bouwWerkritme } from '../api/_lib/opvolging-werkritme.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// 8 SEPTEMBER — DE WHATSAPP-LAAG KREEG DE SPREIDING NIET
// ═══════════════════════════════════════════════════════════════════════════
// Gemeten uit de gerenderde SVG op productie. Uitgaand stond drie keer op
// exact x=688.3 en twee keer op 674.7; inkomend vier keer op 671.9 en daarna
// nog drie keer dubbel. Alle negentien rechthoeken zaten in de SVG, ze lagen
// alleen op elkaar: van 19 handelingen waren er ongeveer zeven te zien.
//
// En uitgerekend daar doet het pijn: die negen inkomende zijn het
// antwoordenspervuur van Joelle, en dat is het BEWIJS dat één WhatsApp drie
// bevestigingen opleverde. Opgestapeld leest het als één tikje.

/** Negen antwoorden binnen een paar minuten, zoals de echte dag. */
function negenAntwoorden() {
  return [0, 0, 0, 0, 1, 1, 1, 2, 3].map((m, i) => ({
    soort: 'whatsapp', richting: 'in',
    tijdstip: `2026-09-07T17:0${m}:0${i}Z`,
  }));
}

const xenVan = (svg, kleur) => [...svg.matchAll(
  new RegExp('<rect x="([\\d.]+)"[^>]*stroke="' + kleur + '"', 'g'))].map((m) => Number(m[1]));

test('negen antwoorden binnen drie minuten leveren negen zichtbare blokjes op', () => {
  const t = bouwTijdlijn({ pogingen: negenAntwoorden(), afspraken: [], dag: '2026-09-07' });
  const xs = xenVan(t.svg, '#C2700A');
  assert.equal(xs.length, 9, 'alle negen horen getekend te worden');
  assert.equal(new Set(xs).size, 9, 'en op negen verschillende plekken: ' + xs.join(' '));
});

test('de whatsapp-blokjes houden minstens de minimale tussenruimte', () => {
  const t = bouwTijdlijn({ pogingen: negenAntwoorden(), afspraken: [], dag: '2026-09-07' });
  const xs = xenVan(t.svg, '#C2700A').sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] - xs[i - 1] >= 7 - 1e-6, `afstand ${(xs[i] - xs[i - 1]).toFixed(1)} is te klein`);
  }
});

test('uitgaand en inkomend worden APART gespreid en verdringen elkaar niet', () => {
  // Twee lanen: een uitgaand bericht op hetzelfde moment als een antwoord mag
  // dat antwoord niet wegduwen, want ze staan boven en onder de lijn.
  const zelfdeMoment = [
    { soort: 'whatsapp', richting: 'uit', tijdstip: '2026-09-07T17:00:00Z' },
    { soort: 'whatsapp', richting: 'in',  tijdstip: '2026-09-07T17:00:00Z' },
  ];
  const t = bouwTijdlijn({ pogingen: zelfdeMoment, afspraken: [], dag: '2026-09-07' });
  const uit = xenVan(t.svg, '#1B5FBF');
  const inn = xenVan(t.svg, '#C2700A');
  assert.equal(uit.length, 1);
  assert.equal(inn.length, 1);
  assert.equal(uit[0], inn[0], 'op hetzelfde tijdstip horen ze op dezelfde x te staan');
});

// ── De zoombandjes dragen wie en hoe laat ─────────────────────────────────

test('een zoombandje draagt de naam en het tijdstip', () => {
  const t = bouwTijdlijn({ pogingen: [], dag: '2026-09-07', afspraken: [
    { scheduled_at: '2026-09-07T12:00:00Z', duration_minutes: 30, status: 'scheduled', lead_name: 'Yasmine Aouada' },
  ] });
  assert.match(t.svg, /Yasmine Aouada/);
  assert.match(t.svg, />14:00/);
});

test('bij een geannuleerde zoomcall staat het woord geannuleerd in beeld', () => {
  // De stippellijn alleen is te subtiel; je moet het kunnen lezen.
  const t = bouwTijdlijn({ pogingen: [], dag: '2026-09-07', afspraken: [
    { scheduled_at: '2026-09-07T12:00:00Z', duration_minutes: 30, status: 'cancelled', lead_name: 'X' },
  ] });
  assert.match(t.svg, /geannuleerd/);
});

// ── Het gat staat in het beeld, niet alleen in de tekst ───────────────────

test('het langste gat wordt in de grafiek zelf gemarkeerd', () => {
  // 5 uur 28 stilte stond wel als bevinding onder de grafiek maar was in het
  // beeld niet te zien; dan moet je de tekst lezen om te weten waar het zit.
  const pogingen = [
    { soort: 'call', richting: 'uit', resultaat: 'gesproken', duur_sec: 30, tijdstip: '2026-09-07T08:11:00Z' },
    { soort: 'call', richting: 'uit', resultaat: 'gesproken', duur_sec: 30, tijdstip: '2026-09-07T14:55:00Z' },
  ];
  // Het gat komt van bouwWerkritme — één berekening, doorgegeven. Zou de
  // tijdlijn hem zelf uitrekenen, dan kan het kader een andere stilte tonen
  // dan de zin eronder.
  const r = bouwWerkritme({ pogingen, dag: '2026-09-07' });
  const t = bouwTijdlijn({ pogingen, afspraken: [], dag: '2026-09-07', gat: r.langste_gat });
  assert.ok(t.gat, 'het gat hoort in beeld te staan');
  assert.match(t.svg, /class="gat"/, 'en als kader in beeld te staan');
  assert.match(t.svg, /10:11/);
  assert.match(t.svg, /16:55/);
});

test('een dag zonder noemenswaardig gat krijgt geen kader', () => {
  const elkUur = [];
  for (let u = 7; u < 19; u++) {
    elkUur.push({ soort: 'call', richting: 'uit', resultaat: 'gesproken', duur_sec: 20,
      tijdstip: `2026-09-07T${String(u).padStart(2, '0')}:15:00Z` });
  }
  const r = bouwWerkritme({ pogingen: elkUur, dag: '2026-09-07' });
  const t = bouwTijdlijn({ pogingen: elkUur, afspraken: [], dag: '2026-09-07', gat: r.langste_gat });
  assert.doesNotMatch(t.svg, /class="gat"/);
});
