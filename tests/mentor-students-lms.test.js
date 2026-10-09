// tests/mentor-students-lms.test.js — de studentbron van de mentor-endpoints
// komt sinds 9 okt 2026 uit het LMS (hlms_student), niet meer uit Bubble.
// Borgt: de studentsleutel (historisch id → anders LMS-id), de mapping, de
// e-mailbrug mentor ↔ hlms_personeel, de eigendomscheck, en dat een
// onbereikbaar LMS een FOUT is en geen lege lijst.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = (p) => pathToFileURL(path.resolve(process.cwd(), p)).href;

/** Minimale nep-databank met eq/in/or-filters. */
function nepDb(tabellen, { fout = null } = {}) {
  return {
    from(tabel) {
      const st = { filters: [] };
      const rijen = () => (tabellen[tabel] || []).filter((r) => st.filters.every((f) => f(r)));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(k, v) { st.filters.push((r) => r[k] === v); return q; },
        in(k, v) { st.filters.push((r) => v.includes(r[k])); return q; },
        or(expr) {
          const delen = expr.split(',').map((d) => d.split('.eq.'));
          st.filters.push((r) => delen.some(([k, v]) => String(r[k]) === v));
          return q;
        },
        maybeSingle: async () => (fout ? { data: null, error: fout } : { data: rijen()[0] ?? null, error: null }),
        then: (ok, nok) => Promise.resolve(fout ? { data: null, error: fout } : { data: rijen(), error: null }).then(ok, nok),
      };
      return q;
    },
  };
}

const MENTOR_UID = '11111111-1111-4111-8111-111111111111';
const PERS_DAVE  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERS_WIM   = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STU_OUD    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STU_NIEUW  = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function laad({ lmsFout = null, lmsWeg = false } = {}) {
  mock.restoreAll();
  const crm = nepDb({
    team_members: [{ id: 'tm-1', user_id: MENTOR_UID, email: 'Dave@DeForexOpleiding.nl', is_active: true }],
  });
  const lms = nepDb({
    hlms_personeel: [
      { id: PERS_DAVE, email: 'dave@deforexopleiding.nl', actief: true, naam: 'Dave' },
      { id: PERS_WIM,  email: 'wim@deforexopleiding.nl',  actief: true, naam: 'Wim' },
    ],
    hlms_student: [
      { id: STU_OUD,   mentor_id: PERS_DAVE, voornaam: 'Oud', achternaam: 'Student', email: 'oud@x.nl',
        bubble_user_id: '1700000000000x123', calls_startsaldo: 10, calls_totaal: 24, eind_datum: '2099-01-01' },
      { id: STU_NIEUW, mentor_id: PERS_DAVE, voornaam: 'Nieuw', achternaam: '', email: 'Nieuw@x.nl',
        bubble_user_id: null, calls_startsaldo: 0, calls_totaal: 48, eind_datum: '2000-01-01' },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', mentor_id: PERS_WIM, email: 'ander@x.nl', bubble_user_id: null },
    ],
    hlms_sessie: [
      { student_id: STU_OUD, status: 'afgerond', duur_minuten: 45 },
      { student_id: STU_OUD, status: 'afgerond', duur_minuten: 90 },
      { student_id: STU_OUD, status: 'no_show',  duur_minuten: 45 },
    ],
  }, { fout: lmsFout });
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: crm, createUserClient: () => ({}) } });
  mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => (lmsWeg ? null : lms) } });
  return import(url('api/_lib/mentorStudents.js') + '?t=' + Math.random());
}

test('STUDENTSLEUTEL: historisch id als het er is, anders het LMS-id', async () => {
  const m = await laad();
  assert.equal(m.studentSleutel({ id: 'lms-1', bubble_user_id: '170x9' }), '170x9');
  assert.equal(m.studentSleutel({ id: 'lms-1', bubble_user_id: null }), 'lms-1');
  assert.equal(m.studentSleutel({ id: 'lms-1', bubble_user_id: '  ' }), 'lms-1');
});

test('MENTOR → STUDENTEN via de e-mailbrug, met de sessieteller van het LMS', async () => {
  const m = await laad();
  const { linked, students } = await m.getMentorStudents(MENTOR_UID);
  assert.equal(linked, true);
  assert.equal(students.length, 2, 'alleen de studenten van Dave, niet die van Wim');
  const oud = students.find((s) => s.lms_student_id === STU_OUD);
  assert.equal(oud.student_id, '1700000000000x123');
  // startsaldo 10 + afgerond 1 + 2 (90 min) + no-show 1 = 14
  assert.equal(oud.calls_1on1_done, 14);
  assert.equal(oud.calls_1on1_total, 24);
  assert.equal(oud.no_shows, 1);
  assert.equal(oud.archived, false);
  const nieuw = students.find((s) => s.lms_student_id === STU_NIEUW);
  assert.equal(nieuw.student_id, STU_NIEUW);
  assert.equal(nieuw.email, 'nieuw@x.nl', 'e-mail in kleine letters');
  assert.equal(nieuw.archived, true, 'toegang verlopen = gearchiveerd');
});

test('EIGENDOM: eigen student ok (op oud id én op LMS-id), andermans student niet', async () => {
  const m = await laad();
  assert.equal((await m.isStudentVanMentor(MENTOR_UID, '1700000000000x123')).ok, true);
  assert.equal((await m.isStudentVanMentor(MENTOR_UID, STU_NIEUW)).ok, true);
  const ander = await m.isStudentVanMentor(MENTOR_UID, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  assert.equal(ander.ok, false);
  assert.match(ander.reden, /hoort niet bij deze mentor/);
  const weg = await m.isStudentVanMentor(MENTOR_UID, '9999999999999x999');
  assert.equal(weg.ok, false);
  assert.match(weg.reden, /niet gevonden/);
});

test('ONBEREIKBAAR LMS is een fout (503), nooit een lege lijst', async () => {
  const m = await laad({ lmsFout: { message: 'connection refused' } });
  await assert.rejects(() => m.getMentorStudents(MENTOR_UID), (e) => e.code === 'DFO_LMS_ONBEREIKBAAR');
  const m2 = await laad({ lmsWeg: true });
  await assert.rejects(() => m2.getMentorStudents(MENTOR_UID), (e) => m2.httpStatusVoor(e) === 503);
});

test('E-MAIL → MENTORNAAM voor sales-retention', async () => {
  const m = await laad();
  const map = await m.getStudentMentorNaamMap();
  assert.equal(map.get('oud@x.nl'), 'Dave');
  assert.equal(map.get('ander@x.nl'), 'Wim');
});
