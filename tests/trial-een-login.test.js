// tests/trial-een-login.test.js
//
// "Eén login voor alle funnels" (26 okt 2026). Legt vast:
//   1. productUitBron / variantUitBron / schakelaar / herkomst — de pure regels;
//   2. de WhatsApp-gate (belProvisioning) maakt in 'lab'-stand een lab-lead in
//      het echte LMS met product + bron + crm_lead_id, stuurt de welkomstmail
//      van de belofte en GEEN tweede WhatsApp — en belt dfo-website niet;
//   3. in 'oud'-stand blijft het oude pad (dfo-website /api/interne-welkom);
//   4. een herhaling voor dezelfde aanvraag maakt geen tweede trial;
//   5. een verlopen lab-lead die opnieuw binnenkomt krijgt een verse week,
//      hoogstens één keer per 30 dagen;
//   6. een webinar-aanmelding krijgt een trial met product 'webinar'.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

let crm; let lms; let mails; let waVerstuurd;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: (e) => e?.code === '23505' } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: {
  sendEmailViaSmtp: async (m) => { mails.push(m); return { ok: true, messageId: 'mid-' + mails.length }; },
} });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: {
  haalLijn: async () => ({ module: 'leadsonderhoud', phoneNumberId: 'pn-1', label: 'hoofdnummer' }),
  mailAfzender: () => 'welkom@deforexopleiding.nl',
} });
const leeg = async () => ({ ok: false });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendTemplate: async (a) => { waVerstuurd.push(a); return { wamid: 'wamid-1' }; },
  goedgekeurdeTemplatesOpLijn: async () => ({ ok: true, templates: [] }),
  templateStatusOpLijn: leeg, d360PhoneNumberId: () => null, d360NummerVoorPhoneNumberId: () => null,
  _resetTemplateCache: () => {}, huidigeLijnId: () => null, lijnFamilie: () => null, kiesVerzendroute: () => null,
  sendText: leeg, sendMedia: leeg, markAsRead: leeg, listTemplates: leeg,
  verifyWebhookSignature: () => false, verifyWebhookSubscription: () => null, getConfigStatus: () => ({}),
  MetaNotConfiguredError: class extends Error {},
} });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const tp = await import(url('api/_lib/trial-product.js'));
const { belProvisioning } = await import(url('api/_lib/toegang-provisioning-caller.js'));
const { magVerlengen } = await import(url('api/_lib/dfo-lms-lab-account.js'));
const { trialVoorWebinar } = await import(url('api/public-webinar-aanmelding.js'));

const LEAD = { id: '11111111-1111-4111-8111-111111111111', email: 'maxim.delombaerde96+mini1@gmail.com', voornaam: 'Maxim', telefoon_e164: '+32472223752', toestemming: true, bron: 'kennismakingscursus-v9', verwijderd_op: null, aangemaakt: '2026-10-26T08:00:00Z' };
const AANVRAAG = { id: '22222222-2222-4222-8222-222222222222', email: LEAD.email, voornaam: 'Maxim', telefoon: '+32472223752', soort: 'minicursus', bron: 'kennismakingscursus-v9', status: 'gereageerd' };

beforeEach(() => {
  crm = maakFakeDb({ leads: [{ ...LEAD }], toegang_aanvragen: [{ ...AANVRAAG }], app_settings: [] });
  lms = maakFakeDb({});
  mails = []; waVerstuurd = [];
});

// ── 1. Pure regels ──────────────────────────────────────────────────────────

test('productUitBron: elke funnel naar zijn belofte', () => {
  assert.equal(tp.productUitBron('kennismakingscursus-v10'), 'minicursus');
  assert.equal(tp.productUitBron('7-daagse-v6'), '7-daagse');
  assert.equal(tp.productUitBron('webinar-v2'), 'webinar');
  assert.equal(tp.productUitBron('the-lab-v1'), 'the-lab');
  assert.equal(tp.productUitBron('the-lab'), 'the-lab');
  assert.equal(tp.productUitBron('website', '7-daagse'), 'website');
  assert.equal(tp.productUitBron(null, 'minicursus'), 'minicursus');
  assert.equal(tp.productUitBron('onbekend', '7-daagse'), '7-daagse');
  assert.equal(tp.variantUitBron('kennismakingscursus-v9'), 'v9');
  assert.equal(tp.variantUitBron('the-lab-site'), 'site');
  assert.equal(tp.variantUitBron('website'), null);
});

