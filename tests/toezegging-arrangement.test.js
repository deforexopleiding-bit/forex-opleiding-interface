// tests/toezegging-arrangement.test.js
//
// De rails waar de knop "Toezegging" in de afsprakenwizard op leunt.
//
// De wizard bouwt alleen een payload; al het gedrag zit in bestaande
// backend-code die tot nu toe alleen via de API bereikbaar was en daardoor
// nooit in een test stond. Wat hier vastligt:
//
//   1. arrangements-propose zet een TOEZEGGING direct op ACTIEF, maakt GEEN
//      pending_actions aan (geen TL-mutatie, geen approval) en pauzeert de
//      lopende aanmaan-runs via het bestaande paused_by_arrangement_id.
//   2. De validatie weigert een afspraak zonder concrete datum en zonder
//      facturen — zonder die twee kan de breach-check niets beoordelen.
//   3. cron-arrangements-breach-check houdt zich stil tot de afgesproken dag,
//      sluit af bij betaling, en verklaart de afspraak verbroken zodra de
//      datum verstreken is met een openstaande factuur.
//
// Geen nieuw pauzemechanisme, geen nieuwe cron: deze tests bewijzen dat het
// bestaande spoor doet wat de knop belooft.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const CUST = '11111111-1111-4111-8111-111111111111';
const INV1 = '22222222-2222-4222-8222-222222222222';
const INV2 = '33333333-3333-4333-8333-333333333333';

const ymd = (offsetDagen) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDagen);
  return d.toISOString().slice(0, 10);
};

function nepRes() {
  const uit = { code: null, body: null };
  return {
    setHeader() {},
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

// ── Supabase-dubbelganger ────────────────────────────────────────────
// Chainbaar én awaitbaar (postgrest-ketens zijn thenables). `rows` bepaalt
// wat een lees-query per tabel oplevert; `log` verzamelt writes zodat we
// kunnen zien wat er NIET is aangemaakt.
function nepAdmin({ rows = {}, log } = {}) {
  const maak = (tabel) => {
    const st = { op: 'select', payload: null, inIds: null };
    const k = {
      select: () => k, eq: () => k, neq: () => k, is: () => k,
      // `.in('id', [...])` filtert wél echt: arrangements-propose vergelijkt
      // het aantal gevonden facturen met het aantal gevraagde.
      in: (col, vals) => { if (col === 'id') st.inIds = vals; return k; },
      gte: () => k, gt: () => k, lte: () => k, lt: () => k, not: () => k,
      order: () => k, limit: () => k, filter: () => k,
      insert: (p) => { st.op = 'insert'; st.payload = p; log?.push({ tabel, op: 'insert', payload: p }); return k; },
      update: (p) => { st.op = 'update'; st.payload = p; log?.push({ tabel, op: 'update', payload: p }); return k; },
      upsert: (p) => { st.op = 'upsert'; st.payload = p; log?.push({ tabel, op: 'upsert', payload: p }); return k; },
      delete: () => { st.op = 'delete'; log?.push({ tabel, op: 'delete' }); return k; },
      single:      async () => ({ data: resultaat(tabel, st, true),  error: null }),
      maybeSingle: async () => ({ data: resultaat(tabel, st, true),  error: null }),
      then: (resolve) => Promise.resolve({ data: resultaat(tabel, st, false), error: null }).then(resolve),
    };
    return k;
  };
  const resultaat = (tabel, st, enkel) => {
    if (st.op === 'insert') {
      const p = Array.isArray(st.payload) ? st.payload : [st.payload];
      const met = p.map((r, i) => ({ id: `${tabel}-${i}`, ...r }));
      return enkel ? met[0] : met;
    }
    let r = Object.prototype.hasOwnProperty.call(rows, tabel) ? rows[tabel] : [];
    if (Array.isArray(r) && st.inIds) r = r.filter((x) => st.inIds.includes(x.id));
    if (enkel) return Array.isArray(r) ? (r[0] ?? null) : r;
    return Array.isArray(r) ? r : (r ? [r] : []);
  };
  return { from: maak };
}

const FACTUREN = [
  { id: INV1, customer_id: CUST, status: 'open', amount_total: 320, amount_paid: 0, credited_amount: 0, due_date: ymd(-30), invoice_number: '2026/1780' },
  { id: INV2, customer_id: CUST, status: 'open', amount_total: 180, amount_paid: 0, credited_amount: 0, due_date: ymd(-20), invoice_number: '2026/1781' },
];

async function laadPropose({ log, hookLog }) {
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: nepAdmin({ log, rows: { customers: [{ id: CUST }], invoices: FACTUREN } }),
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
      supabase: {},
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => true,
      requirePermissionFailOpen: async () => true,
      checkPermissionOrDeny: async () => true,
    },
  });
  mock.module(url('api/_lib/audit-customer.js'), {
    namedExports: { getClientIp: () => '127.0.0.1' },
  });
  mock.module(url('api/_lib/dunning-arrangement-hooks.js'), {
    namedExports: {
      pauseRunsForArrangement: async (arrId, custId) => { hookLog.push({ arrId, custId }); },
      unpauseRunsForArrangement: async () => {},
      completeRunsFromArrangement: async () => {},
    },
  });
  const mod = await import(url('api/arrangements-propose.js') + '?t=' + Math.random());
  return mod.default;
}

