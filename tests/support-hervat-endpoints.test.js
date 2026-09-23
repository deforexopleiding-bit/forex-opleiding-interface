// tests/support-hervat-endpoints.test.js
//
// DE WEG TERUG MAG NIEMAND BUITENSLUITEN.
//
// Drie regels die deze test vastlegt:
//
//   1. support-hervat-check kent geen lockout. Wie alleen het kenmerk kent,
//      kan zoveel foute codes insturen als hij wil: er komt nooit een 423,
//      `verificatie_geblokkeerd` gaat nooit omhoog, en het antwoord is
//      letterlijk hetzelfde als bij een verzonnen kenmerk. Elke poging
//      verbruikt de code; meer gebeurt er niet.
//
//   2. Eén code opent hooguit één sessie, ook bij gelijktijdige verzoeken, en
//      de klantlookup draait alleen voor een gesprek dat nog niet geverifieerd
//      was.
//
//   3. Een storing is geen ongeldig token. gesprekUitToken houdt "bestaat
//      niet" en "kon het niet nagaan" uit elkaar, en support-poll maakt van
//      het tweede een 503. Alleen de 401 draagt SESSIE_ONGELDIG, en dat is
//      het enige signaal waarop de widget een sessie weggooit.

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── in-memory Supabase ─────────────────────────────────────────────────────
// Klein, maar getrouw waar het hier om draait: een update met filters raakt
// alleen de rijen die op dat moment aan de filters voldoen. Zonder dat bewijst
// de test over "één code, één sessie" niets.
const db = { tabellen: {}, leesfout: {}, lookups: 0 };

function ketting(tabel) {
  const filters = [];
  let modus = 'select';
  let patch = null;
  let ordening = null;
  let limiet = null;
  let head = false;

  const voldoet = (rij) => filters.every(([op, k, v]) => {
    if (op === 'eq') return rij[k] === v;
    if (op === 'is') return (rij[k] ?? null) === v;
    if (op === 'gte') return String(rij[k]) >= String(v);
    return true;
  });

  async function resultaat(enkel) {
    if (modus === 'select' && db.leesfout[tabel]) {
      return { data: null, error: { message: db.leesfout[tabel] }, count: null };
    }
    const rijen = db.tabellen[tabel] || (db.tabellen[tabel] = []);
    if (modus === 'insert') {
      const rij = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...patch };
      rijen.push(rij);
      return { data: enkel ? rij : [rij], error: null };
    }
    let geraakt = rijen.filter(voldoet);
    if (modus === 'update') {
      geraakt.forEach((r) => Object.assign(r, patch));
      geraakt = geraakt.map((r) => ({ ...r }));
    }
    if (ordening) {
      geraakt = [...geraakt].sort((a, b) => (a[ordening.k] < b[ordening.k] ? -1 : 1) * (ordening.op ? 1 : -1));
    }
    if (limiet != null) geraakt = geraakt.slice(0, limiet);
    if (head) return { data: null, error: null, count: geraakt.length };
    if (enkel) return { data: geraakt[0] || null, error: null };
    return { data: geraakt, error: null };
  }

  const k = {
    select: (_c, opts) => { if (opts?.head) head = true; return k; },
    insert: (p) => { modus = 'insert'; patch = p; return k; },
    update: (p) => { modus = 'update'; patch = p; return k; },
    eq: (a, b) => { filters.push(['eq', a, b]); return k; },
    is: (a, b) => { filters.push(['is', a, b]); return k; },
    gte: (a, b) => { filters.push(['gte', a, b]); return k; },
    order: (a, o) => { ordening = { k: a, op: !!o?.ascending }; return k; },
    limit: (n) => { limiet = n; return k; },
    gt: () => k,
    maybeSingle: () => resultaat(true),
    then: (ok, nee) => resultaat(false).then(ok, nee),
  };
  return k;
}

