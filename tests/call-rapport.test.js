// tests/call-rapport.test.js
//
// HET CALL-RAPPORT (Opvolging → tab Call-rapport, /api/call-rapport).
//
// Drie lagen, alle drie echt gedraaid:
//   1. de startdatum-helper (api/_lib/call-rapportage-start.js);
//   2. de pure optelling bouwCallRapport — per closer, per categorie, per
//      setter, de startdatum, testrijen, verzette voorgangers;
//   3. het endpoint met een nep-databank (alleen lezen) en de rechten;
//   4. het scherm in een vm-context, gevoed met de uitvoer van (2).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── Nep-databank: alleen lezen ─────────────────────────────────────────────
const db = { tabellen: {}, log: [], fout: {} };

function from(tabel) {
  const q = { tabel, filters: [] };
  const verboden = () => { throw new Error('READ-ONLY: schrijven naar ' + tabel); };
  const k = {
    select: (kol) => { q.kol = kol; return k; },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return k; },
    gte: (c, v) => { q.filters.push(['gte', c, v]); return k; },
    lt: (c, v) => { q.filters.push(['lt', c, v]); return k; },
    in: (c, v) => { q.filters.push(['in', c, v]); return k; },
    order: () => k,
    insert: verboden, update: verboden, upsert: verboden, delete: verboden,
    maybeSingle: async () => {
      const r = run();
      return { data: r.data[0] || null, error: r.error };
    },
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  function run() {
    db.log.push(q);
    if (db.fout[tabel]) return { data: null, error: { message: db.fout[tabel] } };
    let rijen = (db.tabellen[tabel] || []).slice();
    for (const [op, c, v] of q.filters) {
      if (op === 'eq') rijen = rijen.filter((r) => r[c] === v);
      if (op === 'gte') rijen = rijen.filter((r) => String(r[c]) >= v);
      if (op === 'lt') rijen = rijen.filter((r) => String(r[c]) < v);
      if (op === 'in') rijen = rijen.filter((r) => v.map(String).includes(String(r[c])));
    }
    return { data: rijen, error: null };
  }
  return k;
}

const auth = { user: { id: 'super' }, toegestaan: true, gevraagd: [] };

mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from },
    supabaseAdmin: { from, rpc: () => { throw new Error('READ-ONLY: rpc'); } },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: () => false,
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: {
    requirePermission: async (req, sleutel) => { auth.gevraagd.push(sleutel); return auth.toegestaan; },
  },
});

const start = await import('../api/_lib/call-rapportage-start.js');
const mod = await import('../api/call-rapport.js');
const { bouwCallRapport, isGeldigeDag, dagGrenzen } = mod;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE STARTDATUM
// ═══════════════════════════════════════════════════════════════════════════

test('startdatum: standaard 2026-10-02, een geldige waarde wint', () => {
  assert.equal(start.STANDAARD_STARTDATUM, '2026-10-02');
  assert.equal(start.CALL_RAPPORTAGE_START_KEY, 'call_rapportage_startdatum');
  assert.equal(start.parseStartdatum({ datum: '2026-11-01' }), '2026-11-01');
  for (const fout of [null, undefined, 'x', { datum: '1-10-2026' }, { datum: 20261001 }, {}]) {
    assert.equal(start.parseStartdatum(fout), '2026-10-02', JSON.stringify(fout));
  }
});

