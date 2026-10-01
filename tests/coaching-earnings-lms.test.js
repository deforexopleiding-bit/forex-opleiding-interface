// tests/coaching-earnings-lms.test.js
//
// Mentorrapporten (coaching) lezen uit het LMS (hlms_sessie) i.p.v. Bubble.
// Borgt: Brusselse maandgrenzen, exacte dubbels 1×, opeenvolgende sessies 2×,
// Bubble-ontdubbeling tegen het LMS, geen Bubble vanaf oktober 2026, en
// vooral: een onbereikbare bron wordt NOOIT stil 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCoachingEarnings,
  brusselsMiddernachtMs,
  brusselsDag,
  LMS_TEAMTRAINING_KOLOM_ONTBREEKT,
} from '../api/_lib/coaching-earnings.js';

const MENTOR = '11111111-1111-1111-1111-111111111111';
const ANDER  = '22222222-2222-2222-2222-222222222222';
const BUBBLE_MENTOR = 'bub-mentor-1';

/**
 * Mini-nabootsing van een supabase-client die de filters ECHT toepast op
 * in-memory rijen, zodat het venster en de mentor-filter getest worden.
 * Een tabelwaarde mag een fout-object { message, code } zijn.
 */
function nepDb(tabellen = {}, { log } = {}) {
  return {
    from(tabel) {
      const filters = [];
      let bereik = null;
      let head = false;
      const keten = {
        select: (_k, opt) => { if (opt?.head) head = true; return keten; },
        eq: (k, v) => { filters.push((r) => r[k] === v); return keten; },
        in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return keten; },
        gte: (k, v) => { filters.push((r) => cmp(r[k], v) >= 0); return keten; },
        lte: (k, v) => { filters.push((r) => cmp(r[k], v) <= 0); return keten; },
        lt: (k, v) => { filters.push((r) => cmp(r[k], v) < 0); return keten; },
        order: () => keten,
        range: (a, b) => { bereik = [a, b]; return keten; },
        then: (resolve, reject) => {
          if (log) log.push(tabel);
          const bron = tabellen[tabel];
          let uit;
          if (bron && !Array.isArray(bron)) uit = { data: null, error: bron, count: null };
          else {
            let rijen = (bron || []).filter((r) => filters.every((f) => f(r)));
            const count = rijen.length;
            if (bereik) rijen = rijen.slice(bereik[0], bereik[1] + 1);
            uit = head ? { data: null, error: null, count } : { data: rijen, error: null, count };
          }
          return Promise.resolve(uit).then(resolve, reject);
        },
      };
      return keten;
    },
  };
}

function cmp(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && /T/.test(String(a)) && /T/.test(String(b))) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

let _id = 0;
const sessie = (o) => ({ id: 's' + (++_id), student_id: 'stu-1', mentor_id: MENTOR, status: 'afgerond', ...o });

const crm = () => nepDb({ mentor_funded_certificates: [] });
const geenBubble = async () => { throw new Error('Bubble mag hier niet bevraagd worden'); };

async function reken({ lms, bubbleList = geenBubble, from = '2026-10-01', to = '2026-10-31', bubbleUserId = null }) {
  return computeCoachingEarnings(
    { bubbleUserId, mentorUserId: MENTOR, from, to },
    { lmsClient: lms, bubbleList, crmClient: crm() },
  );
}

// ── Brusselse tijd ─────────────────────────────────────────────────────

test('Brusselse middernacht is DST-correct', () => {
  assert.equal(new Date(brusselsMiddernachtMs('2026-09-01')).toISOString(), '2026-08-31T22:00:00.000Z'); // zomertijd
  assert.equal(new Date(brusselsMiddernachtMs('2026-11-01')).toISOString(), '2026-10-31T23:00:00.000Z'); // wintertijd
  assert.equal(new Date(brusselsMiddernachtMs('2026-10-25')).toISOString(), '2026-10-24T22:00:00.000Z'); // dag van omschakeling
  assert.equal(brusselsDag('2026-09-30T22:30:00.000Z'), '2026-10-01');
});

