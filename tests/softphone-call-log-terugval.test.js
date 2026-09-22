// tests/softphone-call-log-terugval.test.js
//
// DE NIEUWE UITKOMST MAG HET LOGGEN NOOIT SLOPEN.
//
// `afgebroken_voor_opnemen` is nieuw. Staat er een CHECK op
// call_log.outcome_hint die hem nog niet kent, dan faalt de insert met 23514 —
// en dan blijft het HELE gesprek ongelogd, inclusief de belpoging eronder.
// Dat is erger dan een iets minder precieze waarde in één kolom.
//
// Dit draait op het live CRM waar Dave de hele dag mee belt, en ik kan het
// schema van de productiedatabank hier niet lezen. Dus moet de code allebei de
// gevallen overleven, en dat hoort bewezen te zijn en niet aangenomen.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── De nagebootste databank ────────────────────────────────────────────────
// Eén tabel telt: call_log. De rest antwoordt leeg, zodat de koppeling naar
// opvolging_pogingen fail-soft langsloopt zonder dit onderwerp te vertroebelen.

const gelogd = { inserts: [], weiger: null };

const bouwQuery = (tabel) => {
  const q = {
    insert(rij) {
      if (tabel === 'call_log') {
        gelogd.inserts.push(rij);
        if (gelogd.weiger && gelogd.weiger(rij)) {
          q.__fout = { code: '23514', message: 'new row violates check constraint "call_log_outcome_hint_check"' };
        } else {
          q.__fout = null;
        }
      }
      return q;
    },
    select() { return q; },
    eq() { return q; }, gte() { return q; }, lt() { return q; }, limit() { return q; },
    order() { return q; }, update() { return q; }, in() { return q; },
    single() { return q.__eind(); },
    maybeSingle() { return q.__eind(); },
    __eind() {
      return q.__fout
        ? Promise.resolve({ data: null, error: q.__fout })
        : Promise.resolve({ data: { id: 'log-1' }, error: null });
    },
    then(res, rej) { return q.__eind().then(res, rej); },
  };
  return q;
};

const db = {
  from: (t) => bouwQuery(t),
  // Het endpoint vraagt eerst wie er belt. Eén vaste gebruiker volstaat: dit
  // gaat over het loggen, niet over de toegang.
  auth: { getUser: async () => ({ data: { user: { id: 'u-dave' } } }) },
};

mock.module('../api/supabase.js', {
  namedExports: {
    supabase: db, supabaseAdmin: db,
    createUserClient: () => db,
    verifyAdmin: async () => ({ ok: true }),
    checkCronAuth: () => ({ ok: true }),
  },
});

// De snelheidsbegrenzer doet hier niet mee: zeven aanroepen achter elkaar
// zouden er anders op stuklopen, en dat is een ander onderwerp.
mock.module('../api/_lib/rate-limit.js', {
  namedExports: { checkRateLimit: async () => ({ limited: false }) },
});

const { default: handler } = await import('../api/softphone-call-log.js');

/** Het endpoint aanroepen en de antwoordcode + body teruggeven. */
async function post(body) {
  gelogd.inserts = [];
  let uit = null;
  const res = {
    setHeader() { return res; },
    status(code) { res.__code = code; return res; },
    json(b) { uit = { code: res.__code, body: b }; return res; },
  };
  await handler({ method: 'POST', headers: {}, body }, res);
  return uit;
}

const BASIS = {
  to_number: '+31612345678',
  line: 'nl',
  started_at: '2026-09-22T09:00:00.000Z',
  ended_at: '2026-09-22T09:00:04.000Z',
};

// ═══════════════════════════════════════════════════════════════════════════
// MET DE MIGRATIE: de echte waarde gaat gewoon de databank in
// ═══════════════════════════════════════════════════════════════════════════

test('met de migratie wordt afgebroken_voor_opnemen zelf gelogd', async () => {
  gelogd.weiger = null;
  const r = await post({ ...BASIS, outcome_hint: 'afgebroken_voor_opnemen' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(gelogd.inserts.length, 1, 'één insert, geen terugval nodig');
  assert.equal(gelogd.inserts[0].outcome_hint, 'afgebroken_voor_opnemen');
});

// ═══════════════════════════════════════════════════════════════════════════
// ZONDER DE MIGRATIE: het gesprek wordt nog steeds gelogd
// ═══════════════════════════════════════════════════════════════════════════

test('zonder de migratie valt hij terug in plaats van de call te verliezen', async () => {
  gelogd.weiger = (rij) => rij.outcome_hint === 'afgebroken_voor_opnemen';
  const r = await post({ ...BASIS, outcome_hint: 'afgebroken_voor_opnemen' });
  assert.equal(r.code, 200, 'de call hoort gelogd te worden, niet verloren te gaan');
  assert.equal(gelogd.inserts.length, 2, 'één poging met de echte waarde, één terugval');
  assert.equal(gelogd.inserts[1].outcome_hint, 'local_cancel');
});

test('de terugval is NOOIT no_answer — dat is het verwijt dat we weghalen', async () => {
  gelogd.weiger = (rij) => rij.outcome_hint === 'afgebroken_voor_opnemen';
  await post({ ...BASIS, outcome_hint: 'afgebroken_voor_opnemen' });
  assert.notEqual(gelogd.inserts[1].outcome_hint, 'no_answer');
  // local_cancel zegt ook 'wij hingen op' en is dus geen uitspraak over de lead.
  assert.equal(gelogd.inserts[1].outcome_hint, 'local_cancel');
});

test('en de echte waarde gaat niet verloren', async () => {
  gelogd.weiger = (rij) => rij.outcome_hint === 'afgebroken_voor_opnemen';
  await post({ ...BASIS, outcome_hint: 'afgebroken_voor_opnemen' });
  assert.equal(gelogd.inserts[1].meta.werkelijke_outcome, 'afgebroken_voor_opnemen');
});

test('meta dat de beller zelf meestuurde blijft staan', async () => {
  gelogd.weiger = (rij) => rij.outcome_hint === 'afgebroken_voor_opnemen';
  await post({ ...BASIS, outcome_hint: 'afgebroken_voor_opnemen', meta: { bron: 'opvolging' } });
  assert.equal(gelogd.inserts[1].meta.bron, 'opvolging');
  assert.equal(gelogd.inserts[1].meta.werkelijke_outcome, 'afgebroken_voor_opnemen');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TERUGVAL IS SMAL
// ═══════════════════════════════════════════════════════════════════════════

test('een 23514 op iets anders wordt NIET weggepoetst', async () => {
  // Anders verbergt deze terugval elke toekomstige schending van een CHECK,
  // en dan zoek je je scheel naar een fout die het endpoint stil opeet.
  gelogd.weiger = () => true;
  const r = await post({ ...BASIS, outcome_hint: 'no_answer' });
  assert.equal(r.code, 500);
  assert.equal(gelogd.inserts.length, 1, 'geen tweede poging voor een andere waarde');
});

test('een andere databankfout dan 23514 blijft gewoon een fout', async () => {
  gelogd.weiger = null;
  const origineel = db.from;
  db.from = (t) => {
    const q = bouwQuery(t);
    if (t === 'call_log') {
      const insert = q.insert;
      q.insert = (rij) => { insert(rij); q.__fout = { code: '42703', message: 'column "x" does not exist' }; return q; };
    }
    return q;
  };
  const r = await post({ ...BASIS, outcome_hint: 'afgebroken_voor_opnemen' });
  db.from = origineel;
  assert.equal(r.code, 500);
  assert.equal(gelogd.inserts.length, 1, 'geen terugval op een fout die er niets mee te maken heeft');
});
