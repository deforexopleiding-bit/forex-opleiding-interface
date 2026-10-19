// tests/lab-test-reset.test.js
//
// "Lab-lead (test)" — de CRM-kant (api/lab-test-reset.js en de test-boeking in
// api/lab-sessie.js).
//   - reset: zonder sessie 401; een echte lead, een gewone testlead (niet
//     beheerd) en een account zonder lab-lead-rij krijgen 403;
//   - reset raakt ENKEL de test-belopdrachten en de test-afspraak van DIT
//     testaccount: een echte taak of afspraak met hetzelfde adres en de taken
//     van een andere lead blijven staan;
//   - na de reset blokkeert de unieke index (één taak per lead per reden) geen
//     nieuwe test-belmelding meer;
//   - een testlead boekt zonder GHL, zonder CRM-lead en zonder Meta-event.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb, upsertLeadRpc } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

let crm; let lms; let ghl; let meta; let ghlSlots;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/lab-meta.js'), { namedExports: {
  stuurLabEvent: async (e) => { meta.push(e); return { ok: true }; },
  labEventId: (n, id) => `${n}_${id}`,
  labUserData: () => ({}),
} });
mock.module(url('api/_lib/create-appointment-from-lead.js'), { namedExports: {
  createAppointmentForLead: async (a) => { ghl.push(a); return { appointment_id: 'echte-afspraak', zoom_join_url: 'https://zoom.us/j/1' }; },
  mapGhlError: () => '',
} });
const echteSlots = await import(url('api/public-opstartsessie-free-slots.js'));
const { default: _slotsHandler, ...slotsNamed } = echteSlots;
mock.module(url('api/public-opstartsessie-free-slots.js'), { defaultExport: _slotsHandler, namedExports: {
  ...slotsNamed, fetchGhlSlots: async () => ghlSlots,
} });

const { default: reset, isBeheerdTestaccount } = await import(url('api/lab-test-reset.js'));
const { default: sessie } = await import(url('api/lab-sessie.js'));
const { _resetGastheerCache } = await import(url('api/_lib/lab-gastheer.js'));

process.env.GHL_CALENDAR_ID = 'cal';
process.env.GHL_PIT_TOKEN = 'tok';

const TOEKOMST = new Date(Date.now() + 5 * 86400000).toISOString();
const TEST = { id: 'll-test', auth_id: 'auth-test', email: 'maxim.del96+lablead@gmail.com', voornaam: 'Test', is_test: true, beheerd_door_auth_id: 'auth-maxim', toegang_tot: TOEKOMST, sessie_moment: null };
const ECHT = { id: 'll-echt', auth_id: 'auth-echt', email: 'lead@voorbeeld.be', voornaam: 'Lien', is_test: false, beheerd_door_auth_id: null, toegang_tot: TOEKOMST, sessie_moment: null, crm_lead_id: 'lead-1' };
const LOS = { id: 'll-los', auth_id: 'auth-los', email: 'maxim.delombaerde96+labtest1@gmail.com', voornaam: 'Los', is_test: true, beheerd_door_auth_id: null, toegang_tot: TOEKOMST, sessie_moment: null };

const taak = (id, labLeadId, extra = {}) => ({ id, reden: 'lab_bellen', lijst: 'dag', reden_code: 'lab_stil_24u', status: 'open', is_test: true, bron_ref: { lab_lead_id: labLeadId, reden: 'lab_stil_24u' }, ...extra });

beforeEach(() => {
  _resetGastheerCache();
  crm = maakFakeDb({
    opvolging_taken: [
      taak('t-test-open', 'll-test'),
      taak('t-test-oud', 'll-test', { reden_code: 'lab_vraag', status: 'gearchiveerd' }),
      taak('t-ander', 'll-los'),
      taak('t-echt', 'll-echt', { is_test: false }),
    ],
    follow_up_appointments: [
      { id: 'a-test', is_test: true, booking_source: 'the-lab', lead_email: TEST.email, status: 'scheduled' },
      { id: 'a-echt-zelfde-adres', is_test: false, booking_source: 'the-lab', lead_email: TEST.email, status: 'scheduled' },
      { id: 'a-echt', is_test: false, booking_source: 'the-lab', lead_email: ECHT.email, status: 'scheduled' },
    ],
    leads: [{ id: 'lead-1', voornaam: 'Lien', email: ECHT.email }],
    scans: [
      { id: 's-test-concept', afspraak_id: 'a-test', status: 'concept', deelnemer_naam: 'TEST · Test' },
      { id: 's-test-afgerond', afspraak_id: 'a-test', status: 'afgerond', deelnemer_naam: 'TEST · Test' },
      { id: 's-echt', afspraak_id: 'a-echt-zelfde-adres', status: 'concept', deelnemer_naam: 'Lien' },
    ],
    profiles: [], app_settings: [],
  }, {
    rpc: { upsert_lead: upsertLeadRpc },
    // De partiële unieke index: één lab_bellen-taak per (lab_lead_id, reden_code).
    uniek: { opvolging_taken: (r, t) => !!r.bron_ref?.lab_lead_id && t.some((x) => x.reden === 'lab_bellen' && x.bron_ref?.lab_lead_id === r.bron_ref.lab_lead_id && x.reden_code === r.reden_code) },
  });
  lms = maakFakeDb({
    'auth.users': [
      { id: 'auth-test', email: TEST.email, token: 'test' },
      { id: 'auth-echt', email: ECHT.email, token: 'echt' },
      { id: 'auth-los', email: LOS.email, token: 'los' },
      { id: 'auth-zaal', email: 'event1@deforexopleiding.nl', token: 'zaal' },
    ],
    hlms_lab_lead: [{ ...TEST }, { ...ECHT }, { ...LOS }],
  });
  ghl = []; meta = [];
  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  ghlSlots = { [morgen]: { slots: [`${morgen}T10:00:00+02:00`] } };
});

