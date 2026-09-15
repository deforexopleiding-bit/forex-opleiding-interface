// tests/events-bevestigd-eigen-plek.test.js
//
// JE EIGEN VRAGENLIJST MAG JE NIET VAN JE EIGEN STOEL DUWEN.
//
// Twee plekken tellen "de bezetting ZONDER deze persoon" en zetten hem op de
// wachtlijst of geven 'vol' terug als die telling al vol staat:
//   · api/event-vervolg-finalize.js  — de vol-check vóór het definitief maken
//   · api/assessment-submit.js       — de overflow-check bij de late-link
//
// Die aanname klopte zolang alleen een ingevulde vragenlijst meetelde: wie nog
// geen vragenlijst had, zat per definitie niet in de telling. Sinds 15 sep 2026
// neemt belstatus 'bevestigd' óók een plek in — en dan zit hij er wél in. Zonder
// deze uitzondering krijgt iemand die telefonisch bevestigd is en netjes zijn
// vragenlijst invult te horen dat het event vol is, met zijn eigen stoel als
// reden.
//
// Het scenario in beide gevallen: event cap 8, 8 plekken bezet, en deze persoon
// is een van die 8 — via belstatus bevestigd, zonder vragenlijst.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const EVENT_ID  = 'aaaaaaaa-1111-2222-3333-444444444444';
const ANDER_EVENT = 'bbbbbbbb-1111-2222-3333-444444444444';
const TOKEN     = 'cccccccc-1111-2222-3333-444444444444';
const RESP_ID   = 'dddddddd-1111-2222-3333-444444444444';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · event-vervolg-finalize — de vol-check
// ═══════════════════════════════════════════════════════════════════════════

// De mocks worden ÉÉN keer gezet (node:test staat geen tweede mock op dezelfde
// specifier toe) en lezen hun antwoorden uit deze mutabele toestand. Elke test
// zet `huidig` en roept de handler aan.
const huidig = { attendee: null, bezet: 8, capacity: 8 };

/**
 * Supabase-dubbelganger. event_attendees-counts geven `huidig.bezet` terug (dat
 * is wat getConfirmedCount leest); de insert in assessment_responses geeft een id.
 */
function nepAdmin() {
  const writes = [];
  const from = (tabel) => {
    const k = {
      select() { return k; },
      insert(v) { k._insert = { tabel, v }; writes.push({ soort: 'insert', tabel, v }); return k; },
      update(v) { writes.push({ soort: 'update', tabel, v }); return k; },
      eq()  { return k; },
      in()  { return k; },
      or()  { return k; },
      not() { return k; },
      is()  { return k; },
      gt()  { return k; },
      limit() { return k; },
      order() { return k; },
      maybeSingle: async () => ({ data: k._insert ? { id: RESP_ID } : null, error: null }),
      then: (res, rej) => Promise.resolve(
        tabel === 'event_attendees'
          ? { data: [], error: null, count: huidig.bezet }
          : { data: [], error: null, count: 0 }
      ).then(res, rej),
    };
    return k;
  };
  return { writes, from };
}

const admin = nepAdmin();
mock.module(url('api/supabase.js'), {
  namedExports: { supabaseAdmin: admin, createUserClient: () => admin, checkCronAuth: () => ({ ok: true }) },
});
mock.module(url('api/_lib/event-vervolg.js'), {
  namedExports: {
    isUuid: (v) => typeof v === 'string' && v.length === 36,
    getAttendeeByToken: async () => huidig.attendee,
    getEvent: async (id) => ({
      id, title: 'Masterclass Gent', starts_at: '2026-09-19T17:00:00.000Z',
      ends_at: null, location: 'Gent', niveau: 'basis', capacity: huidig.capacity,
      status: 'published', signups_closed: false,
    }),
    getVervolgQuestionnaire: async () => ({ id: 'q-1' }),
  },
});
mock.module(url('api/_lib/assessment-validation.js'), {
  namedExports: {
    loadActiveQuestions: async () => ([{ key: 'v1', type: 'text', is_required: false }]),
    validateAnswers: () => ({ ok: true, errors: [], normalized: { v1: 'ja' } }),
  },
});
mock.module(url('api/_lib/event-attendee-mutations.js'), {
  namedExports: {
    onConfirmedAttendeeMutation: async () => ([]),
    onAttendeePlekChange: async () => ({ changed: false }),
    plekToestandGewijzigd: () => false,
    PLEK_SELECT: 'id',
  },
});
mock.module(url('api/_lib/events-bevestiging-send.js'), {
  namedExports: { sendEventAttendeeBevestiging: async () => ({ ok: true }) },
});
mock.module(url('api/_lib/event-website-berichten.js'), {
  namedExports: { reedsVerstuurd: async () => true, markeerVerstuurd: async () => {}, SOORTEN: { BEVESTIGING: 'bevestiging' } },
});

process.env.OPSTARTSESSIE_SECRET = 'geheim';
// Pas NA de mocks importeren: event-registration bindt supabaseAdmin op
// module-load, dus een statische import bovenaan zou de echte client pakken
// en getConfirmedCount stil 0 laten teruggeven.
const { isPlekBezet } = await import(url('api/_lib/event-registration.js'));
const finalize = (await import(url('api/event-vervolg-finalize.js'))).default;

