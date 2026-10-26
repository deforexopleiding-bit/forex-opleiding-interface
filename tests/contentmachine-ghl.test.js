// tests/contentmachine-ghl.test.js — Contentmachine fase 5: nieuwsbrief via GoHighLevel.
//
//   1. helper: config/ontbrekende env, template aanmaken + vullen, eigen contact, testmail, stats
//   2. endpoint: niet gekoppeld → 503 met env-namen; naar-ghl enkel na goedkeuren; template
//      hergebruikt; testmail enkel naar de ingelogde gebruiker; stats → status verstuurd
//   3. NOOIT een verzending naar de lijst: enkel /conversations/messages naar één contact

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldOutput } from './_contentmachine-voorbeeld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fake = maakFake();
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from: fake.from },
    supabaseAdmin: { from: fake.from, storage: fake.storage },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'maxim@x.nl' } } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: () => false,
  },
});
mock.module('../api/_lib/requirePermission.js', { namedExports: { requirePermission: async () => true } });

const G = await import('../api/_lib/ghl-nieuwsbrief.js');
const NB = await import('../api/contentmachine/nieuwsbrief.js');

const ID = '99999999-9999-4999-8999-999999999999';
const ENV = { GHL_PIT_TOKEN: 'pit-x', GHL_LOCATION_ID: 'loc1', GHL_DAVE_USER_ID: 'usr1' };

/** Nep-GHL: logt elke aanroep, antwoordt per pad. */
function nepGhl(antwoorden = {}) {
  const log = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const sleutel = `${init.method || 'GET'} ${u.pathname}`;
    log.push({ sleutel, url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const a = antwoorden[sleutel] ?? { status: 200, json: {} };
    const r = typeof a === 'function' ? a(u, init) : a;
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.json ?? {}) };
  };
  return { f, log };
}

test('config: ontbrekende env-namen, links naar het e-mailgedeelte', () => {
  const leeg = G.ghlNieuwsbriefConfig({});
  assert.equal(leeg.ok, false);
  assert.deepEqual(leeg.ontbreekt, ['GHL_PIT_TOKEN', 'GHL_LOCATION_ID']);
  const ok = G.ghlNieuwsbriefConfig({ GHL_API_KEY: 'k', GHL_LOCATION_ID: 'loc1' });
  assert.equal(ok.ok, true);
  assert.equal(G.ghlLinks('loc1').campagnes, 'https://app.gohighlevel.com/v2/location/loc1/marketing/emails/scheduled');
});

test('template: aanmaken (type html) → redirect = id; vullen met html + previewText', async () => {
  const cfg = G.ghlNieuwsbriefConfig(ENV);
  const { f, log } = nepGhl({ 'POST /emails/builder': { status: 201, json: { redirect: 'tpl1', traceId: 't' } } });
  assert.equal(await G.maakTemplate(cfg, { naam: 'DFO drop 22-10-26' }, f), 'tpl1');
  await G.vulTemplate(cfg, { templateId: 'tpl1', html: '<p>x</p>', previewText: 'pre' }, f);
  assert.equal(log[0].body.type, 'html'); assert.equal(log[0].body.locationId, 'loc1');
  assert.equal(log[0].headers.Version, '2021-07-28');
  assert.deepEqual([log[1].sleutel, log[1].body.editorType, log[1].body.html, log[1].body.previewText, log[1].body.updatedBy], ['POST /emails/builder/data', 'html', '<p>x</p>', 'pre', 'usr1']);
});

test('fout met 403 → duidelijke melding over de scopes', async () => {
  const cfg = G.ghlNieuwsbriefConfig(ENV);
  const { f } = nepGhl({ 'POST /emails/builder': { status: 403, json: { message: 'The token is not authorized for this scope.' } } });
  await assert.rejects(() => G.maakTemplate(cfg, { naam: 'x' }, f), /scopes/);
});

test('eigen contact: eerst zoeken, anders upsert ZONDER tags; testmail naar één contact', async () => {
  const cfg = G.ghlNieuwsbriefConfig(ENV);
  const { f, log } = nepGhl({
    'GET /contacts/search/duplicate': { status: 200, json: { contact: null } },
    'POST /contacts/upsert': { status: 200, json: { contact: { id: 'c9' } } },
    'POST /conversations/messages': { status: 200, json: { messageId: 'm1', conversationId: 'cv', status: 'pending' } },
  });
  const id = await G.eigenContact(cfg, { email: 'maxim@x.nl', naam: 'Maxim' }, f);
  assert.equal(id, 'c9');
  assert.equal(log[1].body.tags, undefined, 'geen tags op het eigen contact');
  await G.stuurTestmail(cfg, { contactId: id, email: 'maxim@x.nl', onderwerp: 'Hallo', html: '<p>x</p>' }, f);
  const m = log[2];
  assert.deepEqual([m.body.type, m.body.contactId, m.body.emailTo, m.body.subject], ['Email', 'c9', 'maxim@x.nl', '[TEST] Hallo']);
  assert.equal(m.headers.Version, '2021-04-15');
});

test('stats: enkel campagnes met dit template; veldnamen defensief', async () => {
  const cfg = G.ghlNieuwsbriefConfig(ENV);
  const { f, log } = nepGhl({ 'GET /emails/schedule': { status: 200, json: { schedules: [
    { id: 'k1', name: 'Drop', status: 'complete', templateId: 'tpl1', stats: { sent: 6012, opened: 2400, clicked: 310 } },
    { id: 'k2', name: 'Andere', status: 'draft', templateId: 'tplX' },
  ] } } });
  const c = await G.campagnesVoorTemplate(cfg, { templateId: 'tpl1' }, f);
  assert.deepEqual(c, [{ id: 'k1', naam: 'Drop', status: 'complete', stats: { verstuurd: 6012, geopend: 2400, geklikt: 310, uitgeschreven: null, bounces: null } }]);
  assert.match(log[0].url, /showStats=true/);
  assert.equal(G.statsUit({}), null);
});

