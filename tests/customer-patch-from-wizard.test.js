// tests/customer-patch-from-wizard.test.js
//
// Unit-tests voor api/_lib/customer-patch-from-wizard.js — de helper die
// wizard-edits toepast op een bestaande klant vóór de TL-push. Mockt
// supabaseAdmin met een minimale in-memory recorder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCustomerPatchFromWizard } from '../api/_lib/customer-patch-from-wizard.js';

// Minimale supabase-mock: registreert de UPDATE-payload en customerId.
function makeMockAdmin() {
  const state = { updates: [], shouldFail: false };
  const admin = {
    from() {
      return {
        update(patch) {
          state.lastPatch = patch;
          return {
            async eq(_col, val) {
              state.updates.push({ id: val, patch });
              return state.shouldFail
                ? { error: new Error('mock db fail') }
                : { error: null };
            },
          };
        },
      };
    },
  };
  return { admin, state };
}

test('past vat_number toe uit wizard-formulier', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', {
    vat_number: 'NL864823770B01',
  });
  assert.equal(r.applied, true);
  assert.deepEqual(r.fields, ['vat_number']);
  assert.equal(state.updates[0].id, 'cust-1');
  assert.equal(state.updates[0].patch.vat_number, 'NL864823770B01');
});

test('past meerdere velden tegelijk toe', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', {
    company_name: 'Nieuw BV',
    vat_number: 'NL864823770B01',
    kvk_number: '12345678',
    email: 'info@nieuw.nl',
    address_street: 'Kerkstraat',
    address_number: '42',
    address_postal: '1234AB',
    address_city: 'Amsterdam',
    address_country: 'NL',
  });
  assert.equal(r.applied, true);
  assert.equal(r.fields.length, 9);
  assert.equal(state.updates[0].patch.company_name, 'Nieuw BV');
  assert.equal(state.updates[0].patch.address_country, 'NL');
});

test('skipt lege string (voorkomt overschrijven met leeg)', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', {
    vat_number: 'NL864823770B01',
    company_name: '',
    kvk_number: '   ', // whitespace-only óók skip
    email: null,
  });
  assert.equal(r.applied, true);
  assert.deepEqual(r.fields, ['vat_number']);
  assert.equal(state.updates[0].patch.company_name, undefined);
  assert.equal(state.updates[0].patch.kvk_number, undefined);
  assert.equal(state.updates[0].patch.email, undefined);
});

test('skipt undefined-velden (partial payload)', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', {
    vat_number: 'NL864823770B01',
    // andere velden ontbreken volledig
  });
  assert.equal(r.applied, true);
  assert.deepEqual(r.fields, ['vat_number']);
});

test('trimt whitespace op strings', async () => {
  const { admin, state } = makeMockAdmin();
  await applyCustomerPatchFromWizard(admin, 'cust-1', {
    vat_number: '  NL864823770B01  ',
  });
  assert.equal(state.updates[0].patch.vat_number, 'NL864823770B01');
});

test('is_company als true → boolean true', async () => {
  const { admin, state } = makeMockAdmin();
  await applyCustomerPatchFromWizard(admin, 'cust-1', { is_company: true });
  assert.equal(state.updates[0].patch.is_company, true);
});

test('is_company als "true"-string → boolean true', async () => {
  const { admin, state } = makeMockAdmin();
  await applyCustomerPatchFromWizard(admin, 'cust-1', { is_company: 'true' });
  assert.equal(state.updates[0].patch.is_company, true);
});

test('is_company als false → boolean false', async () => {
  const { admin, state } = makeMockAdmin();
  await applyCustomerPatchFromWizard(admin, 'cust-1', { is_company: false });
  assert.equal(state.updates[0].patch.is_company, false);
});

test('is_company als "yes" / random → geen mutatie', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', {
    is_company: 'yes',
    vat_number: 'NL864823770B01',
  });
  assert.equal(r.applied, true);
  assert.deepEqual(r.fields, ['vat_number']);
  assert.equal(state.updates[0].patch.is_company, undefined);
});

test('address_country strikt: alleen NL/BE toegestaan', async () => {
  const { admin, state } = makeMockAdmin();
  await applyCustomerPatchFromWizard(admin, 'cust-1', { address_country: 'DE' });
  // DE mag niet — geen update
  assert.equal(state.updates.length, 0);
});

test('address_country NL → toegestaan', async () => {
  const { admin, state } = makeMockAdmin();
  await applyCustomerPatchFromWizard(admin, 'cust-1', { address_country: 'BE' });
  assert.equal(state.updates[0].patch.address_country, 'BE');
});

test('leeg customer_data → geen update', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', {});
  assert.equal(r.applied, false);
  assert.deepEqual(r.fields, []);
  assert.equal(state.updates.length, 0);
});

test('null customerId → geen update', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, null, { vat_number: 'X' });
  assert.equal(r.applied, false);
  assert.equal(state.updates.length, 0);
});

test('null customer_data → geen update', async () => {
  const { admin, state } = makeMockAdmin();
  const r = await applyCustomerPatchFromWizard(admin, 'cust-1', null);
  assert.equal(r.applied, false);
  assert.equal(state.updates.length, 0);
});

test('DB-error throwt door', async () => {
  const { admin, state } = makeMockAdmin();
  state.shouldFail = true;
  await assert.rejects(
    async () => applyCustomerPatchFromWizard(admin, 'cust-1', { vat_number: 'X' }),
    /mock db fail/,
  );
});
