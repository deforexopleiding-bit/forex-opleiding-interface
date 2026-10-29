// tests/meta-lead-settings.test.js
//
// Dekt de Meta-koppeling-instellingen: bron->funnel-mapping, de per-funnel gate
// (default AAN), de effectieve test-event-code (instelling wint, env-fallback) en
// het lezen met defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  funnelVanBron, funnelAan, effectieveTestCode, leesMetaLeadSettings,
} from '../api/_lib/meta-lead-settings.js';

test('funnelVanBron: mapping', () => {
  assert.equal(funnelVanBron('opstartsessie'), 'opstartsessie');
  assert.equal(funnelVanBron('direct'), 'opstartsessie');
  assert.equal(funnelVanBron('webinar-v1'), 'webinar');
  assert.equal(funnelVanBron('webinar-v2'), 'webinar');
  assert.equal(funnelVanBron('lab'), 'lab');
  assert.equal(funnelVanBron('the-lab'), 'lab');
});

test('funnelAan: default AAN, expliciet UIT telt', () => {
  assert.equal(funnelAan({ funnels: {} }, 'opstartsessie'), true);          // default aan
  assert.equal(funnelAan({ funnels: { webinar: false } }, 'webinar-v1'), false);
  assert.equal(funnelAan({ funnels: { lab: false } }, 'lab'), false);
  assert.equal(funnelAan(undefined, 'opstartsessie'), true);
});

test('effectieveTestCode: instelling wint, env als fallback', () => {
  // geconfigureerd + testmode aan -> de code
  assert.equal(effectieveTestCode({ geconfigureerd: true, testmode: true, test_event_code: 'TEST123' }), 'TEST123');
  // geconfigureerd + testmode uit -> live (null), ongeacht env
  process.env.META_CAPI_TEST_EVENT_CODE = 'ENVCODE';
  assert.equal(effectieveTestCode({ geconfigureerd: true, testmode: false, test_event_code: 'TEST123' }), null);
  // niet geconfigureerd -> env-fallback
  assert.equal(effectieveTestCode({ geconfigureerd: false }), 'ENVCODE');
  delete process.env.META_CAPI_TEST_EVENT_CODE;
  assert.equal(effectieveTestCode({ geconfigureerd: false }), null);
});

test('leesMetaLeadSettings: parst waarde, defaults bij fout', async () => {
  const sbOk = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: { funnels: { lab: false }, testmode: true, test_event_code: 'X' } }, error: null }) }) }) }) };
  const s = await leesMetaLeadSettings(sbOk);
  assert.equal(s.funnels.opstartsessie, true);   // ontbrekend -> aan
  assert.equal(s.funnels.lab, false);
  assert.equal(s.testmode, true);
  assert.equal(s.geconfigureerd, true);

  const sbKapot = { from: () => { throw new Error('boom'); } };
  const d = await leesMetaLeadSettings(sbKapot);
  assert.equal(d.funnels.opstartsessie, true);
  assert.equal(d.geconfigureerd, false);
});
