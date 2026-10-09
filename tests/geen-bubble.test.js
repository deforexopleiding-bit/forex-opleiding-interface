// tests/geen-bubble.test.js — het CRM draait zonder Bubble (Maxim, 9 okt 2026:
// Bubble gaat dicht; het LMS is de bron voor studenten, mentoren en sessies).
//
// Twee bewijzen:
//   1. STATISCH — in api/ en modules/ staat geen enkele aanroep naar Bubble
//      meer: geen import van een Bubble-client, geen bubbleList/Get/Patch/
//      Workflow, geen BUBBLE_*-omgevingsvariabele, geen Bubble-domein.
//      (Wat wél mag: de DB-kolommen bubble_user_id / bubble_student_id als
//      historische koppelsleutel, en commentaar.)
//   2. DYNAMISCH — de belangrijkste endpoints die vroeger Bubble lazen,
//      draaien met BUBBLE_API_ROOT en BUBBLE_API_TOKEN LEEG en geven 200 met
//      data (geen 5xx, geen lege lijst waar data hoort). Databanken zijn nep.

import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.cwd();
const url = (p) => pathToFileURL(path.resolve(ROOT, p)).href;

function bestanden(dir, uit = []) {
  for (const n of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, n);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) bestanden(rel, uit);
    else if (/\.(js|mjs|html)$/.test(n)) uit.push(rel);
  }
  return uit;
}

// Alleen uitvoerbare regels: commentaarregels vallen weg.
function codeRegels(bron) {
  return bron.split('\n')
    .map((r, i) => ({ r, i: i + 1 }))
    .filter(({ r }) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(r));
}

