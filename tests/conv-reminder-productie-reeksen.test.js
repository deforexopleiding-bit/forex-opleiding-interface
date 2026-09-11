// tests/conv-reminder-productie-reeksen.test.js
//
// De zeven dossiers waar de no-reply-cyclus in productie op vastliep, als
// regressietest. Cijfers gemeten op 10 september 2026 over alle 141
// wanbetalers: 66 gepauzeerd door een gesprek, en tien daarvan kregen ná hun
// laatste inkomende bericht nog herinneringen — zes van hen vijf tot negen
// stuks, allemaal met template joost_reminder_2_nl, en de verzendtijd wandelde
// per dag verder de nacht in.
//
// Wat er misging, in drie lagen:
//
//   1. DE BAL. `balLigtBijOns` mat tegen `max(laatste outbound, laatste
//      reminder)`. De herinnering van de cron IS een outbound, dus één
//      herinnering die er doorheen glipte zette de bal terug bij de klant en
//      schakelde de guard voorgoed uit voor dat gesprek.
//   2. DE LUS. De cron schreef niets naar `dunning_log`, dus bleef
//      `hasReplyAfterLastSend()` de laatste engine-aanmaning als "laatste
//      send" zien en herkende dezelfde oude klantreactie eindeloos opnieuw als
//      vers — waarna de teller op nul ging en het altijd r1 bleef.
//   3. DE WANDELING. r2 en rz hingen aan een rollende 24-uursklok vanaf het
//      exacte tijdstip van de vorige herinnering, met een cron die elk kwartier
//      tikt. Elke dag schoof het moment op tot het de nacht in liep.
//
// Deze tests dekken laag 1 en 3 op de pure beslisfunctie. Laag 2 zit in
// tests/dunning-reply-detection.test.js (event-type in hasReplyAfterLastSend)
// en in de cron zelf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineStage } from '../api/_lib/conv-reminder-stage.js';

const H = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// Productie-config op het moment van meten.
const CFG = { reminder_1_hours: 24, reminder_2_hours: 24, resume_after_hours: 24 };

/**
 * De zeven gemeten dossiers. `laatsteInbound` is het laatste bericht van de
 * klant; ná dat moment heeft niemand nog inhoudelijk geantwoord. `herinneringen`
 * is het aantal dat er sindsdien tóch uitging.
 */
const DOSSIERS = [
  { naam: 'Michiel Van Brenk',   laatsteInbound: '2026-08-27T13:14:00Z', herinneringen: 9, laatste: '2026-09-05T22:15:00Z' },
  { naam: 'Marie Nyumah',        laatsteInbound: '2026-08-08T16:24:00Z', herinneringen: 9, laatste: '2026-09-02T01:15:00Z' },
  { naam: 'Ingrid Van Den Eede', laatsteInbound: '2026-07-30T12:00:00Z', herinneringen: 9, laatste: '2026-09-03T02:15:00Z' },
  { naam: 'ER Schilderwerken',   laatsteInbound: '2026-08-19T12:00:00Z', herinneringen: 9, laatste: '2026-08-30T16:16:00Z' },
  { naam: 'Ismail Toure',        laatsteInbound: '2026-09-05T09:24:00Z', herinneringen: 5, laatste: '2026-09-10T12:15:00Z' },
  { naam: 'Saemon Horvath',      laatsteInbound: '2026-09-04T08:07:00Z', herinneringen: 5, laatste: '2026-09-10T06:30:00Z' },
  { naam: 'Samuel Yago',         laatsteInbound: '2026-09-07T10:07:20Z', herinneringen: 3, laatste: '2026-09-10T12:15:00Z' },
];

const NU = Date.parse('2026-09-10T13:00:00Z');

// ── LAAG 1: niemand heeft geantwoord → er gaat niets meer uit ─────────

