// tests/events-berichten-plek-bevestigd.test.js
//
// "JE PLEK IS NOG NIET DEFINITIEF" NAAR IEMAND DIE AL BEVESTIGD HEEFT.
//
// Sinds 15 sep 2026 neemt belstatus 'bevestigd' een plek in. Twee reeksen
// berichten hingen nog aan de oude regel (alleen de vragenlijst telt) en
// vertelden daardoor het verkeerde verhaal:
//
//   · cron-events-website-berichten — vervolg_2u / vervolg_24u sturen een
//     herinnering dat de plek nog niet vaststaat; warmup + de twee reminders
//     (tijd, locatie, wat mee te nemen) gingen juist LANGS wie bevestigd was.
//   · de automatisatie "Vragenlijst-herinnering" (on_signup) gate't op de
//     conditie assessment_not_completed en stuurt "je plek is nog NIET
//     definitief bevestigd".
//
// Deze test legt het bedoelde gedrag vast: wie zijn plek al heeft, krijgt geen
// bericht meer dat het tegendeel beweert, en krijgt de praktische reminders wél.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE CONDITIE — assessment_not_completed
// ═══════════════════════════════════════════════════════════════════════════

const { buildConditionState, evaluateCondition } =
  await import(url('api/_lib/events-automation-engine.js'));

const AR = '11111111-2222-3333-4444-555555555555';
const EVENT = { id: 'ev-1', niveau: 'basis', starts_at: '2026-09-19T17:00:00.000Z' };

const attendee = (extra) => ({
  id: 'att-1', event_id: 'ev-1', status: 'aangemeld',
  assessment_response_id: null, is_test: false, call_status: null, ...extra,
});

test('plek_bevestigd staat in de conditie-state', () => {
  assert.equal(buildConditionState(attendee({ call_status: 'bevestigd' }), EVENT).plek_bevestigd, true);
  assert.equal(buildConditionState(attendee({ assessment_response_id: AR }), EVENT).plek_bevestigd, true);
  assert.equal(buildConditionState(attendee(), EVENT).plek_bevestigd, false);
});

test('"vragenlijst niet ingevuld" is NIET waar als de plek via bevestigd vaststaat', () => {
  // De herinnering die hierachter hangt zegt "je plek is nog NIET definitief".
  // Voor deze persoon is dat onwaar, dus de conditie faalt en de stappen
  // erna draaien niet (skip_to_end in die automatisatie).
  const state = buildConditionState(attendee({ call_status: 'bevestigd' }), EVENT);
  assert.equal(evaluateCondition('assessment_not_completed', state), false);
});

test('zonder plek blijft de herinnering gewoon gaan', () => {
  for (const cs of [null, 'geen_gehoor', 'voicemail', 'terugbellen']) {
    const state = buildConditionState(attendee({ call_status: cs }), EVENT);
    assert.equal(evaluateCondition('assessment_not_completed', state), true, String(cs));
  }
});

test('wachtlijst + bevestigd krijgt de herinnering wél — daar is nog geen plek', () => {
  const state = buildConditionState(attendee({ status: 'wachtlijst', call_status: 'bevestigd' }), EVENT);
  assert.equal(evaluateCondition('assessment_not_completed', state), true);
});

test('assessment_completed zelf is NIET veranderd', () => {
  // Die check beantwoordt letterlijk "heeft hij de vragenlijst ingevuld?".
  // "Bevestiging aanmelding" (on_assessment_completed) hangt daaraan en blijft
  // dus voorbehouden aan wie de vragenlijst invulde.
  const bevestigdZonderVragenlijst = buildConditionState(attendee({ call_status: 'bevestigd' }), EVENT);
  assert.equal(evaluateCondition('assessment_completed', bevestigdZonderVragenlijst), false);

  const metVragenlijst = buildConditionState(attendee({ assessment_response_id: AR }), EVENT);
  assert.equal(evaluateCondition('assessment_completed', metVragenlijst), true);
  assert.equal(evaluateCondition('assessment_not_completed', metVragenlijst), false);
});