mock.module('../api/supabase.js', {
  namedExports: { supabaseAdmin: { from: ketting }, supabase: {}, createUserClient: () => ({}) },
});
mock.module('../api/_lib/rate-limit.js', {
  namedExports: { checkRateLimit: async () => ({ limited: false }) },
});
mock.module('../api/_lib/support-lookups.js', {
  namedExports: {
    zoekKlant: async () => { db.lookups++; return { customer: { id: 'klant-1' }, meerdere: false }; },
    haalOnboarding: async () => null,
  },
});
mock.module('../api/_lib/support-beschikbaarheid.js', {
  namedExports: { haalBeschikbaarheid: async () => ({ live: false }) },
});

const { default: check } = await import('../api/support-hervat-check.js');
const { default: poll } = await import('../api/support-poll.js');
const { gesprekUitToken, SESSIE_ONGELDIG } = await import('../api/_lib/support-sessie.js');

const KENMERK = 'SUP-Z3HB8F';

function gesprek() { return db.tabellen.support_gesprekken[0]; }

function nieuweCode(code = '123456') {
  db.tabellen.support_verificaties.push({
    id: crypto.randomUUID(),
    gesprek_id: 'g-1',
    code_hash: sha(code),
    pogingen: 0,
    verbruikt_op: null,
    vervalt_op: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });
}

function res() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

async function doeCheck(body) {
  const r = res();
  await check({ method: 'POST', headers: {}, body }, r);
  return r;
}

async function doePoll({ token = 'x'.repeat(43), query = {} } = {}) {
  const r = res();
  await poll({ method: 'GET', headers: { 'x-support-token': token }, query }, r);
  return r;
}

beforeEach(() => {
  db.tabellen = {
    support_gesprekken: [{
      id: 'g-1', kenmerk: KENMERK, email: 'paulien@hotmail.com', telefoon: null,
      geverifieerd: false, verificatie_geblokkeerd: false, status: 'wacht_op_klant',
      sessie_token_hash: sha('oud-token-'.padEnd(43, 'o')),
    }],
    support_verificaties: [],
    support_berichten: [],
  };
  db.leesfout = {};
  db.lookups = 0;
});

describe('support-hervat-check: geen lockout, geen orakel', () => {
  test('een foute code en een verzonnen kenmerk geven exact hetzelfde antwoord', async () => {
    nieuweCode('123456');
    const fout = await doeCheck({ kenmerk: KENMERK, code: '000000' });
    const onbekend = await doeCheck({ kenmerk: 'SUP-QQQQQQ', code: '000000' });
    assert.equal(fout.statusCode, 400);
    assert.deepEqual(
      { s: fout.statusCode, b: fout.body },
      { s: onbekend.statusCode, b: onbekend.body },
    );
  });

  test('twintig foute codes: nooit een 423, nooit geblokkeerd, gesprek onaangeroerd', async () => {
    const voor = JSON.stringify(gesprek());
    // Zo zou een aanvaller het doen: één code laten versturen en die dan
    // blijven bestoken. De oorspronkelijke versie gaf bij de vijfde een 423 en
    // zette het gesprek voorgoed op slot.
    nieuweCode('123456');
    for (let i = 0; i < 20; i++) {
      const r = await doeCheck({ kenmerk: KENMERK, code: '999999' });
      assert.notEqual(r.statusCode, 423, `poging ${i + 1}`);
      assert.equal(r.statusCode, 400);
    }
    assert.equal(gesprek().verificatie_geblokkeerd, false);
    assert.equal(JSON.stringify(gesprek()), voor, 'het gesprek zelf mag niet veranderen');

    // En de eigenaar komt er daarna gewoon in met een verse code.
    nieuweCode('424242');
    const goed = await doeCheck({ kenmerk: KENMERK, code: '424242' });
    assert.equal(goed.statusCode, 200);
  });

  test('een foute poging verbruikt de code: daarna werkt ook de goede niet meer', async () => {
    nieuweCode('123456');
    await doeCheck({ kenmerk: KENMERK, code: '000000' });
    assert.ok(db.tabellen.support_verificaties[0].verbruikt_op, 'code is op');
    const daarna = await doeCheck({ kenmerk: KENMERK, code: '123456' });
    assert.equal(daarna.statusCode, 400);
    assert.equal(gesprek().sessie_token_hash, sha('oud-token-'.padEnd(43, 'o')), 'token niet geroteerd');
  });
});

