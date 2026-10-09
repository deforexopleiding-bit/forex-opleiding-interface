// tests/coaching-earnings-lms.test.js
//
// Mentorrapporten (coaching) lezen uit het LMS (hlms_sessie) i.p.v. Bubble.
// Borgt: Brusselse maandgrenzen, sessie-eenheden van 45 min (90 min = 2, zoals
// de studentteller in het LMS), zelfde-moment-rijen tellen elk + signaal,
// opeenvolgende sessies 2×,
// geen Bubble meer (dicht sinds oktober 2026: vóór oktober alleen het
// LMS-deel, mét melding), en vooral: een onbereikbare bron wordt NOOIT stil 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCoachingEarnings,
  brusselsMiddernachtMs,
  brusselsDag,
  eenhedenVan,
  coachingRegelLabel,
  LMS_TEAMTRAINING_KOLOM_ONTBREEKT,
} from '../api/_lib/coaching-earnings.js';

const MENTOR = '11111111-1111-1111-1111-111111111111';
const ANDER  = '22222222-2222-2222-2222-222222222222';

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
async function reken({ lms, from = '2026-10-01', to = '2026-10-31' }) {
  return computeCoachingEarnings(
    { mentorUserId: MENTOR, from, to },
    { lmsClient: lms, crmClient: crm() },
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

test('eenhedenVan: max(1, round(duur / 45)), null/0 → 45', () => {
  const gevallen = [[45, 1], [60, 1], [30, 1], [90, 2], [135, 3], [180, 4], [null, 1], [0, 1]];
  for (const [duur, verwacht] of gevallen) assert.equal(eenhedenVan(duur), verwacht, `duur ${duur}`);
  assert.equal(eenhedenVan(undefined), 1);
});

test('90 min afgerond = 2 × €35, 90 min no-show = 2 × €25, 60 min = 1', async () => {
  const lms = nepDb({
    hlms_sessie: [
      sessie({ start_tijd: '2026-10-02T10:00:00.000Z', duur_minuten: 90 }),
      sessie({ start_tijd: '2026-10-03T10:00:00.000Z', duur_minuten: 90, status: 'no_show' }),
      sessie({ start_tijd: '2026-10-04T10:00:00.000Z', duur_minuten: 60 }),
      sessie({ start_tijd: '2026-10-05T10:00:00.000Z', duur_minuten: 45 }),
      sessie({ start_tijd: '2026-10-06T10:00:00.000Z', duur_minuten: null }),
    ],
    hlms_teamtraining_trainer: [],
  });
  const r = await reken({ lms });
  assert.deepEqual(r.breakdown.one_on_one, {
    count: 5, rate: 35, total: 5 * 35, afspraken: 4, meervoudig: 1, meervoudig_per_eenheden: { 2: 1 },
  });
  assert.deepEqual(r.breakdown.no_show, {
    count: 2, rate: 25, total: 2 * 25, afspraken: 1, meervoudig: 1, meervoudig_per_eenheden: { 2: 1 },
  });
  assert.equal(r.grand_total, 5 * 35 + 2 * 25);
  assert.equal(r._meta.bronnen.lms.afgerond, 5, 'bronnen telt eenheden');
  assert.deepEqual(r._meta.bronnen.lms.afspraken, { afgerond: 4, no_show: 1 });
});

test('payoutregel-label noemt meervoudige afspraken, anders het gewone label', () => {
  assert.equal(coachingRegelLabel('1-op-1 sessies', { afspraken: 28, meervoudig_per_eenheden: {} }), '1-op-1 sessies');
  assert.equal(
    coachingRegelLabel('1-op-1 sessies', { afspraken: 86, meervoudig_per_eenheden: { 2: 5 } }),
    '1-op-1 sessies à 45 min (86 afspraken, waarvan 5 van 90 min)',
  );
  assert.equal(
    coachingRegelLabel('No-shows', { afspraken: 4, meervoudig_per_eenheden: { 3: 1, 2: 2 } }),
    'No-shows à 45 min (4 afspraken, waarvan 2 van 90 min en 1 van 135 min)',
  );
});

test('zelfde student + start_tijd + mentor telt twee keer, met signaal', async () => {
  const t = '2026-10-15T13:00:00.000Z';
  const lms = nepDb({
    hlms_sessie: [sessie({ start_tijd: t }), sessie({ start_tijd: t, status: 'no_show' }), sessie({ start_tijd: t })],
    hlms_teamtraining_trainer: [],
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.one_on_one.count, 2);
  assert.equal(r.breakdown.no_show.count, 1);
  assert.equal(r.grand_total, 2 * 35 + 25);
  assert.deepEqual(r._meta.lms_zelfde_moment, [{ student_id: 'stu-1', start_tijd: t, rijen: 3 }]);
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
  assert.deepEqual(r._meta.lms_zelfde_moment, []);
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
  const { status, afgerond, no_show, team } = r._meta.bronnen.lms;
  assert.deepEqual({ status, afgerond, no_show, team }, { status: 'gelezen', afgerond: 1, no_show: 1, team: 0 });
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

// ── Bubble is dicht ────────────────────────────────────────────────────

test('oktober: geen melding, oude bron niet van toepassing', async () => {
  const lms = nepDb({ hlms_sessie: [sessie({ start_tijd: '2026-10-02T10:00:00.000Z' })], hlms_teamtraining_trainer: [] });
  const r = await reken({ lms });
  assert.equal(r._meta.bronnen.oud_lms.status, 'niet-van-toepassing');
  assert.equal(r._meta.melding, undefined);
  assert.equal(r.breakdown.one_on_one.count, 1);
});

test('september: alleen het LMS-deel, mét melding — en NIETS naar Bubble', async () => {
  const lms = nepDb({ hlms_sessie: [sessie({ start_tijd: '2026-09-10T10:00:00.000Z' })], hlms_teamtraining_trainer: [] });
  const r = await reken({ lms, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r._meta.bronnen.oud_lms.status, 'gesloten');
  assert.match(r._meta.melding, /vóór 1 oktober 2026/);
  assert.equal(r.breakdown.one_on_one.count, 1);
  assert.equal(r._meta.bronnen.bubble, undefined);
});

test('de helper kent geen Bubble meer (geen import, geen aanroep)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/_lib/coaching-earnings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/bubble\.js'/);
  assert.doesNotMatch(src, /bubbleList|bubbleUserId/);
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
  assert.doesNotMatch(src, /bubbleUserId/, 'coaching niet meer afhankelijk van bubble-id');
  const coachIdx  = src.indexOf('await computeCoachingEarnings(');
  const unlinkIdx = src.indexOf(".update({ payout_id: null })");
  assert.ok(coachIdx > 0 && unlinkIdx > 0 && coachIdx < unlinkIdx, 'coaching vóór ledger-unlink');
});

// ── Intakes (sinds 5 oktober 2026) ─────────────────────────────────────

test('intake: ¼ sessie per GOEDGEKEURDE intake van DEZE mentor in het venster — geen sessie', async () => {
  const { RATE_INTAKE, intakeRegelLabel } = await import('../api/_lib/coaching-earnings.js');
  const lms = nepDb({
    hlms_sessie: [sessie({ start_tijd: '2026-10-10T10:00:00Z', duur_minuten: 45 })],
    hlms_intake: [
      { crm_onboarding_id: 'a', afgerond_door: MENTOR, afgerond_op: '2026-10-01T09:00:00Z', goedgekeurd_op: '2026-10-02T09:00:00Z' },
      { crm_onboarding_id: 'b', afgerond_door: MENTOR, afgerond_op: '2026-10-20T09:00:00Z', goedgekeurd_op: '2026-10-20T10:00:00Z' },
      { crm_onboarding_id: 'c', afgerond_door: ANDER,  afgerond_op: '2026-10-20T09:00:00Z', goedgekeurd_op: '2026-10-20T10:00:00Z' },
      // Goedgekeurd 30/9 23:30 Brussel: buiten het venster, ook al ...
      { crm_onboarding_id: 'd', afgerond_door: MENTOR, afgerond_op: '2026-09-30T20:00:00Z', goedgekeurd_op: '2026-09-30T21:30:00Z' },
      // "Intake klaar" maar nog NIET goedgekeurd: telt niet (Maxim, 6 okt).
      { crm_onboarding_id: 'e', afgerond_door: MENTOR, afgerond_op: '2026-10-05T09:00:00Z', goedgekeurd_op: null },
      // Klaar in september, goedgekeurd in oktober: telt in oktober.
      { crm_onboarding_id: 'f', afgerond_door: MENTOR, afgerond_op: '2026-09-29T09:00:00Z', goedgekeurd_op: '2026-10-03T09:00:00Z' },
    ],
  });
  const r = await reken({ lms });
  assert.equal(RATE_INTAKE, 8.75);
  assert.equal(4 * RATE_INTAKE, 35, 'vier intakes = één sessie');
  assert.equal(r.breakdown.intake.count, 3);
  assert.equal(r.breakdown.intake.total, 26.25);
  assert.equal(r.breakdown.one_on_one.count, 1, 'een intake verbruikt geen sessie');
  assert.equal(r.grand_total, 35 + 26.25);
  assert.equal(r._meta.lms_intake, 'gelezen');
  assert.equal(intakeRegelLabel(2), 'Intakes: 2 × 0,25');
});

test('intake: goedgekeurd_op bestaat nog niet (migratie) → 0 met benoemde meta, geen crash', async () => {
  const { LMS_INTAKE_GOEDKEURING_ONTBREEKT } = await import('../api/_lib/coaching-earnings.js');
  const lms = nepDb({
    hlms_sessie: [sessie({ start_tijd: '2026-10-10T10:00:00Z' })],
    hlms_intake: { code: '42703', message: 'column hlms_intake.goedgekeurd_op does not exist' },
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.intake.count, 0);
  assert.equal(r._meta.lms_intake, LMS_INTAKE_GOEDKEURING_ONTBREEKT);
});

test('intake: tabel bestaat nog niet → 0 met benoemde meta, geen crash', async () => {
  const { LMS_INTAKE_TABEL_ONTBREEKT } = await import('../api/_lib/coaching-earnings.js');
  const lms = nepDb({
    hlms_sessie: [sessie({ start_tijd: '2026-10-10T10:00:00Z' })],
    hlms_intake: { code: 'PGRST205', message: "Could not find the table 'public.hlms_intake' in the schema cache" },
  });
  const r = await reken({ lms });
  assert.equal(r.breakdown.intake.count, 0);
  assert.equal(r._meta.lms_intake, LMS_INTAKE_TABEL_ONTBREEKT);
  assert.equal(r.grand_total, 35);
});

test('intake: andere fout → throw (geen stille 0)', async () => {
  const lms = nepDb({ hlms_sessie: [], hlms_intake: { code: '57014', message: 'canceling statement due to statement timeout' } });
  await assert.rejects(() => reken({ lms }), (e) => e.code === 'LMS_ONBEREIKBAAR');
});

// ── Oude maanden in de payout: snapshot, nooit opnieuw rekenen ─────────

test('payout-generate-core rekent maanden vóór oktober 2026 niet opnieuw uit', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/_lib/payout-generate-core.js', import.meta.url), 'utf8');
  const guard = src.indexOf('period.start < OUDE_BRON_EINDE');
  const coach = src.indexOf('await computeCoachingEarnings(');
  assert.ok(guard > 0 && guard < coach, 'eerst de oude-maand-check, dan pas rekenen');
  assert.match(src, /err\.code = 'OUDE_PERIODE'/, 'zonder bestaand concept: duidelijke fout, geen te laag bedrag');
  assert.match(src, /startsWith\('coaching_'\)/, 'met concept: de opgeslagen coachingregels hergebruiken');
});
