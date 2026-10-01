// tests/call-uitkomst-motor.test.js
//
// DE UITKOMSTMOTOR, ECHT GEDRAAID — geen bronteksten grepen.
//
// api/follow-up-appointment-outcome.js met een nep-databank, nep-GHL en
// nep-Zoom. Bewaakt de drie wijzigingen van 1 oktober 2026:
//   1. geen_geld   → completed, GHL showed, Zoom weg, geen lead;
//   2. onbereikbaar→ no_show, GHL noshow, Zoom blijft, geen lead;
//   3. no_show met zonder_terugbel_lead:true → geen lead; zonder vlag (en met
//      elke andere waarde dan precies true) het oude gedrag: lead +2u.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const st = { appt: null, log: [], ghl: [], zoom: [] };

function reset(appt) {
  st.appt = {
    id: '11111111-2222-4333-8444-555555555555',
    lead_name: 'Jan Peeters', lead_email: 'jan@example.com', lead_phone: '+32470123456',
    scheduled_at: '2026-09-30T10:00:00Z', status: 'scheduled', owner_id: 'dave',
    lead_ghl_contact_id: 'c-1', zoom_meeting_id: 'zoom-1', ghl_appointment_id: 'ghl-1',
    prev_state: null, snelle_notitie: '',
    ...appt,
  };
  st.log = []; st.ghl = []; st.zoom = [];
}

function from(tabel) {
  const q = { tabel, op: 'select', waarde: null, filters: [] };
  const k = {
    select: () => k,
    insert: (v) => { q.op = 'insert'; q.waarde = v; return k; },
    update: (v) => { q.op = 'update'; q.waarde = v; return k; },
    delete: () => { q.op = 'delete'; return k; },
    eq: (c, v) => { q.filters.push([c, v]); return k; },
    maybeSingle: () => run(), single: () => run(),
    then: (res, rej) => run().then(res, rej),
  };
  async function run() {
    st.log.push({ ...q });
    if (tabel === 'profiles') return { data: { role: 'manager' }, error: null };
    if (tabel === 'follow_up_leads' && q.op === 'insert') return { data: { id: 'lead-nieuw' }, error: null };
    if (tabel === 'follow_up_appointments') {
      if (q.op === 'update') { Object.assign(st.appt, q.waarde); return { data: null, error: null }; }
      if (q.op === 'select') return { data: { ...st.appt }, error: null };
    }
    return { data: null, error: null };
  }
  return k;
}

mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'dave' } } }) } }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async () => true },
});
mock.module('../api/_lib/ghl-appointment.js', {
  namedExports: { updateGhlAppointmentStatus: async (id, s) => { st.ghl.push([id, s]); } },
});
mock.module('../api/_lib/zoom-meeting.js', {
  namedExports: { deleteZoomMeeting: async (id) => { st.zoom.push(id); } },
});

const mod = await import('../api/follow-up-appointment-outcome.js');
const handler = mod.default;

async function post(body) {
  const uit = { code: null, body: null };
  const res = {
    setHeader() {},
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
  };
  await handler({ method: 'POST', headers: {}, body: { appointment_id: st.appt.id, ...body } }, res);
  return uit;
}

const leads = () => st.log.filter((r) => r.tabel === 'follow_up_leads' && r.op === 'insert');

test('geen_geld: completed, uitkomst vast, GHL showed, Zoom weg, geen lead', async () => {
  reset();
  const r = await post({ outcome: 'geen_geld', note: 'pas na de zomer' });
  assert.equal(r.code, 200);
  assert.equal(r.body.new_status, 'completed');
  assert.equal(st.appt.status, 'completed');
  assert.equal(st.appt.uitkomst, 'geen_geld');
  assert.ok(st.appt.uitkomst_op, 'het moment hoort gezet te zijn');
  assert.deepEqual(st.ghl, [['ghl-1', 'showed']]);
  assert.deepEqual(st.zoom, ['zoom-1'], 'de call is geweest: meeting weg');
  assert.equal(leads().length, 0);
  assert.match(st.appt.snelle_notitie, /Geen geld — gesprek gevoerd, geen sale om financiële redenen — pas na de zomer$/);
  assert.equal(st.appt.prev_state.outcome_before_undo, 'geen_geld', 'undo moet terug kunnen');
  assert.equal(st.appt.prev_state.status, 'scheduled');
});

