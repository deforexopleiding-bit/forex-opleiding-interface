// tests/lead-inlog-opnieuw.test.js
//
// "Inloggegevens opnieuw versturen" voor een lead.
//
// WAT HIER MISGING (vóór deze wijziging):
//   1. Een alternatief adres maakte een TWEEDE account. De endpoint gaf het adres
//      blind door aan dfo-website, en die doet geefToegang({email}) — bij een
//      onbekend adres een nieuwe lms_gebruikers-rij + auth-user. De lead kon dan
//      met het nieuwe adres in een leeg account inloggen, en het oude bleef staan.
//   2. Geen `soort` → een minicursus-lead kreeg het 7-daagse-sjabloon.
//   3. "Geef toegang" stuurde product 'mini-cursus' (slug is 'minicursus') → 400.
//   4. lead-toegang-verlenen las `wa?.ok` op een ARRAY → toast zei altijd
//      "welkomstmail MISLUKT", ook als de mail wél was verstuurd.
//
// De handler draait hier echt: supabase, rechten en fetch (naar dfo-website)
// zijn gestubd; we kijken naar wat er geschreven en verstuurd wordt.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { welkomUitkomst } from '../api/_lib/welkom.js';
import {
  normaliseerProductSlug, bepaalSoort, toegangStatus, verplaatsAccountEmail,
} from '../api/_lib/lead-lms-account.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const ACC_ID = '22222222-2222-4222-8222-222222222222';
const AUTH_ID = '33333333-3333-4333-8333-333333333333';
const MINI_ID = '7cade2aa-f104-48a0-a913-7906086187a1';
const ZEVEN_ID = '2d3eea2b-6f80-4dd7-b258-e5d96f2b90f1';

// ─── Nep-supabase ────────────────────────────────────────────────────────────
// Elke query wordt vastgelegd als { tabel, op, payload, filters }. Een
// `antwoord(q)`-functie bepaalt wat lees-queries opleveren.
function nepAdmin(antwoord, opties = {}) {
  const log = [];
  const authCalls = [];
  const from = (tabel) => {
    const q = { tabel, op: 'select', payload: null, filters: {}, neq: {} };
    const resolve = () => {
      log.push(q);
      if (q.op === 'select') return Promise.resolve(antwoord(q) || { data: null, error: null });
      if (opties.schrijfFout && opties.schrijfFout(q)) return Promise.resolve({ data: null, error: opties.schrijfFout(q) });
      return Promise.resolve({ data: null, error: null });
    };
    const b = {
      select: () => b,
      eq: (k, v) => { q.filters[k] = v; return b; },
      neq: (k, v) => { q.neq[k] = v; return b; },
      limit: () => b, order: () => b, in: () => b, is: () => b,
      update: (p) => { q.op = 'update'; q.payload = p; return b; },
      insert: (p) => { q.op = 'insert'; q.payload = p; return b; },
      upsert: (p) => { q.op = 'upsert'; q.payload = p; return b; },
      delete: () => { q.op = 'delete'; return b; },
      maybeSingle: () => resolve(),
      single: () => resolve(),
      then: (ok, nok) => resolve().then(ok, nok),
    };
    return b;
  };
  return {
    from,
    auth: {
      admin: {
        updateUserById: async (id, attrs) => {
          authCalls.push({ id, attrs });
          return opties.authFout ? { data: null, error: opties.authFout } : { data: { user: { id } }, error: null };
        },
        createUser: async () => { throw new Error('createUser hoort hier NOOIT te gebeuren'); },
      },
    },
    _log: log,
    _auth: authCalls,
  };
}

