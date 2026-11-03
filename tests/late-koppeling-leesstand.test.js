// tests/late-koppeling-leesstand.test.js
//
// Late koppeling van oude mails mag een gelezen gesprek niet terug ongelezen
// maken (3 nov 2026, go van Maxim).
//
// Gemeten op productie (administratie@): 22 nog ongelezen mails kregen hun
// klant pas later (klant aangemaakt na de sync), en 9 ongelezen mails uit
// mei–juli zouden bij de volgende backfill-run hetzelfde doen. De badge telt
// elke ongelezen mail met die customer_id, dus het gesprek werd ongelezen.
//
// Regel: bij koppelen gaat een ONGELEZEN mail ouder dan
// LATE_KOPPELING_GELEZEN_NA_DAGEN (7) in dezelfde update op is_read=true.
// Jongere mails blijven ongelezen. Ontkoppelen raakt is_read niet.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ── nep-databank: de PostgREST-ketens die de twee routes gebruiken ───────── */

function nepDb(tabellen, { foutBijUpdate = null } = {}) {
  const db = JSON.parse(JSON.stringify(tabellen));
  const updates = [];
  return {
    db, updates,
    from(tabel) {
      const filters = [];
      let actie = 'select';
      let waarden = null;
      let enkel = false;
      const voerUit = () => {
        if (actie === 'update' && foutBijUpdate) return { data: null, error: { message: foutBijUpdate }, count: null };
        const rijen = (db[tabel] || []).filter((r) => filters.every((f) => f(r)));
        if (actie === 'update') {
          updates.push({ tabel, waarden: { ...waarden }, n: rijen.length });
          for (const r of rijen) Object.assign(r, waarden);
        }
        const data = enkel ? (rijen[0] ? { ...rijen[0] } : null) : rijen.map((r) => ({ ...r }));
        return { data, error: null, count: rijen.length };
      };
      const b = {
        update(v) { actie = 'update'; waarden = v; return b; },
        select() { return b; },
        eq(k, v) { filters.push((r) => r[k] === v); return b; },
        in(k, arr) { filters.push((r) => arr.includes(r[k])); return b; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return b; },
        maybeSingle() { enkel = true; return Promise.resolve(voerUit()); },
        then(ok, fout) { return Promise.resolve(voerUit()).then(ok, fout); },
      };
      return b;
    },
  };
}

let huidigeDb = nepDb({});
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from: (t) => huidigeDb.from(t) },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async () => true },
});

const L = await import('../api/_lib/gesprek-leesstand.js');
const { default: koppelHandler } = await import('../api/email-message-link-customer.js');
const { persistUpdates } = await import('../api/backfill-email-customer-id.js');

const NU = Date.parse('2026-11-03T12:00:00Z');
const dagenTerug = (d) => new Date(NU - d * 24 * 60 * 60 * 1000).toISOString();
const KLANT = '11111111-1111-4111-8111-111111111111';
const ANDER = '22222222-2222-4222-8222-222222222222';
const MAIL  = '33333333-3333-4333-8333-333333333333';

/* ── 1. de gedeelde regel ─────────────────────────────────────────────────── */

test('de grens is een benoemde constante op de gedeelde plek: 7 dagen', () => {
  assert.equal(L.LATE_KOPPELING_GELEZEN_NA_DAGEN, 7);
});

test('oudGenoegVoorGelezen: ouder dan 7 dagen ja, 7 dagen of jonger nee, onbekend nee', () => {
  assert.equal(L.oudGenoegVoorGelezen(dagenTerug(30), NU), true);
  assert.equal(L.oudGenoegVoorGelezen(dagenTerug(7.01), NU), true);
  assert.equal(L.oudGenoegVoorGelezen(dagenTerug(7), NU), false, 'precies 7 dagen kan nog nieuw zijn');
  assert.equal(L.oudGenoegVoorGelezen(dagenTerug(1), NU), false);
  assert.equal(L.oudGenoegVoorGelezen(null, NU), false, 'zonder datum: leeftijd onbekend → ongelezen laten');
  assert.equal(L.oudGenoegVoorGelezen('geen datum', NU), false);
});