for (const d of DOSSIERS) {
  test(`${d.naam}: geen antwoord na de laatste inbound → geen herinnering (teller 0)`, () => {
    const stage = determineStage({
      run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
      convLastInboundAt: d.laatsteInbound,
      convLastAnswerAt:  null,              // niemand heeft ooit geantwoord
      noReplyCfg: CFG,
      nowMs: NU,
    });
    assert.equal(stage, null, `${d.naam} kreeg er ${d.herinneringen}`);
  });

  test(`${d.naam}: ook met de teller op 1 gaat er geen r2 uit`, () => {
    const stage = determineStage({
      run: {
        paused_conversation_reminder_count: 1,
        paused_conversation_last_reminder_at: d.laatste,
      },
      convLastInboundAt: d.laatsteInbound,
      convLastAnswerAt:  null,
      noReplyCfg: CFG,
      nowMs: NU,
    });
    assert.equal(stage, null);
  });

  test(`${d.naam}: en de aanmaanladder hervat niet`, () => {
    const stage = determineStage({
      run: {
        paused_conversation_reminder_count: 2,
        paused_conversation_last_reminder_at: d.laatste,
      },
      convLastInboundAt: d.laatsteInbound,
      convLastAnswerAt:  null,
      noReplyCfg: CFG,
      nowMs: NU,
    });
    assert.equal(stage, 'rz_blocked', 'blijft gepauzeerd tot een mens antwoordt');
  });
}

// ── Samuel in detail: de eigen herinnering mag de bal niet terugleggen ──

test('SAMUEL: de bot-herinnering van 08-09 telt niet als ons antwoord', () => {
  // Volledige tijdlijn uit productie (run 473750ce-518c-41e1-b7d3-595aab3fd539):
  //   04-09 16:00  engine stuurt aanmaning_dag21          (template)
  //   04-09 16:21  klant: "waarom krijg ik dit bericht nu pas binnen"
  //   05-09 08:42  Joost antwoordt inhoudelijk            (vrije tekst)  ← telt
  //   06-09 08:45  herinnering                            (template)
  //   07-09 09:00  herinnering                            (template)
  //   07-09 10:07  klant zegt zijn overeenkomst op        ← bal bij ons
  //   08-09 10:15, 09-09 10:30, 10-09 12:15  herinneringen (template)
  //
  // De caller levert alleen het laatste INHOUDELIJKE antwoord aan: 05-09 08:42.
  // De herinneringen erna zijn templates en tellen niet mee.
  const stage = determineStage({
    run: {
      paused_conversation_reminder_count: 0,
      paused_conversation_last_reminder_at: '2026-09-10T12:15:00Z',
    },
    convLastInboundAt: '2026-09-07T10:07:20Z',
    convLastAnswerAt:  '2026-09-05T08:42:00Z',
    noReplyCfg: CFG,
    nowMs: NU,
  });
  assert.equal(stage, null, 'inbound 07-09 is nieuwer dan ons antwoord 05-09 → bal bij ons');
});

test('SAMUEL: vóór zijn opzegging waren de herinneringen wél terecht', () => {
  // Op 06-09 stond het er anders voor: Joost had op 05-09 08:42 inhoudelijk
  // geantwoord en de klant zweeg sindsdien. Dan is een herinnering na 24 uur
  // stilte precies waarvoor de cyclus bedoeld is. De fix maakt de cyclus niet
  // stuk, hij stopt hem op het juiste moment.
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: '2026-09-04T16:21:00Z',
    convLastAnswerAt:  '2026-09-05T08:42:00Z',
    noReplyCfg: CFG,
    nowMs: Date.parse('2026-09-06T08:45:00Z'),
  });
  assert.equal(stage, 'r1');
});

// ── LAAG 3: de verzendtijd mag niet wandelen ─────────────────────────

test('WANDELING: op kalenderdagen verankerd vuurt r2 niet ná 24u-en-een-kwartier', () => {
  // Reeks-Michiel in het klein: de vorige herinnering ging gisteren om 17:31
  // de deur uit. Op een rollende 24-uursklok is de drempel vandaag om 17:31
  // gehaald en vuurt de eerstvolgende kwartiertik om 17:45 — elke dag een
  // stukje later. Dag-verankerd is de drempel op de nieuwe kalenderdag gehaald
  // en vuurt de eerste tik binnen het verzendvenster.
  const gisteren1731 = Date.parse('2026-09-09T17:31:00Z');
  const vandaag0815  = Date.parse('2026-09-10T08:15:00Z');

  const rollend = determineStage({
    run: { paused_conversation_reminder_count: 1, paused_conversation_last_reminder_at: iso(gisteren1731) },
    convLastInboundAt: iso(gisteren1731 - 100 * H),
    convLastAnswerAt:  iso(gisteren1731 - 50 * H),
    noReplyCfg: CFG,
    nowMs: vandaag0815,
  });
  assert.equal(rollend, null, 'zonder dag-anker is het om 08:15 nog geen 24 uur');

  const dagVerankerd = determineStage({
    run: { paused_conversation_reminder_count: 1, paused_conversation_last_reminder_at: iso(gisteren1731) },
    convLastInboundAt: iso(gisteren1731 - 100 * H),
    convLastAnswerAt:  iso(gisteren1731 - 50 * H),
    kalenderdagenSindsOnsBericht: 1,
    noReplyCfg: CFG,
    nowMs: vandaag0815,
  });
  assert.equal(dagVerankerd, 'r2', 'dag-verankerd vuurt de eerste tik van de nieuwe dag');
});

