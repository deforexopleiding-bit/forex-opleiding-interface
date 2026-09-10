// tests/opvolging-afrondknop-afgerond.test.js
//
// DE AFRONDKNOP MOET TONEN DAT HIJ AL GEBRUIKT IS.
//
// Maxims reden, en die bepaalt het ontwerp: Dave rondt er 's ochtends twee af,
// kijkt 's middags opnieuw, en moet dan kunnen zien welke twee. Anders doet hij
// het dubbel — dezelfde call krijgt twee uitkomsten en de tweede overschrijft
// de eerste.
//
// ── DE MODULE WERKT OP ZICHZELF ─────────────────────────────────────────
// Dit leest `uitkomst`, en niets anders. Die kolom wordt uitsluitend geschreven
// door writeUitkomst() in api/follow-up-appointment-outcome.js — het endpoint
// waar de afrondknop naartoe post. `status` blijft buiten beschouwing: die kan
// van elders komen, en de module praat geen externe status na.
//
// Dat onderscheid is niet cosmetisch. Sale en gesprek_gehad worden allebei
// `completed`; wilt_niet_meer en niet_geschikt allebei `cancelled`. Uit de
// status is dus niet af te lezen of er verkocht is, laat staan of Dave iets
// heeft vastgelegd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { afgerondAls, afrondActie } from '../api/_lib/opvolging-call-afgerond.js';
import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';

// ═══════════════════════════════════════════════════════════════════════════
// DE REGEL
// ═══════════════════════════════════════════════════════════════════════════

test('zonder vastgelegde uitkomst blijft de knop staan', () => {
  const a = afrondActie({ id: 'x', status: 'scheduled', scheduled_at: '2026-09-09T13:00:00Z' });
  assert.equal(a.toon, 'knop');
  assert.equal(a.vastgelegd, null);
});

test('met een vastgelegde uitkomst toont de kaart die uitkomst', () => {
  const a = afrondActie({ uitkomst: 'sale', uitkomst_op: '2026-09-09T10:00:00Z' });
  assert.equal(a.toon, 'uitkomst');
  assert.equal(a.vastgelegd.label, 'klant geworden');
  assert.equal(a.vastgelegd.op, '2026-09-09T10:00:00Z');
});