describe('support-hervat-check: rotatie en verificatie', () => {
  test('goede code: vers token, hash op het gesprek, geverifieerd, één klantlookup', async () => {
    nieuweCode('123456');
    const r = await doeCheck({ kenmerk: KENMERK, code: '123456' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.token);
    assert.equal(gesprek().sessie_token_hash, sha(r.body.token));
    assert.equal(gesprek().geverifieerd, true);
    assert.equal(gesprek().customer_id, 'klant-1');
    assert.equal(db.lookups, 1);
  });

  test('al geverifieerd: alleen rotatie, geen klantlookup, koppeling blijft staan', async () => {
    Object.assign(gesprek(), { geverifieerd: true, customer_id: 'bestaand', geverifieerd_op: '2026-09-01T00:00:00Z' });
    nieuweCode('123456');
    const r = await doeCheck({ kenmerk: KENMERK, code: '123456' });
    assert.equal(r.statusCode, 200);
    assert.equal(db.lookups, 0);
    assert.equal(gesprek().customer_id, 'bestaand');
    assert.equal(gesprek().geverifieerd_op, '2026-09-01T00:00:00Z');
  });

  test('één code opent één sessie, ook bij twee gelijktijdige verzoeken', async () => {
    nieuweCode('123456');
    const [a, b] = await Promise.all([
      doeCheck({ kenmerk: KENMERK, code: '123456' }),
      doeCheck({ kenmerk: KENMERK, code: '123456' }),
    ]);
    const geslaagd = [a, b].filter((r) => r.statusCode === 200);
    assert.equal(geslaagd.length, 1);
    assert.equal(gesprek().sessie_token_hash, sha(geslaagd[0].body.token));
  });
});

describe('storing is geen ongeldig token', () => {
  test('gesprekUitToken: onbekend en leesfout zijn verschillende uitkomsten', async () => {
    const onbekend = await gesprekUitToken('bestaat-niet-'.padEnd(43, 'x'));
    assert.deepEqual(onbekend, { gesprek: null, leesfout: false });

    db.leesfout.support_gesprekken = 'connection reset';
    const storing = await gesprekUitToken('bestaat-niet-'.padEnd(43, 'x'));
    assert.deepEqual(storing, { gesprek: null, leesfout: true });
  });

  test('support-poll: leesfout op het token → 503, zonder SESSIE_ONGELDIG', async () => {
    db.leesfout.support_gesprekken = 'connection reset';
    const r = await doePoll();
    assert.equal(r.statusCode, 503);
    assert.notEqual(r.body?.code, SESSIE_ONGELDIG);
  });

  test('support-poll: onbekend token → 401 mét SESSIE_ONGELDIG', async () => {
    const r = await doePoll({ token: 'bestaat-niet-'.padEnd(43, 'x') });
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.code, SESSIE_ONGELDIG);
  });

  test('support-poll: berichten niet te lezen → 503 en geen lege 200 zonder gesprek', async () => {
    const token = 'oud-token-'.padEnd(43, 'o');
    db.leesfout.support_berichten = 'timeout';
    const r = await doePoll({ token, query: { volledig: '1' } });
    assert.equal(r.statusCode, 503);
  });

  test('support-poll: geldig token → 200 met het gesprek', async () => {
    const r = await doePoll({ token: 'oud-token-'.padEnd(43, 'o'), query: { volledig: '1' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.gesprek.kenmerk, KENMERK);
  });
});
