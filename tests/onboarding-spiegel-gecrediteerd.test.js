// tests/onboarding-spiegel-gecrediteerd.test.js
//
// "EERSTE FACTUUR BETAALD" MAG GEEN CREDITNOTA ZIJN.
//
// 29 september 2026: de reserveringsfee van een student werd gecrediteerd.
// Teamleader verrekent de creditnota met de factuur, onze sync maakt daar
// status 'paid' + amount_paid = volledig bedrag van. De onboarding-spiegel
// keek alleen naar status 'paid' en zou de mentor in het LMS "eerste factuur
// betaald" laten zien bij een student die niets betaald had. Zelfde beeld bij
// vijf andere gespiegelde onboardings.
//
// Deze test draait de ECHTE spiegelOnboarding tegen een nep-CRM en vangt de
// rij af die naar het LMS zou gaan.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const OB = '11111111-1111-4111-8111-111111111111';
const KLANT = '22222222-2222-4222-8222-222222222222';
const tabellen = {};

function nepAdmin() {
  return {
    from(tabel) {
      let rows = [...(tabellen[tabel] || [])];
      const k = {
        select: () => k,
        eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return k; },
        in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return k; },
        is: () => k, order: () => k, limit: () => k, not: () => k, neq: () => k, gte: () => k, lte: () => k,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r, j) => Promise.resolve({ data: rows, error: null }).then(r, j),
      };
      return k;
    },
  };
}
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: nepAdmin(), createUserClient: () => nepAdmin() } });

const { spiegelOnboarding } = await import(url('api/_lib/onboarding-spiegel.js'));
const { telAlsBetaald, isVolledigGecrediteerd } = await import(url('api/_lib/factuur-betaald.js'));

function nepLms() {
  const geschreven = [];
  const lms = {
    geschreven,
    from() {
      const k = {
        select: () => k, eq: () => k, in: () => k, limit: () => k,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async (rij) => { geschreven.push(rij); return { error: null }; },
        delete: () => ({ eq: async () => ({ error: null }) }),
        then: (r, j) => Promise.resolve({ data: [], error: null }).then(r, j),
      };
      return k;
    },
  };
  return lms;
}

async function spiegelMet(facturen) {
  tabellen.onboardings = [{ id: OB, customer_id: KLANT, status: 'bezig', archived_at: null, start_date: null, current_step: 1,
    mentor_user_id: null, dfo_lms_student_id: '33333333-3333-4333-8333-333333333333', answers: {}, completed_at: null }];
  tabellen.invoices = facturen.map((f) => ({ customer_id: KLANT, ...f }));
  const lms = nepLms();
  const uit = await spiegelOnboarding(OB, { lmsClient: lms });
  assert.equal(uit.resultaat, 'geschreven', JSON.stringify(uit));
  return lms.geschreven[0];
}

test('volledig gecrediteerde factuur (status paid) telt NIET als eerste factuur betaald', async () => {
  const rij = await spiegelMet([{ id: 'f1', status: 'paid', amount_total: 99.99, amount_paid: 99.99, credited_amount: 99.99 }]);
  assert.equal(rij.eerste_factuur_betaald, false);
});

test('echt betaalde factuur telt wél, ook naast een gecrediteerde', async () => {
  const rij = await spiegelMet([
    { id: 'f1', status: 'paid', amount_total: 99.99, amount_paid: 99.99, credited_amount: 99.99 },
    { id: 'f2', status: 'paid', amount_total: 300, amount_paid: 300, credited_amount: 0 },
  ]);
  assert.equal(rij.eerste_factuur_betaald, true);
});

test('deels gecrediteerd en verder betaald telt als betaald; open factuur niet', async () => {
  assert.equal((await spiegelMet([{ id: 'f1', status: 'paid', amount_total: 300, amount_paid: 300, credited_amount: 100 }])).eerste_factuur_betaald, true);
  assert.equal((await spiegelMet([{ id: 'f1', status: 'open', amount_total: 300, amount_paid: 0, credited_amount: 0 }])).eerste_factuur_betaald, false);
});

test('helpers: volledig gecrediteerd is nooit betaald, wat de status ook zegt', () => {
  assert.equal(isVolledigGecrediteerd({ amount_total: 100, credited_amount: 100 }), true);
  assert.equal(isVolledigGecrediteerd({ amount_total: 100, credited_amount: 99.99 }), false);
  assert.equal(isVolledigGecrediteerd({ amount_total: 0, credited_amount: 0 }), false);
  assert.equal(telAlsBetaald({ status: 'paid', amount_total: 100, credited_amount: 100 }), false);
  assert.equal(telAlsBetaald({ status: 'paid', amount_total: 100, credited_amount: 0 }), true);
  assert.equal(telAlsBetaald({ status: 'credited', amount_total: 100, credited_amount: 100 }), false);
});
