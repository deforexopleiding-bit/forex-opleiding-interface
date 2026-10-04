// tests/setter-rapport-btw.test.js
//
// Setter-maandrapport met btw-uitsplitsing: vaste vergoeding is EXCL. btw
// (btw komt erbij), commissie blijft INCL. btw (zoals het grootboek boekt)
// en wordt teruggerekend. Afronding per regel, totalen = som van de regels.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SETTER_BTW_PCT, btwUitExcl, btwUitIncl, bouwRapport, normaliseerRapport, legacyBtw,
  computeAndUpsertSetterReport,
} from '../api/_lib/setter-report-core.js';

const ROMY = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';
const CFG = { user_id: ROMY, pct: 3, is_active: true, effective_from: '2026-08-31', monthly_fee: 650 };
const regel = (id, amount, betaal_datum = '2026-09-15') => ({ id, status: 'vrijgegeven', amount, basis: Math.round(amount / 0.03 * 100) / 100, pct: 3, betaal_datum, monthly_report_id: null });

test('btw-tarief is één constante: 21', () => {
  assert.equal(SETTER_BTW_PCT, 21);
});

test('vaste vergoeding: excl → btw → incl (650 → 136,50 → 786,50)', () => {
  assert.deepEqual(btwUitExcl(650), { excl: 650, btw: 136.5, incl: 786.5 });
  assert.deepEqual(btwUitExcl(333.33), { excl: 333.33, btw: 70, incl: 403.33 }, 'btw afgerond op centen');
});

test('commissie: incl → excl + btw (30 → 24,79 + 5,21), incl blijft exact', () => {
  assert.deepEqual(btwUitIncl(30), { excl: 24.79, btw: 5.21, incl: 30 });
  assert.deepEqual(btwUitIncl(18), { excl: 14.88, btw: 3.12, incl: 18 });
  for (const v of [0.01, 3, 7.77, 216.04, 1000]) {
    const b = btwUitIncl(v);
    assert.equal(Math.round((b.excl + b.btw) * 100) / 100, v, `excl + btw = incl voor ${v}`);
  }
});

test('totalen = som van de afgeronde regels (niet het totaal opnieuw afgerond)', () => {
  const r = bouwRapport({ cfg: { ...CFG, monthly_fee: 0 }, monthStart: '2026-09-01', entries: [regel('a', 10), regel('b', 10), regel('c', 10)] });
  assert.ok(r.lines.every((l) => l.amount_excl === 8.26 && l.amount_btw === 1.74 && l.amount_incl === 10));
  assert.equal(r.commission_excl, 24.78, '3 × 8,26 — niet round2(30/1,21) = 24,79');
  assert.equal(r.commission_btw, 5.22);
  assert.equal(r.commission_incl, 30, 'incl = exact wat geboekt is');
});

test('gemengd rapport: 650 excl. vast + 30 en 3 commissie', () => {
  const r = bouwRapport({ cfg: CFG, monthStart: '2026-09-01', entries: [regel('a', 30), regel('b', 3, '2026-09-20')] });
  assert.equal(r.btw_pct, SETTER_BTW_PCT);
  assert.deepEqual([r.fee_excl, r.fee_btw, r.fee_incl], [650, 136.5, 786.5]);
  assert.deepEqual([r.commission_excl, r.commission_btw, r.commission_incl], [27.27, 5.73, 33]);
  assert.deepEqual([r.total_excl, r.total_btw, r.total_incl], [677.27, 142.23, 819.5]);
  // Backward-compat-aliassen = incl.
  assert.deepEqual([r.fee_total, r.commission_total, r.total], [786.5, 33, 819.5]);
  // Elke regel: drie bedragen + tarief, amount = amount_incl.
  for (const l of r.lines) {
    assert.equal(l.btw_pct, SETTER_BTW_PCT);
    assert.equal(l.amount, l.amount_incl);
    assert.equal(Math.round((l.amount_excl + l.amount_btw) * 100) / 100, l.amount_incl);
  }
  const som = (k) => Math.round(r.lines.reduce((s, l) => s + l[k], 0) * 100) / 100;
  assert.equal(r.total_excl, som('amount_excl'));
  assert.equal(r.total_btw, som('amount_btw'));
  assert.equal(r.total_incl, som('amount_incl'));
});