test('koppelPatch: oude ongelezen mail → gelezen; jonge, al gelezen of ontkoppelen → is_read niet aangeraakt', () => {
  assert.deepEqual(L.koppelPatch({ is_read: false, date_received: dagenTerug(60) }, KLANT, NU), { customer_id: KLANT, is_read: true });
  assert.deepEqual(L.koppelPatch({ is_read: false, date_received: dagenTerug(2) }, KLANT, NU), { customer_id: KLANT });
  assert.deepEqual(L.koppelPatch({ is_read: true, date_received: dagenTerug(60) }, KLANT, NU), { customer_id: KLANT });
  assert.deepEqual(L.koppelPatch({ is_read: false, date_received: dagenTerug(60) }, null, NU), { customer_id: null });
  assert.deepEqual(L.koppelPatch({ is_read: false, date_received: null }, KLANT, NU), { customer_id: KLANT });
});

/* ── 2. email-message-link-customer ──────────────────────────────────────── */

function nepRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function koppel(db, customer_id) {
  huidigeDb = db;
  const res = nepRes();
  await koppelHandler({ method: 'POST', body: { message_id: MAIL, customer_id }, headers: {} }, res);
  return res;
}
const klanten = [
  { id: KLANT, archived_at: null, anonymized_at: null },
  { id: ANDER, archived_at: null, anonymized_at: null },
];

test('link-customer: een ongelezen mail van weken oud koppelen → in dezelfde update gelezen', async () => {
  const db = nepDb({ customers: klanten, email_messages: [
    { id: MAIL, from_address: 'k@x.be', customer_id: null, is_read: false, date_received: dagenTerug(40) },
  ] });
  const res = await koppel(db, KLANT);
  assert.equal(res.code, 200);
  assert.equal(res.body.item.gelezen_gezet, true);
  assert.equal(res.body.item.is_read, true);
  assert.deepEqual(db.db.email_messages[0], { ...db.db.email_messages[0], customer_id: KLANT, is_read: true });
  assert.equal(db.updates.length, 1, 'één schrijfactie, geen tweede update');
  assert.deepEqual(db.updates[0].waarden, { customer_id: KLANT, is_read: true });
});

test('link-customer: een mail van de laatste 7 dagen blijft ongelezen', async () => {
  const db = nepDb({ customers: klanten, email_messages: [
    { id: MAIL, from_address: 'k@x.be', customer_id: null, is_read: false, date_received: new Date(Date.now() - 2 * 864e5).toISOString() },
  ] });
  const res = await koppel(db, KLANT);
  assert.equal(res.code, 200);
  assert.equal(res.body.item.gelezen_gezet, false);
  assert.equal(db.db.email_messages[0].is_read, false);
  assert.deepEqual(db.updates[0].waarden, { customer_id: KLANT });
});

test('link-customer: omkoppelen naar een andere klant volgt dezelfde regel', async () => {
  const db = nepDb({ customers: klanten, email_messages: [
    { id: MAIL, from_address: 'k@x.be', customer_id: ANDER, is_read: false, date_received: dagenTerug(20) },
  ] });
  const res = await koppel(db, KLANT);
  assert.equal(res.body.item.previous_customer_id, ANDER);
  assert.equal(db.db.email_messages[0].is_read, true);
});

test('link-customer: ontkoppelen (customer_id=null) raakt is_read niet', async () => {
  const db = nepDb({ customers: klanten, email_messages: [
    { id: MAIL, from_address: 'k@x.be', customer_id: KLANT, is_read: false, date_received: dagenTerug(90) },
  ] });
  const res = await koppel(db, null);
  assert.equal(res.code, 200);
  assert.equal(db.db.email_messages[0].customer_id, null);
  assert.equal(db.db.email_messages[0].is_read, false);
  assert.deepEqual(db.updates[0].waarden, { customer_id: null });
});

