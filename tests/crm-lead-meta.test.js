// tests/crm-lead-meta.test.js
//
// Lichte garanties voor de Meta-Lead-helper van de funnel-endpoints:
//   - gooit nooit (fail-soft): een funnel-endpoint mag er nooit op stuklopen;
//   - buiten productie gaat er niets naar Meta (de poort beslist dat);
//   - bewaarFbCookies doet niets zonder lead of zonder fbp/fbc.
// De echte verzending + dedup verifieer je in Meta Test Events (zie PR).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meldCrmLead, verwerkLeadMeta, bewaarFbCookies } from '../api/_lib/crm-lead-meta.js';

// Zorg dat we niet per ongeluk in de "productie"-tak belanden.
delete process.env.VERCEL_ENV;

test('meldCrmLead: buiten productie geen verzending, gooit niet', async () => {
  const sb = {}; // mag niet aangeroepen worden in deze tak
  const r = await meldCrmLead(sb, { leadId: 'lead-1', email: 'klant@voorbeeld.nl', toestemming: true });
  assert.equal(r.verstuurd, false);
  assert.equal(r.reden, 'geen_productie');
});

test('meldCrmLead: gooit nooit, ook bij een kapotte client', async () => {
  const kapot = { from() { throw new Error('boom'); } };
  // toestemming weglaten -> valt terug op leadHeeftToestemming (gebruikt sb) ->
  // die is fail-soft en geeft false -> poort geeft geen_toestemming.
  const r = await meldCrmLead(kapot, { leadId: 'lead-2', email: 'x@voorbeeld.nl' });
  assert.equal(r.verstuurd, false);
  assert.ok(typeof r.reden === 'string');
});

test('verwerkLeadMeta: zonder leadId meteen klaar', async () => {
  const r = await verwerkLeadMeta({}, { email: 'x@voorbeeld.nl' });
  assert.deepEqual(r, { verstuurd: false, reden: 'geen_lead' });
});

test('bewaarFbCookies: niets te doen zonder lead of zonder cookies', async () => {
  let aangeroepen = false;
  const sb = { from() { aangeroepen = true; return { select() { return { eq() { return { maybeSingle: async () => ({ data: null, error: null }) }; } }; } }; } };
  await bewaarFbCookies(sb, null, { fbp: 'x' });      // geen lead
  await bewaarFbCookies(sb, 'lead-3', {});             // geen cookies
  assert.equal(aangeroepen, false);
});