test('schakelaar: standaard lab, per product terug te zetten, onzin = lab', () => {
  assert.equal(tp.bestemmingUit(null, 'minicursus'), 'lab');
  assert.equal(tp.bestemmingUit({ minicursus: 'oud' }, 'minicursus'), 'oud');
  assert.equal(tp.bestemmingUit({ minicursus: 'oud' }, '7-daagse'), 'lab');
  assert.equal(tp.bestemmingUit('{"webinar":"OUD"}', 'webinar'), 'oud');
  assert.equal(tp.bestemmingUit({ webinar: 'ergens' }, 'webinar'), 'lab');
});

test('herkomst: kolommen, of de marker van vóór de migratie, anders The Lab; nieuwe beloftes mogen', () => {
  assert.deepEqual(tp.herkomstVanAanmelding({ product: 'minicursus', bron: 'kennismakingscursus-v9' }), { product: 'minicursus', bron: 'kennismakingscursus-v9', variant: 'v9' });
  assert.deepEqual(tp.herkomstVanAanmelding({ landingspagina: tp.herkomstMarker('7-daagse', '7-daagse-v6') }), { product: '7-daagse', bron: '7-daagse-v6', variant: 'v6' });
  assert.equal(tp.herkomstVanAanmelding({ landingspagina: 'https://www.deforexopleiding.nl/the-lab' }).product, 'the-lab');
  assert.equal(tp.isProduct('eerste-trade'), true);
  assert.equal(tp.productLabel('eerste-trade'), 'Eerste trade');
  assert.equal(tp.productLabel('minicursus'), 'Minicursus');
  assert.equal(tp.isProduct('<script>'), false);
});

test('magVerlengen: alleen verlopen, niet geboekt, en vorige start ≥ 30 dagen geleden', () => {
  const nu = Date.parse('2026-11-30T12:00:00Z');
  assert.equal(magVerlengen({ toegang_van: '2026-10-01T00:00:00Z', toegang_tot: '2026-10-08T00:00:00Z' }, nu), true);
  assert.equal(magVerlengen({ toegang_van: '2026-11-20T00:00:00Z', toegang_tot: '2026-11-27T00:00:00Z' }, nu), false, 'minder dan 30 dagen');
  assert.equal(magVerlengen({ toegang_van: '2026-10-01T00:00:00Z', toegang_tot: '2026-12-08T00:00:00Z' }, nu), false, 'nog geldig');
  assert.equal(magVerlengen({ toegang_van: '2026-10-01T00:00:00Z', toegang_tot: '2026-10-08T00:00:00Z', sessie_geboekt_op: '2026-10-05T00:00:00Z' }, nu), false, 'geboekt');
});

// ── 2-4. De WhatsApp-gate ───────────────────────────────────────────────────

test('gate in lab-stand: lab-lead met herkomst + lead_id, welkomstmail van de minicursus, geen WhatsApp, geen dfo-website', async () => {
  const oudFetch = globalThis.fetch;
  let gebeld = 0;
  globalThis.fetch = async () => { gebeld++; return new Response('{}', { status: 200 }); };
  try {
    const r = await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
    assert.equal(r.ok, true);
    assert.equal(r.body.bestemming, 'lab');
    assert.equal(gebeld, 0, 'het oude trial-LMS wordt niet meer aangesproken');

    const ll = lms.tabellen.hlms_lab_lead[0];
    assert.equal(ll.product, 'minicursus');
    assert.equal(ll.bron, 'kennismakingscursus-v9');
    assert.equal(ll.variant, 'v9');
    assert.equal(ll.crm_lead_id, LEAD.id, 'altijd de CRM lead_id');
    assert.equal(ll.is_test, true, 'plus-adres van Maxim = test');

    const a = crm.tabellen.lab_aanmeldingen[0];
    assert.equal(a.product, 'minicursus');
    assert.equal(a.toegang_aanvraag_id, AANVRAAG.id);
    assert.equal(a.lead_id, LEAD.id);
    assert.equal(a.resultaat, 'nieuw_account');
    assert.equal(a.wa_status, 'gate_bevestigd');
    assert.equal(waVerstuurd.length, 0);

    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, 'Je minicursus staat klaar');
    assert.match(mails[0].html, /Log in/);
    assert.match(mails[0].html, /\/the-lab\/start\/\?s=/);
    assert.doesNotMatch(mails[0].html, /deforexopleiding\.nl\/lms/, 'nooit meer het oude platform');
  } finally { globalThis.fetch = oudFetch; }
});