test('link-customer: een databankfout bij de update is een 500, geen stille ok', async () => {
  const db = nepDb({ customers: klanten, email_messages: [
    { id: MAIL, from_address: 'k@x.be', customer_id: null, is_read: false, date_received: dagenTerug(40) },
  ] }, { foutBijUpdate: 'RLS' });
  const res = await koppel(db, KLANT);
  assert.equal(res.code, 500);
  assert.match(res.body.error, /RLS/);
});

/* ── 3. backfill-email-customer-id ───────────────────────────────────────── */

test('backfill persistUpdates: oude ongelezen gelezen, jonge ongelezen blijven, alleen NULL-rijen', async () => {
  const sb = nepDb({ email_messages: [
    { id: 'oud',    customer_id: null,  is_read: false },
    { id: 'jong',   customer_id: null,  is_read: false },
    { id: 'gelezen',customer_id: null,  is_read: true },
    { id: 'bezet',  customer_id: ANDER, is_read: false },
  ] });
  const r = await persistUpdates([
    { id: 'oud',     customer_id: KLANT, is_read: true },
    { id: 'jong',    customer_id: KLANT },
    { id: 'gelezen', customer_id: KLANT },
    { id: 'bezet',   customer_id: KLANT, is_read: true },
  ], sb);
  assert.deepEqual(r, { updated: 3, markedRead: 1 });
  const stand = Object.fromEntries(sb.db.email_messages.map((m) => [m.id, [m.customer_id, m.is_read]]));
  assert.deepEqual(stand, {
    oud: [KLANT, true], jong: [KLANT, false], gelezen: [KLANT, true], bezet: [ANDER, false],
  }, 'een rij die al een klant heeft, blijft volledig onaangeroerd');
});

test('backfill persistUpdates: een mislukte update gooit (geen console.warn + doorgaan meer)', async () => {
  const sb = nepDb({ email_messages: [{ id: 'a', customer_id: null, is_read: false }] }, { foutBijUpdate: 'timeout' });
  await assert.rejects(persistUpdates([{ id: 'a', customer_id: KLANT, is_read: true }], sb), /timeout/);
});

/* ── 4. bedrading ─────────────────────────────────────────────────────────── */

const code = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');

test('backfill: leest is_read + date_received, bouwt de patch met koppelPatch en meldt de telling', () => {
  const s = code('api/backfill-email-customer-id.js');
  assert.ok(s.includes(".select('id, from_address, is_read, date_received', { count: 'exact' })"));
  assert.ok(s.includes('updates.push({ id: r.id, ...koppelPatch(r, cid, nu) });'));
  assert.ok(s.includes('would_mark_read_count') && s.includes('marked_read_count'));
  assert.ok(s.includes('gelezen_na_dagen: LATE_KOPPELING_GELEZEN_NA_DAGEN'));
  assert.ok(!s.includes("console.warn('[backfill-email-customer-id] update chunk fail:'"));
  assert.ok(s.includes('const dryRun     = body.dry_run !== false;'), 'standaard blijft dry-run');
});

test('link-customer: leest is_read + date_received en schrijft koppelPatch in één update', () => {
  const s = code('api/email-message-link-customer.js');
  assert.ok(s.includes(".select('id, from_address, customer_id, is_read, date_received')"));
  assert.ok(s.includes('const patch = koppelPatch(msg, customerId);'));
  assert.ok(s.includes('.update(patch)'));
  assert.ok(s.includes("if (custErr) throw new Error('klant: ' + custErr.message);"), 'klantfout niet inslikken');
});

test('geen eigen kopie van de 7 dagen in de routes', () => {
  for (const p of ['api/backfill-email-customer-id.js', 'api/email-message-link-customer.js']) {
    assert.ok(!/\b7\s*\*\s*24|\b604800/.test(code(p)), p + ' rekent de grens niet zelf');
  }
});
