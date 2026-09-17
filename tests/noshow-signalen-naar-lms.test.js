// tests/noshow-signalen-naar-lms.test.js
//
// ÉÉN BRON VOOR SIGNALEN. De opvolging van studenten gebeurt voortaan in het
// LMS (hlms_signaal, hoofdmentorbord); de CRM-kant van de twee automatische
// no-show-signalen gaat uit.
//
// Wat hier bewaakt wordt is niet zozeer dat er iets werkt, maar dat er iets
// NIET meer gebeurt — en dat is lastiger vast te houden: een uitgezette cron
// is met één regel in vercel.json weer aan, en een guard is met één
// weggehaalde regel weg. Vandaar contracttests op beide sloten.
//
// En, even belangrijk, de TEGENPROEF: de andere signaaltypes en de
// auto-afsluiting van onboardings moeten het gewoon blijven doen. Een
// opruiming die te ver doorschiet is net zo schadelijk als eentje die niet
// gebeurt — dan verdwijnen de mentor-meldingen mee, en die gaan over iets
// heel anders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const CRON      = lees('api/cron/noshow-detect.js');
const VERCEL    = JSON.parse(lees('vercel.json'));
const SQL       = lees('docs/sql-migrations/2026-09-17-noshow-signalen-naar-lms.sql');
const OVERZICHT = lees('modules/students-overview.html');
const MENTOR    = lees('modules/mentor-students.html');
const AUTOMAT   = lees('modules/klanten-v2/views/automatiseringen-v2.js');
const AFRONDEN  = lees('api/cron/onboarding-eerste-sessie-afronden.js');
const CREATE    = lees('api/student-signals-create.js');

const LMS_LINK = 'https://lms.deforexopleiding.nl/hoofdmentor/';

// ═══════════════════════════════════════════════════════════════════════════
// 1) HET AANMAKEN STAAT UIT — twee sloten
// ═══════════════════════════════════════════════════════════════════════════

test('de cron staat niet meer in vercel.json', () => {
  const paden = (VERCEL.crons || []).map((c) => c.path);
  assert.equal(paden.includes('/api/cron/noshow-detect'), false,
    'de no-show-cron is weer ingepland — dan maakt hij opnieuw CRM-signalen aan');
});

test('en de handler stopt ook als iemand hem met de hand aanroept', () => {
  // Een cron-entry is zo weer teruggezet; het tweede slot zit in de code.
  // De stop moet VÓÓR de eerste databankbevraging staan, anders doet de
  // handler alsnog werk.
  const stopIdx   = CRON.indexOf('uitgezet: true');
  const insertIdx = CRON.indexOf(".from('student_signals').insert");
  assert.ok(stopIdx > 0, 'de handler heeft geen uitgezet-stop');
  assert.ok(insertIdx > stopIdx,
    'de insert staat vóór de stop — dan maakt de cron nog steeds signalen aan');
});

