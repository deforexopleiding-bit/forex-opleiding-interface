// tests/leads-promote.test.js
//
// Bewijst de 3 kritieke edge cases:
//  1) email bestaat al als customer → LINK, geen dubbel
//  2) lege email → nette fout, GEEN halve customer
//  3) al gepromoted → idempotent no-op

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, splitName, validateLeadForPromote, decidePromoteAction } from '../api/_lib/leads-promote.js';

// ── normalizeEmail ─────────────────────────────────────────────────────────

test('normalizeEmail: valide email → lowercase-trimmed', () => {
  assert.equal(normalizeEmail('  Jeff@Example.COM '), 'jeff@example.com');
});

test('normalizeEmail: null/undefined/leeg → ""', () => {
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail('   '), '');
});

test('normalizeEmail: ongeldig formaat → "" (fail-safe)', () => {
  assert.equal(normalizeEmail('no-at-sign'), '');
  assert.equal(normalizeEmail('@nolocal.com'), '');
  assert.equal(normalizeEmail('nodomain@'), '');
});

test('normalizeEmail: non-string input → ""', () => {
  assert.equal(normalizeEmail(42), '');
  assert.equal(normalizeEmail({}), '');
});

// ── splitName ──────────────────────────────────────────────────────────────

test('splitName: één woord → alleen first_name', () => {
  assert.deepEqual(splitName('Madonna'), { first_name: 'Madonna', last_name: null });
});

test('splitName: twee woorden → voornaam + achternaam', () => {
  assert.deepEqual(splitName('Jeffrey Biemold'), { first_name: 'Jeffrey', last_name: 'Biemold' });
});

test('splitName: drie+ woorden → voornaam + rest', () => {
  assert.deepEqual(splitName('Van Der Berg Jr'), { first_name: 'Van', last_name: 'Der Berg Jr' });
});

test('splitName: leeg → beide null', () => {
  assert.deepEqual(splitName(''), { first_name: null, last_name: null });
  assert.deepEqual(splitName('   '), { first_name: null, last_name: null });
  assert.deepEqual(splitName(null), { first_name: null, last_name: null });
});

// ── validateLeadForPromote ─────────────────────────────────────────────────

test('lead=null → lead-not-found', () => {
  const r = validateLeadForPromote(null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'lead-not-found');
});

test('lead met geldige email → ok', () => {
  const r = validateLeadForPromote({ id: 'l1', email: 'test@example.com', naam: 'Test User' });
  assert.equal(r.ok, true);
  assert.equal(r.email, 'test@example.com');
});

// EDGE CASE 2: lege email
test('EDGE 2: lead met lege email → email-required (geen halve customer)', () => {
  const r = validateLeadForPromote({ id: 'l1', email: '', naam: 'Naamloos' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'email-required');
  assert.match(r.message, /e-mail/i);
});

test('EDGE 2: lead met NULL email → email-required', () => {
  const r = validateLeadForPromote({ id: 'l1', email: null, naam: 'Naamloos' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'email-required');
});

test('EDGE 2: lead met ongeldige email → email-required', () => {
  const r = validateLeadForPromote({ id: 'l1', email: 'ongeldig-adres', naam: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'email-required');
});

// EDGE CASE 3: al gepromoted
test('EDGE 3: lead al gewonnen + customer_id → already-promoted no-op', () => {
  const r = validateLeadForPromote({
    id: 'l1',
    email: 'x@y.com',
    status: 'gewonnen',
    customer_id: 'cust-99',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'already-promoted');
  assert.equal(r.existing_customer_id, 'cust-99');
});

test('EDGE 3: lead gewonnen zonder customer_id → NIET already-promoted (mag door)', () => {
  const r = validateLeadForPromote({ id: 'l1', email: 'x@y.com', status: 'gewonnen', customer_id: null });
  assert.equal(r.ok, true, 'zonder customer_id-koppeling mag doorzet nog steeds');
});

// ── decidePromoteAction ────────────────────────────────────────────────────

// EDGE CASE 1: bestaande customer → LINK, geen dubbel
test('EDGE 1: bestaande customer met matched email → action=link, geen create', () => {
  const lead = { id: 'l1', naam: 'Jane Doe', email: 'jane@example.com', telefoon: '+31612345678' };
  const existing = { id: 'cust-42', email: 'JANE@example.com' };
  const r = decidePromoteAction(lead, existing);
  assert.equal(r.action, 'link');
  assert.equal(r.customer_id, 'cust-42');
  assert.equal(r.payload, undefined, 'geen payload bij link');
});

test('geen bestaande customer → action=create met naam/email/telefoon', () => {
  const lead = { id: 'l1', naam: 'John Q Public', email: 'john@public.com', telefoon: ' +31611223344 ' };
  const r = decidePromoteAction(lead, null);
  assert.equal(r.action, 'create');
  assert.deepEqual(r.payload, {
    first_name: 'John',
    last_name:  'Q Public',
    email:      'john@public.com',
    phone:      '+31611223344',
  });
});

test('create-payload: telefoon leeg → phone=null', () => {
  const lead = { id: 'l1', naam: 'X', email: 'x@y.com', telefoon: null };
  const r = decidePromoteAction(lead, null);
  assert.equal(r.payload.phone, null);
});

test('existingCustomer zonder id → toch create (defensive)', () => {
  const lead = { id: 'l1', naam: 'X', email: 'x@y.com' };
  const r = decidePromoteAction(lead, { id: null, email: 'x@y.com' });
  assert.equal(r.action, 'create');
});

// ── Regressie-guard: normalize-mismatch niet mogelijk ──────────────────────

test('email met hoofdletters in existingCustomer wordt correct als match herkend', () => {
  const lead = { id: 'l1', naam: 'Y', email: 'lower@case.com' };
  const existing = { id: 'cust-x', email: 'LOWER@CASE.com' };
  const r = decidePromoteAction(lead, existing);
  assert.equal(r.action, 'link', 'case-verschil mag geen dubbel opleveren');
});

test('email met whitespace-verschil wordt correct herkend', () => {
  const lead = { id: 'l1', naam: 'Y', email: '  jane@x.com  ' };
  assert.equal(normalizeEmail(lead.email), 'jane@x.com');
});
