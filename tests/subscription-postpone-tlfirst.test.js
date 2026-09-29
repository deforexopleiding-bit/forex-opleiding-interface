// tests/subscription-postpone-tlfirst.test.js
//
// VERLENGEN MET TEAMLEADER EERST.
//
// postponeSubscription deed altijd: eerst de DB, dan Teamleader "best effort".
// Weigerde Teamleader, dan stond het abonnement in onze DB verlengd en in TL
// niet — en meldde de crediteerronde toch "verlengd". Met tlFirst (opt-in,
// alleen de crediteerronde) wordt de DB pas bijgewerkt na een 2xx van TL.
// Zonder tlFirst blijft het oude gedrag (andere callers) ongewijzigd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const dbUpdates = [];
const tlCalls = [];
let tlStatus = 204;

mock.module(url('api/supabase.js'), {
  namedExports: {
    supabaseAdmin: {
      from: (tabel) => {
        const k = {
          update: (patch) => { dbUpdates.push({ tabel, patch }); return k; },
          insert: async () => ({ error: null }),
          eq: () => k, select: () => k,
          single: async () => ({ data: { id: 's1' }, error: null }),
        };
        return k;
      },
    },
  },
});
mock.module(url('api/_lib/teamleader-token.js'), {
  namedExports: {
    getActiveToken: async () => ({ access_token: 'x' }),
    tlFetch: async (path, opts) => { tlCalls.push({ path, body: JSON.parse(opts.body) }); return { ok: tlStatus < 300, status: tlStatus, text: async () => 'nee' }; },
  },
});
mock.module(url('api/_lib/audit-customer.js'), { namedExports: { getClientIp: () => null } });
const { postponeSubscription, restoreSubscription } = await import(url('api/_lib/subscription-postpone.js'));

const SUB = { id: 's1', teamleader_subscription_id: 'tl-s1', start_date: '2026-01-01', end_date: '2027-01-01', term_count: 12, postponed_months: 0 };
const reset = (s) => { dbUpdates.length = 0; tlCalls.length = 0; tlStatus = s; };
const subUpdates = () => dbUpdates.filter((u) => u.tabel === 'subscriptions');

test('tlFirst + Teamleader weigert → TL_NOT_CONFIRMED en GEEN DB-update', async () => {
  reset(400);
  await assert.rejects(postponeSubscription(SUB, 3, { tlFirst: true, todayStr: '2026-09-29' }), (e) => e.code === 'TL_NOT_CONFIRMED');
  assert.equal(tlCalls.length, 1);
  assert.equal(subUpdates().length, 0);
});

test('tlFirst + Teamleader akkoord → eerst TL, dan DB, pushed=true', async () => {
  reset(204);
  const r = await postponeSubscription(SUB, 3, { tlFirst: true, todayStr: '2026-09-29' });
  assert.equal(r.tl.pushed, true);
  assert.deepEqual(tlCalls[0].body, { id: 'tl-s1', ends_on: '2027-04-01' }, 'lopend abo: alleen ends_on');
  assert.equal(subUpdates()[0].patch.end_date, '2027-04-01');
  assert.equal(subUpdates()[0].patch.term_count, 15);
});

test('tlFirst zonder Teamleader-id → NO_TL_ID, niets aangeraakt', async () => {
  reset(204);
  await assert.rejects(postponeSubscription({ ...SUB, teamleader_subscription_id: null }, 1, { tlFirst: true, todayStr: '2026-09-29' }), (e) => e.code === 'NO_TL_ID');
  assert.equal(tlCalls.length + subUpdates().length, 0);
});

test('postpone geeft een exacte momentopname terug (voor terugzetten)', async () => {
  reset(204);
  const r = await postponeSubscription({ ...SUB, original_end_date: null }, 1, { tlFirst: true, todayStr: '2026-09-29' });
  assert.deepEqual(r.snapshot, { start_date: '2026-01-01', end_date: '2027-01-01', term_count: 12, postponed_months: 0, original_start_date: null, original_end_date: null });
});

test('restore: Teamleader eerst, dan de EXACTE oude waarden in de DB (geen terugrekenen)', async () => {
  reset(204);
  // Maandgrens: 31 jan + 1 mnd = 3 mrt via setMonth. Terugrekenen zou 3 feb geven.
  const snap = { start_date: '2026-01-01', end_date: '2027-01-31', term_count: 12, postponed_months: 0, original_start_date: null, original_end_date: null };
  await restoreSubscription({ id: 's1', teamleader_subscription_id: 'tl-s1', start_date: '2026-01-01', end_date: '2027-03-03' }, snap);
  assert.deepEqual(tlCalls[0].body, { id: 'tl-s1', ends_on: '2027-01-31' });
  assert.deepEqual(subUpdates()[0].patch, { start_date: '2026-01-01', end_date: '2027-01-31', term_count: 12, postponed_months: 0, original_start_date: null, original_end_date: null });
});

test('restore: Teamleader weigert → TL_NOT_CONFIRMED en GEEN DB-update', async () => {
  reset(400);
  await assert.rejects(
    restoreSubscription({ id: 's1', teamleader_subscription_id: 'tl-s1', start_date: '2026-01-01' }, { end_date: '2027-01-01', start_date: '2026-01-01' }),
    (e) => e.code === 'TL_NOT_CONFIRMED');
  assert.equal(subUpdates().length, 0);
});

test('restore van een verschoven (nog niet gestart) abo zet ook starts_on terug', async () => {
  reset(204);
  await restoreSubscription({ id: 's1', teamleader_subscription_id: 'tl-s1', start_date: '2026-12-01' }, { start_date: '2026-11-01', end_date: '2027-11-01', term_count: 12, postponed_months: 0 });
  assert.deepEqual(tlCalls[0].body, { id: 'tl-s1', ends_on: '2027-11-01', starts_on: '2026-11-01' });
});

test('zonder tlFirst: oud gedrag — DB eerst, TL-weigering alleen gerapporteerd', async () => {
  reset(400);
  const r = await postponeSubscription(SUB, 2, { todayStr: '2026-09-29' });
  assert.equal(subUpdates().length, 1, 'DB wordt wél bijgewerkt (ongewijzigd gedrag)');
  assert.equal(r.tl.pushed, false);
});
