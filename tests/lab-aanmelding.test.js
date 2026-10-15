// tests/lab-aanmelding.test.js
//
// Contracttests op POST /api/lab-aanmelding (The Lab als leadmachine).
// Draait de ECHTE handler met een nep-CRM en een nep-LMS en legt vast:
//   1. een nieuwe lead krijgt lead + trial-account + loginmail;
//   2. idempotent op e-mail: tweede aanmelding = nieuwe link, geen tweede
//      account, bron niet overschreven, maar de touch wél geregistreerd;
//   3. bestaande student, mentor of zaalaccount wordt NOOIT verlaagd of
//      bijgezet — wel "je hebt al toegang";
//   4. honeypot = niets doen, wel een gewoon antwoord;
//   5. zonder toestemming geen WhatsApp (de loginmail gaat wel: daar vroeg de
//      lead zelf om);
//   6. ontbreekt de LMS-migratie, dan blijft er geen trial zonder einddatum
//      achter en krijgt de bezoeker toch een gewoon antwoord.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb, upsertLeadRpc } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

let crm; let lms; let mails; let waVerstuurd; let waLive;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: (e) => e?.code === '23505' } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: {
  sendEmailViaSmtp: async (m) => { mails.push(m); return { ok: true, messageId: 'mid-' + mails.length }; },
} });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: {
  haalLijn: async () => ({ module: 'leadsonderhoud', phoneNumberId: 'pn-1', label: 'hoofdnummer' }),
  mailAfzender: () => 'welkom@deforexopleiding.nl',
} });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendTemplate: async (a) => { waVerstuurd.push(a); return { wamid: 'wamid-1' }; },
  goedgekeurdeTemplatesOpLijn: async () => ({ ok: true, templates: waLive }),
} });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const { default: handler } = await import(url('api/lab-aanmelding.js'));
const { beslisAccount } = await import(url('api/_lib/dfo-lms-lab-account.js'));

function nieuweCrm(leads = [], extra = {}) {
  return maakFakeDb({ leads, ...extra }, { rpc: { upsert_lead: upsertLeadRpc } });
}

beforeEach(() => {
  crm = nieuweCrm();
  lms = maakFakeDb({});
  mails = []; waVerstuurd = []; waLive = [];
});

async function post(body, headers = {}) {
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  await handler({ method: 'POST', headers: { origin: 'https://lms.deforexopleiding.nl', ...headers }, body }, res);
  return res;
}

const GELDIG = {
  voornaam: 'Maxim', email: 'maxim.delombaerde96+labtest1@gmail.com', gsm: '0472 22 37 52',
  toestemming: true, hook: 'TEST', utm_source: 'facebook', utm_campaign: 'lab-okt', utm_content: 'H03',
  landingspagina: 'https://lms.deforexopleiding.nl/the-lab/?utm_source=facebook&email=x@y.z', fbclid: 'abc123',
};

test('nieuwe lead: lead, trial-account met einddatum, rol trial en een loginmail', async () => {
  const r = await post(GELDIG);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.event_id, /^lab_lead_/);

  const lead = crm.tabellen.leads[0];
  assert.equal(lead.bron, 'the-lab');
  assert.equal(lead.traject, 'the-lab');
  assert.equal(lead.soort, 'facebook');
  assert.equal(lead.telefoon_e164, '+32472223752');

  assert.equal(lms.authUsers.length, 1);
  const ll = lms.tabellen.hlms_lab_lead[0];
  assert.equal(ll.crm_lead_id, lead.id);
  assert.equal(ll.is_test, true);
  const dagen = (Date.parse(ll.toegang_tot) - Date.now()) / 86400000;
  assert.ok(dagen > 6.9 && dagen < 7.1, 'toegang_tot = nu + 7 dagen');
  assert.deepEqual(lms.tabellen.hlms_rol.map((x) => x.rol), ['trial']);
  assert.equal(lms.tabellen.hlms_lab_sleutel.length, 1);

  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'Je toegang tot The Lab staat klaar');
  assert.match(mails[0].html, /\/the-lab\/start\/\?s=[A-Za-z0-9_-]{40,}/);
  assert.doesNotMatch(mails[0].html, /labtest1/, 'geen e-mailadres in de link');

  const a = crm.tabellen.lab_aanmeldingen[0];
  assert.equal(a.resultaat, 'nieuw_account');
  assert.equal(a.hook, 'TEST');
  assert.equal(a.landingspagina, 'https://lms.deforexopleiding.nl/the-lab/', 'querystring weggeknipt');
  assert.match(a.fbc, /^fb\.1\.\d+\.abc123$/);
  assert.equal(a.wa_status, 'geen_template');
});

