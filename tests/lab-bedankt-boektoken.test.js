// tests/lab-bedankt-boektoken.test.js
//
// Bedankpagina van de Lab-funnels (2026-10-20): meteen de strategiesessie
// boeken zonder LMS-sessie, met het boektoken uit /api/lab-aanmelding.
//   - token: ondertekend, verloopt, wijst naar één aanmelding;
//   - GET/POST /api/lab-sessie met `Authorization: LabBoek <token>` = exact het
//     LMS-pad: bron 'the-lab', gastheer eigenaar, LMS-vinkje;
//   - zonder lab-lead (bestaande student / LMS even weg): boeken voor de persoon
//     van de aanmelding, zonder LMS-vinkje;
//   - testaanmelding (+labtest) → TEST-afspraak (niet in Daves agenda);
//   - al geboekt → 409; vervalst of verlopen token → 401;
//   - geen no-show-akkoord in dit pad (gemeten: ook niet in het LMS-pad).

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb, upsertLeadRpc } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role';
process.env.GHL_CALENDAR_ID = 'cal';
process.env.GHL_PIT_TOKEN = 'tok';

let crm; let lms; let geboekt; let ghlSlots; let metaEvents;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/create-appointment-from-lead.js'), { namedExports: {
  createAppointmentForLead: async (a) => { geboekt.push(a); return { appointment_id: 'afspraak-1', zoom_join_url: 'https://zoom.us/j/1' }; },
  mapGhlError: () => '',
} });
mock.module(url('api/_lib/lab-meta.js'), { namedExports: {
  stuurLabEvent: async (e) => { metaEvents.push(e); return { ok: true }; },
  labEventId: (n, k) => `lab_${n.toLowerCase()}_${k}`, labUserData: () => ({}),
} });
const echteSlots = await import(url('api/public-opstartsessie-free-slots.js'));
const { default: _slotsHandler, ...slotsNamed } = echteSlots;
mock.module(url('api/public-opstartsessie-free-slots.js'), { defaultExport: _slotsHandler, namedExports: { ...slotsNamed, fetchGhlSlots: async () => ghlSlots } });

const { default: sessie } = await import(url('api/lab-sessie.js'));
const { maakBoektoken, leesBoektoken, boektokenUitHeader } = await import(url('api/_lib/lab-boektoken.js'));
const { _resetGastheerCache } = await import(url('api/_lib/lab-gastheer.js'));

const AID = '0b9c1f8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
const DAVE = { id: 'prof-dave', email: 'dave@deforexopleiding.nl', full_name: 'Dave Heylen', avatar_url: null, is_active: true };
const AANM = { id: AID, lead_id: 'lead-1', email: 'lead@voorbeeld.nl', voornaam: 'Lien', achternaam: null, telefoon_e164: '+31612345678', lms_lead_id: 'll-1', is_test: false };
const LAB = { id: 'll-1', auth_id: 'auth-1', email: 'lead@voorbeeld.nl', voornaam: 'Lien', achternaam: null, telefoon: '+31612345678', crm_lead_id: 'lead-1', toegang_tot: new Date(Date.now() + 5 * 86400000).toISOString(), sessie_moment: null, is_test: false };

beforeEach(() => {
  crm = maakFakeDb({
    leads: [{ id: 'lead-1', voornaam: 'Lien', email: 'lead@voorbeeld.nl', telefoon_e164: '+31612345678' }],
    profiles: [{ ...DAVE }], app_settings: [], lab_aanmeldingen: [{ ...AANM }], follow_up_appointments: [],
  }, { rpc: { upsert_lead: upsertLeadRpc }, verplicht: {} });
  lms = maakFakeDb({ hlms_lab_lead: [{ ...LAB }] });
  _resetGastheerCache();
  geboekt = []; metaEvents = [];
  const d = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  ghlSlots = { [d]: { slots: [`${d}T10:00:00+02:00`, `${d}T14:30:00+02:00`] } };
});

function res() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
const vraag = async (method, token, body) => { const r = res(); await sessie({ method, headers: { origin: 'https://www.deforexopleiding.nl', ...(token ? { authorization: 'LabBoek ' + token } : {}) }, body }, r); return r; };

test('token: ondertekend, verloopt, wijst naar één aanmelding', () => {
  const t = maakBoektoken({ aanmeldingId: AID, funnel: 'the-lab-v1' });
  assert.deepEqual(leesBoektoken(t), { ok: true, aanmeldingId: AID, funnel: 'the-lab-v1' });
  assert.equal(leesBoektoken(t.slice(0, -2) + 'xx').ok, false, 'vervalste handtekening');
  assert.equal(leesBoektoken(t.replace(AID, AID.replace('0b9', '1b9'))).ok, false, 'ander id');
  assert.equal(leesBoektoken(maakBoektoken({ aanmeldingId: AID, nu: Date.now() - 49 * 3600 * 1000 })).reden, 'verlopen');
  assert.equal(maakBoektoken({ aanmeldingId: 'geen-uuid' }), null);
  assert.doesNotMatch(t, /lead@|Lien/, 'geen persoonsgegevens in het token');
  assert.equal(boektokenUitHeader({ headers: { authorization: 'LabBoek abc' } }), 'abc');
  assert.equal(boektokenUitHeader({ headers: { authorization: 'Bearer abc' } }), null);
});

