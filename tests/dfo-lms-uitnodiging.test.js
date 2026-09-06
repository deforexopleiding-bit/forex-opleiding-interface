// tests/dfo-lms-uitnodiging.test.js
//
// Borgt de drie dingen die bij de LMS-uitnodiging een klant kunnen schaden:
//
//   1. DE GRENDEL. Is er al eerder gemaild (uitnodiging_verstuurd_op gevuld),
//      dan mag stap 2 NIET draaien. Anders krijgt de student een tweede mail
//      én werkt zijn eerste wachtwoord niet meer.
//   2. DE AFSLUITENDE SCHUINE STREEP. Zonder die streep volgt een 308, en de
//      x-dfo-secret-header valt bij die omleiding weg — je krijgt dan een 403
//      die niets met het geheim te maken heeft.
//   3. HET ONDERSCHEID tussen mail_mislukt (niets veranderd, veilig opnieuw)
//      en mail_verstuurd_wachtwoord_niet_gezet (student kan er NIET in).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  stuurLmsUitnodiging,
  bouwUrl,
  MAIL_VERSTUURD,
  MAIL_MISLUKT,
  MAIL_VERSTUURD_WACHTWOORD_NIET_GEZET,
  FOUT_PREFIX_HERSTELBAAR,
  FOUT_PREFIX_ACTIE_VEREIST,
} from '../api/_lib/dfo-lms-uitnodiging.js';

const echteFetch = globalThis.fetch;
let gedaan = [];   // alle aanroepen die de module deed

function nepFetch(routes) {
  return async (url, opts) => {
    gedaan.push({ url: String(url), opts });
    // De stap-2-URL bevat OOK het stap-1-pad
    // (.../studenten/<id>/uitnodiging/). Kies daarom de sleutel die het
    // LAATST in de URL voorkomt — dat is het meest specifieke stuk.
    const u = String(url);
    const key = Object.keys(routes)
      .filter((k) => u.includes(k))
      .sort((a, b) => u.lastIndexOf(b) - u.lastIndexOf(a))[0];
    const r = key ? routes[key] : { status: 404, body: { code: 'niet_gevonden' } };
    return {
      status: r.status ?? 200,
      json: async () => r.body,
    };
  };
}

beforeEach(() => {
  gedaan = [];
  process.env.DFO_LMS_PUSH_SECRET = 'test-geheim';
  process.env.DFO_LMS_BASE_URL = 'https://lms.test.local';
});
afterEach(() => { globalThis.fetch = echteFetch; });

// ── 1) De afsluitende schuine streep ────────────────────────────────────────

test('bouwUrl zet altijd een afsluitende schuine streep', () => {
  assert.equal(bouwUrl('/api/admin/studenten'), 'https://lms.test.local/api/admin/studenten/');
  assert.equal(bouwUrl('/api/admin/studenten/'), 'https://lms.test.local/api/admin/studenten/');
  assert.equal(bouwUrl('api/admin/studenten'), 'https://lms.test.local/api/admin/studenten/');
});

test('bouwUrl werkt ook als de basis-URL zelf een streep heeft', () => {
  process.env.DFO_LMS_BASE_URL = 'https://lms.test.local/';
  assert.equal(bouwUrl('/api/admin/studenten/'), 'https://lms.test.local/api/admin/studenten/');
});

test('beide aangeroepen paden eindigen op een schuine streep', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'gekoppeld_aan_bestaande_rij',
      data: { student: { id: 'stud-1', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: 'uitnodiging_verstuurd' } },
  });
  await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(gedaan.length, 2);
  for (const g of gedaan) {
    assert.ok(g.url.endsWith('/'), 'pad zonder afsluitende streep: ' + g.url);
  }
});

test('een 308 wordt herkend en niet stil gevolgd', async () => {
  globalThis.fetch = nepFetch({ '/api/admin/studenten/': { status: 308, body: null } });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.match(r.fout, /omleiding 308/);
  assert.match(r.fout, /schuine streep/);
});

// ── 2) DE GRENDEL ───────────────────────────────────────────────────────────

test('GRENDEL: al eerder gemaild → stap 2 wordt NIET aangeroepen', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'gekoppeld_aan_bestaande_rij',
      data: { student: { id: 'stud-1', uitnodiging_verstuurd_op: '2026-09-01T10:00:00Z' } } } },
    '/uitnodiging/': { body: { code: 'uitnodiging_verstuurd' } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });

  assert.equal(gedaan.length, 1, 'stap 2 had NIET aangeroepen mogen worden');
  assert.ok(!gedaan.some((g) => g.url.includes('/uitnodiging/')));
  assert.equal(r.ok, true);
  assert.equal(r.overgeslagen, true);
  assert.equal(r.verstuurd, false);
  assert.equal(r.uitnodiging_verstuurd_op, '2026-09-01T10:00:00Z');
});

test('GRENDEL: nog nooit gemaild (null) → stap 2 draait wel', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'aangemaakt',
      data: { student: { id: 'stud-2', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: 'uitnodiging_verstuurd' } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, true);
  assert.equal(r.verstuurd, true);
  assert.ok(gedaan.some((g) => g.url.includes('/uitnodiging/')));
});

