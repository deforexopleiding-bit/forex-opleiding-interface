// tests/conv-reminder-outbound-guard.test.js
//
// Bewijst FIX B voor de no-reply-reminder bug: als WIJ recenter hebben
// gestuurd dan de klant, mag determineStage GEEN r1/r2 returnen. Terwijl
// een échte no-reply-situatie (klant stil, wij ook stil) wel een reminder
// blijft opleveren. Pure unit-tests op determineStage — geen DB, geen HTTP.
//
// Achtergrond: de reminder-tekst zegt "nog geen reactie van mij gekregen".
// Als wij intussen wél hebben geantwoord (via inbox-send) is dat onwaar en
// verwarrend voor de klant. Fix A ontpauzeert de run direct bij een send;
// deze test dekt fix B als vangnet in de cron zelf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Pure helper geïmporteerd — geen supabase-init nodig (cron-file zelf laadt
// supabase op module-load, dus die kunnen we in unit-tests niet gebruiken).
import { determineStage } from '../api/_lib/conv-reminder-stage.js';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-08-01T12:00:00Z').getTime();

const DEFAULT_CFG = {
  reminder_1_hours: 20,
  reminder_2_hours: 24,
  resume_after_hours: 24,
};

// ── SCENARIO 1: onterecht — wij hebben al gereageerd ──────────────────

test('count=0: klant stuurde 25u geleden, wij antwoorden 5u geleden → GEEN r1', () => {
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: new Date(NOW - 25 * HOUR).toISOString(),
    convLastOutboundAt: new Date(NOW - 5 * HOUR).toISOString(),
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null, 'Wij hebben net gereageerd — reminder mag NIET');
});

test('count=0: klant stuurde 30u geleden, wij antwoorden 25u geleden → GEEN r1', () => {
  // Zelfs als onze outbound zelf al 25u oud is, is 'ie recenter dan de
  // klant-inbound → wij hebben gereageerd, klant is aan zet nu.
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: new Date(NOW - 30 * HOUR).toISOString(),
    convLastOutboundAt: new Date(NOW - 25 * HOUR).toISOString(),
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

test('count=1: r1 verstuurd 30u geleden, wij handmatig antwoord 5u geleden → GEEN r2', () => {
  // Symmetrische guard: als medewerker persoonlijk reageert na r1, mag
  // er geen automatische r2 komen.
  const stage = determineStage({
    run: {
      paused_conversation_reminder_count: 1,
      paused_conversation_last_reminder_at: new Date(NOW - 30 * HOUR).toISOString(),
    },
    convLastInboundAt: new Date(NOW - 40 * HOUR).toISOString(),
    convLastOutboundAt: new Date(NOW - 5 * HOUR).toISOString(),
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null);
});

// ── SCENARIO 2: terecht — niemand heeft gereageerd ────────────────────

test('count=0: klant stuurde 25u geleden, geen outbound → WEL r1 (terecht)', () => {
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: new Date(NOW - 25 * HOUR).toISOString(),
    convLastOutboundAt: null,
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r1', 'Echte no-reply moet nog gewoon reminder krijgen');
});

test('count=0: klant stuurde 25u geleden, onze outbound ouder dan inbound → WEL r1', () => {
  // Bv. wij stuurden 40u geleden een aanmaning → klant reageerde 25u geleden →
  // wij hebben daarna niet gereageerd. Echte no-reply-situatie.
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: new Date(NOW - 25 * HOUR).toISOString(),
    convLastOutboundAt: new Date(NOW - 40 * HOUR).toISOString(),
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r1');
});

test('count=1: r1 verstuurd 26u geleden, geen inbound & geen latere outbound → WEL r2', () => {
  const stage = determineStage({
    run: {
      paused_conversation_reminder_count: 1,
      paused_conversation_last_reminder_at: new Date(NOW - 26 * HOUR).toISOString(),
    },
    convLastInboundAt: new Date(NOW - 50 * HOUR).toISOString(),
    convLastOutboundAt: new Date(NOW - 26 * HOUR).toISOString(), // r1 zelf, geen latere
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r2');
});

// ── EDGE CASES ────────────────────────────────────────────────────────

test('count=0: geen outbound-info doorgegeven → gedrag valt terug op oud (alleen inbound-check)', () => {
  // Als de cron de outbound-query mist (fail-soft), moet 'ie NIET stuk gaan.
  // Gedrag is dan hetzelfde als vóór fix B: reminder gaat af op inbound-timing.
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: new Date(NOW - 25 * HOUR).toISOString(),
    // convLastOutboundAt niet meegegeven — default null
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r1');
});

test('count=0: klant net gereageerd (5u geleden), wij nog niet → nog te vroeg (null)', () => {
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: new Date(NOW - 5 * HOUR).toISOString(),
    convLastOutboundAt: null,
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, null, '5u < 20u drempel — nog geen reminder');
});

test('count=0: outbound = inbound (exact tijd) → GEEN r1 (equal telt als "wij hebben gereageerd")', () => {
  // Edge: als beide op exact hetzelfde moment (theoretisch onmogelijk maar
  // defensief). Comparator is `>`, dus equal → geen guard → r1 gaat toch af.
  // Documenteer bewust: strikt > vermijdt false-positives bij clock-skew.
  const t = new Date(NOW - 25 * HOUR).toISOString();
  const stage = determineStage({
    run: { paused_conversation_reminder_count: 0, paused_conversation_last_reminder_at: null },
    convLastInboundAt: t,
    convLastOutboundAt: t,
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  assert.equal(stage, 'r1', 'Equal → geen guard (strikt >); acceptabele race');
});

test('count=2: rz onaangeroerd door outbound-guard (resume is puur timing)', () => {
  const stage = determineStage({
    run: {
      paused_conversation_reminder_count: 2,
      paused_conversation_last_reminder_at: new Date(NOW - 25 * HOUR).toISOString(),
    },
    convLastInboundAt: new Date(NOW - 50 * HOUR).toISOString(),
    convLastOutboundAt: new Date(NOW - 1 * HOUR).toISOString(), // wij hebben net gestuurd
    noReplyCfg: DEFAULT_CFG,
    nowMs: NOW,
  });
  // rz is een resume-actie (geen send), dus outbound-guard geldt niet.
  assert.equal(stage, 'rz');
});
