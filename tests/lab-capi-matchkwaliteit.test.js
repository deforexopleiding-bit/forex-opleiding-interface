// tests/lab-capi-matchkwaliteit.test.js
//
// The Lab → Meta CAPI (2026-10-25): meer matchgegevens (ln, country), namen
// genormaliseerd zoals de website, token in de body, herhalen bij netwerk/5xx/429.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

mock.module('../api/supabase.js', { namedExports: { supabaseAdmin: { from() { throw new Error('geen db in deze test'); } } } });
const L = await import('../api/_lib/lab-meta.js');
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('labUserData: em, ph, fn, ln, country, external_id gehasht; ip/ua/fbc/fbp ongehasht', () => {
  const ud = L.labUserData({
    email: ' Jan@X.nl ', telefoonE164: '+31612345678', voornaam: ' José ', achternaam: "van der Berg-O'Neil",
    externalId: 'lead-1', fbc: 'fb.1.1.c', fbp: 'fb.1.1.p', ip: '1.2.3.4', userAgent: 'UA',
  });
  assert.deepEqual(ud.em, [h('jan@x.nl')]);
  assert.deepEqual(ud.ph, [h('31612345678')]);
  assert.deepEqual(ud.fn, [h('josé')]);
  assert.deepEqual(ud.ln, [h('vanderbergoneil')]);
  assert.deepEqual(ud.country, [h('nl')]);
  assert.deepEqual(ud.external_id, [h('lead-1')]);
  assert.equal(ud.fbc, 'fb.1.1.c');
  assert.equal(ud.client_ip_address, '1.2.3.4');
  assert.equal(L.landUitE164('+32470123456'), 'be');
  assert.equal(L.landUitE164('+49301234567'), null);
});

test('verstuurMetHerhaling: herhalen bij netwerk/5xx/429, niet bij 4xx', async () => {
  const antw = (status, json = {}) => ({ ok: status < 300, status, json: async () => json });
  const reeks = [() => { throw new Error('netwerk'); }, () => antw(500), () => antw(200, { events_received: 1 })];
  let i = 0; const gewacht = [];
  const r = await L.verstuurMetHerhaling('https://x', { a: 1 }, { fetchFn: async () => reeks[i++](), wacht: async (ms) => { gewacht.push(ms); } });
  assert.equal(r.ok, true);
  assert.equal(r.resp.pogingen, 3);
  assert.deepEqual(gewacht, [500, 1500]);
  let n = 0;
  const vier = await L.verstuurMetHerhaling('https://x', {}, { fetchFn: async () => { n += 1; return antw(400); }, wacht: async () => {} });
  assert.equal(vier.ok, false);
  assert.equal(n, 1);
});

test('bron: token en appsecret_proof in de body, niet in de URL; ln doorgegeven door de callers', () => {
  const s = lees('api/_lib/lab-meta.js');
  assert.match(s, /const body = \{ data: \[event\], access_token: cfg\.token \};/);
  assert.match(s, /body\.appsecret_proof = computeAppsecretProof/);
  assert.doesNotMatch(s, /searchParams\.set\('access_token'/);
  assert.match(s, /console\.error\('\[lab-meta\] event mislukt na herhaalpogingen'/);
  assert.match(lees('api/lab-aanmelding.js'), /voornaam: d\.voornaam, achternaam: d\.achternaam,/);
  assert.match(lees('api/lab-sessie.js'), /voornaam: lab\.voornaam, achternaam: lab\.achternaam, externalId: lead\.id/);
});