test('de stop geeft 200 en geen foutcode', () => {
  // Dit is geen storing maar een beslissing. Een cron die rood eindigt laat
  // iemand zoeken naar een probleem dat er niet is.
  assert.match(CRON, /res\.status\(200\)\.json\(\{\s*\n?\s*ok: true,\s*\n?\s*uitgezet: true/,
    'de uitgezet-stop geeft geen nette 200 terug');
});

test('de stop vertelt WAAR de opvolging dan wél staat', () => {
  assert.ok(CRON.includes(LMS_LINK),
    'wie deze cron aanroept krijgt geen verwijzing naar het hoofdmentorbord');
});

test('het watermerk wordt niet gewist of verzet door de stop', () => {
  // Wie de cron ooit terugzet moet hervatten waar hij gebleven was, niet een
  // gat hebben of alles opnieuw doen.
  const voorStop = CRON.slice(0, CRON.indexOf('uitgezet: true'));
  assert.doesNotMatch(voorStop, /noshow_detect_since[\s\S]{0,200}(update|upsert|delete)/i,
    'het watermerk wordt aangeraakt voordat de handler stopt');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) TEGENPROEF — wat NIET geraakt mag worden
// ═══════════════════════════════════════════════════════════════════════════

test('TEGENPROEF: de auto-afsluiting van onboardings blijft ingepland', () => {
  // Die hangt aan de eerste AFGERONDE LMS-sessie, is een andere cron met een
  // eigen watermerk, en is nog nodig.
  const paden = (VERCEL.crons || []).map((c) => c.path);
  assert.ok(paden.includes('/api/cron/onboarding-eerste-sessie-afronden'),
    'de auto-afsluiting is mee uitgezet — die is nog nodig');
});

test('TEGENPROEF: de auto-afsluiting leest geen student_signals en is niet aangeraakt', () => {
  assert.doesNotMatch(AFRONDEN, /student_signals/,
    'de auto-afsluiting hangt aan student_signals — dan zou hij hierdoor breken');
  assert.doesNotMatch(AFRONDEN, /uitgezet/,
    'er staat een uitgezet-stop in de auto-afsluiting');
});

test('TEGENPROEF: de mentor kan nog steeds de andere signaaltypes melden', () => {
  // reageert_niet, eerste_call, niet_bereikbaar, geen_reactie_bellen, anders.
  // Die komen van mentoren en gaan over iets anders dan een gemiste sessie.
  for (const type of ['eerste_call', 'reageert_niet', 'niet_bereikbaar',
    'geen_reactie_bellen', 'anders']) {
    assert.ok(CREATE.includes("'" + type + "'"),
      'het meldtype ' + type + ' is verdwenen uit student-signals-create');
  }
  assert.doesNotMatch(CREATE, /uitgezet/,
    'het meldpunt van de mentor is mee uitgezet');
});

test('TEGENPROEF: het Aandachtspunten-scherm toont de mentor-meldingen nog', () => {
  assert.match(OVERZICHT, /apTypeFilter === 'meldingen'/,
    'het filter op mentor-meldingen is verdwenen');
  assert.match(OVERZICHT, /reageert_niet\s*:/,
    'de labels van de mentor-meldingen zijn verdwenen');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) DE EENMALIGE DATAWIJZIGING
// ═══════════════════════════════════════════════════════════════════════════

/** De SQL zonder commentaarregels — alleen wat er echt draait. */
const SQL_CODE = SQL.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');

test('de migratie verwijdert NIETS', () => {
  // De opdracht is expliciet: niets weggooien. Een DELETE die per ongeluk in
  // een latere versie sluipt is precies wat niemand terug kan draaien.
  assert.doesNotMatch(SQL_CODE, /\bDELETE\b/i, 'er staat een DELETE in de migratie');
  assert.doesNotMatch(SQL_CODE, /\bDROP\s+TABLE\b/i, 'er staat een DROP TABLE in de migratie');
  assert.doesNotMatch(SQL_CODE, /\bTRUNCATE\b/i, 'er staat een TRUNCATE in de migratie');
});

test('de lijst met id\'s wordt vastgelegd VOORDAT er iets wordt afgesloten', () => {
  const logIdx    = SQL_CODE.indexOf('INSERT INTO public.student_signals_lms_overdracht');
  const updateIdx = SQL_CODE.indexOf('UPDATE public.student_signals s');
  assert.ok(logIdx > 0, 'de id\'s worden nergens vastgelegd — dan is dit niet terug te draaien');
  assert.ok(updateIdx > logIdx, 'de update staat vóór het vastleggen van de id\'s');
});

test('de migratie raakt ALLEEN de twee automatische types', () => {
  // Elke schrijvende opdracht moet op de twee types afgebakend zijn.
  const schrijvend = SQL_CODE.split(';')
    .filter((st) => /\b(INSERT|UPDATE)\b/i.test(st) && st.includes('student_signals'));
  assert.ok(schrijvend.length >= 2, 'er zijn minder schrijvende opdrachten dan verwacht');
  for (const st of schrijvend) {
    assert.match(st, /type IN \('no_show', 'eerste_call_no_show'\)/,
      'een schrijvende opdracht is niet afgebakend op de twee types:\n' + st.trim().slice(0, 200));
  }
});

test('de migratie raakt geen al afgehandelde signalen (en is dus herhaalbaar)', () => {
  const schrijvend = SQL_CODE.split(';')
    .filter((st) => /\b(INSERT|UPDATE)\b/i.test(st) && st.includes('student_signals'));
  for (const st of schrijvend) {
    assert.match(st, /status <> 'afgehandeld'|ON CONFLICT/,
      'een schrijvende opdracht heeft geen rem op al-afgehandelde rijen:\n' + st.trim().slice(0, 200));
  }
});

test('de afgesproken uitkomsttekst staat er letterlijk in', () => {
  assert.ok(SQL_CODE.includes("'Vervangen door de LMS-opvolging (hoofdmentorbord)'"),
    'de uitkomsttekst wijkt af van wat afgesproken is');
  assert.match(SQL_CODE, /status\s*=\s*'afgehandeld'/);
  assert.match(SQL_CODE, /handled_at\s*=\s*now\(\)/);
});

test('er staat een rollback in het bestand', () => {
  assert.match(SQL, /ROLLBACK/i, 'er staat geen terugdraai-aanwijzing in de migratie');
  assert.match(SQL, /SET status\s*=\s*o\.status_voor/,
    'de rollback zet de oude status niet terug');
});

test('de uitkomst past binnen de CHECK-constraint van de tabel', () => {
  // uitkomst_type mag alleen: opgelost / geen_gehoor_opnieuw /
  // student_gestopt / anders (migratie 017). Een waarde daarbuiten laat de
  // hele UPDATE falen — en dat merk je pas als Cowork 'm draait.
  const toegestaan = lees('migrations/017_student_signals.sql')
    .match(/uitkomst_type\s+text CHECK \(uitkomst_type IN \(([^)]+)\)/);
  assert.ok(toegestaan, 'de CHECK-constraint is niet meer te vinden in migratie 017');
  const gebruikt = SQL_CODE.match(/uitkomst_type\s*=\s*'([a-z_]+)'/);
  assert.ok(gebruikt, 'de migratie zet geen uitkomst_type');
  assert.ok(toegestaan[1].includes("'" + gebruikt[1] + "'"),
    'uitkomst_type ' + gebruikt[1] + ' staat niet in de CHECK-constraint');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) DE SCHERMEN ZEGGEN WAAR HET WÉL STAAT
// ═══════════════════════════════════════════════════════════════════════════

test('elk scherm dat deze signalen las, verwijst naar het hoofdmentorbord', () => {
  // Een lege lijst zonder uitleg leest als "er is niets aan de hand". Dat is
  // precies het verkeerde bericht als de opvolging ergens anders staat.
  for (const [naam, bron] of [
    ['Aandachtspunten (students-overview)', OVERZICHT],
    ['No-shows-tab (mentor-students)',      MENTOR],
    ['Automatiseringen-diagnose',           AUTOMAT],
  ]) {
    assert.ok(bron.includes(LMS_LINK), naam + ' verwijst niet naar het hoofdmentorbord');
    assert.match(bron, /opgevolgd in het LMS/,
      naam + ' zegt niet dat no-shows in het LMS opgevolgd worden');
  }
});

test('de lege No-shows-tab zegt niet langer "geen no-shows 🎉"', () => {
  // Dat is een uitspraak over de studenten, terwijl het een uitspraak over
  // het CRM is.
  assert.doesNotMatch(MENTOR, /Geen openstaande no-shows 🎉/,
    'de oude juichtekst staat er nog');
});

test('de lege Aandachtspunten-lijst legt bij een auto-filter uit waarom hij leeg is', () => {
  assert.match(OVERZICHT, /AUTO_SIGNAL_TYPES\.includes\(state\.apTypeFilter\)/,
    'de lege-lijst-tekst maakt geen onderscheid tussen de auto-types en de meldingen');
});
