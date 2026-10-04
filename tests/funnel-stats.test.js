// tests/funnel-stats.test.js
//
// FUNNEL-DASHBOARD (Leadsonderhoud → Funnels, /api/funnel-stats).
//
//   1. pure aggregatie (api/_lib/funnel-stats-compute.js): fase-bereik,
//      conversies incl. deling door nul, afhaken per quizversie, Amsterdam-
//      periode, onbekende variant/event genegeerd, lead-resultaat + dekking;
//   2. endpoint met een nep-databank (alleen lezen): 401/403/400, fail-soft
//      als funnel_events nog niet bestaat, keyset-paging over >1000 rijen;
//   3. registry bevat de zes varianten;
//   4. het scherm (vm-context): kaarten per groep, inactief-banner, afhaken
//      uitklappen, periode-presets in Amsterdam-tijd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── Nep-databank: alleen lezen ──────────────────────────────────────────────
const db = { tabellen: {}, ontbreekt: {}, fout: {}, log: [] };

function from(tabel) {
  const q = { tabel, filters: [], lim: null };
  const verboden = () => { throw new Error('READ-ONLY: schrijven naar ' + tabel); };
  const k = {
    select: (kol) => { q.kol = kol; return k; },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return k; },
    is: (c, v) => { q.filters.push(['is', c, v]); return k; },
    in: (c, v) => { q.filters.push(['in', c, v]); return k; },
    gte: (c, v) => { q.filters.push(['gte', c, v]); return k; },
    lt: (c, v) => { q.filters.push(['lt', c, v]); return k; },
    gt: (c, v) => { q.filters.push(['gt', c, v]); return k; },
    order: (c, o) => { q.order = [c, o?.ascending !== false]; return k; },
    limit: (n) => { q.lim = n; return k; },
    insert: verboden, update: verboden, upsert: verboden, delete: verboden,
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
  function run() {
    db.log.push(q);
    if (db.ontbreekt[tabel]) {
      return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${tabel}' in the schema cache` } };
    }
    if (db.fout[tabel]) return { data: null, error: { message: db.fout[tabel] } };
    let rijen = (db.tabellen[tabel] || []).slice();
    for (const [op, c, v] of q.filters) {
      if (op === 'eq') rijen = rijen.filter((r) => r[c] === v);
      if (op === 'is') rijen = rijen.filter((r) => (r[c] ?? null) === v);
      if (op === 'in') rijen = rijen.filter((r) => v.map(String).includes(String(r[c])));
      // ISO-strings met dezelfde vorm (…Z) vergelijken we als tijd.
      if (op === 'gte') rijen = rijen.filter((r) => (typeof v === 'number' ? r[c] >= v : Date.parse(r[c]) >= Date.parse(v)));
      if (op === 'lt') rijen = rijen.filter((r) => (typeof v === 'number' ? r[c] < v : Date.parse(r[c]) < Date.parse(v)));
      if (op === 'gt') rijen = rijen.filter((r) => r[c] > v);
    }
    if (q.order) {
      const [c, asc] = q.order;
      rijen.sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c]));
    }
    if (q.lim != null) rijen = rijen.slice(0, Math.min(q.lim, 1000));
    else rijen = rijen.slice(0, 1000);
    return { data: rijen, error: null };
  }
  return k;
}

const auth = { user: { id: 'u1' }, toegestaan: true, gevraagd: [] };

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

const C = await import('../api/_lib/funnel-stats-compute.js');
const E = await import('../api/funnel-stats.js');
const handler = E.default;

// 2 oktober 2026 in Amsterdam = zomertijd (UTC+2): 2026-10-01T22:00Z t/m 2026-10-02T22:00Z.
const START = new Date('2026-10-01T22:00:00Z');
const EIND = new Date('2026-10-02T22:00:00Z');
const TS = '2026-10-02T10:00:00Z';
const ev = (session_id, event_type, extra = {}) => ({
  session_id, variant: 'kennismakingscursus-v2', event_type, stap_nr: null, vraag_id: null,
  quiz_versie: null, ts: TS, lead_id: null, ...extra,
});
const vraag = (sid, n, versie = 'q1', extra = {}) => ev(sid, 'vraag_getoond', { stap_nr: n, quiz_versie: versie, vraag_id: 'v' + n, ...extra });

