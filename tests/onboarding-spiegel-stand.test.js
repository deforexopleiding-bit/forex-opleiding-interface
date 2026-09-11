// tests/onboarding-spiegel-stand.test.js
//
// WAAROM DEZE KOLOM ER IS. Gemeten 11 september 2026: van de 25 spiegelrijen
// horen er VIJF bij een onboarding met status 'afgerond'. De mentorband aan
// LMS-kant filtert op NIETS behalve mentor_id — alles wat de policy teruggeeft
// wordt een belopdracht. Tot vier afgeronde klanten zouden daar als bellen
// hebben gestaan.
//
// ── LETTERLIJK, NIET VERTAALD ─────────────────────────────────────────────
// `onboarding_stand` draagt het woord uit `onboardings.status` ONGEWIJZIGD
// over. Geen vertaling, geen lower(), geen trim(), geen woordenlijst, en geen
// CHECK-constraint in de databank.
//
// Dat is de kern van het ontwerp: komt er in het CRM een status bij (on hold
// staat op de rol), dan ziet het LMS een onbekend woord en toont die rij apart
// met "stand onbekend, controleer in het CRM voor je belt". Bij een
// vertaallaag zou dat nieuwe geval stilletjes in de emmer 'loopt' of
// 'afgerond' vallen en zou niemand het merken.
//
// Dit is bewust het TEGENOVERGESTELDE van product_soort in dfo-lms-student.js,
// waar een strikte woordenlijst juist goed is. Daar is de lezer een betalende
// KLANT die geen 'onbekend' hoort te zien; hier is de lezer een MEDEWERKER die
// juist moet zien dat er iets nieuws is. Wie de lezer is bepaalt of vertalen
// of doorgeven het veiligst is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hoortZichtbaarTeZijn, NIET_ZICHTBARE_STATUSSEN }
  from '../api/_lib/onboarding-spiegel.js';

const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');
const MIGRATIE = 'docs/sql-migrations/2026-09-11-hlms-crm-onboarding-stand.sql';
const SPIEGEL  = 'api/_lib/onboarding-spiegel.js';

// ══════════════════════════════════════════════════════════════════════════
// LETTERLIJKE DOORGIFTE
// ══════════════════════════════════════════════════════════════════════════

