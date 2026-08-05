// tests/teamleader-contact.test.js
//
// Unit-tests voor api/_lib/teamleader-contact.js — de B2B-guard die
// ensureCompanyWithContact toegevoegd heeft. Test alleen de PURE guards
// (input-validatie); de TL-fetch mock zit niet in scope voor deze test-suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCustomerRef } from '../api/_lib/teamleader-contact.js';

test('toCustomerRef: string legacy → contact-type', () => {
  assert.deepEqual(toCustomerRef('abc-123'), { type: 'contact', id: 'abc-123' });
});

test('toCustomerRef: {type,id} passthru', () => {
  assert.deepEqual(toCustomerRef({ type: 'company', id: 'xyz' }), { type: 'company', id: 'xyz' });
  assert.deepEqual(toCustomerRef({ type: 'contact', id: 'abc' }), { type: 'contact', id: 'abc' });
});

test('toCustomerRef: {id} zonder type → default contact', () => {
  assert.deepEqual(toCustomerRef({ id: 'x' }), { type: 'contact', id: 'x' });
});

test('toCustomerRef: null/undefined → null', () => {
  assert.equal(toCustomerRef(null), null);
  assert.equal(toCustomerRef(undefined), null);
});

// De B2B-guard in ensureCompanyWithContact throwt met .code='TL_B2B_CONTACT_NAME_REQUIRED'
// als er geen persoonsnaam is. Om die te testen zonder TL-fetch mock, importeren we
// de functie en simuleren een klant zonder naam. Dit raakt de TL-fetch niet want de
// guard staat vóór de eerste tlFetch-call.
test('ensureCompanyWithContact: geen persoonsnaam → throwt CODE TL_B2B_CONTACT_NAME_REQUIRED', async () => {
  const mod = await import('../api/_lib/teamleader-contact.js');
  const customer = {
    id: 'test-uuid',
    is_company: true,
    company_name: 'Test BV',
    first_name: '',
    last_name: '',
    tl_company_id: null,
    tl_contact_id: null,
  };
  await assert.rejects(
    async () => { await mod.ensureCompanyWithContact(customer); },
    (err) => {
      assert.equal(err.code, 'TL_B2B_CONTACT_NAME_REQUIRED');
      assert.equal(err.customer_id, 'test-uuid');
      assert.match(err.message, /contactpersoon/i);
      return true;
    },
  );
});

test('ensureCompanyWithContact: alleen first_name → guard laat door (unit-scope)', async () => {
  // We kunnen niet de hele functie draaien zonder TL-fetch mock; we bevestigen
  // hier alleen dat de guard NIET throwt bij 1 naam. De rest (tlFetch) faalt
  // met een netwerk-fout omdat we geen token hebben — dat is verwacht en niet
  // de assert. We vangen die en checken alleen dat 't NIET onze code-throw is.
  const mod = await import('../api/_lib/teamleader-contact.js');
  const customer = {
    id: 'test-uuid-2',
    is_company: true,
    company_name: 'Test BV',
    first_name: 'Alex',
    last_name: '',
  };
  try {
    await mod.ensureCompanyWithContact(customer);
  } catch (err) {
    // Als de code onze naam-guard raakte, zou err.code TL_B2B_CONTACT_NAME_REQUIRED zijn.
    // Andere errors (network, token missing) zijn OK voor deze test.
    assert.notEqual(err.code, 'TL_B2B_CONTACT_NAME_REQUIRED', 'Naam-guard mag niet triggeren bij aanwezige first_name');
  }
});

test('ensureCompanyWithContact: alleen last_name → guard laat door', async () => {
  const mod = await import('../api/_lib/teamleader-contact.js');
  const customer = {
    id: 'test-uuid-3',
    is_company: true,
    company_name: 'Test BV',
    first_name: '',
    last_name: 'Janssen',
  };
  try {
    await mod.ensureCompanyWithContact(customer);
  } catch (err) {
    assert.notEqual(err.code, 'TL_B2B_CONTACT_NAME_REQUIRED', 'Naam-guard mag niet triggeren bij aanwezige last_name');
  }
});

test('ensureCompanyWithContact: whitespace-only namen → guard triggert', async () => {
  const mod = await import('../api/_lib/teamleader-contact.js');
  const customer = {
    id: 'test-uuid-4',
    is_company: true,
    company_name: 'Test BV',
    first_name: '   ',
    last_name: '\t\n',
  };
  await assert.rejects(
    async () => { await mod.ensureCompanyWithContact(customer); },
    (err) => err.code === 'TL_B2B_CONTACT_NAME_REQUIRED',
  );
});
