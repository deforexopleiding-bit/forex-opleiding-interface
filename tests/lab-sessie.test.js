// tests/lab-sessie.test.js
//
// De strategiesessie boeken vanuit het LMS (api/lab-sessie.js) en de
// "stuur me een nieuwe link"-aanvraag (api/lab-nieuwe-link.js).
//   - geen of ongeldige LMS-sessie → 401, geen lab-lead → 403;
//   - de schaarste-telling is echt: alleen momenten tot en met zondag;
//   - een moment dat intussen weg is, wordt niet geboekt;
//   - boeken gaat met bron 'the-lab' en vinkt de boeking af in het LMS;
//   - nieuwe link: hetzelfde antwoord voor bekend en onbekend adres.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb, upsertLeadRpc } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

let crm; let lms; let mails; let geboekt; let ghlSlots;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async (m) => { mails.push(m); return { ok: true }; } } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: { haalLijn: async () => ({}), mailAfzender: () => 'welkom@deforexopleiding.nl' } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: { sendTemplate: async () => ({}), goedgekeurdeTemplatesOpLijn: async () => ({ ok: true, templates: [] }) } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });
mock.module(url('api/_lib/create-appointment-from-lead.js'), { namedExports: {
  createAppointmentForLead: async (a) => { geboekt.push(a); return { appointment_id: 'afspraak-1', zoom_join_url: null }; },
  mapGhlError: () => '',
} });
const echteSlots = await import(url('api/public-opstartsessie-free-slots.js'));
const { default: _slotsHandler, ...slotsNamed } = echteSlots;
mock.module(url('api/public-opstartsessie-free-slots.js'), { defaultExport: _slotsHandler, namedExports: {
  ...slotsNamed, fetchGhlSlots: async () => ghlSlots,
} });

const { default: sessie, momentenUitSlots, aantalDezeWeek } = await import(url('api/lab-sessie.js'));
const { _resetGastheerCache, initialen, gastheerUitProfiel } = await import(url('api/_lib/lab-gastheer.js'));
const DAVE = { id: 'prof-dave', email: 'dave@deforexopleiding.nl', full_name: 'Dave Heylen', avatar_url: null, is_active: true, role: 'sales' };
const { default: nieuweLink, ANTWOORD } = await import(url('api/lab-nieuwe-link.js'));

process.env.GHL_CALENDAR_ID = 'cal';
process.env.GHL_PIT_TOKEN = 'tok';

const LAB = { id: 'll-1', auth_id: 'auth-1', email: 'lead@voorbeeld.be', voornaam: 'Lien', achternaam: null, telefoon: '+32472223752', crm_lead_id: 'lead-1', toegang_tot: new Date(Date.now() + 5 * 86400000).toISOString(), sessie_moment: null };

beforeEach(() => {
  crm = maakFakeDb({ leads: [{ id: 'lead-1', voornaam: 'Lien', email: 'lead@voorbeeld.be', telefoon_e164: '+32472223752' }], profiles: [{ ...DAVE }], app_settings: [] }, { rpc: { upsert_lead: upsertLeadRpc } });
  _resetGastheerCache();
  lms = maakFakeDb({ 'auth.users': [{ id: 'auth-1', email: 'lead@voorbeeld.be', token: 'goed' }], hlms_lab_lead: [{ ...LAB }] });
  mails = []; geboekt = [];
  const morgen = new Date(Date.now() + 86400000);
  const d = morgen.toISOString().slice(0, 10);
  ghlSlots = { [d]: { slots: [`${d}T10:00:00+02:00`, `${d}T14:30:00+02:00`] } };
});

function res() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; },
  };
}
const vraag = async (h, method, token, body) => { const r = res(); await h({ method, headers: token ? { authorization: 'Bearer ' + token } : {}, body }, r); return r; };

test('zonder geldige LMS-sessie: 401; geen lab-lead: 403', async () => {
  assert.equal((await vraag(sessie, 'GET', null)).statusCode, 401);
  assert.equal((await vraag(sessie, 'GET', 'fout')).statusCode, 401);
  lms.tabellen.hlms_lab_lead = [];
  assert.equal((await vraag(sessie, 'GET', 'goed')).statusCode, 403);
});

test('GET: vrije momenten in de toekomst en een echte telling', async () => {
  const r = await vraag(sessie, 'GET', 'goed');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.momenten.length, 2);
  assert.equal(typeof r.body.deze_week, 'number');
});

test('aantalDezeWeek telt alleen tot en met zondag', () => {
  const woensdag = Date.parse('2026-10-14T10:00:00Z');
  const m = ['2026-10-15T08:00:00.000Z', '2026-10-18T08:00:00.000Z', '2026-10-19T08:00:00.000Z'];
  assert.equal(aantalDezeWeek(m, woensdag), 2);
});

test('momentenUitSlots laat momenten binnen twee uur weg', () => {
  const nu = Date.parse('2026-10-15T08:00:00Z');
  const uit = momentenUitSlots([{ date: '2026-10-15', times: ['10:30', '12:00'] }], nu);
  assert.deepEqual(uit, ['2026-10-15T10:00:00.000Z']);
});

test('POST: boekt met bron the-lab en vinkt het af in het LMS', async () => {
  const g = await vraag(sessie, 'GET', 'goed');
  const r = await vraag(sessie, 'POST', 'goed', { moment: g.body.momenten[0] });
  assert.equal(r.statusCode, 200);
  assert.equal(geboekt[0].source, 'the-lab');
  assert.equal(geboekt[0].lead.id, 'lead-1');
  assert.equal(geboekt[0].lead.lead_phone, '+32472223752');
  assert.equal(lms.tabellen.hlms_lab_lead[0].sessie_moment, g.body.momenten[0]);
  assert.equal(lms.tabellen.hlms_lab_lead[0].sessie_afspraak_id, 'afspraak-1');
  // Tweede keer: al geboekt.
  assert.equal((await vraag(sessie, 'POST', 'goed', { moment: g.body.momenten[1] })).statusCode, 409);
});

