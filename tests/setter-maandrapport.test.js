// tests/setter-maandrapport.test.js
//
// Setter-maandrapport: vaste vergoeding, selectie van commissieregels (maand
// + achterblijvers, geen dubbele koppeling), totalen, datum-guard van de cron,
// en de upsert-flow tegen een in-memory database.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  vasteVergoeding, selecteerRegels, bouwRapport, isEersteVanDeMaandUTC, previousMonthStart,
  normalizeMonthStart, nextMonthStart, computeAndUpsertSetterReport,
} from '../api/_lib/setter-report-core.js';

const ROMY = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';
const CFG = { user_id: ROMY, pct: 3, is_active: true, effective_from: '2026-08-31', monthly_fee: 750 };

test('vaste vergoeding: alleen actief en effective_from <= de 1e van de maand', () => {
  assert.equal(vasteVergoeding(CFG, '2026-08-01'), 0, 'start 31 aug → augustus geen vergoeding');
  assert.equal(vasteVergoeding(CFG, '2026-09-01'), 750);
  assert.equal(vasteVergoeding({ ...CFG, is_active: false }, '2026-09-01'), 0);
  assert.equal(vasteVergoeding({ ...CFG, monthly_fee: 0 }, '2026-09-01'), 0);
  assert.equal(vasteVergoeding(null, '2026-09-01'), 0);
});

test('regelselectie: maand M + achterblijvers, niet later, niet van een ander rapport, niet uitbetaald', () => {
  const e = (id, o) => ({ id, status: 'vrijgegeven', amount: 10, monthly_report_id: null, ...o });
  const entries = [
    e('sep', { betaal_datum: '2026-09-30' }),
    e('aug-laat', { betaal_datum: '2026-08-15' }),
    e('okt', { betaal_datum: '2026-10-01' }),
    e('ander', { betaal_datum: '2026-09-10', monthly_report_id: 'r-aug' }),
    e('eigen', { betaal_datum: '2026-09-10', monthly_report_id: 'r-sep' }),
    e('betaald', { betaal_datum: '2026-09-10', status: 'uitbetaald' }),
    e('zonder-datum', { betaal_datum: null, created_at: '2026-09-02T06:00:00Z' }),
  ];
  const ids = selecteerRegels(entries, { monthStart: '2026-09-01', reportId: 'r-sep' }).map((x) => x.id).sort();
  assert.deepEqual(ids, ['aug-laat', 'eigen', 'sep', 'zonder-datum']);
});

test('rapport: 750 vast + commissie (incl. achterblijver); regels in volgorde, totaal klopt', () => {
  const r = bouwRapport({
    cfg: CFG, monthStart: '2026-11-01',
    entries: [
      { id: 'a', status: 'vrijgegeven', amount: 18, basis: 600, pct: 3, betaal_datum: '2026-11-02', customer_id: 'c1', note: 'Factuur 2026 / 2001' },
      { id: 'b', status: 'vrijgegeven', amount: 3, basis: 100, pct: 3, betaal_datum: '2026-10-28', customer_id: 'c2', note: 'Factuur 2026 / 1990 · reserveringsfee' },
    ],
    labels: { c1: 'John Vliet', c2: 'Salih Polat' },
  });
  assert.equal(r.fee_total, 750);
  assert.equal(r.commission_total, 21);
  assert.equal(r.total, 771);
  assert.deepEqual(r.lines.map((l) => l.kind), ['vaste_vergoeding', 'commissie', 'commissie']);
  assert.match(r.lines[1].label, /^Salih Polat · .* \(betaald 28-10-2026\)$/, 'achterblijver uit oktober krijgt zijn betaaldatum');
  assert.equal(r.lines[0].label, 'Vaste maandvergoeding november 2026');
  assert.deepEqual(r.entry_ids.sort(), ['a', 'b']);
});

test('rapport: forward-only — een (legacy) regel <= 0 wordt nooit opgenomen', () => {
  const r = bouwRapport({
    cfg: { ...CFG, monthly_fee: 0 }, monthStart: '2026-11-01',
    entries: [
      { id: 'a', status: 'vrijgegeven', amount: 18, basis: 600, betaal_datum: '2026-11-02' },
      { id: 'neg', status: 'vrijgegeven', amount: -18, basis: -600, betaal_datum: '2026-11-05' },
      { id: 'nul', status: 'vrijgegeven', amount: 0, basis: 0.01, betaal_datum: '2026-11-06' },
    ],
  });
  assert.deepEqual(r.entry_ids, ['a']);
  assert.equal(r.total, 18);
  assert.ok(r.lines.every((l) => l.amount > 0));
});

