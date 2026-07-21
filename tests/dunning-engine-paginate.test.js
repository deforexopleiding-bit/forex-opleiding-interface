// tests/dunning-engine-paginate.test.js
//
// Regressietest voor fetchAllRows() in api/_lib/dunning-engine.js.
// Bewijst dat >1000 rijen correct doorgeplakt worden — precies wat de
// PostgREST default max-rows liet doorlekken en klanten met meerdere
// open facturen als enkel-factuur liet tellen (multi-factuur-doorlek).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllRows } from '../api/_lib/dunning-engine.js';

// Fake supabase-queryBuilder: eindigt op .range(from, to) → {data, error}.
// buildQuery-callback moet een VERS object teruggeven (dat is de contract).
function makeFakeBuilder(allRows) {
  return () => ({
    async range(from, to) {
      const slice = allRows.slice(from, to + 1);
      return { data: slice, error: null };
    },
  });
}

// ─── Basisgedrag ──────────────────────────────────────────────────────────

test('fetchAllRows: lege set → []', async () => {
  const rows = await fetchAllRows(makeFakeBuilder([]));
  assert.deepEqual(rows, []);
});

test('fetchAllRows: 5 rijen → 5 rijen (één chunk, stopt bij <1000)', async () => {
  const src = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  const rows = await fetchAllRows(makeFakeBuilder(src));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows, src);
});

test('fetchAllRows: 999 rijen → 999 (één chunk)', async () => {
  const src = Array.from({ length: 999 }, (_, i) => ({ id: i }));
  const rows = await fetchAllRows(makeFakeBuilder(src));
  assert.equal(rows.length, 999);
});

test('fetchAllRows: exact 1000 rijen → 1000 (twee chunks, 2e is leeg)', async () => {
  const src = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const rows = await fetchAllRows(makeFakeBuilder(src));
  assert.equal(rows.length, 1000);
});

test('fetchAllRows: 1500 rijen → 1500 (twee chunks: 1000 + 500)', async () => {
  const src = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
  const rows = await fetchAllRows(makeFakeBuilder(src));
  assert.equal(rows.length, 1500);
  // Volgorde behouden across chunks
  assert.equal(rows[0].id,    0);
  assert.equal(rows[999].id,  999);
  assert.equal(rows[1000].id, 1000);
  assert.equal(rows[1499].id, 1499);
});

test('fetchAllRows: 3500 rijen → 3500 (vier chunks: 1000+1000+1000+500)', async () => {
  const src = Array.from({ length: 3500 }, (_, i) => ({ id: i }));
  const rows = await fetchAllRows(makeFakeBuilder(src));
  assert.equal(rows.length, 3500);
});

// ─── Bug-bewijs: multi-factuur-doorlek zou zonder pagination gebeuren ──

test('multi-factuur scenario: klant met 4 facturen wordt correct geteld ook bij 1200 totaal', async () => {
  // Simuleer productie-situatie: veel klanten, één klant heeft 4 open
  // facturen die door de 1000-cap gedeeltelijk zouden wegvallen.
  const rows = [];
  // 800 rijen van 800 andere klanten (elk 1 factuur).
  for (let i = 0; i < 800; i++) rows.push({ customer_id: 'other-' + i });
  // 2 facturen van de multi-klant net vóór de 1000-boundary.
  rows.push({ customer_id: 'multi-klant' });
  rows.push({ customer_id: 'multi-klant' });
  // Nog 200 andere klanten om ruim over 1000 heen te gaan.
  for (let i = 0; i < 200; i++) rows.push({ customer_id: 'other-b-' + i });
  // De laatste 2 facturen van de multi-klant komen NA rij 1000.
  rows.push({ customer_id: 'multi-klant' });
  rows.push({ customer_id: 'multi-klant' });
  assert.equal(rows.length, 1004);

  const fetched = await fetchAllRows(makeFakeBuilder(rows));
  // Zonder pagination zou fetched.length = 1000 en zou multi-klant er 2 zijn.
  // Met pagination = 1004 en multi-klant = 4.
  assert.equal(fetched.length, 1004);
  const cnt = fetched.filter((r) => r.customer_id === 'multi-klant').length;
  assert.equal(cnt, 4, 'multi-klant moet ALLE 4 facturen behouden na pagination');
});

// ─── Error-propagatie ─────────────────────────────────────────────────────

test('fetchAllRows: DB-error uit range() propageert (fail-fast)', async () => {
  const build = () => ({
    async range(_from, _to) {
      return { data: null, error: { code: '42P01', message: 'relation missing' } };
    },
  });
  await assert.rejects(fetchAllRows(build), (err) => {
    // supabase-js retourneert de error als plain object (niet Error-instance);
    // helper gooit 'em rechtstreeks door — dus ook plain object.
    return !!err && err.code === '42P01';
  });
});

// ─── buildQuery-callback wordt per chunk fresh aangeroepen ───────────────

test('fetchAllRows: buildQuery wordt per chunk opnieuw aangeroepen', async () => {
  let calls = 0;
  const src = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
  const build = () => {
    calls++;
    return {
      async range(from, to) {
        return { data: src.slice(from, to + 1), error: null };
      },
    };
  };
  const rows = await fetchAllRows(build);
  assert.equal(rows.length, 2500);
  // 2500 rijen = 3 chunks (1000 + 1000 + 500). Callback per chunk = 3 calls.
  assert.equal(calls, 3);
});
