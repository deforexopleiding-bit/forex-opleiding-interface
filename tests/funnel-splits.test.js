// tests/funnel-splits.test.js — funnel-split-test + router-beheer (2026-10-21).
//   1. rekenkern: bezoekers / landing / opt-in / leads / call per variant, alleen testverkeer;
//   2. validatie (slug, pad, gewicht); verkeersverdeling;
//   3. endpoint: lezen (+ migratie ontbreekt), winnaar (verliezers blijven aan op 0%), rechten;
//   4. scherm: Funnels-tab in drie subtabs; Koppelen toont link + kopieerknop + statusregel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { berekenSplitStats, valideerSplit, valideerVariant, verkeersVerdeling, nlDagStartUtc, veiligPad } from '../api/_lib/funnel-split-stats.js';
import { maakHandler } from '../api/funnel-splits.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('rekenkern: per variant, alleen events met meta.split van deze test', () => {
  const splits = [{ id: 'S1', slug: 'minicursus', varianten: [{ bron: 'kennismakingscursus-v7' }, { bron: 'kennismakingscursus-v8' }] }];
  const toew = [
    { split_id: 'S1', bron: 'kennismakingscursus-v7', bezoeker_id: 'b1' },
    { split_id: 'S1', bron: 'kennismakingscursus-v7', bezoeker_id: 'b1' },   // terugkerend = 1 bezoeker
    { split_id: 'S1', bron: 'kennismakingscursus-v7', bezoeker_id: 'b2' },
    { split_id: 'S1', bron: 'kennismakingscursus-v8', bezoeker_id: 'b3' },
  ];
  const ev = (split, variant, event_type, session_id, lead_id = null) => ({ split, variant, event_type, session_id, lead_id });
  const events = [
    ev('minicursus', 'kennismakingscursus-v7', 'landing', 's1'), ev('minicursus', 'kennismakingscursus-v7', 'landing', 's2'),
    ev('minicursus', 'kennismakingscursus-v7', 'gegevens_ok', 's1'), ev('minicursus', 'kennismakingscursus-v7', 'lead_ingediend', 's1', 'L1'),
    ev('minicursus', 'kennismakingscursus-v7', 'geboekt', 's1'),
    ev('minicursus', 'kennismakingscursus-v8', 'landing', 's3'),
    ev('andere-test', 'kennismakingscursus-v7', 'landing', 's9'),   // niet van deze test
  ];
  const r = berekenSplitStats(splits, toew, events).S1;
  assert.deepEqual(r['kennismakingscursus-v7'], { bezoekers: 2, landing: 2, opt_in: 1, leads: 1, geboekt: 1, optin_pct: 50, lead_pct: 50, geboekt_pct: 50 });
  assert.deepEqual(r['kennismakingscursus-v8'], { bezoekers: 1, landing: 1, opt_in: 0, leads: 0, geboekt: 0, optin_pct: 0, lead_pct: 0, geboekt_pct: 0 });
});

test('verkeersverdeling, validatie en NL-dagstart', () => {
  assert.deepEqual(verkeersVerdeling([{ id: 'a', gewicht: 90, actief: true }, { id: 'b', gewicht: 10, actief: true }, { id: 'c', gewicht: 50, actief: false }]), { a: 90, b: 10, c: 0 });
  assert.deepEqual(verkeersVerdeling([{ id: 'a', gewicht: 100, actief: true }, { id: 'b', gewicht: 0, actief: true }]), { a: 100, b: 0 });
  assert.equal(valideerSplit({ slug: 'Mini Cursus', naam: 'x' }).ok, false);
  assert.deepEqual(valideerSplit({ slug: 'minicursus', naam: ' Mini-cursus ', fallback_pad: '/kennismakingscursus-v7' }).rij, { slug: 'minicursus', naam: 'Mini-cursus', actief: true, fallback_pad: '/kennismakingscursus-v7', notitie: null });
  assert.equal(valideerSplit({ slug: 'a', naam: 'x', fallback_pad: '//evil.com' }).ok, false);
  assert.equal(valideerVariant({ bron: 'kennismakingscursus-v7', pad: 'https://evil.com', gewicht: 50 }).ok, false);
  assert.equal(valideerVariant({ bron: 'kennismakingscursus-v7', pad: '/kennismakingscursus-v7', gewicht: 101 }).ok, false);
  assert.equal(veiligPad('/x?y=1'), '/x');
  assert.equal(nlDagStartUtc('2026-10-21'), '2026-10-20T22:00:00.000Z', 'zomertijd');
  assert.equal(nlDagStartUtc('2026-11-02'), '2026-11-01T23:00:00.000Z', 'wintertijd');
});