test('elke uitkomst die het afrond-endpoint kent heeft een leesbare tekst', () => {
  // De set komt uit api/follow-up-appointment-outcome.js. Zou daar een waarde
  // bijkomen zonder tekst, dan staat er straks 'no_show' op het scherm.
  const bron = readFileSync('api/follow-up-appointment-outcome.js', 'utf8');
  const set = bron.match(/const OUTCOMES = new Set\(\[([\s\S]*?)\]\)/)[1];
  const waarden = [...set.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(waarden.length >= 9, 'de outcome-set is niet gevonden');
  for (const w of waarden) {
    const label = afgerondAls({ uitkomst: w }).label;
    assert.ok(label && !label.includes('_'), w + ' heeft geen leesbare tekst: ' + label);
  }
});

test('een onbekende uitkomst wordt leesbaar getoond, niet verborgen', () => {
  // Dat er iets vastligt is het punt. Verbergen zou een knop opleveren die doet
  // alsof er niets is, en dan rondt Dave het alsnog dubbel af.
  assert.equal(afgerondAls({ uitkomst: 'iets_nieuws' }).label, 'iets nieuws');
});

test('een lege of ontbrekende uitkomst telt niet als afgerond', () => {
  for (const u of [null, undefined, '', '   ']) {
    assert.equal(afgerondAls({ uitkomst: u }), null, JSON.stringify(u));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE MODULE PRAAT GEEN EXTERNE STATUS NA
// ═══════════════════════════════════════════════════════════════════════════

test('een status zonder uitkomst laat de knop staan — ook no_show', () => {
  // Mehran Jahani stond op no_show zonder dat Dave iets had vastgelegd. Dat is
  // geen uitkomst van ONZE module, dus de knop hoort te blijven. Zou de status
  // meetellen, dan praat de module een externe waarheid na en kan Dave er niets
  // meer mee.
  for (const status of ['no_show', 'completed', 'cancelled', 'wacht_op_reschedule']) {
    const a = afrondActie({ status, scheduled_at: '2026-09-08T16:00:00Z' });
    assert.equal(a.toon, 'knop', status);
  }
});

test('en een undo brengt de knop terug', () => {
  // writeUitkomst() zet beide kolommen op null bij een correctie. Een vergissing
  // herstelt zich daarmee vanzelf naar een knop; daar is niets extra's voor
  // nodig.
  assert.equal(afrondActie({ uitkomst: 'sale' }).toon, 'uitkomst');
  assert.equal(afrondActie({ uitkomst: null, uitkomst_op: null }).toon, 'knop');
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP DE PADEN DIE ECHT DRAAIEN
// ═══════════════════════════════════════════════════════════════════════════

test('een afgeronde call VERDWIJNT niet uit het blok', () => {
  // Zonder dit kan 'Afgerond' nooit zichtbaar zijn: zodra Dave een uitkomst
  // vastlegt gaat de afspraak naar completed/no_show/cancelled, en die vallen
  // geen van drieën in BEZET_STATUSSEN. De regel verdween dus precies op het
  // moment dat hij hem afrondde.
  const D = '2026-09-09';
  const [dag] = voegAgendaSamen({
    slots: [], van: D, tot: D,
    afspraken: [
      { id: 'a1', lead_name: 'Al afgerond', status: 'completed',
        scheduled_at: D + 'T08:00:00Z', uitkomst: 'sale', uitkomst_op: D + 'T09:00:00Z' },
      { id: 'a2', lead_name: 'Nog niet', status: 'scheduled', scheduled_at: D + 'T09:00:00Z' },
    ],
  });
  assert.deepEqual(dag.bezet.map((b) => b.naam), ['Nog niet']);
  assert.deepEqual(dag.afgerond.map((b) => b.naam), ['Al afgerond']);
  assert.equal(dag.afgerond[0].afrond.vastgelegd.label, 'klant geworden');
});

test('maar hij blokkeert daarmee GEEN vrij moment', () => {
  // De reden dat het een aparte lijst is en geen verbreding van `bezet`. Zou
  // een afgezegde call het slot bezet houden, dan kan niemand er meer boeken.
  const D = '2026-09-09';
  const [dag] = voegAgendaSamen({
    slots: [{ date: D, times: ['13:00'] }], van: D, tot: D,
    afspraken: [{ id: 'a', lead_name: 'Afgezegd', status: 'cancelled',
      scheduled_at: D + 'T11:00:00Z', uitkomst: 'annuleren' }],
  });
  assert.deepEqual(dag.vrij.map((v) => v.tijd), ['13:00']);
  assert.equal(dag.afgerond.length, 1, 'hij staat wel in het blok');
});

test('een status zonder onze uitkomst komt er NIET bij', () => {
  // De module praat geen externe waarheid na. Een afspraak die elders op
  // no_show is gezet zonder dat Dave iets vastlegde, hoort hier niet.
  const D = '2026-09-09';
  const [dag] = voegAgendaSamen({
    slots: [], van: D, tot: D,
    afspraken: [{ id: 'a', lead_name: 'Van elders', status: 'no_show',
      scheduled_at: D + 'T11:00:00Z' }],
  });
  assert.equal(dag.afgerond.length, 0);
  assert.equal(dag.bezet.length, 0);
});

test('dezelfde call staat niet twee keer in het blok', () => {
  const D = '2026-09-09';
  const [dag] = voegAgendaSamen({
    slots: [], van: D, tot: D,
    afspraken: [{ id: 'a', lead_name: 'Bezig', status: 'in_progress',
      scheduled_at: D + 'T11:00:00Z', uitkomst: 'gesprek_gehad' }],
  });
  assert.equal(dag.bezet.length, 1);
  assert.equal(dag.afgerond.length, 0, 'hij zit al bij bezet');
});

test('het callsblok leest bezet EN afgerond, op tijd gesorteerd', () => {
  const view = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  const i = view.indexOf('async function fetchCalls');
  // Ruim genomen: fetchCalls draagt sinds de achterstand ook de vraag of die
  // meegehaald moet worden, en dat schuift de regels hieronder naar achteren.
  // Waar ze staan doet er niet toe; dát ze er staan wel.
  const blok = view.slice(i, i + 2000);
  assert.match(blok, /d0\.gepland/,
    'het callsblok hoort het dagbeeld te lezen');
  assert.match(blok, /d0\.bezet \|\| \[\]/);
  assert.match(blok, /d0\.afgerond \|\| \[\]/,
    'de terugval voor een oudere server hoort afgerond mee te nemen, anders '
    + 'verdwijnt elke afgeronde call weer uit het blok');
  assert.match(blok, /sort\(/);
});

test('het endpoint haalt uitkomst op, met een terugval als de kolom ontbreekt', () => {
  const bron = readFileSync('api/opvolging-agenda.js', 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  // `uitkomst` staat sinds het dagbeeld in een lijst met de andere optionele
  // kolommen; wat blijft gelden is dat hij gevraagd wordt en dat 42703 niet het
  // hele blok omgooit.
  assert.match(bron, /'uitkomst'/);
  assert.match(bron, /'uitkomst_op'/);
  assert.match(bron, /error\.code !== '42703'/,
    'zonder terugval valt het hele blok om zolang de migratie niet gedraaid is');
  assert.match(bron, /beschikbaar\.filter/,
    'de terugval hoort de ontbrekende kolom weg te laten en het opnieuw te proberen');
});

/**
 * De echte knoppen-uitdrukking uit de view knippen en UITVOEREN.
 *
 * Op 9 september gaf een sabotage die de knop achter een voorwaarde verstopte
 * nul rood, omdat geen enkele test naar de view keek. Dit voert hem uit.
 */
function rendereerAfrond(c) {
  const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  const start = VIEW.indexOf("((c.afrond && c.afrond.toon === 'uitkomst')");
  assert.ok(start > 0, 'de afrond-uitdrukking is niet gevonden in de view');
  // HAAKJES TELLEN, niet op een letterlijk einde mikken. Het vorige anker
  // zocht "</button>');" en brak stil zodra de knop achter een voorwaarde
  // kwam te staan — een test die niet meer draait terwijl hij groen oogt is
  // precies wat we hier aan het uitroeien zijn. Loopt de balans niet af, dan
  // faalt deze test luid in plaats van een halve uitdrukking te draaien.
  let diep = 0;
  let eind = -1;
  for (let n = start; n < VIEW.length; n += 1) {
    const ch = VIEW[n];
    // Quotes overslaan: er staan haakjes in de HTML-teksten zelf.
    if (ch === "'") { n = VIEW.indexOf("'", n + 1); if (n < 0) break; continue; }
    if (ch === '(') diep += 1;
    else if (ch === ')') { diep -= 1; if (diep === 0) { eind = n; break; } }
  }
  assert.ok(eind > start, 'de uitdrukking loopt niet af — anker of code is stuk');
  const bron = 'const uit = ' + VIEW.slice(start, eind + 1) + ';\nuit;';
  const ctx = createContext({
    c, i: 0,
    // De knoppenregel komt van de server; hier staat hij aan zodat deze test
    // over de afrondchip gaat en niet over de knoppenregel. Die heeft een
    // eigen test in tests/opvolging-dagbeeld.test.js.
    k: { afronden: true, bellen: true, whatsapp: true, zoom: true },
    esc: (s) => String(s == null ? '' : s),
    nl : (s) => String(s == null ? '' : s),
    iso: (s) => String(s == null ? '' : s),
  });
  return runInContext(bron, ctx, { filename: 'opvolging-v2.js#afrond' });
}

test('de view toont Afgerond met de uitkomst zodra die vastligt', () => {
  const html = rendereerAfrond({ afrond: afrondActie({ uitkomst: 'no_show', uitkomst_op: '2026-09-09T08:00:00Z' }) });
  assert.match(html, /Afgerond/);
  assert.match(html, /niet gekomen/);
  assert.doesNotMatch(html, /__opvCallAfrond/, 'er hoort geen knop meer te staan');
});

test('en gewoon de knop zolang er niets vastligt', () => {
  const html = rendereerAfrond({ afrond: afrondActie({ status: 'no_show' }) });
  assert.match(html, /__opvCallAfrond/);
  assert.doesNotMatch(html, /Afgerond &middot;/);
});

test('een oudere server zonder het veld valt terug op de knop', () => {
  const html = rendereerAfrond({ afrond: undefined });
  assert.match(html, /__opvCallAfrond/);
});