test('idempotent: tweede aanmelding = nieuwe link, geen tweede account, touch wel geteld', async () => {
  await post(GELDIG);
  const r = await post({ ...GELDIG, hook: 'H07', utm_source: 'instagram' });
  assert.equal(r.statusCode, 200);
  assert.equal(crm.tabellen.leads.length, 1);
  assert.equal(crm.tabellen.leads[0].soort, 'facebook', 'herkomst niet overschreven');
  assert.equal(lms.authUsers.length, 1);
  assert.equal(lms.tabellen.hlms_lab_lead.length, 1);
  assert.equal(lms.tabellen.hlms_rol.length, 1);
  assert.equal(crm.tabellen.lab_aanmeldingen.length, 2);
  assert.equal(crm.tabellen.lab_aanmeldingen[1].resultaat, 'nieuwe_link');
  assert.equal(crm.tabellen.lab_aanmeldingen[1].hook, 'H07');
  assert.equal(mails[1].subject, 'Je nieuwe link voor The Lab');
  assert.equal(lms.tabellen.hlms_lab_sleutel.length, 2);
});

test('bestaande 7-daagse-lead behoudt zijn bron', async () => {
  crm = nieuweCrm([{ id: 'lead-7', email: GELDIG.email, bron: '7-daagse-v2', soort: 'instagram', traject: '7-daagse', verwijderd_op: null }]);
  await post(GELDIG);
  assert.equal(crm.tabellen.leads.length, 1);
  assert.equal(crm.tabellen.leads[0].bron, '7-daagse-v2');
  assert.equal(crm.tabellen.lab_aanmeldingen[0].lead_id, 'lead-7');
  assert.equal(lms.tabellen.hlms_lab_lead[0].crm_lead_id, 'lead-7');
});

test('bestaande student: nooit trial erbij, wel "je hebt al toegang"', async () => {
  lms = maakFakeDb({
    'auth.users': [{ id: 'auth-s', email: GELDIG.email }],
    hlms_rol: [{ auth_id: 'auth-s', rol: 'student' }],
    hlms_student: [{ id: 's1', email: GELDIG.email.toUpperCase() }],
  });
  const r = await post(GELDIG);
  assert.equal(r.body.bericht, (await post({ ...GELDIG, email: 'iemand.anders@voorbeeld.be' })).body.bericht, 'zelfde antwoord: geen orakel');
  assert.deepEqual(lms.tabellen.hlms_rol.filter((x) => x.auth_id === 'auth-s').map((x) => x.rol), ['student']);
  assert.equal((lms.tabellen.hlms_lab_lead || []).filter((x) => x.email === GELDIG.email).length, 0);
  assert.equal(mails[0].subject, 'Je hebt al toegang bij De Forex Opleiding');
  assert.equal(crm.tabellen.lab_aanmeldingen[0].resultaat, 'al_toegang');
});

test('mentor (alleen hlms_rol) en zaalaccount (alleen trial) blijven onaangeroerd', async () => {
  lms = maakFakeDb({
    'auth.users': [{ id: 'auth-m', email: 'mentor@voorbeeld.be' }, { id: 'auth-e', email: 'event3@deforexopleiding.nl' }],
    hlms_rol: [{ auth_id: 'auth-m', rol: 'mentor' }, { auth_id: 'auth-e', rol: 'trial' }],
  });
  await post({ ...GELDIG, email: 'mentor@voorbeeld.be' });
  await post({ ...GELDIG, email: 'event3@deforexopleiding.nl' });
  assert.equal(lms.tabellen.hlms_rol.length, 2);
  assert.equal((lms.tabellen.hlms_lab_lead || []).length, 0);
  assert.equal(lms.authUsers.length, 2);
  assert.deepEqual(crm.tabellen.lab_aanmeldingen.map((a) => a.resultaat), ['al_toegang', 'al_toegang']);
});

test('beslisAccount: de regels zelf', () => {
  const leeg = { labLead: null, authId: null, rollen: [], heeftStudentRij: false, heeftPersoneelRij: false };
  assert.equal(beslisAccount(leeg), 'nieuw');
  assert.equal(beslisAccount({ ...leeg, labLead: { id: 1 } }), 'bestaand_lab');
  assert.equal(beslisAccount({ ...leeg, authId: 'a', rollen: ['trial'] }), 'heeft_toegang');
  assert.equal(beslisAccount({ ...leeg, authId: 'a', rollen: ['admin'] }), 'heeft_toegang');
  assert.equal(beslisAccount({ ...leeg, heeftStudentRij: true }), 'heeft_toegang');
  assert.equal(beslisAccount({ ...leeg, authId: 'a' }), 'koppel_bestaande_auth');
});

