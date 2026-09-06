// tests/opvolging-endpoint-404.test.js
//
// N — een 404-afhandeling die nooit draaide, en een 500 die de database citeert.
//
// GEMETEN IN PRODUCTIE. /api/opvolging-taak-update aangeroepen met een taak_id
// dat niet bestaat gaf: 500, met de tekst "Cannot coerce the result to a single
// JSON object". De lees-query deed `.single()`, en die geeft bij NUL rijen een
// FOUT in plaats van null. Die fout ging naar de catch, en de regel eronder —
// `if (!taak) return 404` — kon dus nooit uitgevoerd worden. De
// not-found-afhandeling stond er, zag er goed uit, en was nog geen enkele keer
// gedraaid.
//
// Voor Dave: klikt hij een knop op een kaart die intussen weg is — tweede
// tabblad, of de nachtelijke doorrol — dan krijgt hij een 500 met een
// databasezin, en dat leest als 'het systeem is stuk' in plaats van 'die kaart
// bestaat niet meer'. api/opvolging-aanmelding-actie.js deed het al goed, dus
// de twee buren spraken elkaar tegen: dat is geen keuze maar een fout.
//
// WAAROM DEZE TEST DE ECHTE HANDLER AANROEPT. Deze fout was langs geen enkele
// andere weg te zien. Een test op de broncode zou 'if (!taak) return 404'
// hebben gevonden en tevreden zijn geweest — precies wat er misging. Dus:
// supabase en de rechten worden gestubd, de handler draait echt, en we kijken
// naar de status die eruit komt.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const NIET_BESTAAND = '00000000-0000-4000-8000-000000000000';

/** Een nep-antwoord in de vorm die postgrest-js teruggeeft. */
const leeg = { data: null, error: null };

/**
 * Bouwt een supabaseAdmin-dubbelganger.
 *
 * `rijen` is een map van tabelnaam naar wat een lees-query moet opleveren.
 * Alles is chainbaar, en aan het eind staat maybeSingle/single.
 */
function nepAdmin(rijen = {}, opzet = {}) {
  const gebruikt = { maybeSingle: 0, single: 0 };
  const maakKetting = (tabel) => {
    const rij = Object.prototype.hasOwnProperty.call(rijen, tabel) ? rijen[tabel] : null;
    const k = {
      select: () => k, eq: () => k, neq: () => k, in: () => k, gte: () => k, lt: () => k,
      gt: () => k, lte: () => k, not: () => k, filter: () => k, order: () => k, limit: () => k,
      update: () => k, insert: () => k, upsert: () => k, delete: () => k,
      maybeSingle: async () => { gebruikt.maybeSingle += 1; return { data: rij, error: null }; },
      // Dit is het gedrag dat de bug veroorzaakte: .single() FAALT op nul rijen.
      single: async () => {
        gebruikt.single += 1;
        if (rij) return { data: rij, error: null };
        return { data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' } };
      },
      then: undefined,
    };
    return k;
  };
  return { from: (tabel) => (opzet.from ? opzet.from(tabel) : maakKetting(tabel)), _gebruikt: gebruikt };
}

function nepRes() {
  const uit = { code: null, body: null, headers: {} };
  return {
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

/** Laadt een endpoint met gestubde supabase + rechten. */
async function laadEndpoint(pad, { rijen = {}, mag = true, admin = null } = {}) {
  const a = admin || nepAdmin(rijen);
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: a,
      supabase: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } },
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => mag,
      requirePermissionFailOpen: async () => mag,
      checkPermissionOrDeny: async () => mag,
    },
  });
  const mod = await import(url(pad) + '?t=' + Math.random());
  return { handler: mod.default, admin: a };
}

const req = (body) => ({ method: 'POST', headers: { authorization: 'Bearer x' }, body, query: {} });

// ═══════════════════════════════════════════════════════════════════════════
// DE 404 DRAAIT NU ECHT
// ═══════════════════════════════════════════════════════════════════════════

test('taak-update: een taak_id dat niet bestaat geeft 404, geen 500', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadEndpoint('api/opvolging-taak-update.js', {
    rijen: { opvolging_taken: null },
  });
  const res = nepRes();
  await handler(req({ taak_id: NIET_BESTAAND, actie: 'later_vandaag' }), res);
  assert.equal(res._uit.code, 404, 'dit was een 500 met een databasezin erin');
  assert.match(res._uit.body.error, /bestaat niet/i);
});

test('en die 404 citeert de database niet', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadEndpoint('api/opvolging-taak-update.js', {
    rijen: { opvolging_taken: null },
  });
  const res = nepRes();
  await handler(req({ taak_id: NIET_BESTAAND, actie: 'later_vandaag' }), res);
  assert.doesNotMatch(JSON.stringify(res._uit.body), /coerce|JSON object|PGRST/i);
});

test('de lees-query gebruikt maybeSingle, niet single', async (t) => {
  // Dit is de eigenlijke oorzaak: .single() gooit op nul rijen.
  t.after(() => mock.reset());
  const admin = nepAdmin({ opvolging_taken: null });
  const { handler } = await laadEndpoint('api/opvolging-taak-update.js', { admin });
  await handler(req({ taak_id: NIET_BESTAAND, actie: 'later_vandaag' }), nepRes());
  assert.ok(admin._gebruikt.maybeSingle > 0, 'maybeSingle hoort gebruikt te worden');
  assert.equal(admin._gebruikt.single, 0, 'single zou hier weer een 500 opleveren');
});

