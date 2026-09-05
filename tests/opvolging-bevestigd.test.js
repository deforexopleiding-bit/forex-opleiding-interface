// tests/opvolging-bevestigd.test.js
//
// 'Bevestigd' is de meest voorkomende uitkomst van een aanmeldkaart, en de
// enige die geen eindpunt is.
//
// De regel in één zin: is er na vandaag nog een ronde, dan slaapt de kaart tot
// vier dagen voor het event; is die er niet, dan gaat hij dicht.
//
//   ronde A — meer dan vier dagen voor het event. De lead zegt 'ja ik kom'. De
//             kaart moet vandaag weg maar niet voorgoed: vier dagen voor het
//             event komt hij terug voor de reminder-call.
//   ronde B — binnen vier dagen. Er komt geen ronde meer, dus de kaart gaat
//             definitief dicht.
//
// Meldt iemand zich twee of drie dagen voor het event aan, dan vallen A en B
// samen en is die ene bevestiging meteen de laatste. Dat volgt uit dezelfde
// regel; het staat hieronder apart omdat het de makkelijkste is om stuk te
// maken.
//
// Twee dingen die stil fout kunnen gaan:
//
//  · bepaalTaakActie() mag een slapende bevestigde kaart niet eerder wakker
//    maken. Hij doet dat alleen als taak.due later is dan de gewenste due, en
//    na 'bevestigd' zijn die precies gelijk. Dat klopt vandaag; deze test legt
//    vast dat het zo blijft.
//
//  · De nachtelijke doorrol trekt alles wat achterloopt naar morgen. Een
//    slapende kaart staat vooruit en hoort dus met rust gelaten te worden —
//    anders staat de bevestigde lead morgen alweer in de lijst.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  bepaalTaakActie, dagPlus, dueVoorAanmelding, WAKKER_DAGEN_VOOR_EVENT,
} from '../api/_lib/opvolging-aanmelding.js';
import { bepaalDoorrol } from '../api/_lib/opvolging-doorrol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 5 september 2026, 10:00 Amsterdamse tijd.
const NU = Date.parse('2026-09-05T08:00:00Z');
const VANDAAG = '2026-09-05';

const ev = (over) => ({
  id: 'ev-1', title: 'Forex Masterclass Gent', location: 'Belgie - Deinsesteenweg 108',
  starts_at: '2026-09-20T17:00:00Z', ...over,
});
const att = (over) => ({ id: 'att-1', status: 'aangemeld', ...over });

/**
 * Wat het endpoint doet bij 'bevestigd', als losse regel.
 *
 * De handler zelf zit vast aan Supabase en een request; deze functie is de
 * beslissing eruit gelicht, één op één zoals api/opvolging-aanmelding-actie.js
 * hem neemt. De test daaronder controleert dat het bestand die regel ook echt
 * zo schrijft, zodat de twee niet uit elkaar kunnen lopen.
 */
function bevestigdBesluit({ eventDag, vandaag }) {
  const wakker = eventDag ? dagPlus(eventDag, -WAKKER_DAGEN_VOOR_EVENT) : null;
  const nogEenRonde = !!wakker && wakker > vandaag;
  return nogEenRonde
    ? { status: 'open', due: wakker, later: false }
    : { status: 'gearchiveerd', archief_reden: 'bevestigd' };
}

// ═══════════════════════════════════════════════════════════════════════════
// RONDE A — DE KAART SLAAPT TOT VIER DAGEN VOOR HET EVENT
// ═══════════════════════════════════════════════════════════════════════════

test('bevestigd in ronde A laat de taak open staan met due = eventdag min 4', () => {
  const b = bevestigdBesluit({ eventDag: '2026-09-20', vandaag: VANDAAG });
  assert.equal(b.status, 'open', 'niet archiveren — er komt nog een reminder-ronde');
  assert.equal(b.due, '2026-09-16');
  assert.equal(b.later, false, 'de later-vlag hoort bij vandaag en zegt over een dag verderop niets');
});

test('de kaart verdwijnt vandaag uit de lijst', () => {
  // De dagweergave toont wat op of vóór vandaag staat. Een due van 16/09 valt
  // daarbuiten, dus Dave ziet hem vanavond niet meer.
  const b = bevestigdBesluit({ eventDag: '2026-09-20', vandaag: VANDAAG });
  assert.ok(b.due > VANDAAG);
});