test('setter-payout-run is uitgeschakeld: 410 + verwijzing naar Rapporten, geen DB', async () => {
  const { default: handler, UITBETAALRONDE_UIT_MELDING } = await import('../api/setter-payout-run.js');
  const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body: { setter_user_id: ROMY, period_start: '2026-09-01', period_end: '2026-09-30' } }, res);
  assert.equal(res.code, 410);
  assert.equal(res.body.code, 'SETTER_UITBETAALRONDE_UIT');
  assert.match(res.body.error, /Rapporten/);
  assert.equal(res.body.error, UITBETAALRONDE_UIT_MELDING);
  const fs = await import('node:fs');
  const bron = fs.readFileSync(new URL('../api/setter-payout-run.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bron, /supabase|from\(/, 'raakt de database niet aan');
  const view = fs.readFileSync(new URL('../modules/klanten-v2/views/setter-payout-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /setter-payout-run|__spRunPayout|Uitbetaalronde draaien<\/button>/, 'knop + aanroep weg uit de setter-UI');
});

test('mentoren-uitbetaling onveranderd: mentor-endpoints/core noemen niets van de setter-wijzigingen', async () => {
  const fs = await import('node:fs');
  const lees = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const mentorBestanden = [
    'api/mentor-payout-run.js', 'api/mentor-payout-generate.js', 'api/mentor-payout-approve.js',
    'api/mentor-payout-mark-paid.js', 'api/mentor-payout-revert.js', 'api/mentor-payout-reopen.js',
    'api/_lib/payout-generate-core.js', 'api/cron/generate-monthly-concepts.js',
  ];
  for (const p of mentorBestanden) {
    const bron = lees(p);
    assert.doesNotMatch(bron, /setter_monthly_report|setter-report-core|setter-payout-run|setter_ledger_entries|UITBETAALRONDE_UIT/, p);
  }
  // De mentor-module blijft z'n eigen uitbetaal-endpoints aanroepen.
  const mentorView = lees('modules/klanten-v2/views/mentoren-v2.js');
  assert.match(mentorView, /mentor-payout-/);
  assert.doesNotMatch(mentorView, /setter-reports|setter-payout-run/);
});

test('datum-guard + maandhelpers', () => {
  assert.equal(isEersteVanDeMaandUTC(new Date('2026-11-01T06:30:00Z')), true);
  assert.equal(isEersteVanDeMaandUTC(new Date('2026-11-02T06:30:00Z')), false);
  // 1 nov 00:30 Amsterdam = 31 okt 23:30 UTC → geen 1e (cron draait 06:30 UTC).
  assert.equal(isEersteVanDeMaandUTC(new Date('2026-10-31T23:30:00Z')), false);
  assert.equal(previousMonthStart(new Date('2027-01-01T06:30:00Z')), '2026-12-01');
  assert.equal(previousMonthStart(new Date('2026-10-01T06:30:00Z')), '2026-09-01');
  assert.equal(normalizeMonthStart('2026-09'), '2026-09-01');
  assert.equal(normalizeMonthStart('2026-13'), null);
  assert.equal(nextMonthStart('2026-12-01'), '2027-01-01');
});

// ── In-memory database ────────────────────────────────────────────────────
function memDb(tables, { missingTables = [], missingCols = [] } = {}) {
  let seq = 0;
  const calls = [];
  return {
    calls, tables,
    from(name) {
      const st = { op: 'select', filters: [], payload: null, cols: '' };
      const match = (r) => st.filters.every((f) => f(r));
      const exec = () => {
        calls.push({ table: name, op: st.op });
        if (missingTables.includes(name)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${name}'` } };
        const miss = missingCols.find((c) => st.cols.includes(c) || (st.payload && JSON.stringify(st.payload).includes(`"${c}"`)));
        if (miss) return { data: null, error: { code: '42703', message: `column ${name}.${miss} does not exist` } };
        const rows = tables[name] || (tables[name] = []);
        if (st.op === 'select') return { data: rows.filter(match).map((r) => ({ ...r })), error: null };
        if (st.op === 'insert') {
          const ins = [].concat(st.payload).map((r) => ({ id: `id-${++seq}`, ...r }));
          rows.push(...ins);
          return { data: ins, error: null };
        }
        if (st.op === 'update') {
          const hit = rows.filter(match);
          hit.forEach((r) => Object.assign(r, st.payload));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (st.op === 'delete') {
          const keep = rows.filter((r) => !match(r));
          const n = rows.length - keep.length;
          tables[name] = keep;
          return { data: n, error: null };
        }
        return { data: null, error: null };
      };
      const b = {
        select(c = '') { st.cols += c; return b; },
        insert(p) { st.op = 'insert'; st.payload = p; return b; },
        update(p) { st.op = 'update'; st.payload = p; return b; },
        delete() { st.op = 'delete'; return b; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
        in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return b; },
        is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        order() { return b; },
        limit() { return b; },
        single: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: r.error }; },
        maybeSingle: async () => { const r = exec(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
        then: (res, rej) => Promise.resolve(exec()).then(res, rej),
      };
      return b;
    },
  };
}

const ledger = () => [
  { id: 'L1', setter_user_id: ROMY, status: 'vrijgegeven', amount: 18, basis: 600, pct: 3, betaal_datum: '2026-11-02', customer_id: null, monthly_report_id: null, created_at: '2026-11-03T06:00:00Z' },
  { id: 'L2', setter_user_id: ROMY, status: 'vrijgegeven', amount: 18, basis: 600, pct: 3, betaal_datum: '2026-12-02', customer_id: null, monthly_report_id: null, created_at: '2026-12-03T06:00:00Z' },
];

test('upsert: concept aanmaken, regels + koppeling; herberekenen dubbelt niets', async () => {
  const db = memDb({ setter_config: [CFG], setter_monthly_reports: [], setter_monthly_report_lines: [], setter_ledger_entries: ledger(), customers: [] });
  const r1 = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-11' });
  assert.equal(r1.skipped, false);
  assert.equal(r1.total, 768);
  assert.equal(db.tables.setter_monthly_reports.length, 1);
  assert.equal(db.tables.setter_monthly_report_lines.length, 2);
  assert.equal(db.tables.setter_ledger_entries.find((e) => e.id === 'L1').monthly_report_id, r1.report_id);
  assert.equal(db.tables.setter_ledger_entries.find((e) => e.id === 'L2').monthly_report_id, null, 'december hoort niet in november');

  const r2 = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-11-01' });
  assert.equal(r2.report_id, r1.report_id);
  assert.equal(r2.total, 768);
  assert.equal(db.tables.setter_monthly_reports.length, 1);
  assert.equal(db.tables.setter_monthly_report_lines.length, 2, 'regels herbouwd, niet verdubbeld');
});

test('upsert: goedgekeurd/uitbetaald rapport wordt nooit overschreven', async () => {
  const db = memDb({
    setter_config: [CFG],
    setter_monthly_reports: [{ id: 'R', setter_user_id: ROMY, period_month: '2026-11-01', status: 'goedgekeurd', total: 1 }],
    setter_monthly_report_lines: [], setter_ledger_entries: ledger(), customers: [],
  });
  const r = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-11' });
  assert.equal(r.skipped, true);
  assert.equal(r.status, 'goedgekeurd');
  assert.equal(db.tables.setter_monthly_reports[0].total, 1);
  assert.ok(!db.calls.some((c) => c.op !== 'select'), 'geen writes');
});

test('upsert: december pakt de nog niet gekoppelde regel, niet die van november', async () => {
  const db = memDb({ setter_config: [CFG], setter_monthly_reports: [], setter_monthly_report_lines: [], setter_ledger_entries: ledger(), customers: [] });
  const nov = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-11' });
  const dec = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-12' });
  assert.equal(dec.commission_total, 18);
  assert.equal(db.tables.setter_ledger_entries.find((e) => e.id === 'L1').monthly_report_id, nov.report_id);
  assert.equal(db.tables.setter_ledger_entries.find((e) => e.id === 'L2').monthly_report_id, dec.report_id);
});

test('upsert: zonder migratie → MIGRATIE_ONTBREEKT', async () => {
  const db = memDb({ setter_config: [CFG] }, { missingCols: ['monthly_fee'] });
  await assert.rejects(
    computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-11' }),
    (e) => e.code === 'MIGRATIE_ONTBREEKT',
  );
});

// ── Cron ────────────────────────────────────────────────────────────────
async function draaiCron(query, db) {
  const m = mock.module(new URL('../api/supabase.js', import.meta.url).href, {
    namedExports: { supabaseAdmin: db, checkCronAuth: () => ({ ok: true }) },
  });
  try {
    const { default: handler } = await import(`../api/cron/generate-setter-reports.js?t=${Math.random()}`);
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query, headers: {} }, res);
    return res;
  } finally { m.restore(); }
}

test('cron: niet de 1e → no-op zonder DB-calls', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T06:30:00Z') });
  const db = memDb({ setter_config: [CFG] });
  const res = await draaiCron({}, db);
  assert.equal(res.body.reason, 'not_first_of_month');
  assert.equal(db.calls.length, 0);
});

test('cron: op de 1e → rapport vorige maand; force + month; zonder migratie 200 skipped', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-01T06:30:00Z') });
  const db = memDb({ setter_config: [CFG], setter_monthly_reports: [], setter_monthly_report_lines: [], setter_ledger_entries: ledger(), customers: [] });
  const res = await draaiCron({}, db);
  assert.equal(res.code, 200);
  assert.equal(res.body.month, '2026-11-01');
  assert.equal(res.body.generated.length, 1);
  assert.equal(res.body.generated[0].total, 768);

  const forced = await draaiCron({ force: 'true', month: '2026-10' }, db);
  assert.equal(forced.body.month, '2026-10-01');
  assert.equal(forced.body.generated[0].total, 750, 'oktober: alleen de vaste vergoeding');

  const zonder = await draaiCron({ force: 'true' }, memDb({ setter_config: [CFG] }, { missingCols: ['monthly_fee'] }));
  assert.equal(zonder.code, 200);
  assert.equal(zonder.body.reason, 'migratie_ontbreekt');
});