// ── endpoint ────────────────────────────────────────────────────────────────
function reset(status = 'goedgekeurd') {
  fake.db.tabellen = {
    profiles: [{ id: 'u1', email: 'maxim@x.nl', full_name: 'Maxim', role: 'super_admin' }],
    content_drops: [{ id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status, versie: 3, input: {}, output: voorbeeldOutput() }],
    content_assets: [], nieuwsbrief_verzendingen: [],
  };
}
async function roep(body, method = 'POST', query = {}) {
  const res = maakRes(); res.send = function (b) { this.body = b; return this; };
  await NB.default({ method, body, query, headers: {} }, res);
  return res;
}
function metEnv(env, fn) {
  const oud = {}; for (const k of Object.keys(ENV)) { oud[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  return fn().finally(() => { for (const k of Object.keys(ENV)) { if (oud[k] === undefined) delete process.env[k]; else process.env[k] = oud[k]; } });
}

test('endpoint: niet gekoppeld → 503 met de env-namen; status-GET werkt zonder GHL', () => metEnv({}, async () => {
  reset();
  const r = await roep({ actie: 'naar-ghl', id: ID });
  assert.equal(r.statusCode, 503); assert.equal(r.body.code, 'GHL_NIET_GEKOPPELD'); assert.match(r.body.error, /GHL_PIT_TOKEN/);
  const s = await roep(undefined, 'GET', { id: ID, ghl: '1' });
  assert.equal(s.statusCode, 200); assert.equal(s.body.ghl.gekoppeld, false); assert.equal(s.body.verzending, null);
}));

test('endpoint: naar-ghl enkel na goedkeuren; tweede keer = zelfde template bijwerken; test + stats', () => metEnv(ENV, async () => {
  const { f, log } = nepGhl({
    'POST /emails/builder': { status: 201, json: { redirect: 'tpl1' } },
    'GET /contacts/search/duplicate': { status: 200, json: { contact: { id: 'c1' } } },
    'GET /emails/schedule': { status: 200, json: { schedules: [{ id: 'k1', status: 'complete', templateId: 'tpl1', stats: { opened: 12 } }] } },
  });
  const echt = globalThis.fetch; globalThis.fetch = f;
  try {
    reset('gegenereerd');
    assert.equal((await roep({ actie: 'naar-ghl', id: ID })).statusCode, 409, 'eerst goedkeuren');
    reset('goedgekeurd');
    const a = await roep({ actie: 'naar-ghl', id: ID, onderwerp: 1 });
    assert.equal(a.statusCode, 200, JSON.stringify(a.body));
    assert.equal(a.body.verzending.template_id, 'tpl1');
    assert.equal(a.body.verzending.status, 'concept');
    assert.equal(a.body.verzending.onderwerp, voorbeeldOutput().nieuwsbrief.onderwerpen[1]);
    const html = log.find((x) => x.sleutel === 'POST /emails/builder/data').body.html;
    assert.match(html, /\{\{unsubscribe_link\}\}/, 'uitschrijf-merge-tag van GHL');
    const b = await roep({ actie: 'naar-ghl', id: ID });
    assert.equal(b.statusCode, 200);
    assert.equal(log.filter((x) => x.sleutel === 'POST /emails/builder').length, 1, 'template wordt hergebruikt');
    assert.equal(fake.db.tabellen.nieuwsbrief_verzendingen.length, 1);
    const t = await roep({ actie: 'test', id: ID });
    assert.equal(t.statusCode, 200); assert.equal(t.body.naar, 'maxim@x.nl');
    assert.equal(t.body.verzending.status, 'test_verstuurd');
    const s = await roep({ actie: 'stats', id: ID });
    assert.equal(s.statusCode, 200);
    assert.equal(s.body.verzending.status, 'verstuurd'); assert.equal(s.body.verzending.campagne_id, 'k1');
    assert.equal(s.body.verzending.stats.laatste.geopend, 12);
    // Er gaat nooit iets naar de lijst: de enige verzending is één testmail naar één contact.
    const verzonden = log.filter((x) => x.sleutel === 'POST /conversations/messages');
    assert.equal(verzonden.length, 1); assert.equal(verzonden[0].body.contactId, 'c1');
    assert.ok(!log.some((x) => /campaign|bulk|schedule/i.test(x.sleutel) && x.sleutel.startsWith('POST')), 'geen campagne-/bulkaanroep');
  } finally { globalThis.fetch = echt; }
}));

test('bedrading: werkblad heeft het GHL-paneel; geen Brevo in de code', () => {
  const w = readFileSync(join(ROOT, 'modules/klanten-v2/views/contentmachine-werkblad-v2.js'), 'utf8');
  for (const t of ['Zet in GHL', 'Stuur test naar mij', 'Open in GHL', 'Ververs stats', 'GHL nog niet gekoppeld']) assert.ok(w.includes(t), t);
  for (const pad of ['api/contentmachine/nieuwsbrief.js', 'api/_lib/ghl-nieuwsbrief.js', 'api/_lib/nieuwsbrief-render.js']) {
    const code = readFileSync(join(ROOT, pad), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /brevo/i, pad);
  }
});