test('startdatum: rij ontbreekt, leesfout of exception → standaard', async () => {
  db.tabellen.app_settings = [];
  assert.equal(await start.leesCallRapportageStart({ from }), '2026-10-02');
  db.tabellen.app_settings = [{ key: 'call_rapportage_startdatum', value: { datum: '2026-10-09' } }];
  assert.equal(await start.leesCallRapportageStart({ from }), '2026-10-09');
  db.fout.app_settings = 'kapot';
  assert.equal(await start.leesCallRapportageStart({ from }), '2026-10-02');
  delete db.fout.app_settings;
  assert.equal(await start.leesCallRapportageStart({ from: () => { throw new Error('weg'); } }), '2026-10-02');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE OPTELLING
// ═══════════════════════════════════════════════════════════════════════════

const DAG = '2026-10-05';                       // maandag, zomertijd (UTC+2)
const NU = Date.parse('2026-10-05T14:00:00Z');  // 16:00 in Amsterdam
const D = 'dave', M = 'maxim', R = 'romy';

const rij = (id, uur, velden) => ({
  id, lead_name: 'Lead ' + id, lead_email: id + '@x.nl', lead_phone: null,
  scheduled_at: '2026-10-05T' + uur + ':00Z', duration_minutes: 30,
  status: 'scheduled', uitkomst: null, uitkomst_op: null, snelle_notitie: null,
  owner_id: D, setter_user_id: null, booking_source: null, parent_appointment_id: null, is_test: false,
  ...velden,
});

function dagRijen() {
  return [
    rij('a1', '08:00', { status: 'completed', uitkomst: 'sale', setter_user_id: R }),
    rij('a2', '08:30', { status: 'completed', uitkomst: 'gesprek_gehad' }),
    // De motor zet bij wilt_niet_meer status 'cancelled'. Toch een gevoerd gesprek.
    rij('a3', '09:00', { status: 'cancelled', uitkomst: 'wilt_niet_meer' }),
    rij('a4', '09:30', { status: 'no_show', uitkomst: 'no_show' }),
    rij('a5', '10:00', { status: 'no_show', uitkomst: 'onbereikbaar' }),
    rij('a6', '10:30', { status: 'completed', uitkomst: 'geen_geld' }),
    rij('a7', '11:00', { snelle_notitie: 'belt zelf terug', parent_appointment_id: 'p0' }),
    rij('a8', '17:00', {}),                                            // nog gepland
    rij('a9', '12:00', { status: 'verplaatst', setter_user_id: R }),   // opvolger a10 zelfde dag
    rij('a10', '13:00', { status: 'completed', uitkomst: 'sale', parent_appointment_id: 'a9' }),
    rij('a11', '12:30', { status: 'cancelled' }),                      // geannuleerd, geen uitkomst
    rij('a12', '06:00', { status: 'verplaatst' }),                     // verzet naar andere dag
    rij('a13', '07:00', { owner_id: M, status: 'cancelled', uitkomst: 'niet_geschikt' }),
    rij('a14', '07:30', { owner_id: M }),                              // opvolger elders
    rij('d1', '15:00', { owner_id: M, lead_email: 'dubbel@x.nl' }),
    rij('d2', '15:30', { owner_id: M, lead_email: 'dubbel@x.nl' }),
    rij('a15', '09:15', { owner_id: null, status: 'completed', uitkomst: 'sale' }),
    rij('t1', '09:45', { is_test: true, status: 'completed', uitkomst: 'sale' }),
  ];
}

const NAMEN = new Map([[D, 'Dave Heylen'], [M, 'Maxim'], [R, 'Romy']]);

function rapport(extra = {}) {
  return bouwCallRapport({
    dag: DAG, vandaag: DAG, startdatum: '2026-10-02', nuMs: NU,
    afspraken: dagRijen(),
    opvolgerVan: new Set(['a12', 'a14']),
    ketenRijen: [{ id: 'p0', parent_appointment_id: null, setter_user_id: R }],
    namen: NAMEN,
    ...extra,
  });
}

test('per closer: aantallen per categorie, vastgelegd en de open rijen', () => {
  const r = rapport();
  assert.equal(r.voor_startdatum, false);
  assert.equal(r.dag_loopt_nog, true);
  const dave = r.closers.find((c) => c.owner_id === D);
  assert.equal(dave.naam, 'Dave Heylen');
  assert.equal(dave.calls, 9);
  assert.equal(dave.vastgelegd, 7);
  const p = dave.per_categorie;
  assert.equal(p.sale, 2);
  assert.equal(p.opvolgen, 1);
  assert.equal(p.geen_interesse, 1, 'cancelled + wilt_niet_meer telt als gevoerd gesprek');
  assert.equal(p.no_show, 1);
  assert.equal(p.onbereikbaar, 1);
  assert.equal(p.geen_geld, 1);
  assert.equal(p.nog_niet_vastgelegd, 1);
  assert.equal(p.gepland, 1);
  assert.equal(dave.nog_niet_vastgelegd, 1);
  assert.equal(dave.gepland, 1);
  // De som van de categorieën is het aantal calls: niets valt stil weg.
  assert.equal(Object.values(p).reduce((a, b) => a + b, 0), dave.calls);

  assert.equal(dave.open.length, 1);
  const open = dave.open[0];
  assert.equal(open.appointment_id, 'a7');
  assert.equal(open.naam, 'Lead a7');
  assert.equal(open.tijd, '13:00', 'tijd in Amsterdam (UTC+2)');
  assert.equal(open.status, 'scheduled');
  assert.equal(open.snelle_notitie, 'belt zelf terug');
  assert.equal(open.setter_naam, 'Romy');
  assert.equal(open.setter_via_keten, true);
});

test('closers: tweede closer, en een call zonder closer krijgt een eigen bak', () => {
  const r = rapport();
  assert.deepEqual(r.closers.map((c) => c.owner_id), [D, M, null], 'gesorteerd op aantal calls');
  const maxim = r.closers.find((c) => c.owner_id === M);
  assert.equal(maxim.calls, 4);
  assert.equal(maxim.per_categorie.niet_gekwalificeerd, 1);
  assert.equal(maxim.per_categorie.nieuw_moment, 1, 'een opvolger elders → nieuw moment');
  assert.equal(maxim.per_categorie.gepland, 2);
  const geen = r.closers.find((c) => c.owner_id === null);
  assert.equal(geen.naam, 'Geen closer toegewezen');
  assert.equal(geen.per_categorie.sale, 1);
});

test('totaal = som van de closers; testrijen tellen nergens', () => {
  const r = rapport();
  assert.equal(r.totaal.calls, r.closers.reduce((n, c) => n + c.calls, 0));
  assert.equal(r.totaal.calls, 14);
  assert.equal(r.totaal.vastgelegd, 9);
  assert.equal(r.totaal.test_uitgesloten, 1);
  const alleIds = r.closers.flatMap((c) => c.rijen.concat(c.niet_meegeteld.rijen).map((x) => x.appointment_id));
  assert.ok(!alleIds.includes('t1'), 'testrij hoort nergens te staan');
});

test('verzette voorganger met opvolger op dezelfde dag is dubbel beeld en valt weg', () => {
  const r = rapport();
  const alleIds = r.closers.flatMap((c) => c.rijen.concat(c.niet_meegeteld.rijen).map((x) => x.appointment_id));
  assert.ok(!alleIds.includes('a9'), 'a9 is dubbel beeld');
  assert.ok(alleIds.includes('a10'), 'de opvolger telt');
  // De opvolger erft de setter via de keten.
  const a10 = r.closers[0].rijen.find((x) => x.appointment_id === 'a10');
  assert.equal(a10.setter_user_id, R);
  assert.equal(a10.setter_via_keten, true);
});

test('ook met een inhoudelijke uitkomst blijft een verzette voorganger dubbel beeld', () => {
  const rijen = dagRijen().map((a) => (a.id === 'a9' ? { ...a, uitkomst: 'gesprek_gehad' } : a));
  const r = rapport({ afspraken: rijen });
  const ids = r.closers.flatMap((c) => c.rijen.map((x) => x.appointment_id));
  assert.ok(!ids.includes('a9'));
});

test('geannuleerd en verzet zonder uitkomst: niet meegeteld, wel zichtbaar', () => {
  const r = rapport();
  const dave = r.closers.find((c) => c.owner_id === D);
  const niet = dave.niet_meegeteld;
  assert.equal(niet.aantal, 2);
  assert.deepEqual(niet.rijen.map((x) => [x.appointment_id, x.categorie]).sort(),
    [['a11', 'geannuleerd'], ['a12', 'nieuw_moment']]);
  assert.equal(niet.per_categorie.geannuleerd, 1);
  assert.equal(r.totaal.niet_meegeteld, 2);
});

test('per setter: via de keten gevonden, en de rest als "geen setter bekend"', () => {
  const r = rapport();
  const romy = r.setters.find((s) => s.setter_user_id === R);
  assert.equal(romy.naam, 'Romy');
  assert.equal(romy.calls, 3);       // a1 (eigen), a7 (via p0), a10 (via a9)
  assert.equal(romy.via_keten, 2);
  assert.equal(romy.per_categorie.sale, 2);
  assert.equal(romy.per_categorie.nog_niet_vastgelegd, 1);
  const geen = r.setters.find((s) => s.setter_user_id === null);
  assert.equal(geen.naam, 'Geen setter bekend');
  assert.equal(romy.calls + geen.calls, r.totaal.calls);
});

test('dubbele boeking wordt gemeld, en telt allebei mee', () => {
  const r = rapport();
  assert.equal(r.dubbele_afspraken.length, 1);
  assert.deepEqual(r.dubbele_afspraken[0].appointment_ids.sort(), ['d1', 'd2']);
});

test('vóór de startdatum: een melding, geen getallen', () => {
  const r = bouwCallRapport({ dag: '2026-10-01', vandaag: '2026-10-01', startdatum: '2026-10-02', afspraken: dagRijen() });
  assert.equal(r.voor_startdatum, true);
  assert.equal(r.totaal, null);
  assert.deepEqual(r.closers, []);
  assert.deepEqual(r.setters, []);
  assert.match(r.melding, /2026-10-02/);
});

test('op de startdatum zelf telt de dag; rijen van een dag ervoor niet', () => {
  const oud = rij('oud', '00:00', { scheduled_at: '2026-10-04T20:00:00Z', status: 'completed', uitkomst: 'sale' });
  const r = bouwCallRapport({
    dag: DAG, vandaag: DAG, startdatum: DAG, nuMs: NU,
    afspraken: [oud, rij('n1', '08:00', { status: 'completed', uitkomst: 'sale' })],
  });
  assert.equal(r.voor_startdatum, false);
  assert.equal(r.totaal.calls, 1, '22:00 op 4 oktober in Amsterdam valt vóór de startdatum');
});

test('Amsterdamse dag: grenzen rond de zomertijd', () => {
  assert.deepEqual(dagGrenzen('2026-10-05'), {
    vanIso: '2026-10-04T22:00:00.000Z', totIso: '2026-10-05T22:00:00.000Z',
  });
  // 25 oktober 2026: terug naar wintertijd, een dag van 25 uur.
  assert.deepEqual(dagGrenzen('2026-10-25'), {
    vanIso: '2026-10-24T22:00:00.000Z', totIso: '2026-10-25T23:00:00.000Z',
  });
  assert.equal(isGeldigeDag('2026-10-05'), true);
  assert.equal(isGeldigeDag('2026-02-30'), false);
  assert.equal(isGeldigeDag('5-10-2026'), false);
});

test('de helpers uit het Salesrapport worden hergebruikt, niet nagebouwd', () => {
  const bron = lees('api/call-rapport.js');
  assert.match(bron, /import \{ relevanteAfspraken, bouwZoomcalls, groepeerDubbele \} from '\.\/opvolging-rapport\.js'/);
  assert.match(bron, /from '\.\/_lib\/call-uitkomst-categorie\.js'/);
  assert.match(bron, /setterUitKeten/);
  assert.match(bron, /leesCallRapportageStart/);
  assert.doesNotMatch(bron, /function callStaat|function relevanteAfspraken/);
  // Geen UTC-dagen (zie de opdracht: geen setter-period / follow-up-metrics).
  assert.doesNotMatch(bron, /setter-period|follow-up-metrics|toISOString\(\)\.slice\(0, ?10\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

async function vraag(query = {}, method = 'GET') {
  const uit = { code: null, body: null };
  const res = {
    setHeader() {},
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
  };
  await mod.default({ method, headers: {}, query }, res);
  return uit;
}

function vulDb() {
  db.log = []; db.fout = {};
  db.tabellen = {
    app_settings: [],
    follow_up_appointments: dagRijen().concat([
      { id: 'p0', parent_appointment_id: null, setter_user_id: R, scheduled_at: '2026-09-28T08:00:00Z', status: 'verplaatst' },
      { id: 'x12', parent_appointment_id: 'a12', scheduled_at: '2026-10-08T08:00:00Z', status: 'scheduled' },
    ]),
    profiles: [
      { id: D, full_name: 'Dave Heylen', email: 'd@x.nl' },
      { id: M, full_name: null, email: 'maxim@x.nl' },
      { id: R, full_name: 'Romy', email: 'r@x.nl' },
    ],
  };
}

test('endpoint: zonder gebruiker 401, zonder recht 403 op calls.rapport.view', async () => {
  vulDb();
  auth.user = null;
  assert.equal((await vraag({ dag: DAG })).code, 401);
  auth.user = { id: 'sales-dave' };
  auth.toegestaan = false; auth.gevraagd = [];
  const r = await vraag({ dag: DAG });
  assert.equal(r.code, 403);
  assert.deepEqual(auth.gevraagd, ['calls.rapport.view'], 'strikt één sleutel, geen terugval');
  assert.ok(!db.log.some((q) => q.tabel === 'follow_up_appointments'), 'bij 403 niets gelezen');
  auth.toegestaan = true;
});

test('endpoint: alleen GET, en een ongeldige dag is 400', async () => {
  vulDb();
  assert.equal((await vraag({}, 'POST')).code, 405);
  assert.equal((await vraag({ dag: '2026-13-01' })).code, 400);
  assert.equal((await vraag({ dag: 'gisteren' })).code, 400);
});

test('endpoint: vóór de startdatum geen query op de afspraken', async () => {
  vulDb();
  db.tabellen.app_settings = [{ key: 'call_rapportage_startdatum', value: { datum: '2026-10-10' } }];
  const r = await vraag({ dag: DAG });
  assert.equal(r.code, 200);
  assert.equal(r.body.voor_startdatum, true);
  assert.equal(r.body.startdatum, '2026-10-10');
  assert.ok(!db.log.some((q) => q.tabel === 'follow_up_appointments'));
});

test('endpoint: een gewone dag — namen, keten en opvolgers uit de databank, alleen lezen', async (t) => {
  vulDb();
  // De klok op maandag 16:00 in Amsterdam, zodat 'gepland' en 'nog niet
  // vastgelegd' hetzelfde uitvallen als in de pure tests hierboven.
  t.mock.timers.enable({ apis: ['Date'], now: NU });
  const r = await vraag({ dag: DAG });
  assert.equal(r.body.vandaag, DAG);
  assert.equal(r.body.dag_loopt_nog, true);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.dag, DAG);
  assert.equal(r.body.startdatum, '2026-10-02');
  const dave = r.body.closers.find((c) => c.owner_id === D);
  assert.equal(dave.naam, 'Dave Heylen');
  assert.equal(dave.calls, 9);
  // De opvolger x12 staat in de databank → a12 is 'nieuw moment'.
  assert.equal(dave.niet_meegeteld.rijen.find((x) => x.appointment_id === 'a12').categorie, 'nieuw_moment');
  // Keten via p0 (buiten de dag) gelezen.
  assert.equal(dave.open[0].setter_naam, 'Romy');
  // Maxim heeft geen full_name: e-mail als naam.
  assert.equal(r.body.closers.find((c) => c.owner_id === M).naam, 'maxim@x.nl');
  // De dag-query zit op de Amsterdamse grenzen.
  const dagQ = db.log.find((q) => q.tabel === 'follow_up_appointments' && q.filters.some((f) => f[0] === 'gte'));
  assert.deepEqual(dagQ.filters.filter((f) => f[0] !== 'in'), [
    ['gte', 'scheduled_at', '2026-10-04T22:00:00.000Z'], ['lt', 'scheduled_at', '2026-10-05T22:00:00.000Z'],
  ]);
  assert.deepEqual(r.body.blinde_vlekken, []);
});

test('endpoint: een leesfout op de namen is een blinde vlek, geen 500', async () => {
  vulDb();
  db.fout.profiles = 'tijdelijk weg';
  const r = await vraag({ dag: DAG });
  assert.equal(r.code, 200);
  assert.equal(r.body.blinde_vlekken.length, 1);
  assert.equal(r.body.closers.find((c) => c.owner_id === D).naam, 'Onbekende gebruiker');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · RECHTEN EN BEDRADING
// ═══════════════════════════════════════════════════════════════════════════

test('de tab staat in de shell, aan een eigen sleutel, en in het register', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /'Rapport', 'Call-rapport'\]/);
  assert.match(shell, /'opvolging\/Call-rapport': 'calls\.rapport\.view'/);
  assert.match(lees('modules/shared/rbac/registry.js'), /key:'calls\.rapport\.view'/);
});

test('de seed: manager aan, sales uit; startdatum ON CONFLICT DO NOTHING', () => {
  const sql = lees('docs/sql-migrations/2026-10-01-call-rapport.sql');
  assert.match(sql, /SELECT 'manager', 'calls\.rapport\.view', true/);
  assert.match(sql, /SELECT 'sales', 'calls\.rapport\.view', false/);
  assert.match(sql, /'call_rapportage_startdatum', '\{"datum": "2026-10-02"\}'::jsonb\)\s*ON CONFLICT \(key\) DO NOTHING/);
});

test('index.html laadt de view na de mapping en na opvolging-v2', () => {
  const html = lees('modules/klanten-v2/index.html');
  const iMap = html.indexOf('call-uitkomst-categorie.js?v=');
  const iOpv = html.indexOf('views/opvolging-v2.js?v=');
  const iView = html.indexOf('views/call-rapport-v2.js?v=');
  assert.ok(iMap > 0 && iOpv > 0 && iView > 0);
  assert.ok(iView > iMap && iView > iOpv);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · HET SCHERM
// ═══════════════════════════════════════════════════════════════════════════

function laadScherm({ metMapping = true } = {}) {
  const taken = [];
  const window = {
    DFO: { VIEWS: {}, render() {} },
    KV: { authedJson: async () => ({}) },
  };
  window.window = window;
  const ctx = createContext({
    window,
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console, queueMicrotask: (fn) => taken.push(fn),
    Date, Math, Number, String, JSON, Intl, Set, Map, Array, Object, encodeURIComponent,
  });
  if (metMapping) runInContext(lees('modules/shared/call-uitkomst-categorie.js'), ctx, { filename: 'map.js' });
  runInContext(lees('modules/klanten-v2/views/call-rapport-v2.js'), ctx, { filename: 'call-rapport-v2.js' });
  return { window, taken };
}

test('scherm: registreert opvolging/Call-rapport en vraagt de dag op', () => {
  const { window, taken } = laadScherm();
  const view = window.DFO.VIEWS['opvolging/Call-rapport'];
  assert.equal(typeof view, 'function');
  const html = view();
  assert.match(html, /Call-rapport/);
  assert.match(html, /Laden/);
  assert.equal(taken.length, 1, 'één fetch ingepland');
});

test('scherm: kaarten per closer met labels uit de mapping, open rijen uitklapbaar', () => {
  const { window } = laadScherm();
  const st = window.__callRapState;
  st.dag = DAG; st.key = DAG; st.data = JSON.parse(JSON.stringify(rapport()));
  const view = window.DFO.VIEWS['opvolging/Call-rapport'];
  let html = view();
  assert.match(html, /data-closer="dave"/);
  assert.match(html, /Dave Heylen/);
  const M = window.CallUitkomstCategorie;
  for (const k of ['sale', 'opvolgen', 'geen_interesse', 'geen_geld', 'no_show', 'onbereikbaar', 'nog_niet_vastgelegd']) {
    assert.ok(html.includes(M.categorieInfo(k).label), 'label ontbreekt: ' + k);
  }
  assert.match(html, /1 nog niet vastgelegd/);
  assert.doesNotMatch(html, /belt zelf terug/, 'dicht: geen rijen');
  window.__callRapToggle('closer:dave');
  html = view();
  assert.match(html, /belt zelf terug/);
  assert.match(html, /Setter: Romy \(via de oorspronkelijke boeking\)/);
  assert.match(html, /13:00 &middot; Lead a7/);
  assert.match(html, /data-setter="romy"/);
  assert.match(html, /mogelijk een dubbele boeking/);
});

test('scherm: vóór de startdatum alleen de melding', () => {
  const { window } = laadScherm();
  const st = window.__callRapState;
  st.dag = '2026-10-01'; st.key = '2026-10-01';
  st.data = bouwCallRapport({ dag: '2026-10-01', vandaag: '2026-10-01', startdatum: '2026-10-02' });
  const html = window.DFO.VIEWS['opvolging/Call-rapport']();
  assert.match(html, /data-voor-startdatum="1"/);
  assert.doesNotMatch(html, /data-closer=/);
});

test('scherm: zonder mapping een duidelijke fout, geen verzonnen labels', () => {
  const { window } = laadScherm({ metMapping: false });
  const html = window.DFO.VIEWS['opvolging/Call-rapport']();
  assert.match(html, /Er ontbreekt een onderdeel/);
});

test('scherm: geen categorielabel hard in de view', () => {
  const bron = lees('modules/klanten-v2/views/call-rapport-v2.js');
  for (const label of ['Opvolgen / bedenktijd', 'Geen interesse', 'Niet gekwalificeerd', 'Nog niet vastgelegd',
    'Nieuw moment ingepland', 'Wacht op nieuw moment', 'Onbereikbaar', 'Geen geld']) {
    assert.ok(!bron.includes("'" + label + "'"), 'hard label in de view: ' + label);
  }
});

test('scherm: dagnavigatie springt per dag en terug naar vandaag', () => {
  const { window } = laadScherm();
  const st = window.__callRapState;
  st.dag = DAG;
  window.__callRapDag(-1);
  assert.equal(st.dag, '2026-10-04');
  window.__callRapDag(1); window.__callRapDag(1);
  assert.equal(st.dag, '2026-10-06');
  window.__callRapDag(0);
  assert.equal(st.dag, null, 'null = vandaag');
});