test('WANDELING: op dezelfde kalenderdag gaat er nooit een tweede herinnering uit', () => {
  const vanochtend = Date.parse('2026-09-10T08:15:00Z');
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 1, paused_conversation_last_reminder_at: iso(vanochtend) },
    convLastInboundAt: iso(vanochtend - 100 * H),
    convLastAnswerAt:  iso(vanochtend - 50 * H),
    kalenderdagenSindsOnsBericht: 0,
    noReplyCfg: CFG,
    nowMs: vanochtend + 23.9 * H,
  });
  assert.equal(stage, null);
});

test('WANDELING: een medewerker die net antwoordde verzet het anker', () => {
  // Anker = ons laatste bericht, dus ook een antwoord van een mens. Zonder dat
  // zou er een automatische "ik heb nog geen reactie gekregen" achteraan komen
  // vlak nadat een collega persoonlijk had gereageerd.
  const stage = determineStage({
    run: {
      paused_conversation_reminder_count: 1,
      paused_conversation_last_reminder_at: iso(Date.now() - 30 * H),
    },
    convLastInboundAt: iso(Date.now() - 40 * H),
    convLastAnswerAt:  iso(Date.now() - 2 * H),
    noReplyCfg: CFG,
    nowMs: Date.now(),
  });
  assert.equal(stage, null);
});

// ── GEEN GESPREK: een pauze die nergens op slaat ─────────────────────
//
// GEMETEN (10 sep 2026): drie runs staan gespreksgepauzeerd terwijl er nul
// WhatsApp-berichten bij de klant staan — Karim Alian (64 dagen te laat),
// Priscilla Mauricia (70) en Khalid Nassiri (44), alle drie in stage
// 'aangemaand'. Hun aanmaanladder staat daardoor al twee maanden stil.
//
// Tot deze wijziging gaf `balLigtBijOns` bij een ontbrekende inbound `false`
// terug — geen bewuste doorlaat maar een gat: de guard greep niet in en de
// teller besliste alsnog. Nu een expliciete blokkade met een eigen reden,
// zodat zo'n run opvalt in plaats van stil te blijven staan.

for (const [naam, dagen] of [['Karim Alian', 64], ['Priscilla Mauricia', 70], ['Khalid Nassiri', 44]]) {
  test(`${naam} (${dagen} dagen te laat): geen klant-bericht → geen_gesprek, geen herinnering`, () => {
    for (const teller of [0, 1, 2]) {
      const stage = determineStage({
        run: {
          paused_conversation_reminder_count: teller,
          paused_conversation_last_reminder_at: teller > 0 ? '2026-09-08T10:00:00Z' : null,
        },
        convLastInboundAt: null,          // nooit een bericht van de klant
        convLastAnswerAt:  '2026-07-01T09:00:00Z',
        noReplyCfg: CFG,
        nowMs: NU,
      });
      assert.equal(stage, 'geen_gesprek', `teller ${teller} mag hier niets doorlaten`);
    }
  });
}

test('GEEN GESPREK gaat vóór alle andere takken, ook vóór de drempel', () => {
  // Zelfs met een verse herinnering van een minuut geleden (drempel niet
  // gehaald) is het antwoord 'geen_gesprek' en niet null: het verschil moet
  // zichtbaar zijn in de log.
  const stage = determineStage({
    run: {
      paused_conversation_reminder_count: 1,
      paused_conversation_last_reminder_at: new Date(NU - 60 * 1000).toISOString(),
    },
    convLastInboundAt: null,
    convLastAnswerAt:  null,
    noReplyCfg: CFG,
    nowMs: NU,
  });
  assert.equal(stage, 'geen_gesprek');
});
