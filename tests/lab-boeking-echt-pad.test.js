// tests/lab-boeking-echt-pad.test.js
//
// DE BOEKING UIT THE LAB, VAN BEGIN TOT EINDE — zonder één echte lead en
// zonder GHL te raken. Waar tests/lab-sessie.test.js createAppointmentForLead
// wegmockt, draait hier de ECHTE createAppointmentForLead: alleen de
// buitenwereld (GHL-contact-upsert, GHL-afspraak, tag) wordt onderschept.
//
// Aanleiding (19 okt): de test-boeking gaf in productie een 500 omdat
// follow_up_appointments.lead_ghl_contact_id NOT NULL is — de nep-databank
// controleerde dat niet. Die doet het nu wel (VERPLICHT_FOLLOW_UP in
// lab-fake-db.js), en deze toets bewijst dat:
//   - de echte boeking een rij maakt met ALLE verplichte kolommen, in Daves
//     agenda (GHL_CALENDAR_ID, toegewezen aan GHL_DAVE_USER_ID), met Dave als
//     eigenaar, bron 'the-lab' en de tag bron-the-lab op het GHL-contact;
//   - de test-boeking een rij maakt met alle verplichte kolommen, zonder ook
//     maar één aanroep naar GHL.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb, upsertLeadRpc, VERPLICHT_FOLLOW_UP } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

let crm; let lms; let ghlVerkeer; let ghlAfspraken; let ghlSlots;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/lab-meta.js'), { namedExports: { stuurLabEvent: async () => ({ ok: true }), labEventId: (n, id) => `${n}_${id}`, labUserData: () => ({}) } });
// De buitenwereld: GHL-contact-upsert en de tag gaan via node-fetch …
mock.module('node-fetch', { defaultExport: async (u, init = {}) => {
  ghlVerkeer.push({ url: String(u), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (String(u).endsWith('/contacts/upsert')) return { ok: true, status: 200, json: async () => ({ contact: { id: 'GHLcontact0000000001' } }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
} });
// … en de afspraak zelf via ghl-appointment.js.
mock.module(url('api/_lib/ghl-appointment.js'), { namedExports: {
  createGhlAppointment: async (a) => { ghlAfspraken.push(a); return { id: 'GHLafspraak000000001', zoom_meeting_id: '123', zoom_join_url: 'https://zoom.us/j/123' }; },
} });
const echteSlots = await import(url('api/public-opstartsessie-free-slots.js'));
const { default: _slotsHandler, ...slotsNamed } = echteSlots;
mock.module(url('api/public-opstartsessie-free-slots.js'), { defaultExport: _slotsHandler, namedExports: { ...slotsNamed, fetchGhlSlots: async () => ghlSlots } });

const { default: sessie, testContactId } = await import(url('api/lab-sessie.js'));
const { _resetGastheerCache } = await import(url('api/_lib/lab-gastheer.js'));

process.env.GHL_CALENDAR_ID = 'agenda-dave';
process.env.GHL_LOCATION_ID = 'locatie';
process.env.GHL_PIT_TOKEN = 'tok';
process.env.GHL_DAVE_USER_ID = 'ghl-dave';

const DAVE = { id: 'prof-dave', email: 'dave@deforexopleiding.nl', full_name: 'Dave Heylen', avatar_url: null, is_active: true, role: 'sales' };
const TOEKOMST = new Date(Date.now() + 5 * 86400000).toISOString();
const ECHT = { id: 'll-echt', auth_id: 'auth-echt', email: 'lien@voorbeeld.be', voornaam: 'Lien', achternaam: 'Peeters', telefoon: '+32470000000', crm_lead_id: null, is_test: false, toegang_tot: TOEKOMST, sessie_moment: null };
const TEST = { id: 'll-test', auth_id: 'auth-test', email: 'admin+lablead@voorbeeld.be', voornaam: 'Test', is_test: true, beheerd_door_auth_id: 'auth-admin', toegang_tot: TOEKOMST, sessie_moment: null };

beforeEach(() => {
  _resetGastheerCache();
  crm = maakFakeDb({ leads: [], profiles: [{ ...DAVE }], app_settings: [{ key: 'lab_gastheer', value: { profiel_id: 'prof-dave' } }], booking_sources: [{ slug: 'the-lab', actief: true, owner_user_id: null }], follow_up_appointments: [] }, { rpc: { upsert_lead: upsertLeadRpc } });
  lms = maakFakeDb({ 'auth.users': [{ id: 'auth-echt', email: ECHT.email, token: 'echt' }, { id: 'auth-test', email: TEST.email, token: 'test' }], hlms_lab_lead: [{ ...ECHT }, { ...TEST }] });
  ghlVerkeer = []; ghlAfspraken = [];
  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  ghlSlots = { [morgen]: { slots: [`${morgen}T14:00:00+02:00`] } };
});

function res() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
const vraag = async (method, token, body) => { const r = res(); await sessie({ method, headers: { authorization: 'Bearer ' + token }, body }, r); return r; };
const verplichtIngevuld = (rij) => VERPLICHT_FOLLOW_UP.every((k) => rij[k] != null && String(rij[k]).length > 0);

test('ECHT PAD: in Daves agenda, Dave eigenaar, bron the-lab, alle verplichte kolommen, tag op het contact', async () => {
  const moment = (await vraag('GET', 'echt')).body.momenten[0];
  const r = await vraag('POST', 'echt', { moment });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ghlAfspraken.length, 1);
  assert.equal(ghlAfspraken[0].calendarId, 'agenda-dave');
  assert.equal(ghlAfspraken[0].assignedUserId, 'ghl-dave');
  const rij = crm.tabellen.follow_up_appointments[0];
  assert.ok(verplichtIngevuld(rij), JSON.stringify(rij));
  assert.equal(rij.lead_ghl_contact_id, 'GHLcontact0000000001');
  assert.equal(rij.booking_source, 'the-lab');
  assert.equal(rij.owner_id, 'prof-dave');
  assert.equal(rij.setter_user_id, null); // Dave is eigenaar, geen setter
  assert.equal(rij.ghl_calendar_id, 'agenda-dave');
  assert.equal(rij.is_test, undefined);
  assert.ok(ghlVerkeer.some((v) => v.url.endsWith('/tags') && v.body.tags.includes('bron-the-lab')), 'tag bron-the-lab');
  // En het LMS weet het.
  assert.equal(lms.tabellen.hlms_lab_lead.find((l) => l.id === 'll-echt').sessie_afspraak_id, rij.id);
});

test('TEST-PAD: alle verplichte kolommen (de 500 van 19 okt), en GHL wordt niet aangeraakt', async () => {
  const moment = (await vraag('GET', 'test')).body.momenten[0];
  const r = await vraag('POST', 'test', { moment });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.test, true);
  const rij = crm.tabellen.follow_up_appointments[0];
  assert.ok(verplichtIngevuld(rij), JSON.stringify(rij));
  assert.equal(rij.lead_ghl_contact_id, testContactId('ll-test'));
  assert.doesNotMatch(rij.lead_ghl_contact_id, /^[A-Za-z0-9]{20}$/); // lijkt op geen enkel GHL-id
  assert.equal(rij.is_test, true);
  assert.equal(ghlAfspraken.length, 0);
  assert.equal(ghlVerkeer.length, 0);
});

test('de nep-databank weigert nu wat productie weigert: geen GHL-contact = 23502', async () => {
  const { error } = await crm.from('follow_up_appointments').insert({ lead_name: 'x', scheduled_at: TOEKOMST });
  assert.equal(error?.code, '23502');
});