// ── Nep-database ───────────────────────────────────────────────────────────
function nepDb(tabellen, fout = {}) {
  const log = [];
  const waarde = (r, c) => (c === 'meta->>split' ? r.meta?.split : r[c]);
  function from(t) {
    const st = { t, op: 'select', filters: [], patch: null, rij: null };
    const k = {
      select: () => k, order: () => k, range: () => k,
      eq: (c, v) => { st.filters.push((r) => waarde(r, c) === v); return k; },
      in: (c, v) => { st.filters.push((r) => v.includes(waarde(r, c))); return k; },
      gte: (c, v) => { st.filters.push((r) => String(waarde(r, c)) >= v); return k; },
      lt: (c, v) => { st.filters.push((r) => String(waarde(r, c)) < v); return k; },
      update: (p) => { st.op = 'update'; st.patch = p; return k; },
      insert: (r) => { st.op = 'insert'; st.rij = r; return k; },
      delete: () => { st.op = 'delete'; return k; },
      then: (ok, nok) => {
        log.push(st);
        if (fout[t]) return Promise.resolve({ data: null, error: fout[t] }).then(ok, nok);
        const rijen = tabellen[t] || (tabellen[t] = []);
        const m = rijen.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === 'update') m.forEach((r) => Object.assign(r, st.patch));
        if (st.op === 'insert') { const n = { id: 'nieuw-' + rijen.length, ...st.rij }; rijen.push(n); return Promise.resolve({ data: [n], error: null }).then(ok, nok); }
        if (st.op === 'delete') m.forEach((r) => rijen.splice(rijen.indexOf(r), 1));
        const data = t === 'funnel_events' ? m.map((r) => ({ ...r, split: r.meta?.split })) : m.map((r) => ({ ...r }));
        return Promise.resolve({ data, error: null }).then(ok, nok);
      },
    };
    return k;
  }
  return { from, log, tabellen };
}

async function roep(handler, req) {
  const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ headers: {}, query: {}, ...req }, res);
  return res;
}

const S1 = '11111111-1111-4111-8111-111111111111';
const VA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tabellen = () => ({
  funnel_splits: [{ id: S1, slug: 'minicursus', naam: 'Mini-cursus', actief: true, fallback_pad: '/kennismakingscursus-v7', aangemaakt: '2026-10-21' }],
  funnel_split_varianten: [
    { id: VA, split_id: S1, bron: 'kennismakingscursus-v7', pad: '/kennismakingscursus-v7', gewicht: 50, actief: true, volgorde: 0 },
    { id: VB, split_id: S1, bron: 'kennismakingscursus-v8', pad: '/kennismakingscursus-v8', gewicht: 50, actief: true, volgorde: 1 },
  ],
  funnel_split_toewijzingen: [{ split_id: S1, bron: 'kennismakingscursus-v7', bezoeker_id: 'b1', ts: '2026-10-21T08:00:00Z' }],
  funnel_events: [
    { variant: 'kennismakingscursus-v7', event_type: 'landing', session_id: 's1', lead_id: null, meta: { split: 'minicursus' }, ts: '2026-10-21T08:00:01Z' },
    { variant: 'kennismakingscursus-v7', event_type: 'landing', session_id: 'sX', lead_id: null, meta: {}, ts: '2026-10-21T08:00:01Z' },
  ],
});
const nu = () => new Date('2026-10-21T12:00:00Z');

test('endpoint: lezen met link, verkeers-% en cijfers (alleen testverkeer)', async () => {
  const db = nepDb(tabellen());
  const h = maakHandler({ db, userVan: async () => ({ id: 'u1' }), magHet: async () => true, nu });
  const r = await roep(h, { method: 'GET', query: {} });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.periode, { van: '2026-09-22', tot: '2026-10-21' });
  const s = r.body.splits[0];
  assert.equal(s.link, 'https://deforexopleiding.nl/go/minicursus');
  assert.deepEqual(s.varianten.map((v) => v.verkeer_pct), [50, 50]);
  assert.equal(s.varianten[0].stats.bezoekers, 1);
  assert.equal(s.varianten[0].stats.landing, 1, 'sessie zonder meta.split telt niet');
});