// ═══════════════════════════════════════════════════════════════════════════
// RONDE B — GEEN RONDE MEER, DUS DICHT
// ═══════════════════════════════════════════════════════════════════════════

test('bevestigd in ronde B archiveert', () => {
  // Het event is over drie dagen; de wakker-dag ligt in het verleden.
  const b = bevestigdBesluit({ eventDag: '2026-09-08', vandaag: VANDAAG });
  assert.equal(b.status, 'gearchiveerd');
  assert.equal(b.archief_reden, 'bevestigd');
  assert.equal(b.due, undefined, 'geen nieuwe due — er komt niets meer');
});

test('op de wakker-dag zelf is het al de laatste ronde', () => {
  // Rand: de wakker-dag is vandaag. `wakker > vandaag` is dan false, dus dicht.
  // Zou hier `>=` staan, dan bleef de kaart vandaag hangen met due = vandaag en
  // stond de bevestigde lead er vanmiddag nog steeds.
  const b = bevestigdBesluit({ eventDag: '2026-09-09', vandaag: VANDAAG });
  assert.equal(dagPlus('2026-09-09', -WAKKER_DAGEN_VOOR_EVENT), VANDAAG);
  assert.equal(b.status, 'gearchiveerd');
});

test('een aanmelding binnen vier dagen voor het event archiveert direct', () => {
  // A en B vallen dan samen: die ene bevestiging is meteen de laatste.
  for (const eventDag of ['2026-09-06', '2026-09-07', '2026-09-08']) {
    const b = bevestigdBesluit({ eventDag, vandaag: VANDAAG });
    assert.equal(b.status, 'gearchiveerd', eventDag + ' hoort meteen dicht te gaan');
  }
});

