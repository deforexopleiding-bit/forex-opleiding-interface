// tests/events-inschrijvingen-vragenlijst.test.js
//
// Events → Inschrijvingen, kolom "Vragenlijst" (fix 2026-10-18).
// Bug: de lijst gaf een ✓ (met een tijd vóór het inschrijfmoment) voor
// deelnemers zonder ingevulde vragenlijst, omdat de kwalificatie-quiz van
// stap 1 (event_kwalificatie_submissions) meetelde. Het detailpaneel kijkt
// alleen naar event_attendees.assessment_response_id. Nu dezelfde bron.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = { tabellen: {}, gelezen: [] };

function from(tabel) {
  db.gelezen.push(tabel);
  const filters = [];
  const k = {
    select: () => k,
    eq: (c, v) => { filters.push(['eq', c, v]); return k; },
    in: (c, v) => { filters.push(['in', c, v]); return k; },
    order: () => k,
    range: () => k,
    then: (ok, nok) => {
      let rijen = (db.tabellen[tabel] || []).slice();
      for (const [op, c, v] of filters) {
        if (op === 'eq') rijen = rijen.filter((r) => r[c] === v);
        if (op === 'in') rijen = rijen.filter((r) => v.includes(r[c]));
      }
      return Promise.resolve({ data: rijen, error: null }).then(ok, nok);
    },
  };
  return k;
}

mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async () => true },
});

const { default: handler } = await import('../api/events-signup-inbox-list.js');

async function roep() {
  let status = 0; let body = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  return { status, body };
}

test('alleen een gekoppelde assessment_response telt als ingevuld; kwalificatie-quiz niet', async () => {
  db.tabellen = {
    event_attendees: [
      // Alleen de stap-1-quiz (14:12), ingeschreven 14:13, geen vragenlijst.
      { id: 'a1', event_id: 'e1', email: 'a@x.nl', status: 'aangemeld', is_test: false, created_at: '2026-10-17T12:13:00Z', registered_at: '2026-10-17T12:13:00Z', assessment_response_id: null, assessment_linked_at: null },
      // Echte vragenlijst ingevuld om 15:40.
      { id: 'a2', event_id: 'e1', email: 'b@x.nl', status: 'aangemeld', is_test: false, created_at: '2026-10-17T12:00:00Z', registered_at: '2026-10-17T12:00:00Z', assessment_response_id: 'r2', assessment_linked_at: '2026-10-17T13:40:05Z' },
      // Gekoppeld, maar response-rij niet leesbaar → tijd uit assessment_linked_at.
      { id: 'a3', event_id: 'e1', email: 'c@x.nl', status: 'aangemeld', is_test: false, created_at: '2026-10-17T11:00:00Z', registered_at: '2026-10-17T11:00:00Z', assessment_response_id: 'r-weg', assessment_linked_at: '2026-10-17T11:30:00Z' },
    ],
    event_signup_inbox: [],
    events: [{ id: 'e1', title: 'Event', starts_at: '2026-10-25T10:00:00Z' }],
    assessment_responses: [{ id: 'r2', submitted_at: '2026-10-17T13:40:00Z', created_at: '2026-10-17T13:39:00Z' }],
    event_kwalificatie_submissions: [
      { attendee_id: 'a1', created_at: '2026-10-17T12:12:00Z' },
      { attendee_id: 'a2', created_at: '2026-10-17T11:59:00Z' },
    ],
  };
  db.gelezen = [];
  const { status, body } = await roep();
  assert.equal(status, 200);
  const per = Object.fromEntries(body.rows.map((r) => [r.matched_attendee_id, r]));
  assert.equal(per.a1.questionnaire_filled, false, 'alleen stap-1-quiz → geen ✓');
  assert.equal(per.a1.questionnaire_filled_at, null);
  assert.equal(per.a2.questionnaire_filled, true);
  assert.equal(per.a2.questionnaire_filled_at, '2026-10-17T13:40:00Z', 'invul-moment = submitted_at, niet de quiz-tijd');
  assert.equal(per.a3.questionnaire_filled, true, 'zelfde conditie als het detailpaneel (assessment_response_id)');
  assert.equal(per.a3.questionnaire_filled_at, '2026-10-17T11:30:00Z');
  assert.ok(!db.gelezen.includes('event_kwalificatie_submissions'), 'kwalificatie-tabel niet meer gelezen');
  // Telling "Matched" leunt op match_status, niet op de vragenlijst.
  assert.equal(body.counts.matched, 3);
});

test('detailpaneel en lijst gebruiken dezelfde conditie; view toont geen ✓ zonder vragenlijst', () => {
  const detail = readFileSync(new URL('../api/events-attendee-assessment-get.js', import.meta.url), 'utf8');
  assert.match(detail, /if \(!att\.assessment_response_id\)/);
  const view = readFileSync(new URL('../modules/klanten-v2/views/events-v2.js', import.meta.url), 'utf8');
  assert.match(view, /const hasQuest = r\.questionnaire_filled === true;/);
  assert.match(view, /title="Vragenlijst nog niet ingevuld" style="color:var\(--text-3\);font-size:11\.5px">nog niet<\/span>/);
  const html = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
  const v = Number((html.match(/views\/events-v2\.js\?v=(\d+)/) || [])[1]);
  assert.ok(v >= 64, 'cache-buster opgehoogd');
});