const req = (body) => ({ method: 'POST', headers: { authorization: 'Bearer x' }, body, query: {} });

// ═══ 1. Aanmaken ════════════════════════════════════════════════════

test('TOEZEGGING gaat direct op ACTIEF — geen approval-stap', async (t) => {
  t.after(() => mock.reset());
  const log = []; const hookLog = [];
  const handler = await laadPropose({ log, hookLog });
  const res = nepRes();
  await handler(req({
    customer_id: CUST,
    type: 'TOEZEGGING',
    invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(10), amount_cents: 32000 }] },
    rationale: 'Klant belt: betaalt na salaris.',
  }), res);

  assert.equal(res._uit.code, 201, JSON.stringify(res._uit.body));
  const ins = log.find((l) => l.tabel === 'payment_arrangements' && l.op === 'insert');
  assert.ok(ins, 'arrangement moet aangemaakt zijn');
  assert.equal(ins.payload.status, 'ACTIEF');
  assert.equal(ins.payload.type, 'TOEZEGGING');
  assert.deepEqual(ins.payload.invoice_ids, [INV1]);
});

test('TOEZEGGING maakt GEEN pending_actions aan — geen TL-mutatie', async (t) => {
  t.after(() => mock.reset());
  const log = []; const hookLog = [];
  const handler = await laadPropose({ log, hookLog });
  const res = nepRes();
  await handler(req({
    customer_id: CUST, type: 'TOEZEGGING', invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(7) }] }, rationale: 'x',
  }), res);

  assert.equal(res._uit.code, 201);
  const pa = log.filter((l) => l.tabel === 'pending_actions' && l.op === 'insert');
  assert.equal(pa.length, 0, 'een toezegging is een afspraak, geen uitvoerstap');
  assert.deepEqual(res._uit.body.pending_actions, []);
});

test('TOEZEGGING pauzeert de lopende aanmaan-runs via het bestaande mechanisme', async (t) => {
  t.after(() => mock.reset());
  const log = []; const hookLog = [];
  const handler = await laadPropose({ log, hookLog });
  const res = nepRes();
  await handler(req({
    customer_id: CUST, type: 'TOEZEGGING', invoice_ids: [INV1, INV2],
    details: { parts: [{ due_date: ymd(14) }] }, rationale: 'x',
  }), res);

  assert.equal(res._uit.code, 201);
  assert.equal(hookLog.length, 1, 'pauseRunsForArrangement moet precies één keer geroepen zijn');
  assert.equal(hookLog[0].custId, CUST);
});

// ═══ 2. Validatie ═══════════════════════════════════════════════════

test('een toezegging zonder concrete datum wordt geweigerd', async (t) => {
  t.after(() => mock.reset());
  const handler = await laadPropose({ log: [], hookLog: [] });
  const res = nepRes();
  await handler(req({
    customer_id: CUST, type: 'TOEZEGGING', invoice_ids: [INV1],
    details: { parts: [{ due_date: 'volgende week' }] }, rationale: 'x',
  }), res);
  assert.equal(res._uit.code, 400);
  assert.match(res._uit.body.error, /due_date/i);
});

test('een toezegging zonder facturen wordt geweigerd — anders valt er niets te controleren', async (t) => {
  t.after(() => mock.reset());
  const handler = await laadPropose({ log: [], hookLog: [] });
  const res = nepRes();
  await handler(req({
    customer_id: CUST, type: 'TOEZEGGING', invoice_ids: [],
    details: { parts: [{ due_date: ymd(5) }] }, rationale: 'x',
  }), res);
  assert.equal(res._uit.code, 400);
  assert.match(res._uit.body.error, /invoice_ids/i);
});