test('STAND 1 — de stand gaat ONGEWIJZIGD door, zonder lower of trim', () => {
  const bron = lees(SPIEGEL);
  assert.match(bron, /onboarding_stand\s*:\s*leesStandLetterlijk\(ob\.status\)/,
    'de stand wordt niet letterlijk uit de CRM-status overgenomen');

  const fn = bron.slice(bron.indexOf('function leesStandLetterlijk'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const verboden of ['toLowerCase', 'toUpperCase', 'trim', 'replace']) {
    assert.ok(!body.includes(verboden),
      'leesStandLetterlijk gebruikt ' + verboden + '() — dat is een bewerking, '
      + 'en dan is het niet meer letterlijk');
  }
});

/**
 * De bron ZONDER commentaar. Dit bestand legt met opzet uit wat er NIET meer
 * gebeurt ("zou in de emmer 'loopt' vallen"), en een test die op de kale
 * tekst afgaat slaat daarop aan. Dan sloop je het commentaar in plaats van de
 * code te repareren. Dat is deze week vijf keer gebeurd.
 */
function codeZonderCommentaar(bron) {
  return bron
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
}

test('STAND 2 — er is GEEN vertaaltabel meer', () => {
  // Een mapping van CRM-status naar eigen woorden is precies wat een nieuwe
  // status onzichtbaar zou maken.
  const code = codeZonderCommentaar(lees(SPIEGEL));
  assert.ok(!/STAND_WOORDENLIJST/.test(code),
    'er staat nog een woordenlijst in de spiegel');
  assert.ok(!/function bepaalStand/.test(code),
    'er staat nog een vertaalfunctie in de spiegel');
  assert.ok(!/['"]loopt['"]/.test(code),
    "er wordt nog naar een eigen woord 'loopt' vertaald");
});

test('STAND 3 — de migratie zet GEEN CHECK op de kolom', () => {
  // Een woordenlijst in de databank zou bij een nieuwe CRM-status de hele
  // schrijfactie laten falen, en dan verouderde de rij in plaats van dat er
  // een onbekend woord zichtbaar werd.
  const sql = lees(MIGRATIE);
  assert.ok(!/CHECK \(onboarding_stand/.test(sql),
    'er staat een CHECK op onboarding_stand — dan blokkeert de databank '
    + 'precies het geval dat zichtbaar hoort te worden');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS onboarding_stand text/,
    'de kolom hoort tekst en nullable te zijn');
  assert.ok(!/onboarding_stand text NOT NULL/.test(sql),
    'de kolom mag leeg zijn');
});

test('STAND 4 — leeg blijft leeg, er wordt niet gegokt', () => {
  const bron = lees(SPIEGEL);
  const fn = bron.slice(bron.indexOf('function leesStandLetterlijk'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /:\s*null/, 'een lege status hoort null te worden');
  for (const gok of ['aangemeld', 'bezig', 'afgerond', 'onbekend']) {
    assert.ok(!body.includes("'" + gok + "'"),
      'leesStandLetterlijk vult ' + gok + ' in als er niets staat — dat is gokken');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// WAT ER NOOIT IN DE SPIEGEL STAAT — een regel, geen toeval
// ══════════════════════════════════════════════════════════════════════════

test('ZICHTBAAR 1 — geannuleerd en gearchiveerd horen er allebei niet in', () => {
  assert.equal(hoortZichtbaarTeZijn({ status: 'geannuleerd' }), false);
  assert.equal(hoortZichtbaarTeZijn({ status: 'gearchiveerd' }), false);
  assert.deepEqual([...NIET_ZICHTBARE_STATUSSEN].sort(),
    ['geannuleerd', 'gearchiveerd']);
});

test('ZICHTBAAR 2 — gearchiveerd valt af OOK zonder archived_at', () => {
  // Dit was eerder een gevolgtrekking uit een ander bestand
  // (onboarding-archive.js zet status én archived_at samen) en geen regel
  // hier. Eén rij met status 'gearchiveerd' en een lege archived_at zou zo
  // in het LMS belanden.
  assert.equal(hoortZichtbaarTeZijn({ status: 'gearchiveerd', archived_at: null }), false);
});

test('ZICHTBAAR 3 — archived_at blijft ook los afvangen', () => {
  assert.equal(hoortZichtbaarTeZijn({ status: 'bezig', archived_at: '2026-09-01' }), false);
});

test('ZICHTBAAR 4 — lopende onboardings blijven gewoon zichtbaar', () => {
  for (const s of ['aangemeld', 'bezig', 'afgerond', 'on hold', 'iets nieuws']) {
    assert.equal(hoortZichtbaarTeZijn({ status: s, archived_at: null }), true,
      'status=' + s + ' hoort zichtbaar te zijn');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DE MIGRATIE
// ══════════════════════════════════════════════════════════════════════════

test('MIGRATIE 1 — draait op dfo-lms, met de Supabase-waarschuwing erboven', () => {
  const sql = lees(MIGRATIE);
  assert.match(sql, /DRAAIEN OP: dfo-lms/);
  assert.match(sql, /NIET op het CRM/);
  assert.match(sql, /bevestigingsvenster/i,
    'de waarschuwing over het bevestigingsvenster ontbreekt');
  assert.match(sql, /controle/i, 'er staat geen controle-query in');
});

test('MIGRATIE 2 — de band krijgt een TOELATINGSLIJST, geen uitsluiting', () => {
  // Tussen het draaien van de migratie en de eerste hersync is elke rij leeg.
  // Bij `<> 'afgerond'` zou elke lege rij ALS BELOPDRACHT verschijnen; een
  // toelatingslijst faalt de goede kant op.
  const sql = lees(MIGRATIE);
  assert.match(sql, /onboarding_stand IN \('aangemeld','bezig'\)/,
    'het geadviseerde bandfilter is geen toelatingslijst');
  assert.ok(!/WHERE[^\n]*onboarding_stand <> 'afgerond'/.test(sql),
    "er wordt nog een uitsluitingsfilter geadviseerd");
  assert.match(sql, /stand onbekend/i,
    'het losse bakje voor onbekende standen staat niet beschreven');
});

test('MIGRATIE 3 — het kolomcommentaar zegt waarom dit NIET onboarding_status is', () => {
  const sql = lees(MIGRATIE);
  const cm = sql.slice(sql.indexOf('COMMENT ON COLUMN public.hlms_crm_onboarding.onboarding_stand'));
  assert.match(cm, /hlms_student\.onboarding_status/,
    'het commentaar noemt de dode Bubble-kolom niet');
  assert.match(cm, /bevroren/i);
  assert.match(cm, /LEEG/,
    'het commentaar zegt niet wat leeg betekent, en dat is juist het geval '
    + 'dat tussen migratie en hersync overal staat');
});

test('MIGRATIE 4 — afgerond_op zit erbij, anders is bewaren zinloos', () => {
  const sql = lees(MIGRATIE);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS afgerond_op\s+timestamptz/);
  assert.match(sql, /completed_at/, 'de bron van afgerond_op staat er niet bij');
});

test('MIGRATIE 5 — completed_at wordt ook echt uit het CRM gelezen', () => {
  const bron = lees(SPIEGEL);
  const i = bron.indexOf('const CRM_KOLOMMEN');
  assert.match(bron.slice(i, i + 300), /completed_at/,
    'completed_at staat niet in de select, dus afgerond_op blijft altijd leeg');
});