// ── 3) Codes van stap 1 ─────────────────────────────────────────────────────

for (const code of ['aangemaakt', 'gekoppeld_aan_bestaande_rij',
                    'gekoppeld_aan_bestaand_account', 'bestaat_al']) {
  test(`stap 1 code '${code}' telt als geslaagd`, async () => {
    globalThis.fetch = nepFetch({
      '/api/admin/studenten/': { body: { code,
        data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
      '/uitnodiging/': { body: { code: 'uitnodiging_verstuurd' } },
    });
    const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
    assert.equal(r.ok, true, 'code ' + code);
  });
}

test('half_aangemaakt stuurt GEEN uitnodiging en meldt het auth_id', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'half_aangemaakt',
      data: { auth_id: 'auth-9' } } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.equal(r.herstelbaar, true);
  assert.match(r.fout, /auth-9/);
  assert.ok(!gedaan.some((g) => g.url.includes('/uitnodiging/')));
});

test('er wordt op code geprogrammeerd, niet op de HTTP-status', async () => {
  // HTTP 200, maar een code die geen succes is → moet falen.
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { status: 200, body: { code: 'rommel', message: 'ok!' } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.match(r.fout, /onverwachte code/);
});

// ── 4) De twee foutcodes van stap 2 ─────────────────────────────────────────

test('mail_mislukt: herstelbaar, geen actie vereist', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'gekoppeld_aan_bestaande_rij',
      data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: MAIL_MISLUKT } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.equal(r.herstelbaar, true);
  assert.notEqual(r.actie_vereist, true);
  assert.ok(r.fout.startsWith(FOUT_PREFIX_HERSTELBAAR));
});

test('mail_verstuurd_wachtwoord_niet_gezet: actie vereist, NIET als herstelbaar', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'gekoppeld_aan_bestaande_rij',
      data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: MAIL_VERSTUURD_WACHTWOORD_NIET_GEZET } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.equal(r.actie_vereist, true);
  assert.notEqual(r.herstelbaar, true);
  assert.ok(r.fout.startsWith(FOUT_PREFIX_ACTIE_VEREIST));
});

test('de twee foutgevallen krijgen VERSCHILLENDE voorvoegsels', () => {
  assert.notEqual(FOUT_PREFIX_HERSTELBAAR, FOUT_PREFIX_ACTIE_VEREIST);
});

// ── 5) Headers en geheim ────────────────────────────────────────────────────

test('stap 1 stuurt x-dfo-secret + content-type; stap 2 alleen het geheim', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'aangemaakt',
      data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: 'uitnodiging_verstuurd' } },
  });
  await stuurLmsUitnodiging({ email: 'a@b.nl' });

  const stap1 = gedaan.find((g) => !g.url.includes('/uitnodiging/'));
  const stap2 = gedaan.find((g) =>  g.url.includes('/uitnodiging/'));

  assert.equal(stap1.opts.headers['x-dfo-secret'], 'test-geheim');
  assert.equal(stap1.opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(stap1.opts.body), { email: 'a@b.nl', herkomst: 'crm' });

  assert.equal(stap2.opts.headers['x-dfo-secret'], 'test-geheim');
  assert.equal(stap2.opts.headers['content-type'], undefined, 'stap 2 stuurt geen content-type');
  assert.equal(stap2.opts.body, undefined, 'stap 2 stuurt geen body');
});

test('zonder geheim wordt er niets aangeroepen', async () => {
  delete process.env.DFO_LMS_PUSH_SECRET;
  globalThis.fetch = nepFetch({});
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.equal(r.overgeslagen, true);
  assert.equal(gedaan.length, 0);
});

test('e-mail wordt genormaliseerd naar kleine letters', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'aangemaakt',
      data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: 'uitnodiging_verstuurd' } },
  });
  await stuurLmsUitnodiging({ email: '  Wim@Example.NL ' });
  const stap1 = gedaan.find((g) => !g.url.includes('/uitnodiging/'));
  assert.equal(JSON.parse(stap1.opts.body).email, 'wim@example.nl');
});


// ── 6) De succescode van stap 2 is STRAK vastgepind ─────────────────────────

test('uitnodiging_verstuurd telt als geslaagd en geeft verstuurd_naar terug', async () => {
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'aangemaakt',
      data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: MAIL_VERSTUURD,
      data: { student: { id: 's' }, verstuurd_naar: 'a@b.nl' } } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, true);
  assert.equal(r.verstuurd, true);
  assert.equal(r.verstuurd_naar, 'a@b.nl');
});

test('een ONBEKENDE code van stap 2 telt NIET als succes', async () => {
  // Een contractwijziging aan LMS-kant mag niet stil als 'gemaild' passeren:
  // dan denken wij dat de student een mail heeft die hij misschien nooit kreeg.
  globalThis.fetch = nepFetch({
    '/api/admin/studenten/': { body: { code: 'aangemaakt',
      data: { student: { id: 's', uitnodiging_verstuurd_op: null } } } },
    '/uitnodiging/': { body: { code: 'iets_nieuws' } },
  });
  const r = await stuurLmsUitnodiging({ email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'iets_nieuws');
  assert.match(r.fout, /onbekende code/);
  assert.match(r.fout, /uitnodiging_verstuurd/);
});