test('gate: een herhaling voor dezelfde aanvraag maakt geen tweede trial of aanmelding', async () => {
  await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
  await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
  assert.equal(lms.tabellen.hlms_lab_lead.length, 1);
  assert.equal(crm.tabellen.lab_aanmeldingen.length, 1);
});

test('gate in oud-stand: het oude pad via dfo-website blijft werken', async () => {
  crm.tabellen.app_settings.push({ key: 'trial_bestemming', value: { minicursus: 'oud' } });
  const oudFetch = globalThis.fetch;
  const oudEnv = { u: process.env.TOEGANG_PROVISIONING_URL, s: process.env.TOEGANG_PROVISIONING_SECRET };
  process.env.TOEGANG_PROVISIONING_URL = 'https://dfo.test/api/interne-welkom';
  process.env.TOEGANG_PROVISIONING_SECRET = 'geheim';
  const calls = [];
  globalThis.fetch = async (u, o) => { calls.push({ u, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  try {
    const r = await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].u, 'https://dfo.test/api/interne-welkom');
    assert.equal(calls[0].body.soort, 'minicursus');
    assert.equal((lms.tabellen.hlms_lab_lead || []).length, 0);
  } finally {
    globalThis.fetch = oudFetch;
    if (oudEnv.u === undefined) delete process.env.TOEGANG_PROVISIONING_URL; else process.env.TOEGANG_PROVISIONING_URL = oudEnv.u;
    if (oudEnv.s === undefined) delete process.env.TOEGANG_PROVISIONING_SECRET; else process.env.TOEGANG_PROVISIONING_SECRET = oudEnv.s;
  }
});

test('gate: zonder de CRM-migratie bewaart de aanmelding de herkomst in landingspagina', async () => {
  const echt = crm;
  // Nep: lab_aanmeldingen kent de nieuwe kolommen nog niet.
  crm = new Proxy(echt, { get(t, k) {
    if (k !== 'from') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
    return (tabel) => {
      const q = t.from(tabel);
      if (tabel !== 'lab_aanmeldingen') return q;
      const insert = q.insert.bind(q);
      q.insert = (rij) => ('product' in rij ? { then: (ok) => ok({ data: null, error: { code: 'PGRST204', message: "Could not find the 'product' column" } }) } : insert(rij));
      return q;
    };
  } });
  try {
    const r = await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
    assert.equal(r.ok, true);
    const a = echt.tabellen.lab_aanmeldingen[0];
    assert.equal(tp.herkomstVanAanmelding(a).product, 'minicursus');
  } finally { crm = echt; }
});

test('verlopen lab-lead komt via een nieuwe belofte terug: verse week + welkomstmail', async () => {
  lms = maakFakeDb({ hlms_lab_lead: [{ id: 'll-1', auth_id: 'au-1', email: AANVRAAG.email, voornaam: 'Maxim', toegang_van: '2026-08-01T00:00:00Z', toegang_tot: '2026-08-08T00:00:00Z', crm_lead_id: LEAD.id, product: 'the-lab' }] });
  const r = await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
  assert.equal(r.ok, true);
  assert.equal(r.body.resultaat, 'verlengd');
  const ll = lms.tabellen.hlms_lab_lead[0];
  assert.ok(Date.parse(ll.toegang_tot) > Date.now() + 6.9 * 86400000);
  assert.equal(mails[0].subject, 'Je minicursus staat klaar');
});

// ── 6. Webinar ──────────────────────────────────────────────────────────────

test('webinar-aanmelding: trial met product webinar en de webinar-welkomstmail', async () => {
  const r = await trialVoorWebinar({ bron: 'webinar-v2', email: 'jan.webinar@gmail.com', voornaam: 'Jan', telefoon: null, toestemming: false, leadId: null });
  assert.equal(r.ok, true);
  assert.equal(r.product, 'webinar');
  assert.equal(lms.tabellen.hlms_lab_lead[0].product, 'webinar');
  assert.match(mails[0].subject, /webinar/i);
});

test('webinar in oud-stand: geen trial', async () => {
  crm.tabellen.app_settings.push({ key: 'trial_bestemming', value: { webinar: 'oud' } });
  const r = await trialVoorWebinar({ bron: 'webinar-v2', email: 'jan.webinar@gmail.com', voornaam: 'Jan', leadId: null });
  assert.equal(r.overgeslagen, 'bestemming_oud');
  assert.equal((lms.tabellen.hlms_lab_lead || []).length, 0);
});

test('funneltegels: een minicursus-trial in lab_aanmeldingen telt NIET als The Lab', async () => {
  const { telAanmeldingen } = await import(url('api/_lib/aanmeldingen-per-funnel.js'));
  const uit = telAanmeldingen({ labAanmeldingen: [
    { email: 'lab.lead@gmail.com', product: 'the-lab' },
    { email: 'oud.lab@gmail.com' },
    { email: 'mini.lead@gmail.com', product: 'minicursus' },
    { email: 'mini.marker@gmail.com', landingspagina: 'trial:minicursus:kennismakingscursus-v9' },
  ] });
  const lab = uit.tegels.overig.delen['the-lab'];
  assert.equal(lab, 2);
});

test('zonder de CRM-migratie: herhaling na een LMS-storing hergebruikt de mislukte aanmelding', async () => {
  const echt = crm;
  crm = new Proxy(echt, { get(t, k) {
    if (k !== 'from') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
    return (tabel) => {
      const q = t.from(tabel);
      if (tabel !== 'lab_aanmeldingen') return q;
      const insert = q.insert.bind(q); const eq = q.eq.bind(q);
      q.insert = (rij) => ('product' in rij ? { then: (ok) => ok({ data: null, error: { code: 'PGRST204', message: "Could not find the 'product' column" } }) } : insert(rij));
      q.eq = (kol, v) => (kol === 'toegang_aanvraag_id' ? { limit: () => ({ then: (ok) => ok({ data: null, error: { code: '42703', message: 'column lab_aanmeldingen.toegang_aanvraag_id does not exist' } }) }) } : eq(kol, v));
      return q;
    };
  } });
  const lmsEcht = lms;
  try {
    lms = null; // eerste poging: LMS niet geconfigureerd → lms_fout
    const r1 = await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
    assert.equal(r1.ok, false);
    lms = lmsEcht;
    const r2 = await belProvisioning({ email: AANVRAAG.email, voornaam: 'Maxim', soort: 'minicursus', aanvraagId: AANVRAAG.id });
    assert.equal(r2.ok, true);
    assert.equal(echt.tabellen.lab_aanmeldingen.length, 1);
    assert.equal(echt.tabellen.lab_aanmeldingen[0].resultaat, 'nieuw_account');
  } finally { crm = echt; lms = lmsEcht; }
});

test('agendatitel bij Dave: "Strategiesessie · via <belofte>", The Lab houdt de oude titel', async () => {
  const { sessieTitel } = await import(url('api/lab-sessie.js'));
  assert.equal(sessieTitel('minicursus', 'Lien Peeters'), 'Strategiesessie · via Minicursus · Lien Peeters');
  assert.equal(sessieTitel('7-daagse', 'Lien'), 'Strategiesessie · via 7-daagse · Lien');
  assert.equal(sessieTitel('the-lab', 'Lien'), 'The Lab · strategiesessie · Lien');
  assert.equal(sessieTitel(null, 'Lien'), 'The Lab · strategiesessie · Lien');
});