test('onbereikbaar: no_show, GHL noshow, Zoom blijft, NOOIT een lead', async () => {
  reset();
  // Ook zonder vlag: onbereikbaar maakt zelf nooit een lead.
  const r = await post({ outcome: 'onbereikbaar' });
  assert.equal(r.code, 200);
  assert.equal(st.appt.status, 'no_show');
  assert.equal(st.appt.uitkomst, 'onbereikbaar');
  assert.deepEqual(st.ghl, [['ghl-1', 'noshow']]);
  assert.deepEqual(st.zoom, [], 'net als no-show blijft de meeting staan');
  assert.equal(leads().length, 0);
  assert.match(st.appt.snelle_notitie, /Onbereikbaar — call niet tot stand gekomen/);
});

test('no_show ZONDER vlag: oud gedrag, terugbel-lead over 2 uur', async () => {
  reset();
  const voor = Date.now();
  const r = await post({ outcome: 'no_show' });
  assert.equal(r.code, 200);
  assert.equal(st.appt.status, 'no_show');
  assert.equal(st.appt.uitkomst, 'no_show');
  assert.equal(leads().length, 1, 'de cockpit houdt zijn terugbel-lead');
  const lead = leads()[0].waarde;
  assert.equal(lead.lead_kind, 'bel');
  assert.equal(lead.source_ref.reason, 'no_show_followup');
  const plus = Date.parse(lead.terugbel_datum) - voor;
  assert.ok(plus > 1.9 * 3600e3 && plus < 2.1 * 3600e3, 'terugbel over twee uur');
  assert.match(st.appt.snelle_notitie, /No-show — nabellen gepland \(\+2u\)$/);
  assert.equal(r.body.followup_lead.lead_id, 'lead-nieuw');
  assert.equal(r.body.terugbel_lead_overgeslagen, undefined);
  assert.equal(st.appt.prev_state.created_lead_id, 'lead-nieuw', 'undo ruimt de lead op');
  assert.deepEqual(st.ghl, [['ghl-1', 'noshow']]);
});

test('no_show MET zonder_terugbel_lead:true: vastgelegd, geen lead', async () => {
  reset();
  const r = await post({ outcome: 'no_show', zonder_terugbel_lead: true });
  assert.equal(r.code, 200);
  assert.equal(st.appt.status, 'no_show');
  assert.equal(st.appt.uitkomst, 'no_show');
  assert.equal(leads().length, 0, 'geen dubbele lead naast de Opvolging-kaart');
  assert.equal(r.body.followup_lead, null);
  assert.equal(r.body.terugbel_lead_overgeslagen, true);
  assert.match(st.appt.snelle_notitie, /^\[[^\]]+\] No-show — geen terugbel-lead/);
  assert.doesNotMatch(st.appt.snelle_notitie, /nabellen gepland/, 'geen belofte die er niet is');
  assert.deepEqual(st.ghl, [['ghl-1', 'noshow']], 'GHL-status is dezelfde');
  assert.equal(st.appt.prev_state.created_lead_id, null);
});

test('alleen precies true telt als vlag', async () => {
  for (const waarde of ['true', 1, 'ja', {}, null]) {
    reset();
    await post({ outcome: 'no_show', zonder_terugbel_lead: waarde });
    assert.equal(leads().length, 1, JSON.stringify(waarde) + ' hoort het oude gedrag te geven');
  }
  assert.equal(mod.zonderTerugbelLead({ zonder_terugbel_lead: true }), true);
  assert.equal(mod.zonderTerugbelLead(undefined), false);
});

test('de vlag raakt andere uitkomsten niet', async () => {
  reset();
  await post({ outcome: 'later_opnieuw', zonder_terugbel_lead: true });
  assert.equal(leads().length, 1, 'later_opnieuw houdt zijn lead — de vlag is alleen voor no_show');
});

test('een onbekende uitkomst wordt nog steeds geweigerd', async () => {
  reset();
  const r = await post({ outcome: 'geen_tijd' });
  assert.equal(r.code, 400);
});

test('undo van geen_geld zet status en uitkomst terug', async () => {
  reset();
  await post({ outcome: 'geen_geld' });
  const r = await post({ action: 'undo' });
  assert.equal(r.code, 200);
  assert.equal(st.appt.status, 'scheduled');
  assert.equal(st.appt.uitkomst, null);
  assert.equal(st.appt.prev_state, null);
});