/** Standaard-DB: een lead met een bestaand account en een minicursus-grant. */
function standaardAntwoord({ lead = {}, account = 'default', grants = null, bezet = {} } = {}) {
  const L = { id: LEAD_ID, voornaam: 'Sanne', achternaam: 'Jansen', email: 'oud@voorbeeld.nl', traject: 'minicursus', ...lead };
  const A = account === 'default'
    ? { id: ACC_ID, auth_id: AUTH_ID, email: 'oud@voorbeeld.nl', lead_id: LEAD_ID, toegang_tot: '2020-09-01T00:00:00Z' }
    : account;
  // Verlopen in het verleden: de GET-test verwacht 'verlopen', ongeacht de klok.
  const G = grants || [{ id: 'g-mini', product_id: MINI_ID, toegang_van: '2020-08-01T00:00:00Z', toegang_tot: '2020-08-31T00:00:00Z' }];
  return (q) => {
    if (q.tabel === 'leads' && q.filters.id) return { data: L, error: null };
    if (q.tabel === 'leads' && q.filters.email) return { data: bezet.lead ? [{ id: 'andere-lead' }] : [], error: null };
    if (q.tabel === 'lms_gebruikers' && q.filters.lead_id) return { data: A && A.lead_id === q.filters.lead_id ? A : null, error: null };
    if (q.tabel === 'lms_gebruikers' && q.filters.email) {
      if (bezet.account && q.filters.email === bezet.account) return { data: { id: 'ander-account' }, error: null };
      return { data: A && A.email === q.filters.email ? A : null, error: null };
    }
    if (q.tabel === 'lms_toegang') return { data: A ? G : [], error: null };
    if (q.tabel === 'lms_producten') return { data: [{ id: MINI_ID, slug: 'minicursus' }, { id: ZEVEN_ID, slug: '7-daagse' }], error: null };
    return { data: null, error: null };
  };
}

function nepRes() {
  const uit = { code: null, body: null };
  return {
    setHeader() {},
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

/** Stub fetch naar dfo-website; legt de verstuurde bodies vast. */
function stubFetch(t, { ok = true, status = 200, body = { ok: true } } = {}) {
  const verstuurd = [];
  const oud = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    verstuurd.push({ url: String(u), body: JSON.parse(init.body) });
    return {
      ok, status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  t.after(() => { globalThis.fetch = oud; });
  return verstuurd;
}

async function laadResend({ admin, rechten = { 'leads.view': true, 'leads.update': true } }) {
  process.env.INTERNE_WELKOM_URL = 'https://dfo.test/api/interne-welkom-mail';
  process.env.INTERNE_WELKOM_SECRET = 'geheim';
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      supabase: {},
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async (_req, key) => !!rechten[key],
      requirePermissionFailOpen: async (_req, key) => !!rechten[key],
    },
  });
  const mod = await import(url('api/lead-welkom-resend.js') + '?t=' + Math.random());
  return mod.default;
}

const post = (body) => ({ method: 'POST', headers: {}, body, query: {} });
const writes = (admin, tabel) => admin._log.filter((q) => q.tabel === tabel && q.op !== 'select');

// ─── Endpoint: geen account → fout, géén nieuw account ──────────────────────

test('geen LMS-account → 409 GEEN_ACCOUNT, niets verstuurd en niets aangemaakt', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord({ account: null }));
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID }), res);
  assert.equal(res._uit.code, 409);
  assert.equal(res._uit.body.code, 'GEEN_ACCOUNT');
  assert.match(res._uit.body.error, /Geef toegang/);
  assert.equal(verstuurd.length, 0, 'zonder account mag er niets naar dfo-website (die zou een account aanmaken)');
  assert.equal(admin._log.filter((q) => q.op !== 'select').length, 0);
});

test('geen account + alternatief adres → ook 409, geen tweede account', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord({ account: null }));
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: 'nieuw@voorbeeld.nl' }), res);
  assert.equal(res._uit.code, 409);
  assert.equal(verstuurd.length, 0);
  assert.equal(admin._auth.length, 0);
});

// ─── Endpoint: zonder alternatief adres ─────────────────────────────────────

test('zonder alternatief → mail naar het geregistreerde adres, met de juiste soort', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.sent, true);
  assert.equal(res._uit.body.doel_email, 'oud@voorbeeld.nl');
  assert.equal(verstuurd.length, 1);
  assert.equal(verstuurd[0].body.email, 'oud@voorbeeld.nl');
  assert.equal(verstuurd[0].body.soort, 'minicursus', 'minicursus-lead hoort het minicursus-sjabloon te krijgen');
  assert.equal(admin._auth.length, 0, 'geen adreswijziging → auth niet aanraken');
});

test('de grant die dfo bij `soort` reset, wordt teruggezet op het oude venster', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID }), res);
  const herstel = writes(admin, 'lms_toegang');
  assert.equal(herstel.length, 1);
  assert.equal(herstel[0].op, 'update');
  assert.equal(herstel[0].filters.id, 'g-mini');
  assert.deepEqual(herstel[0].payload, { toegang_van: '2020-08-01T00:00:00Z', toegang_tot: '2020-08-31T00:00:00Z' });
  assert.equal(res._uit.body.toegang_hersteld, true);
});