function fase(res, variant, naam) {
  return res.per_variant[variant].funnel.find((f) => f.fase === naam);
}

// ════════════════════════════════════════════════════════════════════════════
// 1 · AGGREGATIE
// ════════════════════════════════════════════════════════════════════════════

test('aggregatie: unieke sessies per fase + conversies', () => {
  const events = [
    // 4 sessies landen (s1 twee keer → telt één keer)
    ev('s1', 'landing'), ev('s1', 'landing'), ev('s2', 'landing'), ev('s3', 'landing'), ev('s4', 'landing'),
    ev('s1', 'formulier_start'), ev('s2', 'formulier_start'),
    ev('s1', 'gegevens_ok'), ev('s2', 'gegevens_ok'),
    vraag('s1', 1), vraag('s2', 1), vraag('s1', 2),
    ev('s1', 'lead_ingediend'),
    ev('s1', 'toegang'),
    ev('s1', 'slot_gekozen'),
    ev('s1', 'geboekt'),
  ];
  const r = C.aggregeerFunnelStats({ events, start: START, eindExclusief: EIND, varianten: ['kennismakingscursus-v2'] });
  const f = r.per_variant['kennismakingscursus-v2'].funnel;
  assert.deepEqual(f.map((x) => x.fase), ['landing', 'formulier_start', 'gegevens_ok', 'quiz_gestart', 'lead_ingediend', 'toegang', 'slot_gekozen', 'geboekt']);
  assert.deepEqual(f.map((x) => x.sessions), [4, 2, 2, 2, 1, 1, 1, 1]);
  assert.equal(f[0].conversie_vorige, null);
  assert.equal(f[0].conversie_landing, 100);
  assert.equal(f[1].conversie_vorige, 50);
  assert.equal(f[1].conversie_landing, 50);
  assert.equal(f[4].conversie_vorige, 50);
  assert.equal(f[4].conversie_landing, 25);
  assert.equal(r.per_variant['kennismakingscursus-v2'].sessies_totaal, 4);
});

test('aggregatie: quiz_gestart telt alleen vraag_getoond stap 1; bereik zonder eerdere fase telt mee', () => {
  const events = [vraag('a', 2), vraag('b', 1), ev('c', 'lead_ingediend')];
  const r = C.aggregeerFunnelStats({ events, start: START, eindExclusief: EIND, varianten: ['kennismakingscursus-v2'] });
  assert.equal(fase(r, 'kennismakingscursus-v2', 'quiz_gestart').sessions, 1);
  // Geen landing, wél lead: bereik-telling → 1 lead.
  assert.equal(fase(r, 'kennismakingscursus-v2', 'lead_ingediend').sessions, 1);
});

test('aggregatie: deling door nul geeft null, nooit NaN/Infinity', () => {
  assert.equal(C.pct(0, 0), null);
  assert.equal(C.pct(3, 0), null);
  assert.equal(C.pct(1, 3), 33.3);
  const r = C.aggregeerFunnelStats({ events: [ev('x', 'formulier_start')], start: START, eindExclusief: EIND, varianten: ['kennismakingscursus-v2'] });
  const f = r.per_variant['kennismakingscursus-v2'].funnel;
  assert.equal(f[0].sessions, 0);
  assert.equal(f[0].conversie_landing, null);
  assert.equal(f[1].conversie_vorige, null);   // 1 / 0
  assert.equal(f[1].conversie_landing, null);
  assert.equal(f[2].conversie_vorige, 0);      // 0 / 1
  for (const x of f) {
    for (const k of ['conversie_vorige', 'conversie_landing']) assert.ok(x[k] === null || Number.isFinite(x[k]));
  }
  // Lege dataset: alles 0 / null.
  const leeg = C.aggregeerFunnelStats({ start: START, eindExclusief: EIND });
  assert.equal(Object.keys(leeg.per_variant).length, 6);
  assert.equal(leeg.per_variant['7-daagse-v2'].lead_resultaat.toegang_pct, null);
});