test('het tarief is een parameter met de constante als default (te wijzigen op één plek)', () => {
  const r9 = bouwRapport({ cfg: CFG, monthStart: '2026-09-01', entries: [regel('a', 30)], btwPct: 9 });
  assert.equal(r9.btw_pct, 9);
  assert.deepEqual([r9.fee_excl, r9.fee_btw, r9.fee_incl], [650, 58.5, 708.5]);
  assert.deepEqual([r9.commission_excl, r9.commission_btw], [27.52, 2.48]);
  // De UI hardcodeert het tarief niet: het label komt uit btw_pct van de API.
  const view = fs.readFileSync(new URL('../modules/klanten-v2/views/setter-payout-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /1\.21|Btw 21|21 ?%/);
  assert.match(view, /btwKop\(r\.btw_pct\)/);
  assert.match(view, /btwKop\(d\.btw_pct\)/);
});

test('legacy-rapport (btw_pct NULL, oude 750-incl.): alleen voor weergave gesplitst', () => {
  const { report, lines } = normaliseerRapport(
    { id: 'R', status: 'goedgekeurd', fee_total: '750', commission_total: '0', total: '750', btw_pct: null },
    [{ id: 'l', kind: 'vaste_vergoeding', label: 'Vaste maandvergoeding september 2026', amount: '750' }],
  );
  assert.equal(report.legacy_btw, true);
  assert.deepEqual([report.total_excl, report.total_btw, report.total_incl], [619.83, 130.17, 750]);
  assert.equal(report.total, 750, 'opgeslagen waarde blijft ongemoeid');
  assert.equal(lines[0].amount_incl, 750);
  // Nieuw rapport: strings → numbers, geen legacy.
  const nieuw = normaliseerRapport({ id: 'N', btw_pct: '21.00', total_incl: '786.50' }, [{ amount_incl: '786.50', btw_pct: '21.00' }]);
  assert.equal(nieuw.report.legacy_btw, false);
  assert.equal(nieuw.report.total_incl, 786.5);
  assert.equal(nieuw.lines[0].btw_pct, 21);
  assert.equal(typeof legacyBtw, 'function');
});

// ── In-memory database (zelfde vorm als in setter-maandrapport.test.js) ──
function memDb(tables, { missingCols = [] } = {}) {
  let seq = 0;
  const calls = [];
  return {
    calls, tables,
    from(name) {
      const st = { op: 'select', filters: [], payload: null, cols: '' };
      const match = (r) => st.filters.every((f) => f(r));
      const exec = () => {
        calls.push({ table: name, op: st.op });
        const miss = missingCols.find((c) => st.cols.includes(c) || (st.payload && JSON.stringify(st.payload).includes(`"${c}"`)));
        if (miss) return { data: null, error: { code: '42703', message: `column ${name}.${miss} does not exist` } };
        const rows = tables[name] || (tables[name] = []);
        if (st.op === 'select') return { data: rows.filter(match).map((r) => ({ ...r })), error: null };
        if (st.op === 'insert') { const ins = [].concat(st.payload).map((r) => ({ id: `id-${++seq}`, ...r })); rows.push(...ins); return { data: ins, error: null }; }
        if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit.map((r) => ({ ...r })), error: null }; }
        if (st.op === 'delete') { tables[name] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
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

// Het oude september-concept (750 als incl. opgeslagen, zonder btw-kolommen).
const oudConcept = (status) => ({
  setter_config: [CFG],
  setter_monthly_reports: [{ id: 'SEP', setter_user_id: ROMY, period_month: '2026-09-01', status, fee_total: 750, commission_total: 0, total: 750 }],
  setter_monthly_report_lines: [{ id: 'oud', report_id: 'SEP', kind: 'vaste_vergoeding', label: 'Vaste maandvergoeding september 2026', amount: 750, position: 0 }],
  setter_ledger_entries: [],
  customers: [],
});

test('herberekenen van een concept vervangt de oude 750-incl.-waarden door 650 excl. / 786,50 incl.', async () => {
  const db = memDb(oudConcept('concept'));
  const r = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-09' });
  assert.equal(r.skipped, false);
  assert.equal(r.report_id, 'SEP');
  const rep = db.tables.setter_monthly_reports[0];
  assert.deepEqual(
    [rep.btw_pct, rep.fee_excl, rep.fee_btw, rep.fee_incl, rep.total_excl, rep.total_btw, rep.total_incl, rep.fee_total, rep.total],
    [21, 650, 136.5, 786.5, 650, 136.5, 786.5, 786.5, 786.5],
  );
  assert.equal(db.tables.setter_monthly_report_lines.length, 1);
  const l = db.tables.setter_monthly_report_lines[0];
  assert.notEqual(l.id, 'oud', 'oude regel vervangen');
  assert.deepEqual([l.btw_pct, l.amount_excl, l.amount_btw, l.amount_incl, l.amount], [21, 650, 136.5, 786.5, 786.5]);
});

test('goedgekeurd rapport blijft bevroren: geen writes, oude waarden blijven', async () => {
  const db = memDb(oudConcept('goedgekeurd'));
  const r = await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-09' });
  assert.equal(r.skipped, true);
  assert.equal(r.status, 'goedgekeurd');
  assert.equal(db.tables.setter_monthly_reports[0].total, 750);
  assert.equal(db.tables.setter_monthly_reports[0].fee_excl, undefined);
  assert.equal(db.tables.setter_monthly_report_lines[0].id, 'oud');
  assert.ok(!db.calls.some((c) => c.op !== 'select'), 'alleen selects');
});

test('zonder btw-migratie: genereren schrijft niets (MIGRATIE_ONTBREEKT), oude regels blijven staan', async () => {
  const db = memDb(oudConcept('concept'), { missingCols: ['fee_excl'] });
  await assert.rejects(computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-09' }), (e) => e.code === 'MIGRATIE_ONTBREEKT');
  assert.equal(db.tables.setter_monthly_report_lines[0].id, 'oud');
  assert.equal(db.tables.setter_monthly_reports[0].total, 750);
});

test('GET /api/setter-reports: btw_pct uit de constante; vóór de migratie legacy-fallback', async () => {
  const run = async (db) => {
    const m1 = mock.module(new URL('../api/supabase.js', import.meta.url).href, {
      namedExports: { supabaseAdmin: db, createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: ROMY } } }) } }) },
    });
    const m2 = mock.module(new URL('../api/_lib/requirePermission.js', import.meta.url).href, { namedExports: { requirePermission: async () => true } });
    try {
      const { default: handler } = await import(`../api/setter-reports.js?t=${Math.random()}`);
      const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ method: 'GET', query: {}, headers: {} }, res);
      return res;
    } finally { m1.restore(); m2.restore(); }
  };
  const oud = await run(memDb(oudConcept('goedgekeurd'), { missingCols: ['btw_pct'] }));
  assert.equal(oud.code, 200);
  assert.equal(oud.body.btw_pct, SETTER_BTW_PCT);
  assert.equal(oud.body.btw_migratie_nodig, true);
  assert.equal(oud.body.reports[0].legacy_btw, true);
  assert.equal(oud.body.reports[0].total_incl, 750);

  const db = memDb(oudConcept('concept'));
  await computeAndUpsertSetterReport({ db, setterId: ROMY, monthStart: '2026-09' });
  const nieuw = await run(db);
  assert.equal(nieuw.body.btw_migratie_nodig, false);
  const r = nieuw.body.reports[0];
  assert.equal(r.legacy_btw, false);
  assert.deepEqual([r.total_excl, r.total_btw, r.total_incl], [650, 136.5, 786.5]);
  assert.equal(r.lines[0].amount_excl, 650);
});