test('geen grant op het product → soort niet meesturen (dfo zou er een aanmaken)', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord({ grants: [] }));
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID }), res);
  assert.equal(res._uit.code, 200);
  assert.equal('soort' in verstuurd[0].body, false);
  assert.equal(res._uit.body.soort_bepaald, 'minicursus');
  assert.equal(writes(admin, 'lms_toegang').length, 0);
});

test('alternatief gelijk aan het huidige adres (andere hoofdletters) → gewoon opnieuw sturen', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  stubFetch(t);
  const handler = await laadResend({ admin, rechten: { 'leads.view': true } });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: '  OUD@voorbeeld.nl ' }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.email_gewijzigd, null);
  assert.equal(admin._auth.length, 0);
});

test('mislukte mail → 200 met sent:false en een leesbare reden', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  stubFetch(t, { ok: false, status: 502, body: { fout: 'Verzenden mislukt' } });
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.sent, false);
  assert.match(res._uit.body.reden, /Verzenden mislukt/);
  assert.equal(writes(admin, 'lms_toegang').length, 1, 'ook bij een fout het venster terugzetten');
});

test('elke verzending komt in de audit_log', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  stubFetch(t);
  const handler = await laadResend({ admin });
  await handler(post({ lead_id: LEAD_ID }), nepRes());
  const a = writes(admin, 'audit_log');
  assert.equal(a.length, 1);
  assert.equal(a[0].payload.entity_type, 'lead');
  assert.equal(a[0].payload.entity_id, LEAD_ID);
  assert.equal(a[0].payload.action, 'lead.inlog_opnieuw_verstuurd');
});

// ─── Endpoint: met alternatief adres ────────────────────────────────────────

test('alternatief adres → bestaand account verplaatst, mail naar het nieuwe adres', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: 'Nieuw@Voorbeeld.nl' }), res);
  assert.equal(res._uit.code, 200, JSON.stringify(res._uit.body));
  assert.deepEqual(admin._auth, [{ id: AUTH_ID, attrs: { email: 'nieuw@voorbeeld.nl' } }]);
  const lw = writes(admin, 'leads');
  assert.equal(lw.length, 1);
  assert.deepEqual(lw[0].payload, { email: 'nieuw@voorbeeld.nl' });
  const gw = writes(admin, 'lms_gebruikers');
  assert.equal(gw.length, 1);
  assert.equal(gw[0].filters.id, ACC_ID, 'het BESTAANDE account wordt bijgewerkt');
  assert.equal(gw[0].payload.email, 'nieuw@voorbeeld.nl');
  assert.equal(admin._log.some((q) => q.tabel === 'lms_gebruikers' && q.op === 'insert'), false);
  assert.equal(verstuurd[0].body.email, 'nieuw@voorbeeld.nl');
  assert.deepEqual(res._uit.body.email_gewijzigd, { van: 'oud@voorbeeld.nl', naar: 'nieuw@voorbeeld.nl' });
});

test('alternatief adres vereist leads.update', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin, rechten: { 'leads.view': true } });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: 'nieuw@voorbeeld.nl' }), res);
  assert.equal(res._uit.code, 403);
  assert.equal(verstuurd.length, 0);
  assert.equal(admin._auth.length, 0);
});

test('alternatief adres in gebruik door een ander account → 409, niets gewijzigd', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord({ bezet: { account: 'bezet@voorbeeld.nl' } }));
  const verstuurd = stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: 'bezet@voorbeeld.nl' }), res);
  assert.equal(res._uit.code, 409);
  assert.equal(res._uit.body.code, 'EMAIL_IN_GEBRUIK');
  assert.equal(admin._auth.length, 0);
  assert.equal(verstuurd.length, 0);
});

test('alternatief adres in gebruik door een andere lead → 409 vóór de auth-wijziging', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord({ bezet: { lead: true } }));
  stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: 'nieuw@voorbeeld.nl' }), res);
  assert.equal(res._uit.code, 409);
  assert.equal(admin._auth.length, 0);
});

test('ongeldig alternatief adres → 400', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  stubFetch(t);
  const handler = await laadResend({ admin });
  const res = nepRes();
  await handler(post({ lead_id: LEAD_ID, email: 'geen-adres' }), res);
  assert.equal(res._uit.code, 400);
});