test('afhaken: per quizversie apart, nooit gemengd; laatste vraag = door bij lead', () => {
  const events = [
    // versie q1: 3 vragen. s1 compleet + lead, s2 stopt na vraag 2, s3 stopt na vraag 1
    vraag('s1', 1), vraag('s1', 2), vraag('s1', 3), ev('s1', 'lead_ingediend'),
    vraag('s2', 1), vraag('s2', 2),
    vraag('s3', 1),
    // versie q2: s4 ziet vraag 1 en 2 (q2). Zou bij mengen q1-vraag 2 vullen.
    vraag('s4', 1, 'q2'), vraag('s4', 2, 'q2'),
    // s5 ziet vraag 1 in q1 maar vraag 2 in q2 → in q1 afgehaakt na vraag 1
    vraag('s5', 1, 'q1'), vraag('s5', 2, 'q2'),
  ];
  const r = C.aggregeerFunnelStats({ events, start: START, eindExclusief: EIND, varianten: ['kennismakingscursus-v2'] });
  const blokken = r.per_variant['kennismakingscursus-v2'].afhaken_per_vraag;
  assert.deepEqual(blokken.map((b) => b.quiz_versie), ['q1', 'q2']);
  const q1 = blokken[0];
  assert.equal(q1.sessies_gestart, 4);
  assert.equal(q1.voltooid, 1);
  assert.deepEqual(q1.vragen.map((v) => [v.stap_nr, v.gezien, v.door, v.afgehaakt]), [
    [1, 4, 2, 2],   // s1,s2 door; s3,s5 afgehaakt
    [2, 2, 1, 1],   // s1 door; s2 afgehaakt
    [3, 1, 1, 0],   // laatste vraag: s1 diende lead in
  ]);
  assert.equal(q1.vragen[0].afhaak_pct, 50);
  assert.equal(q1.vragen[0].vraag_id, 'v1');
  const q2 = blokken[1];
  assert.equal(q2.sessies_gestart, 1);
  assert.deepEqual(q2.vragen.map((v) => [v.stap_nr, v.gezien, v.door, v.afgehaakt]), [
    [1, 1, 1, 0],
    [2, 2, 0, 2],   // s4 + s5 zagen q2-vraag 2, geen lead
  ]);
  // Zonder versie → 'onbekend'
  const r2 = C.aggregeerFunnelStats({ events: [vraag('z', 1, null)], start: START, eindExclusief: EIND, varianten: ['kennismakingscursus-v2'] });
  assert.equal(r2.per_variant['kennismakingscursus-v2'].afhaken_per_vraag[0].quiz_versie, 'onbekend');
});

test('periode: Amsterdam-dag, niet UTC-dag', () => {
  const events = [
    ev('vroeg', 'landing', { ts: '2026-10-01T21:59:59Z' }),  // 1 okt 23:59 NL → buiten
    ev('nacht', 'landing', { ts: '2026-10-01T22:30:00Z' }),  // 2 okt 00:30 NL → binnen (UTC-datum is 1 okt!)
    ev('avond', 'landing', { ts: '2026-10-02T21:59:00Z' }),  // 2 okt 23:59 NL → binnen
    ev('laat', 'landing', { ts: '2026-10-02T22:00:00Z' }),   // 3 okt 00:00 NL → buiten
  ];
  const r = C.aggregeerFunnelStats({ events, start: START, eindExclusief: EIND, varianten: ['kennismakingscursus-v2'] });
  assert.equal(fase(r, 'kennismakingscursus-v2', 'landing').sessions, 2);
  assert.equal(r.events_genegeerd, 2);
  // De endpoint-periode rekent dezelfde grenzen uit.
  const p = E.periodeUitQuery({ van: '2026-10-02', tot: '2026-10-02' });
  assert.equal(p.start.toISOString(), START.toISOString());
  assert.equal(p.eindExclusief.toISOString(), EIND.toISOString());
  // Wintertijd (UTC+1).
  const w = E.periodeUitQuery({ van: '2026-11-10', tot: '2026-11-10' });
  assert.equal(w.start.toISOString(), '2026-11-09T23:00:00.000Z');
});

