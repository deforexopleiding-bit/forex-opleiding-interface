// tests/trainingdrops.test.js — module Trainingdrops (wekelijkse training-funnel).
//
//   1. training-bron: patroon, label, datum, links
//   2. funnel-stats-compute + leads-v2 herkennen 'training-<dd-mm-jj>' als patroon
//   3. aggregatie per drop (bezoekers, formulier, leads, conversie, kanalen, testleads,
//      lead met een latere bron via de sessie)
//   4. endpoint: alleen lezen, leads.view, fail-soft zonder funnel_events, extra leads
//   5. bedrading: menu-item, allowlist, script-tag

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    like: (c, v) => { q.filters.push(['like', c, v]); return k; },
    gt: (c, v) => { q.filters.push(['gt', c, v]); return k; },
    gte: (c, v) => { q.filters.push(['gte', c, v]); return k; },
    lt: (c, v) => { q.filters.push(['lt', c, v]); return k; },
    order: (c, o) => { q.order = [c, o?.ascending !== false]; return k; },
    limit: (n) => { q.lim = n; return k; },
    insert: verboden, update: verboden, upsert: verboden, delete: verboden,
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  function run() {
    db.log.push(q);
    if (db.ontbreekt[tabel]) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${tabel}'` } };
    if (db.fout[tabel]) return { data: null, error: { message: db.fout[tabel] } };
    let rijen = (db.tabellen[tabel] || []).slice();
    for (const [op, c, v] of q.filters) {
      if (op === 'eq') rijen = rijen.filter((r) => r[c] === v);
      if (op === 'is') rijen = rijen.filter((r) => (r[c] ?? null) === v);
      if (op === 'in') rijen = rijen.filter((r) => v.map(String).includes(String(r[c])));
      if (op === 'like') { const pre = v.replace(/%$/, ''); rijen = rijen.filter((r) => String(r[c] || '').startsWith(pre)); }
      if (op === 'gt') rijen = rijen.filter((r) => r[c] > v);
      if (op === 'gte') rijen = rijen.filter((r) => Date.parse(r[c]) >= Date.parse(v));
      if (op === 'lt') rijen = rijen.filter((r) => Date.parse(r[c]) < Date.parse(v));
    }
    if (q.order) { const [c, asc] = q.order; rijen.sort((a, b) => (asc ? 1 : -1) * (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0)); }
    rijen = rijen.slice(0, Math.min(q.lim ?? 1000, 1000));
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
  namedExports: { requirePermission: async (req, sleutel) => { auth.gevraagd.push(sleutel); return auth.toegestaan; } },
});

const B = await import('../api/_lib/training-bron.js');
const C = await import('../api/_lib/trainingdrops-compute.js');
const F = await import('../api/_lib/funnel-stats-compute.js');
const E = await import('../api/trainingdrops.js');