test('GET geeft het geregistreerde adres, de toegangsstatus en de soort', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin(standaardAntwoord());
  const handler = await laadResend({ admin, rechten: { 'leads.view': true } });
  const res = nepRes();
  await handler({ method: 'GET', headers: {}, query: { lead_id: LEAD_ID } }, res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.account.email, 'oud@voorbeeld.nl');
  assert.equal(res._uit.body.account.verlopen, true);
  assert.equal(res._uit.body.soort, 'minicursus');
  assert.equal(res._uit.body.mag_adres_wijzigen, false);
  assert.equal(admin._log.filter((q) => q.op !== 'select').length, 0, 'GET schrijft niets');
});

// ─── verplaatsAccountEmail: terugdraaien als een latere stap faalt ──────────

test('faalt leads.update na de auth-wijziging → auth wordt teruggezet', async () => {
  const admin = nepAdmin(standaardAntwoord(), {
    schrijfFout: (q) => (q.tabel === 'leads' && q.op === 'update' ? { code: '23505', message: 'duplicate key' } : null),
  });
  const r = await verplaatsAccountEmail(admin, {
    account: { id: ACC_ID, auth_id: AUTH_ID, email: 'oud@voorbeeld.nl', lead_id: LEAD_ID },
    leadId: LEAD_ID, oudeLeadEmail: 'oud@voorbeeld.nl', nieuweEmail: 'nieuw@voorbeeld.nl',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.deepEqual(admin._auth.map((c) => c.attrs.email), ['nieuw@voorbeeld.nl', 'oud@voorbeeld.nl']);
});

test('auth-botsing → 409 zonder DB-writes', async () => {
  const admin = nepAdmin(standaardAntwoord(), { authFout: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' } });
  const r = await verplaatsAccountEmail(admin, {
    account: { id: ACC_ID, auth_id: AUTH_ID, email: 'oud@voorbeeld.nl', lead_id: LEAD_ID },
    leadId: LEAD_ID, oudeLeadEmail: 'oud@voorbeeld.nl', nieuweEmail: 'nieuw@voorbeeld.nl',
  });
  assert.equal(r.status, 409);
  assert.equal(admin._log.filter((q) => q.op !== 'select').length, 0);
});

test('account van een andere lead wordt niet verplaatst', async () => {
  const admin = nepAdmin(standaardAntwoord());
  const r = await verplaatsAccountEmail(admin, {
    account: { id: ACC_ID, auth_id: AUTH_ID, email: 'oud@voorbeeld.nl', lead_id: '99999999-9999-4999-8999-999999999999' },
    leadId: LEAD_ID, oudeLeadEmail: 'oud@voorbeeld.nl', nieuweEmail: 'nieuw@voorbeeld.nl',
  });
  assert.equal(r.code, 'ACCOUNT_VAN_ANDERE_LEAD');
  assert.equal(admin._auth.length, 0);
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

test('productslug-aliassen worden genormaliseerd', () => {
  for (const a of ['mini-cursus', 'Mini Cursus', 'mini', '2', 'minicursus', ' MINI-CURSUS ']) {
    assert.equal(normaliseerProductSlug(a), 'minicursus', a);
  }
  for (const a of ['7 daagse', '7daagse', '7-daagse', '7']) {
    assert.equal(normaliseerProductSlug(a), '7-daagse', a);
  }
  assert.equal(normaliseerProductSlug('1-op-1-coaching'), '1-op-1-coaching');
  assert.equal(normaliseerProductSlug(''), null);
  assert.equal(normaliseerProductSlug(null), null);
});

test('soort uit traject, anders uit de grants', () => {
  assert.equal(bepaalSoort({ traject: 'minicursus' }), 'minicursus');
  assert.equal(bepaalSoort({ traject: 'kennismakingscursus-v2' }), 'minicursus');
  assert.equal(bepaalSoort({ traject: '7-daagse-v1' }), '7-daagse');
  assert.equal(bepaalSoort({ traject: 'event', grantSlugs: ['minicursus'] }), 'minicursus');
  assert.equal(bepaalSoort({ traject: null, grantSlugs: ['7-daagse', 'minicursus'] }), '7-daagse');
  assert.equal(bepaalSoort({ traject: 'event' }), null);
});

test('toegangsstatus: laatste datum telt, NULL op een grant = onbeperkt', () => {
  const nu = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual(toegangStatus({ toegang_tot: '2026-09-01T00:00:00Z' }, [], nu),
    { toegang_tot: '2026-09-01T00:00:00.000Z', onbeperkt: false, verlopen: true });
  assert.equal(toegangStatus({ toegang_tot: '2026-09-01T00:00:00Z' }, [{ toegang_tot: '2026-11-01T00:00:00Z' }], nu).verlopen, false);
  assert.equal(toegangStatus({}, [{ toegang_tot: null }], nu).onbeperkt, true);
  assert.equal(toegangStatus({}, [], nu).verlopen, null);
});

test('welkomUitkomst leest de ARRAY van stuurWelkom (bug: wa?.ok was altijd undefined)', () => {
  assert.deepEqual(welkomUitkomst([{ kanaal: 'email', ok: true }]).ok, true);
  assert.equal(welkomUitkomst([{ kanaal: 'email', ok: false, status: 502 }]).reden, 'HTTP 502');
  assert.equal(welkomUitkomst([{ kanaal: 'email', ok: false, reden: 'niet-geconfigureerd' }]).reden, 'niet-geconfigureerd');
  assert.equal(welkomUitkomst([]).ok, false);
  assert.equal(welkomUitkomst(null).ok, false);
});

test('lead-toegang-verlenen gebruikt welkomUitkomst en de slug-normalisatie', () => {
  const src = readFileSync(join(ROOT, 'api/lead-toegang-verlenen.js'), 'utf8');
  assert.doesNotMatch(src, /wa\?\.ok/);
  assert.match(src, /welkomUitkomst\(wa/);
  assert.match(src, /normaliseerProductSlug\(/);
});

test("de 'Geef toegang'-knop stuurt de echte slug 'minicursus'", () => {
  const src = readFileSync(join(ROOT, 'modules/klanten-v2/views/leadsonderhoud-v2.js'), 'utf8');
  assert.doesNotMatch(src, /product = 'mini-cursus'/);
  assert.match(src, /product = 'minicursus'/);
});

// ─── De gedeelde popup ──────────────────────────────────────────────────────

function laadPopup() {
  const window = {};
  const ctx = createContext({ window, document: {}, console, Number, String, Date, JSON, Math, encodeURIComponent });
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/_inlog-opnieuw.js'), 'utf8'), ctx);
  return window.InlogOpnieuw;
}

test('popup-melding: succes, gewijzigd adres, mislukte mail en fouten', () => {
  const P = laadPopup();
  // (vm-context: objecten uit de sandbox zijn niet deepEqual met deze realm)
  const ok = P.bouwMelding(200, { ok: true, sent: true, doel_email: 'a@b.nl' });
  assert.equal(ok.ok, true);
  assert.equal(ok.tekst, 'Inloglink verstuurd naar a@b.nl');
  const gew = P.bouwMelding(200, { ok: true, sent: true, doel_email: 'n@b.nl', email_gewijzigd: { van: 'o@b.nl', naar: 'n@b.nl' } });
  assert.equal(gew.ok, true);
  assert.match(gew.tekst, /gewijzigd van o@b\.nl naar n@b\.nl/);
  const mis = P.bouwMelding(200, { ok: true, sent: false, reden: 'HTTP 502' });
  assert.equal(mis.ok, false);
  assert.match(mis.tekst, /mislukt \(HTTP 502\)/);
  assert.match(P.bouwMelding(409, { code: 'GEEN_ACCOUNT', error: 'Gebruik "Geef toegang"' }).tekst, /Geef toegang/);
  assert.equal(P.bouwMelding(500, null).tekst, 'Versturen mislukt (HTTP 500)');
  assert.match(P.bouwMelding(200, { ok: true, sent: true, doel_email: 'a@b.nl', toegang_hersteld: false }).tekst, /niet worden teruggezet/);
});

test('popup wordt door beide views gebruikt en staat vóór hen in index.html', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const iPopup = html.indexOf('views/_inlog-opnieuw.js');
  assert.ok(iPopup > 0);
  assert.ok(iPopup < html.indexOf('views/leads-v2.js'));
  assert.ok(iPopup < html.indexOf('views/leadsonderhoud-v2.js'));
  const leads = readFileSync(join(ROOT, 'modules/klanten-v2/views/leads-v2.js'), 'utf8');
  const lo = readFileSync(join(ROOT, 'modules/klanten-v2/views/leadsonderhoud-v2.js'), 'utf8');
  assert.match(leads, /InlogOpnieuw\.open\(/);
  assert.match(lo, /InlogOpnieuw\.open\(/);
  assert.ok((lo.match(/__lsInlogOpnieuw\(/g) || []).length >= 2, 'Contacten-rij én Gesprekken-kop');
});