test('onbekende variant of onbekend event-type wordt genegeerd', () => {
  const events = [
    ev('a', 'landing'),
    ev('b', 'landing', { variant: 'kennismakingscursus-v9' }),
    ev('c', 'landing', { variant: 'website' }),
    ev('d', 'pagina_bekeken'),
    ev('e', 'landing', { session_id: null }),
    ev('f', 'landing', { ts: 'geen-datum' }),
  ];
  const r = C.aggregeerFunnelStats({ events, start: START, eindExclusief: EIND });
  assert.equal(fase(r, 'kennismakingscursus-v2', 'landing').sessions, 1);
  assert.equal(r.events_genegeerd, 5);
  assert.ok(!('kennismakingscursus-v9' in r.per_variant));
  assert.ok(!('website' in r.per_variant));
  // Onbekende variant in de gevraagde lijst wordt ook weggelaten.
  const r2 = C.aggregeerFunnelStats({ events, start: START, eindExclusief: EIND, varianten: ['onzin', '7-daagse-v1'] });
  assert.deepEqual(Object.keys(r2.per_variant), ['7-daagse-v1']);
});

test('lead-resultaat: kwalificatie, test-mails eruit, geboekt via opstartsessie, dekking', () => {
  const leads = [
    { id: 'L1', bron: '7-daagse-v2', kwalificatie: 'toegang', email: 'a@x.nl', aangemaakt: TS, afspraak_op: TS },
    { id: 'L2', bron: '7-daagse-v2', kwalificatie: 'toegang', email: 'b@x.nl', aangemaakt: TS, afspraak_op: null },
    { id: 'L3', bron: '7-daagse-v2', kwalificatie: 'geen toegang', email: 'c@x.nl', aangemaakt: TS, afspraak_op: null },
    { id: 'L4', bron: '7-daagse-v2', kwalificatie: null, email: 'd@x.nl', aangemaakt: TS, afspraak_op: null },
    { id: 'L5', bron: '7-daagse-v2', kwalificatie: 'toegang', email: 'test@x.nl', aangemaakt: TS },          // test → eruit
    { id: 'L6', bron: '7-daagse-v2', kwalificatie: 'toegang', email: 'e@x.nl', aangemaakt: '2026-10-01T21:00:00Z' }, // vóór periode
    { id: 'L7', bron: 'kennismakingscursus-v2', kwalificatie: 'toegang', email: 'f@x.nl', aangemaakt: TS },
  ];
  const boekingen = [
    { booking_source: '7-daagse-v2', appointment_id: 'A1', lead_id: 'L1', created_at: TS },
    { booking_source: '7-daagse-v2', appointment_id: null, lead_id: 'L2', created_at: TS },        // geen afspraak
    { booking_source: '7-daagse-v2', appointment_id: 'A3', lead_id: null, created_at: '2026-10-03T08:00:00Z' }, // buiten
    { booking_source: '7-daagse', appointment_id: 'A4', lead_id: null, created_at: TS },           // andere bron
  ];
  const r = C.aggregeerFunnelStats({
    leads, boekingen, gekoppeldeLeadIds: ['L1', 'L3', 'L7'],
    start: START, eindExclusief: EIND, varianten: ['7-daagse-v2'],
  });
  assert.deepEqual(r.per_variant['7-daagse-v2'].lead_resultaat, {
    leads: 4, toegang: 2, geen_toegang: 1, kwalificatie_onbekend: 1, toegang_pct: 50,
    geboekt: 1, leads_met_afspraak: 1, leads_met_sessie: 2, dekking_pct: 50,
  });
  // Tracking niet actief → funnel/afhaken/dekking null, lead-telling blijft.
  const r2 = C.aggregeerFunnelStats({ leads, boekingen, start: START, eindExclusief: EIND, varianten: ['7-daagse-v2'], trackingActief: false });
  const v = r2.per_variant['7-daagse-v2'];
  assert.equal(v.funnel, null);
  assert.equal(v.afhaken_per_vraag, null);
  assert.equal(v.lead_resultaat.leads, 4);
  assert.equal(v.lead_resultaat.leads_met_sessie, null);
  assert.equal(v.lead_resultaat.dekking_pct, null);
});

