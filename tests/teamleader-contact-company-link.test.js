// tests/teamleader-contact-company-link.test.js
//
// Regressietest voor de idempotent-detectie in de TL link/unlink helper.
// De HTTP-call zelf test ik hier NIET (dat vereist een TL-mock met OAuth-
// flow); ik dek de pure error-recognizers die bepalen of een 400/404 van TL
// als "al gelinkt" / "al ontgelinkt" moet worden opgevat.
//
// Deze recognizers zijn de kern van de idempotentie-belofte in de
// fase-2 sync: dubbel-klikken of retry-after-partial-fail mag geen
// harde fout geven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAlreadyLinkedError,
  isAlreadyUnlinkedError,
} from '../api/_lib/teamleader-contact-company-link.js';

// ─────────────────────────────────────────────────────────────────────────────
// isAlreadyLinkedError
// ─────────────────────────────────────────────────────────────────────────────

test('isAlreadyLinkedError: 400 + "already linked" → true', () => {
  assert.equal(isAlreadyLinkedError(400, 'Contact already linked to company'), true);
});

test('isAlreadyLinkedError: 400 + "duplicate" → true', () => {
  assert.equal(isAlreadyLinkedError(400, '{"error":"duplicate link"}'), true);
});

test('isAlreadyLinkedError: 400 + "already exists" → true', () => {
  assert.equal(isAlreadyLinkedError(400, 'Link already exists'), true);
});

test('isAlreadyLinkedError: 400 + "already associated" → true', () => {
  assert.equal(isAlreadyLinkedError(400, 'This contact is already associated with this company'), true);
});

test('isAlreadyLinkedError: 400 + andere fout → false (blijft harde error)', () => {
  assert.equal(isAlreadyLinkedError(400, 'company_id is invalid'), false);
});

test('isAlreadyLinkedError: 500 + "already linked" → false (server-fout is geen idempotent-case)', () => {
  assert.equal(isAlreadyLinkedError(500, 'already linked'), false);
});

test('isAlreadyLinkedError: 404 → false (link-endpoint geeft geen 404 voor idempotency)', () => {
  assert.equal(isAlreadyLinkedError(404, 'not found'), false);
});

test('isAlreadyLinkedError: case-insensitive', () => {
  assert.equal(isAlreadyLinkedError(400, 'ALREADY LINKED'), true);
  assert.equal(isAlreadyLinkedError(400, 'Duplicate'), true);
});

test('isAlreadyLinkedError: null/undefined body → false (geen crash)', () => {
  assert.equal(isAlreadyLinkedError(400, null), false);
  assert.equal(isAlreadyLinkedError(400, undefined), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// isAlreadyUnlinkedError
// ─────────────────────────────────────────────────────────────────────────────

test('isAlreadyUnlinkedError: 404 (any body) → true (link bestaat al niet)', () => {
  assert.equal(isAlreadyUnlinkedError(404, ''), true);
  assert.equal(isAlreadyUnlinkedError(404, 'Not found'), true);
});

test('isAlreadyUnlinkedError: 400 + "not linked" → true', () => {
  assert.equal(isAlreadyUnlinkedError(400, 'Contact is not linked to this company'), true);
});

test('isAlreadyUnlinkedError: 400 + "no association" → true', () => {
  assert.equal(isAlreadyUnlinkedError(400, 'no association exists'), true);
});

test('isAlreadyUnlinkedError: 400 + "does not exist" → true', () => {
  assert.equal(isAlreadyUnlinkedError(400, 'Link does not exist'), true);
});

test('isAlreadyUnlinkedError: 400 + andere fout → false', () => {
  assert.equal(isAlreadyUnlinkedError(400, 'invalid company_id format'), false);
});

test('isAlreadyUnlinkedError: 500 → false (server-fout is geen idempotent-case)', () => {
  assert.equal(isAlreadyUnlinkedError(500, 'not linked'), false);
});

test('isAlreadyUnlinkedError: case-insensitive', () => {
  assert.equal(isAlreadyUnlinkedError(400, 'NOT LINKED'), true);
});