test('honeypot: gewoon antwoord, maar niets aangemaakt of verstuurd', async () => {
  const r = await post({ ...GELDIG, website: 'http://spam.example' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal((crm.tabellen.leads || []).length, 0);
  assert.equal(lms.authUsers.length, 0);
  assert.equal(mails.length, 0);
});

test('zonder toestemming: geen WhatsApp, ook al staat er een goedgekeurd template', async () => {
  crm = nieuweCrm([], { onderhoud_sjablonen: [{ id: 's1', traject_slug: 'the-lab', soort: 'welkom', kanaal: 'whatsapp', actief: true, meta_template: 'lab_welkom', variabele_volgorde: ['voornaam', 'loginlink'] }] });
  waLive = [{ name: 'lab_welkom', language: 'nl' }];
  await post({ ...GELDIG, toestemming: false });
  assert.equal(waVerstuurd.length, 0);
  assert.equal(crm.tabellen.lab_aanmeldingen[0].wa_status, 'geen_toestemming');
  assert.equal(mails.length, 1, 'de loginmail gaat wél');
});

test('met toestemming en een goedgekeurd template: WhatsApp met voornaam en loginlink', async () => {
  crm = nieuweCrm([], { onderhoud_sjablonen: [{ id: 's1', traject_slug: 'the-lab', soort: 'welkom', kanaal: 'whatsapp', actief: true, meta_template: 'lab_welkom', variabele_volgorde: ['voornaam', 'loginlink'] }] });
  waLive = [{ name: 'lab_welkom', language: 'nl' }];
  await post(GELDIG);
  assert.equal(waVerstuurd.length, 1);
  assert.equal(waVerstuurd[0].to, '32472223752');
  assert.equal(waVerstuurd[0].variables[0], 'Maxim');
  assert.match(waVerstuurd[0].variables[1], /\/the-lab\/start\/\?s=/);
  assert.equal(crm.tabellen.lab_aanmeldingen[0].wa_status, 'verstuurd');
});

test('validatie: ontbrekende velden en een onbekend nummer geven 400 met het veld', async () => {
  assert.equal((await post({ ...GELDIG, email: 'geen-adres' })).body.veld, 'email');
  assert.equal((await post({ ...GELDIG, voornaam: '  ' })).body.veld, 'voornaam');
  assert.equal((await post({ ...GELDIG, gsm: '' })).body.veld, 'gsm');
  assert.equal((await post({ ...GELDIG, gsm: '12' })).statusCode, 400);
  assert.equal(lms.authUsers.length, 0);
});

test('LMS-migratie nog niet gedraaid: geen trial zonder einddatum, wel een gewoon antwoord', async () => {
  lms = maakFakeDb({}, { ontbrekend: ['hlms_lab_lead'] });
  const r = await post(GELDIG);
  assert.equal(r.statusCode, 200);
  assert.equal(lms.authUsers.length, 0, 'het net aangemaakte account is opgeruimd');
  assert.equal((lms.tabellen.hlms_rol || []).length, 0);
  assert.equal(crm.tabellen.lab_aanmeldingen[0].resultaat, 'lms_fout');
  assert.equal(mails.length, 0);
  assert.match(r.body.bericht, /klaar/, 'geen belofte van een mail die nog niet weg is');
});

test('CRM-migratie nog niet gedraaid: aanmelding werkt gewoon door', async () => {
  crm = maakFakeDb({}, { rpc: { upsert_lead: upsertLeadRpc }, ontbrekend: ['lab_aanmeldingen', 'lab_meta_events'] });
  const r = await post(GELDIG);
  assert.equal(r.statusCode, 200);
  assert.equal(lms.tabellen.hlms_lab_lead.length, 1);
  assert.equal(mails.length, 1);
});

test('CORS: een vreemd origin wordt niet gereflecteerd', async () => {
  const r = await post(GELDIG, { origin: 'https://kwaad.example' });
  assert.equal(r.headers['access-control-allow-origin'], 'https://lms.deforexopleiding.nl');
  const r2 = await post(GELDIG, { origin: 'https://www.deforexopleiding.nl' });
  assert.equal(r2.headers['access-control-allow-origin'], 'https://www.deforexopleiding.nl');
});