test('blinde vlekken: ontbrekende tabel, lege tabel, latere start, afgekapt', () => {
  assert.match(C.bepaalBlindeVlekken({ tabelBestaat: false }).join(' '), /migratie funnel_events niet gedraaid/);
  assert.match(C.bepaalBlindeVlekken({ tabelBestaat: true, eersteEventTs: null }).join(' '), /nog geen events/);
  const v = C.bepaalBlindeVlekken({ tabelBestaat: true, eersteEventTs: '2026-10-02T08:00:00Z', start: new Date('2026-09-01T00:00:00Z'), afgekapt: true, maxEvents: 25000 });
  assert.ok(v.some((s) => /Tracking pas actief vanaf 2026-10-02/.test(s)));
  assert.ok(v.some((s) => /afgekapt/.test(s)));
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · ENDPOINT
// ════════════════════════════════════════════════════════════════════════════

function nepRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
async function call(query) {
  const res = nepRes();
  await handler({ method: 'GET', query, headers: {} }, res);
  return res;
}
function reset() {
  db.tabellen = {}; db.ontbreekt = {}; db.fout = {}; db.log = [];
  auth.user = { id: 'u1' }; auth.toegestaan = true; auth.gevraagd = [];
}

test('endpoint: 401 zonder gebruiker, 403 zonder leads.view, 405 bij POST', async () => {
  reset();
  auth.user = null;
  assert.equal((await call({ van: '2026-10-02', tot: '2026-10-02' })).statusCode, 401);
  reset();
  auth.toegestaan = false;
  const r = await call({ van: '2026-10-02', tot: '2026-10-02' });
  assert.equal(r.statusCode, 403);
  assert.deepEqual(auth.gevraagd, ['leads.view']);
  const res = nepRes();
  await handler({ method: 'POST', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('endpoint: 400 bij foute datums of onbekende variant', async () => {
  reset();
  for (const q of [
    { van: '2026-13-01', tot: '2026-10-02' },
    { van: '2026-02-30', tot: '2026-03-01' },
    { van: '02-10-2026', tot: '2026-10-02' },
    { van: '2026-10-05', tot: '2026-10-02' },     // van > tot
    { van: '2026-10-02' },                        // tot ontbreekt
    { van: '2024-01-01', tot: '2026-10-02' },     // > 366 dagen
    { van: '2026-10-02', tot: '2026-10-02', variant: 'website' },
  ]) {
    const r = await call(q);
    assert.equal(r.statusCode, 400, JSON.stringify(q));
    assert.ok(r.body.error);
  }
  // Zonder van/tot: default laatste 7 dagen → 200.
  db.ontbreekt.funnel_events = true;
  db.tabellen.leads = []; db.tabellen.opstartsessie_submissions = [];
  const ok = await call({});
  assert.equal(ok.statusCode, 200);
  const dagen = (Date.parse(ok.body.periode.tot) - Date.parse(ok.body.periode.van)) / 86400000 + 1;
  assert.equal(dagen, 7);
});

test('endpoint: fail-soft als funnel_events niet bestaat → 200, tracking_actief false', async () => {
  reset();
  db.ontbreekt.funnel_events = true;
  db.tabellen.leads = [
    { id: 'L1', bron: 'kennismakingscursus-v2', kwalificatie: 'toegang', email: 'a@x.nl', aangemaakt: TS, afspraak_op: null, verwijderd_op: null },
    { id: 'L2', bron: 'kennismakingscursus-v2', kwalificatie: 'toegang', email: 'b@x.nl', aangemaakt: TS, afspraak_op: null, verwijderd_op: '2026-10-02T11:00:00Z' },
  ];
  db.tabellen.opstartsessie_submissions = [
    { booking_source: 'kennismakingscursus-v2', appointment_id: 'A1', lead_id: 'L1', created_at: TS },
  ];
  const r = await call({ van: '2026-10-02', tot: '2026-10-02' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.tracking_actief, false);
  assert.equal(r.body.meta.tabel_bestaat, false);
  assert.match(r.body.meta.blinde_vlekken.join(' '), /tracking nog niet actief \(migratie funnel_events niet gedraaid\)/i);
  assert.equal(r.body.varianten.length, 6);
  const v = r.body.per_variant['kennismakingscursus-v2'];
  assert.equal(v.funnel, null);
  assert.equal(v.lead_resultaat.leads, 1);       // verwijderde lead telt niet
  assert.equal(v.lead_resultaat.geboekt, 1);
  // Bij een ontbrekende tabel worden geen event-pagina's gelezen.
  assert.equal(db.log.filter((q) => q.tabel === 'funnel_events').length, 1);
});

test('endpoint: lege tabel → tracking_actief false; andere leesfout → ook 200', async () => {
  reset();
  db.tabellen.funnel_events = [];
  db.tabellen.leads = []; db.tabellen.opstartsessie_submissions = [];
  let r = await call({ van: '2026-10-02', tot: '2026-10-02' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.tabel_bestaat, true);
  assert.equal(r.body.meta.tracking_actief, false);
  reset();
  db.fout.funnel_events = 'permission denied';
  db.tabellen.leads = []; db.tabellen.opstartsessie_submissions = [];
  r = await call({ van: '2026-10-02', tot: '2026-10-02' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.tracking_actief, false);
  assert.match(r.body.meta.blinde_vlekken.join(' '), /permission denied/);
});

test('endpoint: leest >1000 events via keyset-paging, filtert variant + periode', async () => {
  reset();
  const rijen = [];
  let id = 0;
  for (let i = 0; i < 1500; i += 1) {
    rijen.push({ id: ++id, ...ev('s' + i, 'landing', { variant: '7-daagse-v2' }) });
  }
  rijen.push({ id: ++id, ...ev('s0', 'lead_ingediend', { variant: '7-daagse-v2', lead_id: 'L1' }) });
  rijen.push({ id: ++id, ...ev('oud', 'landing', { variant: '7-daagse-v2', ts: '2026-09-30T10:00:00Z' }) });
  rijen.push({ id: ++id, ...ev('kmc', 'landing') });
  rijen.push({ id: ++id, ...ev('s1', 'vraag_beantwoord', { variant: '7-daagse-v2', stap_nr: 1 }) }); // niet opgehaald
  db.tabellen.funnel_events = rijen;
  db.tabellen.leads = [
    { id: 'L1', bron: '7-daagse-v2', kwalificatie: 'toegang', email: 'a@x.nl', aangemaakt: TS, afspraak_op: null, verwijderd_op: null },
    { id: 'L2', bron: '7-daagse-v2', kwalificatie: 'toegang', email: 'b@x.nl', aangemaakt: TS, afspraak_op: null, verwijderd_op: null },
  ];
  db.tabellen.opstartsessie_submissions = [];
  const r = await call({ van: '2026-10-02', tot: '2026-10-02', variant: '7-daagse-v2' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.varianten, ['7-daagse-v2']);
  assert.equal(r.body.meta.tracking_actief, true);
  assert.equal(r.body.meta.eerste_event_ts, '2026-09-30T10:00:00Z');
  assert.equal(r.body.meta.events_gelezen, 1501);
  assert.equal(r.body.meta.afgekapt, false);
  const v = r.body.per_variant['7-daagse-v2'];
  assert.equal(v.funnel[0].sessions, 1500);
  assert.equal(v.funnel.find((f) => f.fase === 'lead_ingediend').sessions, 1);
  assert.equal(v.lead_resultaat.leads_met_sessie, 1);
  assert.equal(v.lead_resultaat.dekking_pct, 50);
  // Twee pagina's (1000 + 501) + probe + dekking.
  const eventQ = db.log.filter((q) => q.tabel === 'funnel_events' && q.kol && q.kol.startsWith('id,'));
  assert.equal(eventQ.length, 2);
  assert.ok(eventQ[1].filters.some(([op, c, v2]) => op === 'gt' && c === 'id' && v2 === 1000));
  // Alleen de benodigde event-types worden opgehaald.
  assert.ok(eventQ[0].filters.some(([op, c]) => op === 'in' && c === 'event_type'));
});

test('endpoint: bron-code schrijft nooit en gebruikt geen rpc', () => {
  const src = lees('api/funnel-stats.js') + lees('api/_lib/funnel-stats-compute.js');
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.match(lees('api/funnel-stats.js'), /requirePermission\(req, 'leads\.view'\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · REGISTRY
// ════════════════════════════════════════════════════════════════════════════

test('registry: FUNNEL_REGISTRY en FUNNEL_VARIANTEN bevatten de zes varianten', () => {
  const zes = ['kennismakingscursus-v1', 'kennismakingscursus-v2', 'kennismakingscursus-v3',
    'kennismakingscursus-v4', '7-daagse-v1', '7-daagse-v2'];
  assert.deepEqual([...C.FUNNEL_VARIANTEN].sort(), [...zes].sort());
  const src = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  const blok = src.slice(src.indexOf('const FUNNEL_REGISTRY = ['), src.indexOf('];', src.indexOf('const FUNNEL_REGISTRY = [')));
  const bronnen = [...blok.matchAll(/bron:\s*'([^']+)'/g)].map((m) => m[1]);
  for (const v of zes) {
    assert.ok(bronnen.includes(v), 'registry mist ' + v);
    assert.match(blok, new RegExp(`route: 'https://deforexopleiding\\.nl/${v}'`));
  }
  assert.ok(bronnen.includes('website'), 'bestaande entry blijft');
  assert.equal(new Set(bronnen).size, bronnen.length, 'geen dubbele bronnen');
});

test('index.html laadt funnel-dashboard vóór leadsonderhoud', () => {
  const html = lees('modules/klanten-v2/index.html');
  const a = html.indexOf('views/funnel-dashboard-v2.js?v=');
  const b = html.indexOf('views/leadsonderhoud-v2.js?v=');
  assert.ok(a > 0 && b > a);
});

// ════════════════════════════════════════════════════════════════════════════
// 4 · HET SCHERM
// ════════════════════════════════════════════════════════════════════════════

function laadScherm(antwoord) {
  const taken = [];
  const calls = [];
  const window = {
    DFO: { VIEWS: {}, renders: 0, render() { window.DFO.renders += 1; } },
    KV: { authedJson: async (url) => { calls.push(url); if (antwoord instanceof Error) throw antwoord; return antwoord; } },
  };
  window.window = window;
  const ctx = createContext({
    window, console, queueMicrotask: (fn) => taken.push(fn),
    Date, Math, Number, String, JSON, Intl, Set, Map, Array, Object, Promise, encodeURIComponent,
  });
  runInContext(lees('modules/klanten-v2/views/funnel-dashboard-v2.js'), ctx, { filename: 'funnel-dashboard-v2.js' });
  return { window, taken, calls };
}

function nepPayload({ actief }) {
  const per = {};
  for (const v of C.FUNNEL_VARIANTEN) {
    const r = C.aggregeerFunnelStats({
      events: actief ? [ev('s1', 'landing', { variant: v }), vraag('s1', 1, 'q1', { variant: v }), vraag('s1', 2, 'q1', { variant: v })] : [],
      leads: [{ id: 'L', bron: v, kwalificatie: 'toegang', email: 'a@x.nl', aangemaakt: TS }],
      start: START, eindExclusief: EIND, varianten: [v], trackingActief: actief,
    });
    per[v] = r.per_variant[v];
  }
  return {
    periode: { van: '2026-10-02', tot: '2026-10-02' },
    varianten: [...C.FUNNEL_VARIANTEN],
    per_variant: per,
    meta: {
      tracking_actief: actief, tabel_bestaat: actief,
      blinde_vlekken: C.bepaalBlindeVlekken({ tabelBestaat: actief, eersteEventTs: actief ? TS : null, start: START }),
    },
  };
}

test('scherm: haalt /api/funnel-stats op en tekent 6 kaarten in 2 groepen', async () => {
  const { window, taken, calls } = laadScherm(nepPayload({ actief: true }));
  const D = window.DFOFunnelDashboard;
  let html = D.render([]);
  assert.match(html, /Funnel-conversie/);
  assert.equal(taken.length, 1);
  await taken[0]();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/funnel-stats\?van=\d{4}-\d{2}-\d{2}&tot=\d{4}-\d{2}-\d{2}$/);
  html = D.render([{ bron: 'kennismakingscursus-v3', naam: 'Mini-cursus (v3)', route: 'https://deforexopleiding.nl/kennismakingscursus-v3' }]);
  assert.equal((html.match(/class="fd-kaart"/g) || []).length, 6);
  assert.match(html, /data-groep="kmc"/);
  assert.match(html, /data-groep="7-daagse"/);
  assert.equal((html.match(/class="fd-fase"/g) || []).length, 6 * 8);
  assert.match(html, /href="https:\/\/deforexopleiding\.nl\/kennismakingscursus-v3"/);
  assert.doesNotMatch(html, /fd-inactief/);
  assert.doesNotMatch(html, /fd-afhaken/);
  window.__fdToggle('7-daagse-v2');
  html = D.render([]);
  assert.equal((html.match(/class="fd-afhaken"/g) || []).length, 1);
  assert.match(html, /Quizversie q1/);
});

test('scherm: tracking niet actief → duidelijke banner, lead-resultaat blijft', async () => {
  const { window, taken } = laadScherm(nepPayload({ actief: false }));
  window.DFOFunnelDashboard.render([]);
  await taken[0]();
  const html = window.DFOFunnelDashboard.render([]);
  assert.match(html, /class="fd-inactief"/);
  assert.match(html, /Tracking nog niet actief \(migratie funnel_events niet gedraaid\)/);
  assert.match(html, /Nog geen trackingdata/);
  assert.equal((html.match(/class="fd-leads"/g) || []).length, 6);
  assert.doesNotMatch(html, /Afhaken per vraag/);
});

test('scherm: fout 403 toont rechten-melding', async () => {
  const err = Object.assign(new Error('x'), { status: 403 });
  const { window, taken } = laadScherm(err);
  window.DFOFunnelDashboard.render([]);
  await taken[0]();
  assert.match(window.DFOFunnelDashboard.render([]), /Geen rechten/);
});

test('scherm: periode-presets in Amsterdam-tijd', () => {
  const { window } = laadScherm({});
  const D = window.DFOFunnelDashboard;
  // 1 okt 22:30 UTC = 2 okt 00:30 in Amsterdam.
  const nu = new Date('2026-10-01T22:30:00Z');
  assert.equal(D.nlVandaag(nu), '2026-10-02');
  assert.deepEqual({ ...D.presetRange('vandaag', nu) }, { van: '2026-10-02', tot: '2026-10-02' });
  assert.deepEqual({ ...D.presetRange('7d', nu) }, { van: '2026-09-26', tot: '2026-10-02' });
  assert.deepEqual({ ...D.presetRange('30d', nu) }, { van: '2026-09-03', tot: '2026-10-02' });
  assert.deepEqual({ ...D.presetRange('maand', nu) }, { van: '2026-10-01', tot: '2026-10-02' });
  // Custom: ongeldig → null, geldig → die waarden.
  D.state.customVan = '2026-10-05'; D.state.customTot = '2026-10-01';
  assert.equal(D.presetRange('custom', nu), null);
  D.state.customVan = '2026-09-01'; D.state.customTot = '2026-09-30';
  assert.deepEqual({ ...D.presetRange('custom', nu) }, { van: '2026-09-01', tot: '2026-09-30' });
  assert.equal(D.plusDagen('2026-03-01', -1), '2026-02-28');
});

test('scherm: leadsonderhoud Funnels-tab tekent het dashboard bovenaan', () => {
  const src = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  const fv = src.slice(src.indexOf('function funnelsView()'), src.indexOf('// ── E-mails-tab'));
  assert.match(fv, /window\.DFOFunnelDashboard\.render\(FUNNEL_REGISTRY\)/);
  assert.match(fv, /\/api\/leads-per-bron-count|_lsFunnelRowHtml/);   // bestaande telling blijft
  assert.match(src, /window\.DFO\.VIEWS\['leadsonderhoud\/Funnels'\]\s*=\s*funnelsView/);
});
