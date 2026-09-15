// tests/events-plek-bezet-sql-spiegel.test.js
//
// NODE EN DE DATABANK MOETEN DEZELFDE REGEL TELLEN.
//
// De "neemt een plek in"-regel staat op drie plaatsen: in JS (isPlekBezet /
// applyPlekBezetFilter), in de browser (events-v2.js) en in SQL (de migratie
// van 15 sep 2026 — predicate, telfunctie, auto-close-trigger en twee views).
// Lopen die uit elkaar, dan sluit de DB-trigger een event dat de UI nog als
// halfvol toont, of andersom. Dat is precies het soort verschil dat niemand
// ziet tot een klant voor een dichte deur staat.
//
// Deze test leest het migratiebestand en toetst dat elke plek waar geteld
// wordt dezelfde drie voorwaarden bevat als de JS-kant. Hij vervangt geen
// echte DB-test — hij bewaakt dat de twee teksten niet stilletjes uiteen gaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isPlekBezet, CONFIRMED_STATUSES, PLEK_BEZET_CALL_STATUS,
} from '../api/_lib/event-registration.js';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIE  = join(ROOT, 'docs/sql-migrations/2026-09-15-events-belstatus-bevestigd-telt-mee.sql');
const sql       = readFileSync(MIGRATIE, 'utf8');
/** Alleen de uitvoerbare regels — commentaar beschrijft de regel ook. */
const code      = sql.split('\n').filter((r) => !r.trimStart().startsWith('--')).join('\n');

/** De belstatus-tak zoals SQL 'm schrijft: lower(btrim(...)) = 'bevestigd'. */
const BELSTATUS_TAK = /lower\(btrim\([^)]*call_status\)\)[^=]*=\s*'bevestigd'/g;

test('het migratiebestand staat er en is geldige, niet-ge-escapete SQL', () => {
  // Het invoerveld waar deze SQL doorheen kwam kan markdown-escapes hebben
  // gezet (een backslash vóór _ of *). Eén zo'n teken maakt het bestand stuk.
  assert.ok(sql.length > 1000);
  assert.equal(sql.includes('\\'), false, 'geen enkele backslash in het bestand');
  assert.match(sql, /^-- 2026-09-15-events-belstatus-bevestigd-telt-mee\.sql/);
});

test('de 4-args-predicate bestaat en draagt de belstatus', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.event_attendee_is_confirmed\([\s\S]*?p_call_status\s+text[\s\S]*?\)/);
  assert.match(sql, /p_status = ANY \(ARRAY\['aangemeld','aanwezig'\]\)/);
  assert.match(sql, /p_is_test = false/);
  assert.match(sql, /p_assessment_response_id IS NOT NULL/);
  assert.match(sql, /coalesce\(lower\(btrim\(p_call_status\)\), ''\) = 'bevestigd'/);
});

test('de JS-constanten en de SQL zeggen hetzelfde', () => {
  assert.deepEqual(CONFIRMED_STATUSES, ['aangemeld', 'aanwezig']);
  assert.equal(PLEK_BEZET_CALL_STATUS, 'bevestigd');
  // De statuslijst uit JS moet letterlijk in de SQL-array staan.
  assert.ok(sql.includes(`ARRAY['${CONFIRMED_STATUSES.join("','")}']`));
});

test('elke plek die telt, telt met de belstatus erbij', () => {
  // Vier tellers naast de predicate zelf: de telfunctie, de auto-close-trigger,
  // de publieke website-view en de AI-readonly-view. De laatste twee schrijven
  // het predicate inline uit (geen functie-aanroep), dus daar moet de
  // belstatus-tak letterlijk staan.
  assert.match(sql, /event_confirmed_count[\s\S]*?event_attendee_is_confirmed\(status::text, assessment_response_id, is_test, call_status\)/);
  assert.match(sql, /fn_event_attendees_auto_close[\s\S]*?NEW\.is_test, NEW\.call_status\)/);
  assert.match(sql, /CREATE OR REPLACE VIEW public\.website_events[\s\S]*?lower\(btrim\(a\.call_status\)\)/);
  assert.match(sql, /CREATE OR REPLACE VIEW ai_readonly\.v_events_upcoming[\s\S]*?lower\(btrim\(a\.call_status\)\)/);

  // Vier keer in uitvoerbare code: de predicate zelf plus drie inline-
  // gebruiken (website_events, plaatsen_over, aantal_plek_bezet).
  assert.equal((code.match(BELSTATUS_TAK) || []).length, 4, 'predicate + 3 inline-gebruiken');
});

test('de trigger luistert ook op call_status', () => {
  // Zonder deze kolom in de UPDATE OF-lijst vuurt de trigger niet bij een
  // belstatuswijziging, en sluit een vol geraakt event dus nooit vanzelf.
  assert.match(sql, /AFTER INSERT OR UPDATE OF status, assessment_response_id, is_test, call_status/);
});

test('aantal_vragenlijst_ingevuld blijft letterlijk de vragenlijst', () => {
  // De AI-view mag de twee begrippen niet door elkaar halen: die kolom is
  // "heeft de vragenlijst ingevuld", aantal_plek_bezet is de capaciteitsregel.
  const i = sql.indexOf('AS aantal_vragenlijst_ingevuld');
  assert.ok(i > 0);
  const blok = sql.slice(sql.lastIndexOf('COUNT(a.id)', i), i);
  assert.match(blok, /a\.assessment_response_id IS NOT NULL/);
  assert.doesNotMatch(blok, /call_status/, 'geen belstatus in de vragenlijst-teller');
  assert.match(sql, /AS aantal_plek_bezet/);
});

test('Node en SQL verwijzen naar elkaar', () => {
  // Wie de een aanpast moet de ander vinden zonder te zoeken. De regel zelf
  // woont in plek-bezet.js; event-registration.js her-exporteert hem en draagt
  // dezelfde verwijzing, zodat je vanuit beide bestanden bij de migratie komt.
  assert.match(sql, /api\/_lib\/event-registration\.js/);
  for (const pad of ['api/_lib/plek-bezet.js', 'api/_lib/event-registration.js']) {
    const js = readFileSync(join(ROOT, pad), 'utf8');
    assert.match(js, /event_attendee_is_confirmed\(text, uuid, boolean, text\)/, pad);
    assert.match(js, /2026-09-15-events-belstatus-bevestigd-telt-mee\.sql/, pad);
  }
});

test('de gevallen uit tests/events-plek-bezet.test.js voldoen aan de SQL-regel', () => {
  // Handmatige her-implementatie van het SQL-predicate, zodat een wijziging in
  // isPlekBezet die de SQL niet volgt hier opvalt.
  const alsSql = (r) =>
    ['aangemeld', 'aanwezig'].includes(r.status)
    && r.is_test === false
    && (r.assessment_response_id != null || String(r.call_status ?? '').trim().toLowerCase() === 'bevestigd');

  const AR = '11111111-2222-3333-4444-555555555555';
  const gevallen = [];
  for (const status of ['aangemeld', 'aanwezig', 'wachtlijst', 'geannuleerd', 'no_show', 'sale', 'switched_to_other_event']) {
    for (const ar of [null, AR]) {
      for (const is_test of [false, true]) {
        for (const call_status of [null, 'bevestigd', 'Bevestigd', ' bevestigd ', 'geen_gehoor', 'komt_niet', '']) {
          gevallen.push({ status, assessment_response_id: ar, is_test, call_status });
        }
      }
    }
  }
  assert.equal(gevallen.length, 196);
  for (const rij of gevallen) {
    assert.equal(isPlekBezet(rij), alsSql(rij), JSON.stringify(rij));
  }
});