test('POST: een moment dat niet (meer) vrij is wordt niet geboekt', async () => {
  const r = await vraag(sessie, 'POST', 'goed', { moment: '2030-01-01T09:00:00Z' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'moment_weg');
  assert.equal(geboekt.length, 0);
});

test('nieuwe link: zelfde antwoord voor bekend en onbekend adres, alleen bekend krijgt mail', async () => {
  const a = await vraag(nieuweLink, 'POST', null, { email: 'lead@voorbeeld.be' });
  const b = await vraag(nieuweLink, 'POST', null, { email: 'onbekend@voorbeeld.be' });
  assert.equal(a.body.bericht, ANTWOORD);
  assert.equal(b.body.bericht, ANTWOORD);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'lead@voorbeeld.be');
  assert.match(mails[0].html, /\/the-lab\/start\/\?s=/);
});

test('nieuwe link na het verlopen: wijst naar de boekingspagina', async () => {
  lms.tabellen.hlms_lab_lead[0].toegang_tot = new Date(Date.now() - 86400000).toISOString();
  await vraag(nieuweLink, 'POST', null, { email: 'lead@voorbeeld.be' });
  assert.match(mails[0].html, /naar=sessie/);
  assert.match(mails[0].html, /Plan mijn strategiesessie/);
});

test('GASTHEER: de kaart krijgt Daves naam en initialen (geen foto → null, geen e-mail of rol)', async () => {
  const r = await vraag(sessie, 'GET', 'goed');
  assert.deepEqual(r.body.gastheer, { voornaam: 'Dave', naam: 'Dave Heylen', foto_url: null, initialen: 'DH' });
});

test('GASTHEER: Dave wordt EIGENAAR van de afspraak, de bron blijft the-lab (geen setter)', async () => {
  const g = await vraag(sessie, 'GET', 'goed');
  await vraag(sessie, 'POST', 'goed', { moment: g.body.momenten[0] });
  assert.equal(geboekt[0].lead.owner_id, 'prof-dave');
  assert.equal(geboekt[0].source, 'the-lab');
});

test('GASTHEER: app_settings.lab_gastheer wint; een inactief profiel telt niet', async () => {
  crm.tabellen.profiles.push({ id: 'prof-ander', email: 'x@deforexopleiding.nl', full_name: 'Ander Persoon', avatar_url: 'https://cdn.voorbeeld/foto.jpg', is_active: true });
  crm.tabellen.app_settings.push({ key: 'lab_gastheer', value: { profiel_id: 'prof-ander' } });
  const r = await vraag(sessie, 'GET', 'goed');
  assert.equal(r.body.gastheer.naam, 'Ander Persoon');
  assert.equal(r.body.gastheer.foto_url, 'https://cdn.voorbeeld/foto.jpg');
  assert.equal(gastheerUitProfiel({ id: 'x', full_name: 'Weg', is_active: false }), null);
});

test('GASTHEER: niemand gevonden → null, en boeken werkt gewoon zonder eigenaar', async () => {
  crm.tabellen.profiles = [];
  const g = await vraag(sessie, 'GET', 'goed');
  assert.equal(g.body.gastheer, null);
  const r = await vraag(sessie, 'POST', 'goed', { moment: g.body.momenten[0] });
  assert.equal(r.statusCode, 200);
  assert.equal(geboekt[0].lead.owner_id, null);
});

test('initialen', () => {
  assert.equal(initialen('Dave Heylen'), 'DH');
  assert.equal(initialen('dave'), 'D');
  assert.equal(initialen(''), null);
});

test('GEBOEKT: de verzetlink en het actuele moment uit de afspraak in het CRM (voor de sessiebalk)', async () => {
  const oud = new Date(Date.now() + 86400000).toISOString();
  const verzet = new Date(Date.now() + 2 * 86400000).toISOString();
  lms.tabellen.hlms_lab_lead[0] = { ...LAB, sessie_moment: oud, sessie_geboekt_op: 'x', sessie_afspraak_id: 'afspraak-9' };
  crm.tabellen.follow_up_appointments = [{ id: 'afspraak-9', scheduled_at: verzet, status: 'scheduled', afspraak_token: '11111111-2222-3333-4444-555555555555' }];
  const r = await vraag(sessie, 'GET', 'goed');
  assert.equal(r.statusCode, 200);
  assert.match(r.body.verzet_url, /\/afspraak\/11111111-2222-3333-4444-555555555555$/);
  assert.equal(r.body.geboekt.moment, verzet);
  // Geannuleerd: geen verzetlink, het LMS-moment blijft.
  crm.tabellen.follow_up_appointments[0].status = 'cancelled';
  const r2 = await vraag(sessie, 'GET', 'goed');
  assert.equal(r2.body.verzet_url, null);
  assert.equal(r2.body.geboekt.moment, oud);
  // Zonder afspraak-id (oude boeking): gewoon zoals vroeger.
  lms.tabellen.hlms_lab_lead[0].sessie_afspraak_id = null;
  const r3 = await vraag(sessie, 'GET', 'goed');
  assert.equal(r3.body.verzet_url, null);
  assert.equal(r3.body.geboekt.moment, oud);
});