test('endpoint: migratie ontbreekt → migratie_nodig, geen fout', async () => {
  const db = nepDb({}, { funnel_splits: { code: 'PGRST205', message: "Could not find the table 'public.funnel_splits' in the schema cache" } });
  const r = await roep(maakHandler({ db, userVan: async () => ({ id: 'u1' }), magHet: async () => true, nu }), { method: 'GET' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.migratie_nodig, true);
});

test('endpoint: winnaar = 100/0, verliezer blijft AAN (sticky + meten); gelijk verdelen; rechten', async () => {
  const db = nepDb(tabellen());
  const rechten = [];
  const h = maakHandler({ db, userVan: async () => ({ id: 'u1' }), magHet: async (req, k) => { rechten.push(k); return true; }, nu });
  let r = await roep(h, { method: 'POST', body: { actie: 'winnaar', split_id: S1, variant_id: VB } });
  assert.equal(r.statusCode, 200);
  const [a, b] = db.tabellen.funnel_split_varianten;
  assert.deepEqual([a.gewicht, a.actief, b.gewicht, b.actief], [0, true, 100, true]);
  r = await roep(h, { method: 'POST', body: { actie: 'gelijk', split_id: S1 } });
  assert.deepEqual(db.tabellen.funnel_split_varianten.map((v) => v.gewicht), [50, 50]);
  assert.deepEqual(rechten, ['leads.update', 'leads.update']);
  r = await roep(h, { method: 'POST', body: { actie: 'variant_opslaan', split_id: S1, bron: 'kennismakingscursus-v6', pad: '//evil.com', gewicht: 10 } });
  assert.equal(r.statusCode, 400);
  const geen = maakHandler({ db, userVan: async () => ({ id: 'u1' }), magHet: async () => false, nu });
  assert.equal((await roep(geen, { method: 'GET' })).statusCode, 403);
  assert.equal((await roep(maakHandler({ db, userVan: async () => null, magHet: async () => true, nu }), { method: 'GET' })).statusCode, 401);
});

test('scherm: Funnels-tab in drie subtabs; Koppelen toont link, kopieerknop en statusregel', () => {
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /views\/funnel-splits-v2\.js\?v=\d+/);
  assert.ok(html.indexOf('funnel-splits-v2.js') < html.indexOf('leadsonderhoud-v2.js'), 'vóór de leadsonderhoud-view geladen');
  const ls = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(ls, /\['koppelen', 'Funnels koppelen'\], \['statistieken', 'Funnelstatistieken'\], \['boekflow', 'Boek-flow \(A\/B\/C\)'\]/);

  const ctx = createContext({ window: {}, document: {}, navigator: {}, console, Intl, Date, Math, URL, queueMicrotask: () => {} });
  ctx.window.KV = { authedJson: async () => ({}) };
  runInContext(lees('modules/klanten-v2/views/funnel-splits-v2.js'), ctx);
  const F = ctx.window.DFOFunnelSplits;
  F.state.fetched = true;
  F.state.data = { migratie_nodig: false, splits: [{
    id: S1, slug: 'minicursus', naam: 'Mini-cursus', actief: true, fallback_pad: null, link: 'https://deforexopleiding.nl/go/minicursus',
    varianten: [
      { id: VA, bron: 'kennismakingscursus-v7', pad: '/kennismakingscursus-v7', gewicht: 100, actief: true, verkeer_pct: 100, stats: { bezoekers: 40, opt_in: 8, optin_pct: 20, leads: 6, lead_pct: 15, geboekt: 2, geboekt_pct: 5 } },
      { id: VB, bron: 'kennismakingscursus-v8', pad: '/kennismakingscursus-v8', gewicht: 0, actief: true, verkeer_pct: 0, stats: { bezoekers: 10, opt_in: 1, optin_pct: 10, leads: 1, lead_pct: 10, geboekt: 0, geboekt_pct: 0 } },
    ],
  }] };
  const reg = [{ bron: 'kennismakingscursus-v7', naam: 'Mini-cursus (v7)', route: 'https://deforexopleiding.nl/kennismakingscursus-v7' },
    { bron: 'kennismakingscursus-v8', naam: 'Mini-cursus (v8)', route: 'https://deforexopleiding.nl/kennismakingscursus-v8' },
    { bron: 'strategiesessie-v1', naam: 'Flow D', route: 'https://deforexopleiding.nl/strategiesessie' }];
  const k = F.renderKoppelen(reg);
  assert.match(k, /https:\/\/deforexopleiding\.nl\/go\/minicursus<\/code>/);
  assert.match(k, />Kopieer link<\/button>/);
  assert.match(k, /WINNAAR/);
  assert.match(k, /gekoppeld · actief · 100% · 40 bezoekers · opt-in 20% · 6 leads/);
  assert.match(k, /gekoppeld · 0% \(blijft meten\) · 0% · 10 bezoekers · opt-in 10% · 1 leads/);
  assert.match(k, /<option value="strategiesessie-v1"/, 'nog niet gekoppelde variant kan erbij (uitdager)');
  const v = F.renderVergelijk();
  assert.match(v, /Lopende split-tests/);
  assert.equal((v.match(/class="fs-vrij"/g) || []).length, 2);
});