test('een bestaande taak gaat gewoon door', async (t) => {
  // Een gate die alles tegenhoudt is geen gate. De gewone weg moet werken.
  t.after(() => mock.reset());
  const { handler } = await laadEndpoint('api/opvolging-taak-update.js', {
    rijen: { opvolging_taken: { id: NIET_BESTAAND, status: 'open', due: '2026-09-07' } },
  });
  const res = nepRes();
  await handler(req({ taak_id: NIET_BESTAAND, actie: 'later_vandaag' }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.success, true);
});

test('poging: een taak die niet bestaat geeft 404 in plaats van een FK-fout', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadEndpoint('api/opvolging-poging.js', {
    rijen: { opvolging_taken: null },
  });
  const res = nepRes();
  await handler(req({ taak_id: NIET_BESTAAND, soort: 'call' }), res);
  assert.equal(res._uit.code, 404);
  assert.match(res._uit.body.error, /bestaat niet/i);
});

test('poging: met een bestaande taak wordt hij gewoon geschreven', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadEndpoint('api/opvolging-poging.js', {
    rijen: { opvolging_taken: { id: NIET_BESTAAND }, opvolging_pogingen: { id: 'p1' } },
  });
  const res = nepRes();
  await handler(req({ taak_id: NIET_BESTAAND, soort: 'call' }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.success, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN DATABASETAAL MEER NAAR BUITEN
// ═══════════════════════════════════════════════════════════════════════════

test('een echte fout wordt gelogd, niet doorgestuurd', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin({}, {
    from: () => { throw new Error('relation "opvolging_taken" does not exist'); },
  });
  const { handler } = await laadEndpoint('api/opvolging-taak-update.js', { admin });
  const res = nepRes();
  await handler(req({ taak_id: NIET_BESTAAND, actie: 'later_vandaag' }), res);
  assert.equal(res._uit.code, 500);
  assert.equal(res._uit.body.error, 'Interne fout');
  assert.doesNotMatch(JSON.stringify(res._uit.body), /relation|does not exist/);
});

test('geen enkel opvolging-endpoint stuurt e.message nog door', async () => {
  // Acht bestanden deden dit, niet zes: dag, taken, weekbalk, poging,
  // taak-update, taak-create, aanmelding-actie en agenda.
  const bestanden = [
    'api/opvolging-taak-update.js', 'api/opvolging-poging.js', 'api/opvolging-dag.js',
    'api/opvolging-taken.js', 'api/opvolging-weekbalk.js', 'api/opvolging-taak-create.js',
    'api/opvolging-aanmelding-actie.js', 'api/opvolging-agenda.js',
  ];
  for (const p of bestanden) {
    const b = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(!/json\(\{ error: e\??\.message/.test(b), p + ' stuurt e.message nog door');
  }
});

test('en elk van die acht logt de echte tekst wél', async () => {
  // Anders is een 500 niet meer te onderzoeken; dan ruilen we een leesbaar
  // scherm voor een blinde vlek in de logs.
  const bestanden = [
    ['api/opvolging-taak-update.js', 'opvolging-taak-update'],
    ['api/opvolging-poging.js', 'opvolging-poging'],
    ['api/opvolging-dag.js', 'opvolging-dag'],
    ['api/opvolging-taken.js', 'opvolging-taken'],
    ['api/opvolging-weekbalk.js', 'opvolging-weekbalk'],
    ['api/opvolging-taak-create.js', 'opvolging-taak-create'],
    ['api/opvolging-aanmelding-actie.js', 'opvolging-aanmelding-actie'],
    ['api/opvolging-agenda.js', 'opvolging-agenda'],
  ];
  for (const [p, naam] of bestanden) {
    const b = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(b.includes("console.error('[" + naam + "]"), p + ' logt de fout niet');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EN .single() BLIJFT STAAN WAAR HIJ HOORT
// ═══════════════════════════════════════════════════════════════════════════

test('een insert houdt .single(), want die gééft altijd een rij', async () => {
  // maybeSingle zou daar een ontbrekend resultaat stil goedkeuren — precies de
  // omgekeerde fout. Klakkeloos overal maybeSingle zetten lost niets op.
  const b = readFileSync(join(ROOT, 'api/opvolging-poging.js'), 'utf8');
  const i = b.indexOf("from('opvolging_pogingen').insert(");
  assert.ok(i > 0);
  assert.match(b.slice(i, i + 500), /\.select\(\)\.single\(\)/);
});

test('de twee buren spreken elkaar niet meer tegen', () => {
  // aanmelding-actie deed het al goed; taak-update nu ook.
  for (const p of ['api/opvolging-taak-update.js', 'api/opvolging-aanmelding-actie.js']) {
    const b = readFileSync(join(ROOT, p), 'utf8');
    assert.match(b, /\.maybeSingle\(\)/, p);
    assert.match(b, /status\(404\)/, p);
  }
});