test('een oudere caller zonder plek_bevestigd valt terug op het oude gedrag', () => {
  // buildConditionState levert het veld altijd, maar evaluateCondition is een
  // pure functie die ook los aangeroepen wordt (en in tests). Zonder het veld
  // mag hij niet stilletjes alles blokkeren.
  assert.equal(evaluateCondition('assessment_not_completed', { assessment_completed: false }), true);
  assert.equal(evaluateCondition('assessment_not_completed', { assessment_completed: true }), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE WEBSITE-CRON — welke rijen elke reeks selecteert
// ═══════════════════════════════════════════════════════════════════════════

/** Supabase-dubbelganger die de HELE filterketen per query onthoudt. */
function nepAdmin() {
  const ketens = [];
  const from = (tabel) => {
    const keten = { tabel, select: null, stappen: [] };
    ketens.push(keten);
    const k = {
      select(kolommen) { keten.select = kolommen; return k; },
      eq(c, v)  { keten.stappen.push(['eq', c, v]);  return k; },
      in(c, v)  { keten.stappen.push(['in', c, v]);  return k; },
      is(c, v)  { keten.stappen.push(['is', c, v]);  return k; },
      or(s)     { keten.stappen.push(['or', s]);     return k; },
      not(c, o, v) { keten.stappen.push(['not', c, o, v]); return k; },
      gt(c, v)  { keten.stappen.push(['gt', c, v]);  return k; },
      gte(c, v) { keten.stappen.push(['gte', c, v]); return k; },
      lt(c, v)  { keten.stappen.push(['lt', c, v]);  return k; },
      lte(c, v) { keten.stappen.push(['lte', c, v]); return k; },
      limit(n)  { keten.stappen.push(['limit', n]);  return k; },
      order()   { return k; },
      then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
    };
    return k;
  };
  return { ketens, from };
}

const admin = nepAdmin();
mock.module(url('api/supabase.js'), {
  namedExports: { supabaseAdmin: admin, createUserClient: () => admin, checkCronAuth: () => ({ ok: true }) },
});
mock.module(url('api/_lib/event-website-berichten.js'), {
  namedExports: {
    SOORTEN: { VERVOLG_2U: 'vervolg_2u', VERVOLG_24U: 'vervolg_24u', WARMUP: 'warmup', REMINDER_24U: 'reminder_24u', REMINDER_1U: 'reminder_1u' },
    reedsVerstuurd: async () => true,
    markeerVerstuurd: async () => {},
    stuurWaEnMail: async () => ({ ok: true }),
    kiesVervolgTemplate: async () => ({ template: 'x', mapping: {} }),
    vervolgLink: () => 'https://example.test/v',
  },
});

const cron = (await import(url('api/cron-events-website-berichten.js'))).default;

const res = { setHeader() {}, status(c) { res._c = c; return res; }, json(b) { res._b = b; return res; } };
await cron({ method: 'POST', headers: {}, query: {} }, res);

// De vijf event_attendees-queries staan in bronvolgorde: vervolg_2u,
// vervolg_24u, warmup, reminder_24u, reminder_1u.
const q = admin.ketens.filter((k) => k.tabel === 'event_attendees');

test('de cron draait alle vijf de reeksen', () => {
  assert.equal(res._c, 200);
  assert.equal(q.length, 5);
});

test('de SELECT leest call_status mee — anders valt er niets te filteren', () => {
  for (const keten of q) assert.match(keten.select, /call_status/);
});

for (const [i, naam] of [[0, 'vervolg_2u'], [1, 'vervolg_24u']]) {
  test(`${naam} sluit belstatus bevestigd uit`, () => {
    const stappen = q[i].stappen;
    // Nog steeds: geen vragenlijst + status aangemeld.
    assert.ok(stappen.some(([o, c, v]) => o === 'is' && c === 'assessment_response_id' && v === null));
    assert.ok(stappen.some(([o, c, v]) => o === 'eq' && c === 'status' && v === 'aangemeld'));
    // Nieuw: en ook geen plek via de bel.
    const ors = stappen.filter(([o]) => o === 'or');
    assert.equal(ors.length, 1, 'precies één or-clausule');
    assert.equal(ors[0][1], 'call_status.is.null,call_status.not.ilike.bevestigd');
  });
}

for (const [i, naam] of [[2, 'warmup'], [3, 'reminder_24u'], [4, 'reminder_1u']]) {
  test(`${naam} gaat naar iedereen met een plek, ook via de belstatus`, () => {
    const stappen = q[i].stappen;
    // De oude harde eis "vragenlijst ingevuld" is weg...
    assert.ok(!stappen.some(([o, c]) => o === 'not' && c === 'assessment_response_id'),
      'geen kale assessment_response_id-eis meer');
    // ...en vervangen door de plek-regel.
    assert.ok(stappen.some(([o, c, v]) => o === 'in' && c === 'status' && v.join() === 'aangemeld,aanwezig'));
    const ors = stappen.filter(([o]) => o === 'or');
    assert.equal(ors.length, 1, 'precies één or-clausule');
    assert.equal(ors[0][1], 'assessment_response_id.not.is.null,call_status.ilike.bevestigd');
  });
}

test('testrijen blijven overal buiten', () => {
  for (const keten of q) {
    assert.ok(keten.stappen.some(([o, c, v]) => o === 'eq' && c === 'is_test' && v === false));
    assert.ok(keten.stappen.some(([o, c, v]) => o === 'eq' && c === 'created_via' && v === 'website'));
  }
});