async function roepFinalizeAan({ attendee, targetEventId = null, bezet = 8, capacity = 8 }) {
  huidig.attendee = attendee;
  huidig.bezet    = bezet;
  huidig.capacity = capacity;

  let payload = null;
  const res = {
    setHeader() {},
    status(code) { res._code = code; return res; },
    json(body) { payload = body; return res; },
  };
  await finalize(
    {
      method: 'POST',
      headers: { 'x-internal-token': 'geheim' },
      body: { t: TOKEN, answers: { v1: 'ja' }, ...(targetEventId ? { target_event_id: targetEventId } : {}) },
    },
    res
  );
  return { payload, code: res._code, admin };
}

const BEVESTIGD_ZONDER_VRAGENLIJST = {
  id: 'att-1', event_id: EVENT_ID, first_name: 'Pres', last_name: 'Uwadiae',
  email: 'pres@example.com', phone: '+32470000000', status: 'aangemeld',
  customer_id: null, source: 'website', choice_token: TOKEN,
  assessment_response_id: null, created_via: 'website',
  call_status: 'bevestigd', is_test: false,
};

test('cap 8, 8 bezet, deze persoon via bevestigd: zijn vragenlijst maakt hem definitief, niet "vol"', async () => {
  const { payload } = await roepFinalizeAan({ attendee: BEVESTIGD_ZONDER_VRAGENLIJST });
  assert.equal(payload.status, 'definitief', 'hij zit zélf in die 8 — dit is geen overboeking');
  assert.notEqual(payload.status, 'vol');
});

test('cap 8, 8 bezet, deze persoon NIET bevestigd: dan is het event wél vol', async () => {
  // De tegenproef. Zonder plek is de telling van 8 er één zonder hem, en dan
  // is er echt geen stoel meer.
  const { payload } = await roepFinalizeAan({
    attendee: { ...BEVESTIGD_ZONDER_VRAGENLIJST, call_status: null },
  });
  assert.equal(payload.status, 'vol');
});

test('verhuizen naar een ander vol event blijft "vol", ook met bevestigd op het huidige', async () => {
  // Zijn plek zit op zijn EIGEN event. Op het doel-event is die stoel nog niet
  // van hem, dus daar geldt de gewone capaciteitscheck onverkort.
  const { payload } = await roepFinalizeAan({
    attendee: BEVESTIGD_ZONDER_VRAGENLIJST,
    targetEventId: ANDER_EVENT,
  });
  assert.equal(payload.status, 'vol');
});

test('wachtlijst + bevestigd krijgt geen vrijstelling', async () => {
  // Bevestigd overrult de vragenlijst, niet de status. Wie op de wachtlijst
  // staat heeft geen plek en moet dus gewoon tegen 'vol' aanlopen.
  const { payload } = await roepFinalizeAan({
    attendee: { ...BEVESTIGD_ZONDER_VRAGENLIJST, status: 'wachtlijst' },
  });
  assert.equal(payload.status, 'vol');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · assessment-submit — de overflow-check bij de late-link
// ═══════════════════════════════════════════════════════════════════════════

test('de late-link-overflow slaat rijen over die al een plek innemen', () => {
  // De beslissing zelf is isPlekBezet op de gevonden rij. Dit is het scenario
  // uit de kop: cap 8, 8 bezet, deze rij is er één van via bevestigd.
  const rij = {
    id: 'att-2', event_id: EVENT_ID, status: 'aangemeld',
    call_status: 'bevestigd', is_test: false,
    // De late-link-lookup filtert op assessment_response_id IS NULL, dus die
    // is hier per definitie leeg.
    assessment_response_id: null,
  };
  assert.equal(isPlekBezet(rij), true, 'hij zit al in de telling van 8');

  // Zonder bevestiging telt hij nog niet mee en hoort de overflow-check wél te
  // draaien — dan gaat hij op de wachtlijst.
  assert.equal(isPlekBezet({ ...rij, call_status: null }), false);
  assert.equal(isPlekBezet({ ...rij, call_status: 'geen_gehoor' }), false);
});

test('de overflow-check in assessment-submit hangt aan die beslissing', () => {
  // Bedradings-bewaking: de guard mag niet stilletjes verdwijnen bij een
  // volgende bewerking van dit blok. De lookup moet call_status + is_test
  // meelezen, anders is isPlekBezet er blind voor.
  const bron = readFileSync(join(ROOT, 'api/assessment-submit.js'), 'utf8');
  const i = bron.indexOf('late-link lookup');
  assert.ok(i > 0);

  assert.match(bron, /select\('id, event_id, first_name, last_name, status, call_status, is_test,/,
    'de lookup leest call_status + is_test mee');
  assert.match(bron, /const neemtAlPlek = isPlekBezet\(att\);/);
  assert.match(bron, /att\.event_id && !neemtAlPlek\) \{/,
    'de overflow-check draait alleen voor rijen die nog GEEN plek innemen');
});