function res() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; },
  };
}
const vraag = async (h, method, token, body) => { const r = res(); await h({ method, headers: token ? { authorization: 'Bearer ' + token } : {}, body }, r); return r; };
const rij = (tabel, id) => crm.tabellen[tabel].find((x) => x.id === id);

test('beheerd testaccount = is_test én beheerd_door', () => {
  assert.equal(isBeheerdTestaccount(TEST), true);
  assert.equal(isBeheerdTestaccount(LOS), false);
  assert.equal(isBeheerdTestaccount(ECHT), false);
  assert.equal(isBeheerdTestaccount({ ...ECHT, beheerd_door_auth_id: 'auth-maxim' }), false); // geen test → nooit
  assert.equal(isBeheerdTestaccount(null), false);
});

test('RESET 401/403: geen sessie, echte lead, gewone testlead, zaalaccount — en er verandert niets', async () => {
  assert.equal((await vraag(reset, 'POST', null, {})).statusCode, 401);
  assert.equal((await vraag(reset, 'POST', 'fout', {})).statusCode, 401);
  for (const t of ['echt', 'los', 'zaal']) {
    const r = await vraag(reset, 'POST', t, {});
    assert.equal(r.statusCode, 403, t);
    assert.equal(r.body.code, 'geen_testaccount');
  }
  assert.equal(crm.log.updates.length, 0);
});

test('RESET: enkel de test-taken en de test-afspraak van DIT account', async () => {
  const r = await vraag(reset, 'POST', 'test', {});
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, taken_gearchiveerd: 2, afspraken_geannuleerd: 1, scans_gewist: 1 });
  // Alleen het TEST-concept van de test-afspraak; wat Dave afrondde en echte scans blijven.
  assert.deepEqual(crm.tabellen.scans.map((s) => s.id).sort(), ['s-echt', 's-test-afgerond']);

  const open = rij('opvolging_taken', 't-test-open');
  assert.equal(open.status, 'gearchiveerd');
  assert.equal(open.archief_reden, 'Testaccount gereset');
  assert.equal(open.bron_ref.lab_lead_id, undefined);
  assert.equal(open.bron_ref.lab_lead_id_voor_reset, 'll-test');
  assert.equal(rij('opvolging_taken', 't-test-oud').bron_ref.lab_lead_id_voor_reset, 'll-test');

  // Niets anders geraakt.
  assert.equal(rij('opvolging_taken', 't-ander').status, 'open');
  assert.equal(rij('opvolging_taken', 't-ander').bron_ref.lab_lead_id, 'll-los');
  assert.equal(rij('opvolging_taken', 't-echt').status, 'open');
  assert.equal(rij('follow_up_appointments', 'a-test').status, 'cancelled');
  assert.equal(rij('follow_up_appointments', 'a-echt-zelfde-adres').status, 'scheduled');
  assert.equal(rij('follow_up_appointments', 'a-echt').status, 'scheduled');
});

test('RESET: daarna kan dezelfde test-belmelding opnieuw ontstaan (de unieke index blokkeert niet meer)', async () => {
  const opnieuw = { reden: 'lab_bellen', reden_code: 'lab_stil_24u', status: 'open', is_test: true, bron_ref: { lab_lead_id: 'll-test' } };
  const voor = await crm.from('opvolging_taken').insert(opnieuw);
  assert.equal(voor.error?.code, '23505');
  await vraag(reset, 'POST', 'test', {});
  const na = await crm.from('opvolging_taken').insert(opnieuw);
  assert.equal(na.error, null);
});

test('RESET is herhaalbaar: een tweede keer raakt niets meer', async () => {
  await vraag(reset, 'POST', 'test', {});
  const r = await vraag(reset, 'POST', 'test', {});
  assert.deepEqual(r.body, { ok: true, taken_gearchiveerd: 0, afspraken_geannuleerd: 0, scans_gewist: 0 });
});

test('TEST-BOEKING: geen GHL, geen CRM-lead, geen Meta-event — wel een is_test-afspraak en het vinkje in het LMS', async () => {
  const moment = (await vraag(sessie, 'GET', 'test')).body.momenten[0];
  assert.ok(moment);
  const r = await vraag(sessie, 'POST', 'test', { moment });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.test, true);
  assert.equal(ghl.length, 0);
  assert.equal(meta.length, 0);
  assert.equal(crm.tabellen.leads.length, 1);
  const afspraak = crm.tabellen.follow_up_appointments.find((a) => a.id === r.body.afspraak_id);
  assert.equal(afspraak.is_test, true);
  assert.equal(afspraak.booking_source, 'the-lab');
  assert.match(afspraak.lead_name, /^TEST · /);
  assert.equal(afspraak.lead_phone, null);
  assert.equal(afspraak.ghl_calendar_id, undefined); // geen agenda → geen bevestiging/herinnering/interne melding
  const lead = lms.tabellen.hlms_lab_lead.find((l) => l.id === 'll-test');
  assert.equal(lead.sessie_afspraak_id, r.body.afspraak_id);
  // Geboekt: geen verzetlink (er is geen GHL-afspraak om te verzetten).
  const g = await vraag(sessie, 'GET', 'test');
  assert.equal(g.body.verzet_url, null);
});

test('ECHTE BOEKING blijft ongewijzigd: via GHL, met Meta-event', async () => {
  const moment = (await vraag(sessie, 'GET', 'echt')).body.momenten[0];
  const r = await vraag(sessie, 'POST', 'echt', { moment });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.test, undefined);
  assert.equal(ghl.length, 1);
  assert.equal(meta.length, 1);
});