test('een part-factuur die niet bij het arrangement hoort wordt geweigerd', async (t) => {
  t.after(() => mock.reset());
  const handler = await laadPropose({ log: [], hookLog: [] });
  const res = nepRes();
  await handler(req({
    customer_id: CUST, type: 'TOEZEGGING', invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(5), invoice_id: INV2 }] }, rationale: 'x',
  }), res);
  assert.equal(res._uit.code, 400);
  assert.match(res._uit.body.error, /invoice_ids/i);
});

// ═══ 3. De bewaking ═════════════════════════════════════════════════

async function laadBreachCheck(invoices) {
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: nepAdmin({ rows: { invoices } }),
      createUserClient: () => ({}),
      supabase: {},
      checkCronAuth: () => true,
      ADMIN_ROLES: [],
    },
  });
  const mod = await import(url('api/cron-arrangements-breach-check.js') + '?t=' + Math.random());
  return mod.evaluateArrangement;
}

const openFactuur = (id) => ({ id, status: 'open', amount_total: 320, amount_paid: 0, credited_amount: 0, due_date: ymd(-30) });
const paidFactuur = (id) => ({ id, status: 'paid', amount_total: 320, amount_paid: 320, credited_amount: 0, due_date: ymd(-30) });

test('vóór de afgesproken dag gebeurt er niets — Joost blijft stil', async (t) => {
  t.after(() => mock.reset());
  const evaluate = await laadBreachCheck([openFactuur(INV1)]);
  const uit = await evaluate({
    id: 'a1', type: 'TOEZEGGING', status: 'ACTIEF', invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(3) }] },
  });
  assert.equal(uit, null, 'geen status-wissel zolang de datum nog niet verstreken is');
});

test('betaald vóór de datum → NAGEKOMEN, ook als de dag nog niet geweest is', async (t) => {
  t.after(() => mock.reset());
  const evaluate = await laadBreachCheck([paidFactuur(INV1)]);
  const uit = await evaluate({
    id: 'a1', type: 'TOEZEGGING', status: 'ACTIEF', invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(5) }] },
  });
  assert.equal(uit?.newStatus, 'NAGEKOMEN');
});

test('datum verstreken en factuur nog open → VERBROKEN', async (t) => {
  t.after(() => mock.reset());
  const evaluate = await laadBreachCheck([openFactuur(INV1)]);
  const uit = await evaluate({
    id: 'a1', type: 'TOEZEGGING', status: 'ACTIEF', invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(-1) }] },
  });
  assert.equal(uit?.newStatus, 'VERBROKEN');
  assert.match(uit.reason, /verstreken/i);
});

test('op de dag zelf nog niet verbroken — de klant heeft de hele dag', async (t) => {
  t.after(() => mock.reset());
  const evaluate = await laadBreachCheck([openFactuur(INV1)]);
  const uit = await evaluate({
    id: 'a1', type: 'TOEZEGGING', status: 'ACTIEF', invoice_ids: [INV1],
    details: { parts: [{ due_date: ymd(0) }] },
  });
  assert.equal(uit, null);
});

test('meerdere facturen: één onbetaalde na de datum is genoeg voor VERBROKEN', async (t) => {
  t.after(() => mock.reset());
  const evaluate = await laadBreachCheck([paidFactuur(INV1), openFactuur(INV2)]);
  const uit = await evaluate({
    id: 'a1', type: 'TOEZEGGING', status: 'ACTIEF', invoice_ids: [INV1, INV2],
    details: { parts: [{ due_date: ymd(-2) }] },
  });
  assert.equal(uit?.newStatus, 'VERBROKEN');
});

test('alles betaald → NAGEKOMEN, ongeacht hoeveel facturen', async (t) => {
  t.after(() => mock.reset());
  const evaluate = await laadBreachCheck([paidFactuur(INV1), paidFactuur(INV2)]);
  const uit = await evaluate({
    id: 'a1', type: 'TOEZEGGING', status: 'ACTIEF', invoice_ids: [INV1, INV2],
    details: { parts: [{ due_date: ymd(-2) }] },
  });
  assert.equal(uit?.newStatus, 'NAGEKOMEN');
});
