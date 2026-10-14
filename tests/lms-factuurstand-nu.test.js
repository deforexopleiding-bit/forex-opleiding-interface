// tests/lms-factuurstand-nu.test.js
//
// "Nu ophalen" (Maxim, 14 oktober 2026 — P2): de machine-route die de
// factuurstand van één student meteen opnieuw berekent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import route, { verversTlFacturen, TL_MAX } from '../api/lms-factuurstand-nu.js';

function nepRes() {
  const uit = { status: null, body: null, headers: {} };
  return {
    uit,
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.status = c; return this; },
    json(b) { uit.body = b; return this; },
  };
}

function nepDb(rijen, fout = null) {
  const gevraagd = {};
  const q = {
    select(k) { gevraagd.select = k; return q; },
    eq(k, v) { gevraagd.eq = [k, v]; return q; },
    in(k, v) { gevraagd.in = [k, v]; return q; },
    not(k, op, v) { gevraagd.not = [k, op, v]; return q; },
    limit(n) { gevraagd.limit = n; return Promise.resolve({ data: rijen, error: fout }); },
  };
  return { gevraagd, from: (t) => { gevraagd.tabel = t; return q; } };
}

test('DE ROUTE IS DICHT zonder geheim, met een fout geheim, voor GET, en zonder geldige student', async () => {
  const oud = { ...process.env };
  try {
    delete process.env.DFO_LMS_PUSH_SECRET; delete process.env.DFO_LMS_AGENDA_SECRET;
    let r = nepRes();
    await route({ method: 'POST', headers: {}, body: {} }, r);
    assert.equal(r.uit.status, 503);

    process.env.DFO_LMS_PUSH_SECRET = 'geheim';
    r = nepRes();
    await route({ method: 'POST', headers: { 'x-dfo-secret': 'fout' }, body: {} }, r);
    assert.equal(r.uit.status, 403);

    r = nepRes();
    await route({ method: 'GET', headers: { 'x-dfo-secret': 'geheim' } }, r);
    assert.equal(r.uit.status, 405);

    r = nepRes();
    await route({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' }, body: { student_id: 'geen-uuid' } }, r);
    assert.equal(r.uit.status, 400);
    assert.equal(r.uit.body.code, 'ongeldige_student');
  } finally {
    process.env = oud;
  }
});

test('TEAMLEADER: alleen de OPEN facturen van die klant, met een TL-id, en hooguit TL_MAX', async () => {
  const db = nepDb([{ id: 'a', tl_invoice_id: 'tl-1' }, { id: 'b', tl_invoice_id: 'tl-2' }]);
  const gezien = [];
  const uit = await verversTlFacturen('klant-1', { db, upsert: async (id) => { gezien.push(id); } });
  assert.deepEqual(uit, { ververst: 2, fouten: 0, gelezen: true });
  assert.deepEqual(gezien, ['tl-1', 'tl-2']);
  assert.equal(db.gevraagd.tabel, 'invoices');
  assert.deepEqual(db.gevraagd.eq, ['customer_id', 'klant-1']);
  assert.deepEqual(db.gevraagd.in[1], ['open', 'partially_paid', 'overdue']);
  assert.deepEqual(db.gevraagd.not, ['tl_invoice_id', 'is', null]);
  assert.equal(db.gevraagd.limit, TL_MAX);
});

test('EEN TL-FOUT PER FACTUUR telt mee en breekt niets af; een leesfout zegt dat', async () => {
  const db = nepDb([{ tl_invoice_id: 'x' }, { tl_invoice_id: 'y' }]);
  let n = 0;
  const uit = await verversTlFacturen('k', { db, upsert: async () => { n += 1; if (n === 1) throw new Error('TL 500'); } });
  assert.deepEqual(uit, { ververst: 1, fouten: 1, gelezen: true });
  const stuk = await verversTlFacturen('k', { db: nepDb(null, { message: 'kapot' }), upsert: async () => {} });
  assert.equal(stuk.gelezen, false);
  assert.deepEqual(await verversTlFacturen(null), { ververst: 0, fouten: 0, gelezen: true });
});

test('HET TIJDSBUDGET: na 20 s stopt het, zodat de knop niet blijft hangen', async () => {
  const db = nepDb([{ tl_invoice_id: '1' }, { tl_invoice_id: '2' }, { tl_invoice_id: '3' }]);
  let klok = 0;
  const uit = await verversTlFacturen('k', { db, nu: () => klok, upsert: async () => { klok += 15_000; } });
  assert.equal(uit.ververst, 2);
});

test('CONTRACT: de spiegel blijft de enige schrijver, en er gaat niets naar de klant', () => {
  const bron = readFileSync(new URL('../api/lms-factuurstand-nu.js', import.meta.url), 'utf8');
  assert.match(bron, /spiegelFactuurstandVoorStudent\(/);
  assert.doesNotMatch(bron, /from\(['"]hlms_crm_factuurstand['"]\)/);
  assert.doesNotMatch(bron, /\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(bron, /sendMessage|sendMail|whatsapp/i);
});
