// tests/advertentie-toestemming.test.js
//
// Meta-gate in het CRM (2026-10-25): niets naar Meta zonder toestemming voor
// advertentiecookies. Body → alleen expliciet true; lead → fail-closed;
// The Lab (Lead/Schedule/voortgang) en CRMCustomer volgen de regel.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const logs = [];
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from: (t) => ({ insert: async (rij) => { logs.push({ t, rij }); return { error: null }; } }) },
  },
});
const T = await import('../api/_lib/advertentie-toestemming.js');
const L = await import('../api/_lib/lab-meta.js');
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

function leadDb(rij, fout = null) {
  const q = { filters: [] };
  const k = {
    select: () => k, is: (c, v) => { q.filters.push(['is', c, v]); return k; },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return k; }, ilike: (c, v) => { q.filters.push(['ilike', c, v]); return k; },
    limit: () => k,
    then: (ok, nok) => Promise.resolve({ data: rij ? [rij] : [], error: fout }).then(ok, nok),
  };
  return { q, sb: { from: () => k } };
}

test('body: alleen cookie_toestemming === true telt', () => {
  assert.equal(T.toestemmingUitBody({ cookie_toestemming: true }), true);
  for (const b of [{ cookie_toestemming: 'true' }, { cookie_toestemming: false }, {}, null]) assert.equal(T.toestemmingUitBody(b), false);
});

test('lead: alleen advertentie_toestemming === true; NULL, geen lead, kolom weg of fout = nee', async () => {
  const ja = leadDb({ advertentie_toestemming: true });
  assert.equal(await T.leadHeeftToestemming(ja.sb, { leadId: 'L1' }), true);
  assert.deepEqual(ja.q.filters.find((f) => f[0] === 'eq'), ['eq', 'id', 'L1']);
  const viaMail = leadDb({ advertentie_toestemming: true });
  assert.equal(await T.leadHeeftToestemming(viaMail.sb, { email: ' Jan@X.nl ' }), true);
  assert.deepEqual(viaMail.q.filters.find((f) => f[0] === 'ilike'), ['ilike', 'email', 'jan@x.nl']);
  assert.equal(await T.leadHeeftToestemming(leadDb({ advertentie_toestemming: null }).sb, { leadId: 'L1' }), false);
  assert.equal(await T.leadHeeftToestemming(leadDb(null).sb, { leadId: 'L1' }), false);
  assert.equal(await T.leadHeeftToestemming(leadDb(null, { code: '42703', message: 'column does not exist' }).sb, { leadId: 'L1' }), false);
  assert.equal(await T.leadHeeftToestemming(leadDb({ advertentie_toestemming: true }).sb, {}), false, 'zonder id of e-mail');
});

test('stuurLabEvent: zonder toestemming → skipped (geen_toestemming), geen Meta-call', async () => {
  const oudFetch = globalThis.fetch;
  let gebeld = false;
  globalThis.fetch = async () => { gebeld = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    logs.length = 0;
    const r = await L.stuurLabEvent({ eventName: 'Schedule', eventId: 'lab_schedule_1', userData: { em: ['x'] } });
    assert.deepEqual(r, { ok: false, status: 'geen_toestemming' });
    assert.equal(gebeld, false);
    assert.equal(logs[0].t, 'lab_meta_events');
    assert.equal(logs[0].rij.status, 'skipped');
    assert.equal(logs[0].rij.skip_reason, 'geen_toestemming');
  } finally { globalThis.fetch = oudFetch; }
});

test('bedrading: poort, Lab-aanmelding/-sessie/-cron en CRMCustomer volgen de toestemming', () => {
  const poort = lees('api/_lib/meta-lead-poort.js');
  assert.match(poort, /toestemming = false \}\) \{\n\s+\/\/[^\n]*\n\s+if \(toestemming !== true\) return \{ eventId: null, reden: 'geen_toestemming' \};/);
  const aan = lees('api/lab-aanmelding.js');
  assert.match(aan, /const advToestemming = toestemmingUitBody\(req\.body\);/);
  assert.match(aan, /await legToestemmingVast\(supabaseAdmin, leadId, advToestemming, 'lab-aanmelding'\);/);
  assert.match(aan, /isTest: d\.is_test, toestemming: advToestemming \}\);/);
  assert.match(aan, /bronUrl: d\.landingspagina,\s+toestemming: advToestemming,/);
  assert.match(lees('api/lab-sessie.js'), /toestemming: await leadHeeftToestemming\(supabaseAdmin, \{ leadId: lead\.id, email: lab\.email \}\),/);
  const cron = lees('api/cron-lab-opvolging.js');
  assert.match(cron, /await leadHeeftToestemming\(supabaseAdmin, \{ leadId: p\.eerste\.lead_id, email: em \}\)/);
  assert.equal((cron.match(/userData: ud\(\), toestemming \}/g) || []).length, 2);
  const crm = lees('api/cron-meta-capi.js');
  assert.match(crm, /if \(!\(await leadHeeftToestemming\(supabaseAdmin, \{ email: customer\?\.email \}\)\)\) \{[\s\S]*?skip_reason: 'geen_toestemming',[\s\S]*?continue;/);
  assert.ok(crm.indexOf("skip_reason: 'geen_toestemming'") < crm.indexOf('postCapiEvents({'), 'check vóór de Meta-call');
});
