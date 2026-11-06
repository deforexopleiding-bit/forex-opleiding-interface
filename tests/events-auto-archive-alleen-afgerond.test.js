// tests/events-auto-archive-alleen-afgerond.test.js
//
// cron-events-auto-archive (2026-11-06): alleen AFGERONDE events
// (completed_at IS NOT NULL) gaan na 3 dagen naar 'archived'. Een event dat
// nog niet afgerond is blijft op 'published' — anders verdwijnt de knop
// "Event afronden" en wordt de mentorbonus nooit berekend.
// Bewaakt: de kandidaten-query én de race-guard van de update filteren op
// completed_at NOT NULL, naast status='published'.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const calls = []; // per query-builder: { table, op, filters: [[methode, ...args]] }

function builder(table) {
  const q = { table, op: null, filters: [] };
  calls.push(q);
  const b = {
    select: (cols) => { q.op = 'select'; q.cols = cols; return b; },
    update: (patch) => { q.op = 'update'; q.patch = patch; return b; },
    eq: (...a) => { q.filters.push(['eq', ...a]); return b; },
    not: (...a) => { q.filters.push(['not', ...a]); return b; },
    or: (...a) => { q.filters.push(['or', ...a]); return b; },
    order: () => b,
    then: (ok, nok) => Promise.resolve(
      q.op === 'select'
        ? { data: [{ id: 'ev-1', title: 'Afgerond', status: 'published' }], error: null }
        : { error: null },
    ).then(ok, nok),
  };
  return b;
}

mock.module('../api/supabase.js', {
  namedExports: {
    checkCronAuth: () => ({ ok: true }),
    supabaseAdmin: { from: (t) => builder(t) },
  },
});

const { default: handler } = await import('../api/cron-events-auto-archive.js');

function fakeRes() {
  return {
    statusCode: 200, body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const heeftAfgerondFilter = (q) =>
  q.filters.some((f) => f[0] === 'not' && f[1] === 'completed_at' && f[2] === 'is' && f[3] === null);

test('kandidaten-query: alleen published én afgerond (completed_at NOT NULL)', async () => {
  calls.length = 0;
  const res = fakeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const sel = calls.find((q) => q.op === 'select');
  assert.ok(sel, 'er is een kandidaten-query');
  assert.equal(sel.table, 'events');
  assert.ok(sel.filters.some((f) => f[0] === 'eq' && f[1] === 'status' && f[2] === 'published'));
  assert.ok(heeftAfgerondFilter(sel), 'kandidaten-query filtert op completed_at NOT NULL');
});

test('update race-guard: published én nog altijd afgerond', async () => {
  calls.length = 0;
  const res = fakeRes();
  await handler({ method: 'GET', headers: {} }, res);
  const upd = calls.find((q) => q.op === 'update');
  assert.ok(upd, 'er is een update');
  assert.equal(upd.patch.status, 'archived');
  assert.ok(upd.filters.some((f) => f[0] === 'eq' && f[1] === 'id' && f[2] === 'ev-1'));
  assert.ok(upd.filters.some((f) => f[0] === 'eq' && f[1] === 'status' && f[2] === 'published'));
  assert.ok(heeftAfgerondFilter(upd), 'race-guard filtert op completed_at NOT NULL');
  assert.equal(res.body.archived, 1);
});