const VERBODEN = [
  /\bbubble(List|Get|Patch|Workflow|FindUserByEmail|UserDisplay|Request)\b/,
  /['"][./]*(_lib\/)?bubble(-1on1|-one-on-one-count|StudentMentors)?\.js['"]/,
  /\bBUBBLE_(API_ROOT|API_TOKEN|WF_SECRET|LOGIN_URL|CREDENTIALS_MAIL)\b/,
  /bubbleapps\.io|bubble\.io\/|dashboard\.deforexopleiding\.nl/,
  /\/api\/(bubble-[a-z-]+|mentor-bubble-link|team-members-bubble-status|onboarding-provision-retry|student-archive)\b/,
];

test('STATISCH: geen enkele uitvoerbare Bubble-aanroep in api/ en modules/', () => {
  const treffers = [];
  for (const f of [...bestanden('api'), ...bestanden('modules')]) {
    for (const { r, i } of codeRegels(readFileSync(path.join(ROOT, f), 'utf8'))) {
      if (VERBODEN.some((re) => re.test(r))) treffers.push(`${f}:${i}: ${r.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(treffers, [], 'Bubble-verwijzingen gevonden:\n' + treffers.join('\n'));
});

test('STATISCH: de Bubble-crons staan niet meer in vercel.json', () => {
  const v = readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  assert.doesNotMatch(v, /first-call-payment-reminder|archive-completed-onboardings/);
});

// ── Dynamisch ─────────────────────────────────────────────────────────────

/** Nep-databank met de filters die de endpoints gebruiken. */
function nepDb(tabellen) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: MENTOR_UID } } }) },
    from(tabel) {
      const st = { f: [] };
      const rijen = () => (tabellen[tabel] || []).filter((r) => st.f.every((fn) => fn(r)));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(k, v) { st.f.push((r) => r[k] === v); return q; },
        neq(k, v) { st.f.push((r) => r[k] !== v); return q; },
        in(k, v) { st.f.push((r) => v.includes(r[k])); return q; },
        gte(k, v) { st.f.push((r) => String(r[k]) >= String(v)); return q; },
        gt(k, v) { st.f.push((r) => String(r[k]) > String(v)); return q; },
        lte(k, v) { st.f.push((r) => String(r[k]) <= String(v)); return q; },
        lt(k, v) { st.f.push((r) => String(r[k]) < String(v)); return q; },
        is(k, v) { st.f.push((r) => (r[k] ?? null) === v); return q; },
        not() { return q; }, ilike() { return q; },
        or(expr) {
          if (/\.eq\./.test(expr) && !/ilike/.test(expr)) {
            const delen = expr.split(',').map((d) => d.split('.eq.'));
            st.f.push((r) => delen.some(([k, v]) => String(r[k]) === v));
          }
          return q;
        },
        maybeSingle: async () => ({ data: rijen()[0] ?? null, error: null }),
        single: async () => ({ data: rijen()[0] ?? null, error: null }),
        then: (ok, nok) => Promise.resolve({ data: rijen(), error: null, count: rijen().length }).then(ok, nok),
      };
      return q;
    },
  };
}

const MENTOR_UID = '11111111-1111-4111-8111-111111111111';
// In productie is hlms_personeel.id gelijk aan het CRM-gebruikers-id (zie
// docs/mentorrapport-bron-lms.md); de e-mailbrug vindt hetzelfde id.
const PERS       = MENTOR_UID;
const STU        = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function nepRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

before(() => {
  delete process.env.BUBBLE_API_ROOT;
  delete process.env.BUBBLE_API_TOKEN;
  const crm = nepDb({
    team_members: [{ id: 'tm-1', user_id: MENTOR_UID, email: 'mentor@x.nl', name: 'Mentor', is_active: true, type: 'mentor' }],
    customers: [], invoices: [], onboardings: [], mentor_student_assessments: [],
    mentor_funded_certificates: [], mentor_payouts: [], profiles: [], user_roles: [],
  });
  const lms = nepDb({
    hlms_personeel: [{ id: PERS, email: 'mentor@x.nl', actief: true, naam: 'Mentor' }],
    hlms_student: [{ id: STU, mentor_id: PERS, voornaam: 'Sam', achternaam: 'Student', email: 'sam@x.nl',
      bubble_user_id: null, calls_startsaldo: 2, calls_totaal: 24, eind_datum: '2099-12-31' }],
    hlms_sessie: [
      { id: 's1', student_id: STU, mentor_id: PERS, start_tijd: '2026-10-02T09:00:00.000Z', status: 'afgerond', duur_minuten: 45 },
      { id: 's2', student_id: STU, mentor_id: PERS, start_tijd: new Date(Date.now() + 7 * 864e5).toISOString(), status: 'gepland', duur_minuten: 45 },
    ],
    hlms_teamtraining_trainer: [], hlms_teamtraining: [], hlms_intake: [], hlms_sessie_taak: [],
  });
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: crm, supabase: crm, createUserClient: () => crm },
  });
  mock.module(url('api/_lib/dfo-lms-db.js'), {
    namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false, UNIQUE_VIOLATION: '23505' },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: { requirePermission: async () => true, requirePermissionFailOpen: async () => true },
  });
});

async function roep(pad, query = {}) {
  const mod = await import(url(pad));
  const res = nepRes();
  await mod.default({ method: 'GET', query, headers: {}, body: null }, res);
  return res;
}

test('DYNAMISCH: mentor-my-students geeft de LMS-studenten, zonder Bubble-env', async () => {
  const r = await roep('api/mentor-my-students.js');
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.linked, true);
  assert.equal(r.body.students.length, 1);
  assert.equal(r.body.students[0].student_id, STU);
  assert.equal(r.body.students[0].calls_1on1_done, 3, 'startsaldo 2 + 1 afgerond');
});

test('DYNAMISCH: mentor-1on1-sessions geeft geplande en afgeronde LMS-sessies', async () => {
  const r = await roep('api/mentor-1on1-sessions.js');
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.completed, 1);
  assert.equal(r.body.counts.planned, 1);
  assert.equal(r.body.completed[0].member_user, STU);
});

test('DYNAMISCH: students-overview (admin) uit het LMS', async () => {
  const r = await roep('api/students-overview.js');
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.students.length, 1);
  assert.equal(r.body.students[0].mentor_name, 'Mentor');
});

test('DYNAMISCH: mentor-coaching-earnings voor oktober, zonder Bubble', async () => {
  const r = await roep('api/mentor-coaching-earnings.js', { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.breakdown.one_on_one.count, 1);
  assert.equal(r.body.melding, undefined);
});

test('DYNAMISCH: mentor-coaching-earnings voor september crasht niet en meldt het', async () => {
  const r = await roep('api/mentor-coaching-earnings.js', { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(r.body.melding, /oktober 2026/);
  assert.deepEqual(r.body.uitbetalingen, []);
});

test('DYNAMISCH: mentor-coaching-debug voor september geeft 200', async () => {
  const r = await roep('api/mentor-coaching-debug.js', { mentor_user_id: MENTOR_UID, period_month: '2026-09' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.lms && !r.body.lms.error, JSON.stringify(r.body.lms));
});
