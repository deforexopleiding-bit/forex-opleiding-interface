// tests/email-customer-match.test.js
//
// Unit-tests voor api/_lib/email-customer-match.js.
//
// Bewijst:
//   1) normalizeEmail is trim+lowercase, tolerant voor null/undefined
//   2) escapeForOr strips commas + parens (PostgREST .or() protection)
//   3) pickBestCandidate ranking-regels
//        3a) filter niet-gearchiveerd/geanonimiseerd
//        3b) heeft-open-factuur wint van geen-open-factuur
//        3c) meest recent aangemaakt wint bij gelijkstand
//        3d) id-lexicografisch als final tie-breaker
//   4) resolveCustomerIdsForEmails end-to-end met fake supabase-client
//        4a) case-insensitieve match (N.Berghorst@... vs n.berghorst@...)
//        4b) ambigue set → deterministische keuze via ranking
//        4c) geen match → null
//        4d) invoice-check overslaan als 0 ambigue matches
//        4e) fail-soft: customers-fetch error → lege Map

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCustomerIdsForEmails,
  _internals,
} from '../api/_lib/email-customer-match.js';

const { normalizeEmail, escapeForOr, pickBestCandidate } = _internals;

// ── 1) normalizeEmail ────────────────────────────────────────────────

test('normalizeEmail: trim + lowercase', () => {
  assert.equal(normalizeEmail('  N.Berghorst@LIVE.nl  '), 'n.berghorst@live.nl');
});
test('normalizeEmail: null/undefined → ""', () => {
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

// ── 2) escapeForOr ───────────────────────────────────────────────────

test('escapeForOr: strips commas + parens', () => {
  assert.equal(escapeForOr('a,b@x.nl'), 'ab@x.nl');
  assert.equal(escapeForOr('(evil)@x.nl'), 'evil@x.nl');
});

// ── 3) pickBestCandidate ─────────────────────────────────────────────

test('pickBestCandidate: enkel-kandidaat trivial', () => {
  const id = pickBestCandidate(
    [{ id: 'c1', archived_at: null, anonymized_at: null, created_at: '2024-01-01' }],
    new Map(),
  );
  assert.equal(id, 'c1');
});

test('pickBestCandidate: filtert gearchiveerd + geanonimiseerd', () => {
  const id = pickBestCandidate(
    [
      { id: 'c1', archived_at: '2024-01-01', anonymized_at: null, created_at: '2025-01-01' },
      { id: 'c2', archived_at: null,         anonymized_at: null, created_at: '2024-01-01' },
    ],
    new Map(),
  );
  assert.equal(id, 'c2', 'archived c1 uit pool → c2 wint');
});

test('pickBestCandidate: heeft-open-factuur wint van geen-factuur', () => {
  const id = pickBestCandidate(
    [
      { id: 'c1', archived_at: null, anonymized_at: null, created_at: '2025-06-01' },
      { id: 'c2', archived_at: null, anonymized_at: null, created_at: '2024-01-01' },
    ],
    new Map([['c1', false], ['c2', true]]),
  );
  assert.equal(id, 'c2', 'c2 heeft open factuur → wint ondanks jongere c1');
});

test('pickBestCandidate: created_at DESC bij gelijke open-status', () => {
  const id = pickBestCandidate(
    [
      { id: 'a', archived_at: null, anonymized_at: null, created_at: '2024-01-01' },
      { id: 'b', archived_at: null, anonymized_at: null, created_at: '2025-06-01' },
    ],
    new Map([['a', false], ['b', false]]),
  );
  assert.equal(id, 'b', 'nieuwste wint');
});

test('pickBestCandidate: id-lexicografisch als final tie-breaker', () => {
  const id = pickBestCandidate(
    [
      { id: 'z', archived_at: null, anonymized_at: null, created_at: '2024-01-01' },
      { id: 'a', archived_at: null, anonymized_at: null, created_at: '2024-01-01' },
    ],
    new Map(),
  );
  assert.equal(id, 'a', 'lexicografisch eerste wint bij volledig gelijke rijen');
});

test('pickBestCandidate: alles gearchiveerd → alsnog keuze uit dead-pool', () => {
  const id = pickBestCandidate(
    [
      { id: 'c1', archived_at: '2024-01-01', anonymized_at: null, created_at: '2025-06-01' },
      { id: 'c2', archived_at: '2024-01-01', anonymized_at: null, created_at: '2024-01-01' },
    ],
    new Map(),
  );
  assert.equal(id, 'c1', 'geen levende → hardste keuze uit dode pool, jongste wint');
});

// ── 4) resolveCustomerIdsForEmails end-to-end ───────────────────────

function fakeSupabase({ customers, invoicesOpen }) {
  return {
    from(tbl) {
      if (tbl === 'customers') {
        return {
          _tbl: 'customers',
          select() { return this; },
          or(_clause) { return this; },
          async then(resolve) {
            resolve({ data: customers, error: null });
          },
        };
      }
      if (tbl === 'invoices') {
        return {
          _ids: null,
          _tbl: 'invoices',
          select() { return this; },
          in(_col, ids) { this._ids = ids; return this; },
          gt() { return this; },
          limit() { return this; },
          async then(resolve) {
            // Return alleen rijen voor customer_ids die in invoicesOpen zitten.
            const rows = (invoicesOpen || [])
              .filter((cid) => (this._ids || []).includes(cid))
              .map((cid) => ({ customer_id: cid }));
            resolve({ data: rows, error: null });
          },
        };
      }
      throw new Error('unexpected table: ' + tbl);
    },
  };
}

test('resolveCustomerIdsForEmails: case-insensitief matcht capital-DB-rijen', async () => {
  const supa = fakeSupabase({
    customers: [
      { id: 'nico1', email: 'N.Berghorst@live.nl', archived_at: null, anonymized_at: null, created_at: '2024-06-01' },
    ],
    invoicesOpen: [],
  });
  const out = await resolveCustomerIdsForEmails(supa, ['n.berghorst@live.nl']);
  assert.equal(out.get('n.berghorst@live.nl'), 'nico1');
});

test('resolveCustomerIdsForEmails: ambigue set kiest via ranking (open factuur wint)', async () => {
  const supa = fakeSupabase({
    customers: [
      { id: 'dup1', email: 'shared@x.nl', archived_at: null, anonymized_at: null, created_at: '2025-06-01' },
      { id: 'dup2', email: 'shared@x.nl', archived_at: null, anonymized_at: null, created_at: '2024-01-01' },
    ],
    invoicesOpen: ['dup2'], // oudere dup2 heeft open factuur → moet winnen
  });
  const out = await resolveCustomerIdsForEmails(supa, ['shared@x.nl']);
  assert.equal(out.get('shared@x.nl'), 'dup2');
});

test('resolveCustomerIdsForEmails: geen match → null', async () => {
  const supa = fakeSupabase({ customers: [], invoicesOpen: [] });
  const out = await resolveCustomerIdsForEmails(supa, ['unknown@x.nl']);
  assert.equal(out.get('unknown@x.nl'), null);
});

test('resolveCustomerIdsForEmails: enkel-hit slaat invoice-check over', async () => {
  // Als de invoice-query voor niet-ambigue rijen wél zou draaien, dan zou
  // een bug in de mock hier zichtbaar worden. We tracken de call.
  let invoiceCalls = 0;
  const supa = {
    from(tbl) {
      if (tbl === 'customers') {
        return {
          select() { return this; },
          or() { return this; },
          async then(r) {
            r({ data: [{ id: 'solo', email: 'solo@x.nl', archived_at: null, anonymized_at: null, created_at: '2024-01-01' }], error: null });
          },
        };
      }
      if (tbl === 'invoices') {
        invoiceCalls++;
        return {
          select() { return this; }, in() { return this; }, gt() { return this; }, limit() { return this; },
          async then(r) { r({ data: [], error: null }); },
        };
      }
    },
  };
  const out = await resolveCustomerIdsForEmails(supa, ['solo@x.nl']);
  assert.equal(out.get('solo@x.nl'), 'solo');
  // Ambigue set is leeg → invoice-fetch overgeslagen (0 ids in de call is
  // no-op in de helper). We tolereren 0 calls.
  assert.equal(invoiceCalls, 0, 'geen invoice-query bij niet-ambigue set');
});

test('resolveCustomerIdsForEmails: customers-fetch error → lege Map (fail-soft)', async () => {
  const supa = {
    from(tbl) {
      if (tbl === 'customers') {
        return {
          select() { return this; },
          or() { return this; },
          async then(r) { r({ data: null, error: { message: 'boom' } }); },
        };
      }
      // invoices niet aangeroepen
    },
  };
  const out = await resolveCustomerIdsForEmails(supa, ['x@y.nl']);
  assert.equal(out.get('x@y.nl'), null, 'fail-soft: null in plaats van throw');
});

test('resolveCustomerIdsForEmails: normalisatie voor deduplicate en match', async () => {
  const supa = fakeSupabase({
    customers: [
      { id: 'c1', email: 'a@x.nl', archived_at: null, anonymized_at: null, created_at: '2024-01-01' },
    ],
    invoicesOpen: [],
  });
  // Input met dubbele varianten van hetzelfde adres.
  const out = await resolveCustomerIdsForEmails(supa, ['A@X.NL', 'a@x.nl', '  a@x.nl  ']);
  // Map key is de lowercase-normalized versie
  assert.equal(out.size, 1);
  assert.equal(out.get('a@x.nl'), 'c1');
});

test('resolveCustomerIdsForEmails: lege input → lege Map', async () => {
  const supa = fakeSupabase({ customers: [], invoicesOpen: [] });
  const out = await resolveCustomerIdsForEmails(supa, []);
  assert.equal(out.size, 0);
});