function reset() {
  db.tabellen = {}; db.ontbreekt = {}; db.fout = {}; db.log = [];
  auth.user = { id: 'u1' }; auth.toegestaan = true; auth.gevraagd = [];
}
async function call(query = {}, method = 'GET') {
  const res = { statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await E.default({ method, query, headers: {} }, res);
  return res;
}

let evId = 0;
const ev = (session_id, event_type, extra = {}) => ({
  id: ++evId, session_id, variant: 'training-22-10-26', event_type, ts: '2026-10-23T11:00:00Z', lead_id: null, src: null, utm: null, ...extra,
});
const lead = (id, extra = {}) => ({
  id, voornaam: 'Jan', achternaam: 'de Vries', email: id + '@x.nl', telefoon: '+31600000000', bron: 'training-22-10-26',
  campagne: null, status: 'nieuw', kwalificatie: null, aangemaakt: '2026-10-23T11:00:00Z', laatste_aanmelding: null, verwijderd_op: null, ...extra,
});

// ════════════════════════════════════════════════════════════════════════════
// 1 · training-bron
// ════════════════════════════════════════════════════════════════════════════

test('training-bron: patroon, label, datum en links', () => {
  assert.equal(B.isTrainingBron('training-22-10-26'), true);
  for (const x of ['training-2-10-26', 'training-22-10-2026', 'training', 'training-22-10-26x', 'webinar-v1', null, 5]) {
    assert.equal(B.isTrainingBron(x), false, String(x));
  }
  assert.equal(B.trainingLabel('training-22-10-26'), 'Live training 22/10/26');
  assert.equal(B.trainingDatum('training-22-10-26'), '2026-10-22');
  assert.equal(B.trainingSlug('training-29-10-26'), '29-10-26');
  assert.deepEqual(B.trainingLinks('training-22-10-26'), {
    live: 'https://training.deforexopleiding.nl/22-10-26',
    site: 'https://www.deforexopleiding.nl/training/22-10-26',
    pagina: '/training/22-10-26',
  });
  assert.equal(B.trainingLabel('7-daagse-v1'), null);
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · herkenning in funnel-stats en de leadlijst
// ════════════════════════════════════════════════════════════════════════════

test('funnel-stats-compute: elke training-<dd-mm-jj> is een bekende variant met label', () => {
  assert.equal(F.isBekendeVariant('training-22-10-26'), true);
  assert.equal(F.isBekendeVariant('training-05-11-26'), true);
  assert.equal(F.isBekendeVariant('training-onzin'), false);
  assert.deepEqual(F.variantInfo('training-05-11-26'), { label: 'Live training 05/11/26', groep: 'training' });
  // De vaste lijst (default van /api/funnel-stats) is niet uitgebreid.
  assert.ok(!F.FUNNEL_VARIANTEN.some((v) => v.startsWith('training-')));
  const r = F.aggregeerFunnelStats({
    events: [ev('s1', 'landing', { quiz_versie: null, stap_nr: null }), ev('s1', 'lead_ingediend')],
    leads: [{ id: 'L1', bron: 'training-22-10-26', email: 'a@x.nl', aangemaakt: '2026-10-23T11:00:00Z' }],
    start: new Date('2026-10-22T22:00:00Z'), eindExclusief: new Date('2026-10-23T22:00:00Z'),
    varianten: ['training-22-10-26'],
  });
  const v = r.per_variant['training-22-10-26'];
  assert.equal(v.label, 'Live training 22/10/26');
  assert.equal(v.groep, 'training');
  assert.equal(v.funnel[0].sessions, 1);
  assert.equal(v.lead_resultaat.leads, 1);
});

test('leads-v2: bronLabel herkent het training-patroon (één regel, niet per week)', () => {
  const src = lees('modules/klanten-v2/views/leads-v2.js');
  const m = src.match(/const TRAINING_BRON_RE = (\/.+\/);/);
  assert.ok(m, 'TRAINING_BRON_RE in leads-v2.js');
  const re = new Function('return ' + m[1])();
  assert.deepEqual(re.exec('training-22-10-26').slice(1), ['training', '22', '10', '26', undefined]);
  assert.deepEqual(re.exec('drop-22-10-26-2').slice(1), ['drop', '22', '10', '26', '2']);
  assert.match(src, /\(t\[1\] === 'drop' \? 'Drop ' : 'Live training '\) \+ t\[2\]/);
  assert.doesNotMatch(src, /'training-22-10-26'/);
});

test('funnel-stats endpoint: ?variant=training-dd-mm-jj toegestaan, onzin niet', async () => {
  const FS = await import('../api/funnel-stats.js');
  reset();
  db.tabellen.funnel_events = []; db.tabellen.leads = []; db.tabellen.opstartsessie_submissions = [];
  const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await FS.default({ method: 'GET', query: { van: '2026-10-23', tot: '2026-10-23', variant: 'training-22-10-26' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.varianten, ['training-22-10-26']);
  assert.equal(res.body.per_variant['training-22-10-26'].label, 'Live training 22/10/26');
  const res2 = { ...res, statusCode: 0 };
  await FS.default({ method: 'GET', query: { variant: 'training-xx' }, headers: {} }, res2);
  assert.equal(res2.statusCode, 400);
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · aggregatie
// ════════════════════════════════════════════════════════════════════════════

test('aggregatie: bezoekers, formulier, leads, conversie en kanalen per drop', () => {
  const events = [
    ev('s1', 'landing', { src: 'ig-story', utm: 'facebook' }), ev('s1', 'formulier_start', { lead_id: 'L1' }), ev('s1', 'lead_ingediend', { lead_id: 'L1', ts: '2026-10-23T11:05:00Z' }),
    ev('s1', 'landing', { src: 'ig-story' }), // dubbel → telt één keer
    ev('s2', 'landing', { utm: 'IG-Story' }), ev('s2', 'formulier_start'),
    ev('s3', 'landing', { utm: 'nieuwsbrief' }), ev('s3', 'lead_ingediend', { lead_id: 'L2' }),
    ev('s4', 'landing', { src: 'TikTok-Bio' }),              // onbekend → zoals het is
    ev('s5', 'landing'),
    ev('s6', 'video_gestart'), // geen fase-type → genegeerd
  ];
  const { drops, totaal } = C.bouwTrainingdrops({ leads: [lead('L1'), lead('L2'), lead('L3')], events });
  assert.equal(drops.length, 1);
  const d = drops[0];
  assert.equal(d.label, 'Live training 22/10/26');
  assert.equal(d.datum, '2026-10-22');
  assert.equal(d.bezoekers, 5);
  assert.equal(d.formulier_gestart, 2);
  assert.equal(d.leads, 3);                 // L3 heeft geen sessie, wel bron
  assert.equal(d.conversie_pct, 60);
  assert.equal(d.formulier_pct, 40);
  const k = Object.fromEntries(d.leads_per_kanaal.map((x) => [x.kanaal, x.n]));
  assert.equal(k['ig-story'], 1);
  assert.equal(k.nieuwsbrief, 1);
  assert.equal(k.onbekend, 1);
  assert.equal(k['ig-bio'], 0);             // vaste kanalen staan er altijd
  const b = Object.fromEntries(d.bezoekers_per_kanaal.map((x) => [x.kanaal, x.n]));
  assert.deepEqual([b['ig-story'], b.nieuwsbrief, b['TikTok-Bio'], b.direct], [2, 1, 1, 1]);
  assert.equal(d.bezoekers_per_kanaal.find((x) => x.kanaal === 'TikTok-Bio').label, 'TikTok-Bio');
  assert.deepEqual(d.leads_per_kanaal.slice(0, 6).map((x) => x.kanaal), ['ig-story', 'ig-bio', 'nieuwsbrief', 'whatsapp', 'meta-ad', 'direct']);
  const l1 = d.lead_lijst.find((x) => x.id === 'L1');
  assert.equal(l1.naam, 'Jan de Vries');
  assert.equal(l1.kanaal, 'ig-story');          // src wint van utm_source
  assert.equal(l1.kanaal_label, 'Instagram story');
  assert.equal(l1.aangemeld_op, '2026-10-23T11:05:00Z');
  assert.equal(totaal.leads, 3);
  assert.equal(totaal.bezoekers, 5);
});

test('aggregatie: testleads en hun sessies tellen niet mee, maar staan gemarkeerd in de lijst', () => {
  const events = [ev('s1', 'landing'), ev('s1', 'lead_ingediend', { lead_id: 'T1' }), ev('s2', 'landing')];
  const { drops } = C.bouwTrainingdrops({
    leads: [lead('T1', { email: 'maxim.delombaerde96+test-training1@gmail.com' })], events,
  });
  const d = drops[0];
  assert.equal(d.bezoekers, 1);
  assert.equal(d.leads, 0);
  assert.equal(d.test_leads, 1);
  assert.equal(d.test_sessies, 1);
  assert.equal(d.conversie_pct, 0);
  assert.equal(d.lead_lijst.length, 1);
  assert.equal(d.lead_lijst[0].test, true);
});

test('aggregatie: lead met een latere bron blijft bij de eerdere drop via de sessie; nieuwste bovenaan', () => {
  const events = [
    ev('a', 'landing', { lead_id: 'L1' }), ev('a', 'lead_ingediend', { lead_id: 'L1' }),
    ev('b', 'landing', { variant: 'training-29-10-26', lead_id: 'L1', utm: 'whatsapp' }),
    ev('b', 'lead_ingediend', { variant: 'training-29-10-26', lead_id: 'L1' }),
  ];
  const { drops } = C.bouwTrainingdrops({ leads: [lead('L1', { bron: 'training-29-10-26' })], events });
  assert.deepEqual(drops.map((d) => d.variant), ['training-29-10-26', 'training-22-10-26']);
  assert.equal(drops[0].leads, 1);
  assert.equal(drops[0].lead_lijst[0].kanaal, 'whatsapp');
  assert.equal(drops[1].leads, 1);
  assert.equal(drops[1].lead_lijst[0].bron_elders, true);
  assert.equal(drops[1].lead_lijst[0].huidige_bron, 'training-29-10-26');
});

test('aggregatie: drop zonder events (alleen leads) en lege invoer', () => {
  const { drops } = C.bouwTrainingdrops({ leads: [lead('L1')], events: [] });
  assert.equal(drops[0].bezoekers, 0);
  assert.equal(drops[0].conversie_pct, null);
  assert.equal(drops[0].leads, 1);
  const leeg = C.bouwTrainingdrops({});
  assert.deepEqual(leeg.drops, []);
  assert.equal(leeg.totaal.drops, 0);
  assert.equal(leeg.totaal.conversie_pct, null);
});

test('kanaal: meta.src, anders meta.utm_source, anders direct; labels', () => {
  assert.equal(C.bepaalKanaal('ig-bio', 'nieuwsbrief'), 'ig-bio');
  assert.equal(C.bepaalKanaal(null, 'Meta-Ad'), 'meta-ad');
  assert.equal(C.bepaalKanaal('  ', 'whatsapp'), 'whatsapp');
  assert.equal(C.bepaalKanaal(null, null), 'direct');
  assert.equal(C.bepaalKanaal('', ''), 'direct');
  assert.equal(C.bepaalKanaal('Podcast Mei', null), 'Podcast Mei');   // onbekend: zoals het is
  assert.deepEqual(
    ['ig-story', 'ig-bio', 'nieuwsbrief', 'whatsapp', 'meta-ad', 'direct', 'Podcast Mei'].map(C.kanaalLabel),
    ['Instagram story', 'Instagram bio', 'Nieuwsbrief', 'WhatsApp', 'Meta-advertentie', 'Direct', 'Podcast Mei'],
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 4 · endpoint
// ════════════════════════════════════════════════════════════════════════════

test('endpoint: 405 / 401 / 403 met leads.view', async () => {
  reset();
  assert.equal((await call({}, 'POST')).statusCode, 405);
  auth.user = null;
  assert.equal((await call()).statusCode, 401);
  reset(); auth.toegestaan = false;
  assert.equal((await call()).statusCode, 403);
  assert.deepEqual(auth.gevraagd, ['leads.view']);
});

test('endpoint: leest training-leads + events (paging), haalt leads met latere bron erbij', async () => {
  reset();
  const rijen = [];
  for (let i = 0; i < 1200; i += 1) rijen.push(ev('s' + i, 'landing', { utm: i % 2 ? 'ig-bio' : null }));
  rijen.push(ev('s0', 'lead_ingediend', { lead_id: 'L1' }));
  rijen.push(ev('s1', 'lead_ingediend', { lead_id: 'L9' }));                       // bron intussen elders
  rijen.push(ev('w', 'landing', { variant: 'webinar-v1' }));                      // geen training
  db.tabellen.funnel_events = rijen;
  db.tabellen.leads = [
    lead('L1'),
    lead('L9', { bron: 'kennismakingscursus-v9' }),
    lead('LX', { verwijderd_op: '2026-10-23T12:00:00Z' }),
    lead('LW', { bron: 'webinar-v1' }),
  ];
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.tracking_actief, true);
  assert.equal(r.body.meta.events_gelezen, 1202);
  assert.equal(r.body.drops.length, 1);
  const d = r.body.drops[0];
  assert.equal(d.bezoekers, 1200);
  assert.deepEqual(d.lead_lijst.map((l) => l.id).sort(), ['L1', 'L9']);
  assert.equal(d.leads_per_kanaal.find((k) => k.kanaal === 'ig-bio').n, 1);
  const evQ = db.log.filter((q) => q.tabel === 'funnel_events');
  assert.equal(evQ.length, 3, '2 pagina\'s training-% + 1 pagina drop-%');
  assert.ok(evQ[1].filters.some(([op, c]) => op === 'gt' && c === 'id'));
  assert.ok(evQ[0].filters.some(([op, c, v]) => op === 'like' && c === 'variant' && v === 'training-%'));
  assert.match(evQ[0].kol, /src:meta->>src/);
  assert.match(evQ[0].kol, /utm:meta->>utm_source/);
});

test('endpoint: fail-soft zonder funnel_events → drops uit de leads', async () => {
  reset();
  db.ontbreekt.funnel_events = true;
  db.tabellen.leads = [lead('L1')];
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.tracking_actief, false);
  assert.equal(r.body.meta.leesfout, null);
  assert.equal(r.body.drops[0].leads, 1);
  reset();
  db.fout.funnel_events = 'permission denied';
  db.tabellen.leads = [];
  const r2 = await call();
  assert.equal(r2.statusCode, 200);
  assert.match(r2.body.meta.leesfout, /permission denied/);
  assert.deepEqual(r2.body.drops, []);
  reset();
  db.fout.leads = 'kapot';
  assert.equal((await call()).statusCode, 500);
});

test('endpoint: bron-code schrijft nooit en gebruikt geen rpc', () => {
  const src = lees('api/trainingdrops.js') + lees('api/_lib/trainingdrops-compute.js') + lees('api/_lib/training-bron.js');
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.match(lees('api/trainingdrops.js'), /requirePermission\(req, 'leads\.view'\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// 5 · bedrading
// ════════════════════════════════════════════════════════════════════════════

test('bedrading: menu-item in Groei, allowlist, view-registratie en script-tag', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  const m = shell.match(/\{ g: 'Groei',\s+id: 'trainingdrops',[^\n]+/);
  assert.ok(m, 'MODS-regel trainingdrops');
  assert.match(m[0], /roles: SAMMK\.concat\('sales'\)/);
  assert.doesNotMatch(m[0], /permKey/);
  // Direct onder Leads in het menu.
  assert.ok(shell.indexOf("id: 'leads',") < shell.indexOf("id: 'trainingdrops',"));
  assert.match(lees('modules/klanten-v2/klanten-v2.js'), /'trainingdrops'/);
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /views\/trainingdrops-v2\.js\?v=\d+"/);
  const view = lees('modules/klanten-v2/views/trainingdrops-v2.js');
  assert.match(view, /VIEWS\['trainingdrops\/'\]/);
  assert.match(view, /\/api\/trainingdrops/);
  assert.match(view, /goMod\('leads'\)/);
  assert.match(view, /__leadOpen\(id\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// 6 · cadeau: strategiesessie met Dave (dfo-website #132)
// ════════════════════════════════════════════════════════════════════════════

const afspraak = (id, extra = {}) => ({
  id, booking_source: 'training-22-10-26', scheduled_at: '2026-10-27T13:00:00Z', status: 'scheduled',
  lead_email: null, is_test: false, parent_appointment_id: null, created_at: '2026-10-23T12:00:00Z', ...extra,
});

test('callCategorie: completed/no_show/cancelled, verwijderd telt niet, de rest = gepland', () => {
  assert.deepEqual(
    ['completed', 'no_show', 'cancelled', 'verwijderd', 'scheduled', 'in_progress', 'wacht_op_reschedule', 'verplaatst', null].map(C.callCategorie),
    ['gehouden', 'no_show', 'geannuleerd', null, 'gepland', 'gepland', 'gepland', 'gepland', 'gepland'],
  );
});

test('calls: koppeling, verzet-keten en e-mail; één call per lead; test en verwijderd tellen niet', () => {
  const leads = [lead('L1'), lead('L2'), lead('L3'), lead('L4'), lead('T1', { email: 'iemand+test@x.nl' })];
  const events = [
    ev('s1', 'landing', { src: 'ig-story', lead_id: 'L1' }), ev('s1', 'cadeau_getoond', { lead_id: 'L1' }), ev('s1', 'cadeau_klik', { lead_id: 'L1' }),
    ev('s2', 'landing', { src: 'nieuwsbrief', lead_id: 'L2' }), ev('s2', 'cadeau_klik', { lead_id: 'L2' }),
    ev('s3', 'landing', { src: 'ig-story' }), ev('s3', 'cadeau_klik'),
  ];
  const afspraken = [
    // L1: geboekt, daarna verzet → de nieuwe rij telt, gehouden.
    afspraak('A1', { status: 'verplaatst', created_at: '2026-10-23T12:00:00Z' }),
    afspraak('A1b', { status: 'completed', parent_appointment_id: 'A1', created_at: '2026-10-24T09:00:00Z' }),
    // L2: no-show, via koppeling.
    afspraak('A2', { status: 'no_show' }),
    // L3: geannuleerd, alleen op e-mail te vinden.
    afspraak('A3', { status: 'cancelled', lead_email: 'L3@x.nl' }),
    // L4: verwijderd → telt niet.
    afspraak('A4', { status: 'verwijderd', lead_email: 'l4@x.nl' }),
    // Testafspraken tellen niet.
    afspraak('AT', { is_test: true, lead_email: 'l4@x.nl' }),
    afspraak('AT2', { lead_email: 'iemand+test@x.nl' }),
    // Andere training.
    afspraak('B1', { booking_source: 'training-29-10-26', lead_email: 'l4@x.nl' }),
    // Geen training-bron.
    afspraak('S1', { booking_source: 'strategiescan', lead_email: 'l4@x.nl' }),
  ];
  const koppelingen = [{ appointment_id: 'A1', lead_id: 'L1' }, { appointment_id: 'A2', lead_id: 'L2' }];
  const { drops, totaal } = C.bouwTrainingdrops({ leads, events, afspraken, koppelingen });
  const d = drops.find((x) => x.variant === 'training-22-10-26');
  assert.equal(d.leads, 4);
  assert.equal(d.test_leads, 1);
  assert.equal(d.cadeau_getoond, 1);
  assert.equal(d.cadeau_klik, 3);
  assert.equal(d.calls, 3);
  assert.deepEqual([d.calls_gepland, d.calls_gehouden, d.calls_no_show, d.calls_geannuleerd], [0, 1, 1, 1]);
  assert.equal(d.leads_met_call, 3);
  assert.equal(d.lead_call_pct, 75);
  const call = (id) => d.lead_lijst.find((l) => l.id === id).call;
  assert.deepEqual(call('L1'), { scheduled_at: '2026-10-27T13:00:00Z', status: 'completed', categorie: 'gehouden', label: 'Gehouden' });
  assert.equal(call('L2').label, 'No-show');
  assert.equal(call('L3').label, 'Geannuleerd');
  assert.equal(call('L4'), null);                       // verwijderd → geen call
  const k = Object.fromEntries(d.kanalen.map((x) => [x.kanaal, x]));
  assert.deepEqual([k['ig-story'].cadeau_klik, k['ig-story'].calls, k['ig-story'].gehouden, k['ig-story'].lead_call_pct], [2, 1, 1, 100]);
  assert.deepEqual([k.nieuwsbrief.calls, k.nieuwsbrief.no_show], [1, 1]);
  assert.deepEqual([k.onbekend.calls, k.onbekend.geannuleerd, k.onbekend.leads], [1, 1, 2]);
  // De call van de andere training maakt daar een drop (en L4 hoort erbij).
  const d2 = drops.find((x) => x.variant === 'training-29-10-26');
  assert.equal(d2.calls, 1);
  assert.equal(d2.leads, 1);
  assert.equal(d2.lead_lijst[0].id, 'L4');
  assert.equal(d2.lead_call_pct, 100);
  assert.equal(totaal.calls, 4);
  assert.equal(totaal.leads_met_call, 4);
});

test('calls: zonder bekende lead wel geteld (kanaal onbekend), niet in de leadlijst', () => {
  const { drops } = C.bouwTrainingdrops({ afspraken: [afspraak('X', { lead_email: 'vreemd@x.nl' })] });
  assert.equal(drops[0].calls, 1);
  assert.equal(drops[0].leads, 0);
  assert.equal(drops[0].lead_call_pct, null);
  assert.equal(drops[0].kanalen.find((k) => k.kanaal === 'onbekend').calls, 1);
});

test('endpoint: leest training-afspraken + koppelingen, haalt leads op id en e-mail erbij', async () => {
  reset();
  db.tabellen.funnel_events = [ev('s1', 'landing', { src: 'whatsapp', lead_id: 'L1' }), ev('s1', 'cadeau_klik', { lead_id: 'L1' })];
  db.tabellen.leads = [
    lead('L1'),
    lead('L7', { bron: 'opstartsessie' }),          // via koppeling
    lead('L8', { bron: '7-daagse-v5', email: 'l8@x.nl' }), // via e-mail
  ];
  db.tabellen.follow_up_appointments = [
    afspraak('A1', { status: 'completed' }),
    afspraak('A7'),
    afspraak('A8', { status: 'no_show', lead_email: 'L8@x.nl' }),
    afspraak('S', { booking_source: 'strategiescan' }),
  ];
  db.tabellen.opstartsessie_submissions = [{ appointment_id: 'A1', lead_id: 'L1' }, { appointment_id: 'A7', lead_id: 'L7' }];
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.calls_fout, null);
  const d = r.body.drops[0];
  assert.deepEqual(d.lead_lijst.map((l) => l.id).sort(), ['L1', 'L7', 'L8']);
  assert.equal(d.calls, 3);
  assert.equal(d.calls_gehouden, 1);
  assert.equal(d.calls_no_show, 1);
  assert.equal(d.kanalen.find((k) => k.kanaal === 'whatsapp').cadeau_klik, 1);
  const q = db.log.find((x) => x.tabel === 'follow_up_appointments');
  assert.ok(q.filters.some(([op, c, v]) => op === 'like' && c === 'booking_source' && v === 'training-%'));
  assert.ok(db.log.some((x) => x.tabel === 'leads' && x.filters.some(([op, c]) => op === 'in' && c === 'email')));
  // Fase-query vraagt de cadeau-events mee op.
  const evQ = db.log.find((x) => x.tabel === 'funnel_events');
  assert.ok(evQ.filters.some(([op, c, v]) => op === 'in' && c === 'event_type' && v.includes('cadeau_klik') && v.includes('cadeau_getoond')));
});

test('endpoint: afspraken niet leesbaar → drops blijven, meta.calls_fout', async () => {
  reset();
  db.tabellen.leads = [lead('L1')];
  db.fout.follow_up_appointments = 'kapot';
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meta.calls_fout, 'kapot');
  assert.equal(r.body.drops[0].leads, 1);
  assert.equal(r.body.drops[0].calls, 0);
});

test('boek-route: training-* krijgt Dave als eigenaar zoals strategiescan, maar geen scan-rij of scan-titel', () => {
  const src = lees('api/public-opstartsessie-book.js');
  assert.match(src, /import \{ isTrainingBron \} from '\.\/_lib\/training-bron\.js';/);
  assert.match(src, /const isTraining = isTrainingBron\(source\);/);
  assert.match(src, /const scanAssessor = \(isScan \|\| isTraining\) \? await leesScanAssessor\(\) : null;/);
  assert.match(src, /if \(scanAssessor\?\.id\) leadRow\.owner_id = scanAssessor\.id;/);
  assert.match(src, /\.\.\.\(isScan \? \{ ghlTitel: scanGhlTitel/);
  assert.match(src, /if \(isScan && result\?\.appointment_id\) \{\s+const scan = await maakScanConcept/);
});

test('funnel-stats: de cadeau-events zijn bekende types', () => {
  for (const t of ['cadeau_getoond', 'cadeau_klik', 'sessie_ingepland']) assert.ok(F.BEKENDE_EVENT_TYPES.includes(t), t);
});

test('bronlabels van afspraken: training-* wordt "Live training dd/mm/jj"', async () => {
  const N = await import('../api/_lib/afspraak-intern-notify.js');
  assert.equal(N.bronVan({ booking_source: 'training-22-10-26' }), 'Live training 22/10/26');
  assert.equal(N.bronVan({ booking_source: 'strategiescan' }), 'strategiescan');
  const lijst = lees('api/leadsonderhoud-opstartsessies-list.js');
  assert.match(lijst, /labelBySlug\.get\(r\.booking_source\) \|\| trainingLabel\(r\.booking_source\)/);
  assert.match(lijst, /labelBySlug\.get\(c\.booking_source\) \|\| trainingLabel\(c\.booking_source\)/);
  assert.match(lees('api/leadsonderhoud-opstartsessies-detail.js'), /let bronLabel = trainingLabel\(row\.booking_source\)/);
  assert.match(lees('api/display-metrics.js'), /trainingLabel\(a\.booking_source\) \|\| a\.booking_source/);
  // Chips in Kennismakingsgesprekken en Daves opvolging-agenda (patroon, geen regel per week).
  assert.match(lees('modules/klanten-v2/views/leadsonderhoud-v2.js'), /const _LS_TRAINING_RE = \/\^\(\?:training\|drop\)-/);
  assert.match(lees('modules/klanten-v2/views/opvolging-v2.js'), /data-bron="training"/);
});

test('view: kolom Call in de leadlijst en de cadeau-cijfers', () => {
  const view = lees('modules/klanten-v2/views/trainingdrops-v2.js');
  assert.match(view, /Lead → call/);
  assert.match(view, /Cadeau-klik/);
  assert.match(view, /<th style="padding:8px 12px">Call<\/th>/);
  assert.match(view, />geen<\/span>/);
});

test('Contentmachine: drop-<dd-mm-jj> en een volgnummer horen bij dezelfde familie', () => {
  assert.ok(B.isTrainingBron('drop-22-10-26'));
  assert.ok(B.isTrainingBron('training-22-10-26-2'));
  assert.ok(!B.isTrainingBron('drop-22-10-26-12'));
  assert.ok(!B.isTrainingBron('drops-22-10-26'));
  assert.equal(B.trainingLabel('drop-22-10-26'), 'Drop 22/10/26');
  assert.equal(B.trainingLabel('training-22-10-26-2'), 'Live training 22/10/26 (2)');
  assert.equal(B.trainingSlug('drop-22-10-26-2'), '22-10-26-2');
  assert.equal(B.trainingDatum('drop-29-10-26'), '2026-10-29');
  assert.equal(B.trainingLinks('drop-29-10-26').live, 'https://training.deforexopleiding.nl/29-10-26');
  assert.deepEqual(B.TRAINING_BRON_PREFIXEN, ['training-', 'drop-']);
});