test('maandgrens: 30/9 23:30 Brussel hoort bij september, 1/10 00:30 bij oktober', async () => {
  const rijen = [
    sessie({ student_id: 'a', start_tijd: '2026-09-30T21:30:00.000Z' }), // 30/9 23:30 lokaal
    sessie({ student_id: 'b', start_tijd: '2026-09-30T22:30:00.000Z' }), // 1/10 00:30 lokaal
    sessie({ student_id: 'c', start_tijd: '2026-08-31T22:30:00.000Z' }), // 1/9 00:30 lokaal
    sessie({ student_id: 'd', start_tijd: '2026-08-31T21:30:00.000Z' }), // 31/8 23:30 lokaal
  ];
  const lms = nepDb({ hlms_sessie: rijen, hlms_teamtraining_trainer: [], hlms_student: [] });
  const sep = await reken({ lms, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(sep.breakdown.one_on_one.count, 2, 'a (30/9 23:30) en c (1/9 00:30)');
  const okt = await reken({ lms, from: '2026-10-01', to: '2026-10-31' });
  assert.equal(okt.breakdown.one_on_one.count, 1, 'b (1/10 00:30)');
});

// ── Telregels LMS ──────────────────────────────────────────────────────

test('exacte dubbel (zelfde student + start_tijd + mentor) telt één keer', async () => {
  const t = '2026-10-15T13:00:00.000Z';
  const lms = nepDb({
    hlms_sessie: [sessie({ start_tijd: t }), sessie({ start_tijd: t })],
    hlms_teamtraining_trainer: [],
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.one_on_one.count, 1);
  assert.equal(r.breakdown.one_on_one.total, 35);
  assert.equal(r._meta.lms_exacte_dubbels, 1);
});

test('opeenvolgende sessies op dezelfde dag (andere starttijd) tellen allebei', async () => {
  const lms = nepDb({
    hlms_sessie: [
      sessie({ start_tijd: '2026-10-15T13:00:00.000Z' }),
      sessie({ start_tijd: '2026-10-15T14:00:00.000Z' }),
    ],
    hlms_teamtraining_trainer: [],
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.one_on_one.count, 2);
  assert.equal(r._meta.lms_exacte_dubbels, 0);
});

test('alleen afgerond/no_show van DEZE mentor tellen; gepland/geannuleerd en andere mentor niet', async () => {
  const lms = nepDb({
    hlms_sessie: [
      sessie({ start_tijd: '2026-10-02T10:00:00.000Z' }),
      sessie({ start_tijd: '2026-10-03T10:00:00.000Z', status: 'no_show' }),
      sessie({ start_tijd: '2026-10-04T10:00:00.000Z', status: 'gepland' }),
      sessie({ start_tijd: '2026-10-05T10:00:00.000Z', status: 'geannuleerd' }),
      sessie({ start_tijd: '2026-10-06T10:00:00.000Z', mentor_id: ANDER }),
    ],
    hlms_teamtraining_trainer: [],
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.one_on_one.count, 1);
  assert.equal(r.breakdown.no_show.count, 1);
  assert.equal(r.grand_total, 35 + 25);
  assert.deepEqual(r._meta.bronnen.lms, { status: 'gelezen', afgerond: 1, no_show: 1, team: 0 });
});

test('LMS-paginatie: meer dan 1000 sessies worden allemaal geteld', async () => {
  const rijen = [];
  const basis = Date.parse('2026-10-02T08:00:00.000Z');
  for (let i = 0; i < 1203; i++) rijen.push(sessie({ student_id: 'p' + i, start_tijd: new Date(basis + i * 60000).toISOString() }));
  const lms = nepDb({ hlms_sessie: rijen, hlms_teamtraining_trainer: [] });
  const r = await reken({ lms });
  assert.equal(r.breakdown.one_on_one.count, 1203);
});

// ── Teamtraining LMS ───────────────────────────────────────────────────

test('teamtraining: alleen gegeven, in venster, met deze mentor als trainer', async () => {
  const lms = nepDb({
    hlms_sessie: [],
    hlms_teamtraining_trainer: [
      { training_id: 't1', personeel_id: MENTOR }, { training_id: 't2', personeel_id: MENTOR },
      { training_id: 't3', personeel_id: MENTOR }, { training_id: 't4', personeel_id: ANDER },
    ],
    hlms_teamtraining: [
      { id: 't1', start_tijd: '2026-10-10T17:00:00.000Z', status: 'gegeven' },
      { id: 't2', start_tijd: '2026-10-11T17:00:00.000Z', status: 'niet_doorgegaan' },
      { id: 't3', start_tijd: '2026-11-01T17:00:00.000Z', status: 'gegeven' },
      { id: 't4', start_tijd: '2026-10-12T17:00:00.000Z', status: 'gegeven' },
    ],
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.team.count, 1);
  assert.equal(r.breakdown.team.total, 50);
  assert.equal(r._meta.lms_teamtraining, 'gelezen');
});

test('ontbrekende teamtraining-stand (42703) → team 0 met benoemde meta, geen crash', async () => {
  const lms = nepDb({
    hlms_sessie: [sessie({ start_tijd: '2026-10-02T10:00:00.000Z' })],
    hlms_teamtraining_trainer: [{ training_id: 't1', personeel_id: MENTOR }],
    hlms_teamtraining: { code: '42703', message: 'column hlms_teamtraining.status does not exist' },
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.team.count, 0);
  assert.equal(r._meta.lms_teamtraining, LMS_TEAMTRAINING_KOLOM_ONTBREEKT);
  assert.equal(r.breakdown.one_on_one.count, 1, 'de rest telt gewoon');
});

test('andere teamtraining-fout → throw (geen 0)', async () => {
  const lms = nepDb({
    hlms_sessie: [],
    hlms_teamtraining_trainer: [{ training_id: 't1', personeel_id: MENTOR }],
    hlms_teamtraining: { code: '57014', message: 'canceling statement due to statement timeout' },
  });
  await assert.rejects(reken({ lms }), (e) => e.code === 'LMS_ONBEREIKBAAR');
});

// ── Faalgedrag ─────────────────────────────────────────────────────────

test('LMS onbereikbaar → throw, nooit stil 0', async () => {
  const lms = nepDb({ hlms_sessie: { message: 'connection reset' } });
  await assert.rejects(reken({ lms }), (e) => e.code === 'LMS_ONBEREIKBAAR' && /connection reset/.test(e.message));
});

test('LMS niet geconfigureerd → throw', async () => {
  const oud = { u: process.env.DFO_LMS_SUPABASE_URL, k: process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.DFO_LMS_SUPABASE_URL; delete process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY;
  try {
    await assert.rejects(
      computeCoachingEarnings({ mentorUserId: MENTOR, from: '2026-10-01', to: '2026-10-31' }, { crmClient: crm() }),
      (e) => e.code === 'LMS_NIET_GECONFIGUREERD',
    );
  } finally {
    if (oud.u !== undefined) process.env.DFO_LMS_SUPABASE_URL = oud.u;
    if (oud.k !== undefined) process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY = oud.k;
  }
});

test('Bubble nodig (september) en onbereikbaar → throw', async () => {
  const lms = nepDb({ hlms_sessie: [], hlms_teamtraining_trainer: [], hlms_student: [] });
  const kapot = async () => { const e = new Error('Bubble 500'); e.code = 'BUBBLE_HTTP_500'; throw e; };
  await assert.rejects(
    reken({ lms, bubbleList: kapot, bubbleUserId: BUBBLE_MENTOR, from: '2026-09-01', to: '2026-09-30' }),
    /Bubble onbereikbaar/,
  );
});

// ── Bubble-tak ─────────────────────────────────────────────────────────

test('oktober bevraagt Bubble niet, ook met bubble-koppeling', async () => {
  let bevraagd = 0;
  const lms = nepDb({ hlms_sessie: [sessie({ start_tijd: '2026-10-02T10:00:00.000Z' })], hlms_teamtraining_trainer: [] });
  const r = await reken({ lms, bubbleUserId: BUBBLE_MENTOR, bubbleList: async () => { bevraagd++; return { results: [] }; } });
  assert.equal(bevraagd, 0);
  assert.equal(r._meta.bronnen.bubble.status, 'niet-van-toepassing');
  assert.equal(r.breakdown.one_on_one.count, 1);
});

function bubbleSessie(o) {
  return {
    'Created By': BUBBLE_MENTOR,
    learn_type1_option_os___learning_type: 'Alpha Program',
    isdone_boolean: true, noshow_boolean: false,
    member_user: 'bub-stu-1', ...o,
  };
}

test('september: Bubble telt mee, maar niet als dezelfde student die dag in het LMS staat', async () => {
  const lms = nepDb({
    hlms_sessie: [
      // LMS-sessie van een ANDERE mentor op 5/9 voor bub-stu-1 → Bubble 5/9 vervalt.
      sessie({ mentor_id: ANDER, student_id: 'lms-stu-1', start_tijd: '2026-09-05T08:00:00.000Z' }),
      // Eigen LMS-sessie 20/9.
      sessie({ student_id: 'lms-stu-2', start_tijd: '2026-09-20T08:00:00.000Z' }),
    ],
    hlms_student: [
      { id: 'lms-stu-1', bubble_user_id: 'bub-stu-1' },
      { id: 'lms-stu-2', bubble_user_id: 'bub-stu-2' },
    ],
    hlms_teamtraining_trainer: [],
  });
  const bubbleRows = [
    bubbleSessie({ starting_date_date: '2026-09-05T14:00:00.000Z' }),                         // dubbel → overslaan
    bubbleSessie({ starting_date_date: '2026-09-03T14:00:00.000Z' }),                         // telt
    bubbleSessie({ starting_date_date: '2026-09-04T14:00:00.000Z', noshow_boolean: true, member_user: null }), // no-show zonder member telt
    bubbleSessie({ starting_date_date: '2026-09-06T14:00:00.000Z', member_user: null }),      // orphan call telt niet
    bubbleSessie({ starting_date_date: '2026-09-07T14:00:00.000Z', learn_type1_option_os___learning_type: 'Gamma' }), // telt niet
    bubbleSessie({ starting_date_date: '2026-09-30T22:30:00.000Z' }),                         // 1/10 lokaal → buiten Bubble-venster
  ];
  const bubbleList = async (type) => (type === '1-1-session'
    ? { results: bubbleRows }
    : { results: [{ isdone_boolean: true, completeddate_date: '2026-09-10T10:00:00.000Z' }] });
  const r = await reken({ lms, bubbleList, bubbleUserId: BUBBLE_MENTOR, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r._meta.bubble_overgeslagen_dubbel_met_lms, 1);
  assert.deepEqual(r._meta.bronnen.bubble, { status: 'gelezen', calls: 1, no_show: 1, team: 1 });
  assert.deepEqual(r._meta.bronnen.lms, { status: 'gelezen', afgerond: 1, no_show: 0, team: 0 });
  assert.equal(r.breakdown.one_on_one.count, 2);
  assert.equal(r.breakdown.no_show.count, 1);
  assert.equal(r.breakdown.team.count, 1);
  assert.equal(r.grand_total, 2 * 35 + 25 + 50);
});

test('zonder bubble-koppeling: alleen LMS, ook in september', async () => {
  const lms = nepDb({ hlms_sessie: [sessie({ start_tijd: '2026-09-10T10:00:00.000Z' })], hlms_teamtraining_trainer: [] });
  const r = await reken({ lms, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r._meta.bronnen.bubble.status, 'geen-bubble-koppeling');
  assert.equal(r.breakdown.one_on_one.count, 1);
});

test('funded-telling faalt → throw (geen stille 0)', async () => {
  const lms = nepDb({ hlms_sessie: [], hlms_teamtraining_trainer: [] });
  await assert.rejects(
    computeCoachingEarnings(
      { mentorUserId: MENTOR, from: '2026-10-01', to: '2026-10-31' },
      { lmsClient: lms, crmClient: nepDb({ mentor_funded_certificates: { message: 'timeout' } }) },
    ),
    /funded/,
  );
});

// ── payout-generate-core: geen stille 0 meer ───────────────────────────

test('payout-generate-core vangt coachingfouten niet meer af en rekent vóór elke schrijfactie', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/_lib/payout-generate-core.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /coaching faalde/, 'oude catch → 0 is weg');
  assert.doesNotMatch(src, /if \(bubbleUserId\) \{/, 'coaching niet meer afhankelijk van bubble-id');
  const coachIdx  = src.indexOf('await computeCoachingEarnings(');
  const unlinkIdx = src.indexOf(".update({ payout_id: null })");
  assert.ok(coachIdx > 0 && unlinkIdx > 0 && coachIdx < unlinkIdx, 'coaching vóór ledger-unlink');
});