test('GET met token: echte momenten + echte telling deze week, gastheer zonder e-mail', async () => {
  const r = await vraag('GET', maakBoektoken({ aanmeldingId: AID, funnel: 'the-lab-v1' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.momenten.length, 2);
  assert.equal(typeof r.body.deze_week, 'number');
  assert.equal(r.body.gastheer?.email, undefined);
});

test('POST met token: zelfde boekpad — bron the-lab, gastheer eigenaar, 30 min, LMS-vinkje, Schedule met funnel', async () => {
  const t = maakBoektoken({ aanmeldingId: AID, funnel: 'the-lab-v2' });
  const g = await vraag('GET', t);
  const r = await vraag('POST', t, { moment: g.body.momenten[0] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.afspraak_id, 'afspraak-1');
  assert.equal(geboekt[0].source, 'the-lab');
  assert.equal(geboekt[0].durationMinutes, 30);
  assert.equal(geboekt[0].lead.owner_id, 'prof-dave');
  assert.equal(geboekt[0].lead.lead_phone, '+31612345678');
  assert.match(geboekt[0].ghlTitel, /^The Lab · strategiesessie · /);
  assert.equal(lms.tabellen.hlms_lab_lead[0].sessie_afspraak_id, 'afspraak-1');
  assert.equal(metaEvents[0].eventName, 'Schedule');
  assert.equal(metaEvents[0].eventId, 'lab_schedule_afspraak-1');
  assert.deepEqual(metaEvents[0].customData, { content_name: 'Lab-strategiesessie', content_category: 'the-lab', funnel: 'the-lab-v2' });
  // Geen no-show-akkoord nodig (zelfde als het LMS-pad).
  assert.equal('noshow_akkoord' in geboekt[0], false);
  // Tweede keer: al geboekt.
  assert.equal((await vraag('POST', t, { moment: g.body.momenten[1] })).statusCode, 409);
});

test('zonder lab-lead (bestaande student / LMS weg): boeken voor de aanmelding, geen LMS-vinkje; daarna al geboekt via het CRM', async () => {
  crm.tabellen.lab_aanmeldingen[0].lms_lead_id = null;
  const t = maakBoektoken({ aanmeldingId: AID });
  const g = await vraag('GET', t);
  const r = await vraag('POST', t, { moment: g.body.momenten[0] });
  assert.equal(r.statusCode, 200);
  assert.equal(geboekt[0].lead.id, 'lead-1');
  assert.equal(lms.tabellen.hlms_lab_lead[0].sessie_afspraak_id ?? null, null);
  crm.tabellen.follow_up_appointments.push({ id: 'afspraak-1', booking_source: 'the-lab', lead_email: 'lead@voorbeeld.nl', scheduled_at: g.body.momenten[0], status: 'scheduled' });
  const g2 = await vraag('GET', t);
  assert.ok(g2.body.geboekt, 'boeking zonder LMS-vinkje telt ook');
});

test('testaanmelding (+labtest): TEST-afspraak, niet in Daves agenda, geen Meta', async () => {
  crm.tabellen.lab_aanmeldingen[0].is_test = true;
  const t = maakBoektoken({ aanmeldingId: AID });
  const g = await vraag('GET', t);
  const r = await vraag('POST', t, { moment: g.body.momenten[0] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.test, true);
  assert.equal(geboekt.length, 0);
  assert.equal(metaEvents.length, 0);
  const a = crm.tabellen.follow_up_appointments.find((x) => x.is_test);
  assert.equal(a.booking_source, 'the-lab');
});

test('ongeldig, vervalst of onbekend token → 401', async () => {
  assert.equal((await vraag('GET', 'lb1.x.y.z.w')).statusCode, 401);
  assert.equal((await vraag('GET', maakBoektoken({ aanmeldingId: '11111111-1111-1111-1111-111111111111' }))).statusCode, 401);
});

test('bedrading: /api/lab-aanmelding geeft elk bewaard adres een boektoken (geen orakel)', () => {
  const src = lees('api/lab-aanmelding.js');
  assert.match(src, /const boekToken = bewaard \? maakBoektoken\(\{ aanmeldingId, funnel: d\.funnel \}\) : null;/);
  assert.match(src, /boek_token: boekToken \}\);/);
  assert.match(src, /if \(v\.bot\) return res\.status\(200\)\.json\(\{ ok: true, event_id: null, bericht: BERICHT_OK, boek_token: null \}\);/);
});
