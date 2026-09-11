// tests/onboarding-spiegel-stand.test.js
//
// WAAROM DEZE KOLOM ER IS. Gemeten 11 september 2026: van de 25 spiegelrijen
// horen er VIJF bij een onboarding met status 'afgerond'. Dat is volgens
// afspraak — een afgeronde onboarding houdt zijn rij, zodat achteraf terug te
// zien is hoe lang een klant erover deed. Maar de spiegel zei nergens DAT hij
// afgerond was, en de mentorband gaat live met precies dat onderscheid als
// bestaansreden. Vijf afgeronde studenten tussen de lopende, zonder manier om
// ze eruit te filteren.
//
// ── DE TWEE LEZERS ────────────────────────────────────────────────────────
// Mentorband:  crm_stand <> 'afgerond'  → alleen lopend werk.
// Hoofdmentor: geen filter; afgerond_op − start_datum = doorlooptijd.
// Er hoeft dus niets weggegooid te worden om het mentorscherm rustig te
// houden. Dat is het verschil tussen "filteren" en "opruimen".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { bepaalStand, STAND_WOORDENLIJST } from '../api/_lib/onboarding-spiegel.js';

const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');
const MIGRATIE = 'docs/sql-migrations/2026-09-11-hlms-crm-onboarding-stand.sql';

// ══════════════════════════════════════════════════════════════════════════
// DE WOORDENLIJST
// ══════════════════════════════════════════════════════════════════════════

test('STAND 1 — de bekende CRM-statussen komen ongewijzigd door', () => {
  for (const s of ['aangemeld', 'bezig', 'afgerond']) {
    assert.equal(bepaalStand(s), s);
  }
  assert.equal(bepaalStand('  Afgerond '), 'afgerond', 'spaties en hoofdletters');
});

test('STAND 2 — onbekende status wordt onbekend, NIET een harde fout', () => {
  // Eén nieuwe status in het CRM mag nooit de hele spiegelrij laten
  // mislukken: een rij die er niet is, is erger dan een stand die
  // "onbekend" zegt.
  for (const s of ['in_behandeling', 'paused', '', null, undefined, 42]) {
    assert.equal(bepaalStand(s), 'onbekend', 'status=' + String(s));
  }
});

test('STAND 3 — geannuleerd en gearchiveerd zitten NIET in de woordenlijst', () => {
  // Zulke onboardings hebben geen spiegelrij meer; die worden verwijderd.
  // Stonden ze er wel in, dan zou een wees-rij er geldig uitzien.
  assert.ok(!STAND_WOORDENLIJST.includes('geannuleerd'));
  assert.ok(!STAND_WOORDENLIJST.includes('gearchiveerd'));
  assert.equal(bepaalStand('geannuleerd'), 'onbekend');
  assert.equal(bepaalStand('gearchiveerd'), 'onbekend');
});

test('STAND 4 — bepaalStand geeft ALLEEN ooit een woord uit de lijst', () => {
  const proef = ['aangemeld', 'bezig', 'afgerond', 'rommel', '', null,
    'GEARCHIVEERD', ' bezig ', 'afgerond ', 0, {}, []];
  for (const s of proef) {
    assert.ok(STAND_WOORDENLIJST.includes(bepaalStand(s)),
      'onverwachte waarde voor ' + JSON.stringify(s));
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DE SCHRIJVER
// ══════════════════════════════════════════════════════════════════════════

test('STAND 5 — de spiegel schrijft crm_stand én afgerond_op', () => {
  const bron = lees('api/_lib/onboarding-spiegel.js');
  assert.match(bron, /crm_stand\s*:\s*bepaalStand\(ob\.status\)/,
    'de stand wordt niet uit de CRM-status afgeleid');
  assert.match(bron, /afgerond_op\s*:\s*ob\.completed_at/,
    'zonder afgerond_op is de doorlooptijd niet terug te rekenen, en dat is '
    + 'de reden dat de rij bewaard blijft');
});

test('STAND 6 — completed_at wordt ook echt uit het CRM gelezen', () => {
  // Anders schrijft hij stilzwijgend altijd null — het soort fout waar de
  // kolomtest voor gemaakt is.
  const bron = lees('api/_lib/onboarding-spiegel.js');
  const kolommen = bron.slice(bron.indexOf('const CRM_KOLOMMEN'),
    bron.indexOf('const CRM_KOLOMMEN') + 300);
  assert.match(kolommen, /completed_at/,
    'completed_at staat niet in de select, dus afgerond_op blijft altijd leeg');
});

// ══════════════════════════════════════════════════════════════════════════
// DE MIGRATIE
// ══════════════════════════════════════════════════════════════════════════

test('MIGRATIE 1 — draait op dfo-lms, met de Supabase-waarschuwing erboven', () => {
  const sql = lees(MIGRATIE);
  assert.match(sql, /DRAAIEN OP: dfo-lms/);
  assert.match(sql, /NIET op het CRM/);
  // Supabase schuift een bevestigingsvenster tussen bij ALTER/DROP en zonder
  // bevestiging draait er niets, terwijl het scherm rustig blijft.
  assert.match(sql, /bevestigingsvenster/i,
    'de waarschuwing over het bevestigingsvenster ontbreekt');
  assert.match(sql, /controle/i, 'er staat geen controle-query in');
});

test('MIGRATIE 2 — de CHECK komt exact overeen met de woordenlijst in code', () => {
  const sql = lees(MIGRATIE);
  const m = sql.match(/CHECK \(crm_stand IN \(([^)]+)\)\)/);
  assert.ok(m, 'geen CHECK op crm_stand gevonden');
  const inSql = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  assert.deepEqual(inSql, [...STAND_WOORDENLIJST].sort(),
    'databank en code zijn het oneens over de woordenlijst — dan faalt een '
    + 'schrijfactie pas in productie');
});

test('MIGRATIE 3 — het kolomcommentaar zegt waarom dit NIET onboarding_status is', () => {
  const sql = lees(MIGRATIE);
  const cm = sql.slice(sql.indexOf('COMMENT ON COLUMN public.hlms_crm_onboarding.crm_stand'));
  assert.match(cm, /onboarding_status/,
    'het commentaar noemt de dode Bubble-kolom niet');
  assert.match(cm, /bevroren|Bubble/i,
    'het commentaar legt niet uit dat die kolom bevroren is');
});

test('MIGRATIE 4 — de kolom heet niet bijna hetzelfde als de dode kolom', () => {
  // `onboarding_stand` naast `onboarding_status` is precies de verwarring
  // die we wilden vermijden.
  const sql = lees(MIGRATIE);
  assert.ok(!/ADD COLUMN IF NOT EXISTS onboarding_stand\b/.test(sql),
    'de kolom heet onboarding_stand — te dicht bij onboarding_status');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS crm_stand/);
});

test('MIGRATIE 5 — beide lezers staan beschreven, filteren in plaats van opruimen', () => {
  const sql = lees(MIGRATIE);
  assert.match(sql, /crm_stand <> 'afgerond'/,
    'het filter voor de mentorband staat er niet in');
  assert.match(sql, /afgerond_op/,
    'de doorlooptijd voor de hoofdmentor staat er niet in');
});