test('zonder event-dag in bron_ref gaat de kaart dicht in plaats van te blijven hangen', () => {
  // Geen dag betekent geen wakker-moment. Openlaten zou een kaart opleveren die
  // nooit meer terugkomt én nooit afgerond is; dan liever zichtbaar afgerond.
  const b = bevestigdBesluit({ eventDag: null, vandaag: VANDAAG });
  assert.equal(b.status, 'gearchiveerd');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE CRON MAAKT DE SLAPENDE KAART NIET EERDER WAKKER
// ═══════════════════════════════════════════════════════════════════════════

test('bepaalTaakActie laat een bevestigde slapende kaart met rust', () => {
  const event = ev({ starts_at: '2026-09-20T17:00:00Z' });
  const taak = { id: 'tk-1', status: 'open', due: '2026-09-16' };
  const b = bepaalTaakActie({ attendee: att(), event, taak, nu: NU });
  assert.equal(b.actie, 'niets',
    'de due staat al precies op de wakker-dag; hem opnieuw zetten zou de kaart vandaag terugbrengen');
});

test('de wakker-dag van het endpoint en die van de cron zijn dezelfde', () => {
  // Dit is waarom de test hierboven werkt. Zou het endpoint een andere dag
  // kiezen dan dueVoorAanmelding(), dan zou de cron de kaart alsnog naar voren
  // trekken en stond de bevestigde lead morgen weer in de lijst.
  const eventDag = '2026-09-20';
  const b = bevestigdBesluit({ eventDag, vandaag: VANDAAG });
  assert.equal(b.due, dueVoorAanmelding({ eventDag, vandaag: VANDAAG }));
});

test('op de wakker-dag maakt de cron hem gewoon weer wakker', () => {
  // Het vangnet: zou de kaart om welke reden dan ook nog verder weg staan, dan
  // haalt de cron hem op de juiste dag alsnog naar voren.
  const event = ev({ starts_at: '2026-09-20T17:00:00Z' });
  const taak = { id: 'tk-1', status: 'open', due: '2026-09-19' };
  const b = bepaalTaakActie({ attendee: att(), event, taak, nu: NU });
  assert.equal(b.actie, 'wakker_maken');
  assert.equal(b.due, '2026-09-16');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE NACHTELIJKE DOORROL LAAT HEM SLAPEN
// ═══════════════════════════════════════════════════════════════════════════

test('de doorrol raakt een slapende bevestigde kaart niet aan', () => {
  const taken = [
    { id: 'slaapt', status: 'open', due: '2026-09-16' },   // bevestigd, wacht op ronde B
    { id: 'loopt-achter', status: 'open', due: '2026-09-04' },
  ];
  const uit = bepaalDoorrol({ taken, morgen: '2026-09-06' });
  assert.deepEqual(uit.map((u) => u.id), ['loopt-achter'],
    'alleen wat achterloopt schuift door; een bevestigde kaart staat vooruit');
});

test('ook op de wakker-dag zelf trekt de doorrol hem niet naar voren', () => {
  // Rand: morgen is precies de wakker-dag. `due >= morgen` hoort dan te gelden.
  const uit = bepaalDoorrol({
    taken: [{ id: 'slaapt', status: 'open', due: '2026-09-16' }],
    morgen: '2026-09-16',
  });
  assert.deepEqual(uit, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT SCHRIJFT DIE REGEL OOK ECHT ZO
// ═══════════════════════════════════════════════════════════════════════════

test('api/opvolging-aanmelding-actie.js kent de actie en gebruikt de gedeelde wakker-dag', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  assert.match(bron, /ACTIES = new Set\(\[[^\]]*'bevestigd'/, "'bevestigd' hoort een geldige actie te zijn");
  assert.match(bron, /dagPlus\(eventDag, -WAKKER_DAGEN_VOOR_EVENT\)/,
    'de wakker-dag hoort uit de gedeelde constante te komen, niet uit een eigen 4');
  assert.match(bron, /bevestigd_op/,  'bevestigd_op hoort geschreven te worden');
  assert.match(bron, /bevestigd_notitie/, 'bevestigd_notitie hoort geschreven te worden');
  assert.doesNotMatch(bron, /notitie is verplicht bij een bevestiging/,
    'de notitie is bij bevestigen juist niet verplicht');
});

test('de notitie is verplicht bij een gesprek en vrij bij een bevestiging', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  assert.match(bron, /actie === 'gesprek_gehad' && !notitie/,
    'alleen gesprek_gehad hoort op een lege notitie te blokkeren');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET SCHERM BELOOFT DEZELFDE DAG ALS DE SERVER
// ═══════════════════════════════════════════════════════════════════════════

function laadView() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set,
  });
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8'),
    ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvAanmeldHelpers, 'de view hoort __opvAanmeldHelpers te zetten');
  return window.__opvAanmeldHelpers;
}

const V = laadView();

test('de view rekent met dezelfde wakker-dag als de server', () => {
  // Het venster vertelt Dave op welke dag de kaart terugkomt. Zou de view een
  // andere 4 hanteren dan api/_lib/opvolging-aanmelding.js, dan belooft het
  // scherm iets anders dan er gebeurt — en dat merk je pas als de kaart op de
  // verkeerde dag opduikt.
  assert.equal(V.WAKKER_DAGEN, WAKKER_DAGEN_VOOR_EVENT);
});

test('de badge toont de bevestigdatum, en verschijnt niet zonder', () => {
  assert.equal(V.bevestigdBadge({ bevestigd_op: null }), '');
  assert.equal(V.bevestigdBadge(null), '');
  const h = V.bevestigdBadge({ bevestigd_op: '2026-09-01T09:30:00Z' });
  assert.match(h, /Bevestigd op 01\/09/);
});

test('de bevestigde kaart draagt de badge en de notitie in beeld', () => {
  // Dit is waar het in ronde B om draait: Dave moet zien dát er bevestigd is,
  // met datum en notitie, anders belt hij met de verkeerde vraag.
  const h = V.taakKaart({
    id: 'tk-1', naam: 'Jan Peeters', telefoon: '+32470123456',
    reden: 'aanmelding', due: '2026-09-16',
    bevestigd_op: '2026-09-01T09:30:00Z', bevestigd_notitie: 'komt met zijn broer',
  }, '2026-09-16', { inGroep: true });
  assert.match(h, /Bevestigd op 01\/09/);
  assert.match(h, /komt met zijn broer/);
  assert.match(h, /Jan Peeters/);
});
