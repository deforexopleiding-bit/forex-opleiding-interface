// tests/customer-link.test.js
//
// Regressietest voor de shared helpers in api/_lib/customer-link.js.
// Test de link-validatie voor de bedrijf ↔ persoon koppeling (v1 lokaal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMissingColumnError,
  customerLabel,
  validateLinkRequest,
} from '../api/_lib/customer-link.js';

// ─────────────────────────────────────────────────────────────────────────────
// isMissingColumnError
// ─────────────────────────────────────────────────────────────────────────────

test('isMissingColumnError: null → false', () => {
  assert.equal(isMissingColumnError(null), false);
  assert.equal(isMissingColumnError(undefined), false);
});

test('isMissingColumnError: PG 42703 → true', () => {
  assert.equal(isMissingColumnError({ code: '42703', message: 'column "x" does not exist' }), true);
});

test('isMissingColumnError: PostgREST PGRST204 → true', () => {
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: 'Could not find the "x" column' }), true);
});

test('isMissingColumnError: PostgREST PGRST205 → true', () => {
  assert.equal(isMissingColumnError({ code: 'PGRST205', message: 'schema cache miss' }), true);
});

test('isMissingColumnError: tekstmatch "schema cache" → true (ook zonder code)', () => {
  assert.equal(isMissingColumnError({ message: 'PostgREST schema cache mismatch' }), true);
});

test('isMissingColumnError: tekstmatch "column X does not exist" → true', () => {
  assert.equal(isMissingColumnError({ message: 'ERROR: column "company_customer_id" does not exist' }), true);
});

test('isMissingColumnError: onbekende PG-fout → false', () => {
  assert.equal(isMissingColumnError({ code: '23505', message: 'duplicate key value' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// customerLabel
// ─────────────────────────────────────────────────────────────────────────────

test('customerLabel: bedrijf met company_name → company_name', () => {
  assert.equal(customerLabel({ is_company: true, company_name: 'Acme B.V.' }), 'Acme B.V.');
});

test('customerLabel: persoon met first + last → "First Last"', () => {
  assert.equal(customerLabel({ is_company: false, first_name: 'Jeffrey', last_name: 'Biemold' }), 'Jeffrey Biemold');
});

test('customerLabel: persoon met alleen first → "First"', () => {
  assert.equal(customerLabel({ is_company: false, first_name: 'Jeffrey' }), 'Jeffrey');
});

test('customerLabel: leeg → null', () => {
  assert.equal(customerLabel({ is_company: false }), null);
  assert.equal(customerLabel({ is_company: true }), null);
});

test('customerLabel: null → null (geen crash)', () => {
  assert.equal(customerLabel(null), null);
  assert.equal(customerLabel(undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateLinkRequest — kern van de gate
// ─────────────────────────────────────────────────────────────────────────────

const PERSON = { id: 'p1', is_company: false, first_name: 'A', last_name: 'B' };
const COMPANY = { id: 'c1', is_company: true, company_name: 'Acme' };

test('validateLinkRequest: geldige link persoon → bedrijf → null (OK)', () => {
  const r = validateLinkRequest({ person: PERSON, company: COMPANY, personId: 'p1', companyId: 'c1' });
  assert.equal(r, null);
});

test('validateLinkRequest: ontkoppel (companyId=null) → null (OK) zolang person klopt', () => {
  const r = validateLinkRequest({ person: PERSON, company: null, personId: 'p1', companyId: null });
  assert.equal(r, null);
});

test('validateLinkRequest: person niet gevonden → 404', () => {
  const r = validateLinkRequest({ person: null, company: COMPANY, personId: 'p1', companyId: 'c1' });
  assert.equal(r?.status, 404);
});

test('validateLinkRequest: person is bedrijf (is_company=true) → 400 PERSON_MUST_NOT_BE_COMPANY', () => {
  const r = validateLinkRequest({
    person: { id: 'p1', is_company: true, company_name: 'X' },
    company: COMPANY,
    personId: 'p1',
    companyId: 'c1',
  });
  assert.equal(r?.status, 400);
  assert.equal(r?.body?.code, 'PERSON_MUST_NOT_BE_COMPANY');
});

test('validateLinkRequest: self-link (person=company) → 400 CANNOT_SELF_LINK', () => {
  const r = validateLinkRequest({
    person: { id: 'p1', is_company: false, first_name: 'A' },
    company: { id: 'p1', is_company: true, company_name: 'X' },
    personId: 'p1',
    companyId: 'p1',
  });
  assert.equal(r?.status, 400);
  assert.equal(r?.body?.code, 'CANNOT_SELF_LINK');
});

test('validateLinkRequest: company niet gevonden → 404', () => {
  const r = validateLinkRequest({ person: PERSON, company: null, personId: 'p1', companyId: 'c1' });
  assert.equal(r?.status, 404);
});

test('validateLinkRequest: target is persoon (is_company=false) → 400 COMPANY_MUST_BE_COMPANY', () => {
  const r = validateLinkRequest({
    person: PERSON,
    company: { id: 'c1', is_company: false, first_name: 'X' },
    personId: 'p1',
    companyId: 'c1',
  });
  assert.equal(r?.status, 400);
  assert.equal(r?.body?.code, 'COMPANY_MUST_BE_COMPANY');
});

test('validateLinkRequest: target is_company=undefined → 400 COMPANY_MUST_BE_COMPANY (strict)', () => {
  const r = validateLinkRequest({
    person: PERSON,
    company: { id: 'c1', first_name: 'X' }, // is_company ontbreekt
    personId: 'p1',
    companyId: 'c1',
  });
  assert.equal(r?.status, 400);
  assert.equal(r?.body?.code, 'COMPANY_MUST_BE_COMPANY');
});
