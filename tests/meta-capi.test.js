// tests/meta-capi.test.js
//
// Regressietest voor de PURE helpers in api/_lib/meta-capi.js. Geen DB,
// geen HTTP naar Meta. HTTP-post-flow zelf test ik hier niet (vereist een
// Meta-mock met echte tokens). Focus:
//   - hashSha256 (known-vectoren)
//   - normalizeEmail / hashedEmail
//   - normalizePhoneE164 / hashedPhone (NL varianten)
//   - extractFbAttribution (attributionSource first, lastAttributionSource fallback)
//   - buildUserData: alleen velden met waarde
//   - hasUsableMatchKey: em/ph/fbc = ok; alleen ip/ua = niet ok
//   - buildCapiEvent: EUR + value + event_id deterministic + action_source
//   - computeAppsecretProof (known-vector)
//   - getMetaCapiConfigStatus: leeg = not_configured

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSha256,
  normalizeEmail,
  normalizePhoneE164,
  hashedEmail,
  hashedPhone,
  extractFbAttribution,
  buildUserData,
  hasUsableMatchKey,
  buildCapiEvent,
  computeAppsecretProof,
  getMetaCapiConfigStatus,
  isWithinCapiWindow,
  CAPI_MAX_AGE_MS,
  META_API_VERSION,
  DEFAULT_EVENT_NAME,
} from '../api/_lib/meta-capi.js';

// ─── SHA-256 known-vectors ────────────────────────────────────────────────

test('hashSha256: "hello" → bekende vector', () => {
  assert.equal(hashSha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('hashSha256: lege string → e3b0c44... (SHA-256 van "")', () => {
  assert.equal(hashSha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ─── normalizeEmail / hashedEmail ─────────────────────────────────────────

test('normalizeEmail: trim + lowercase', () => {
  assert.equal(normalizeEmail('  Test@Example.COM '), 'test@example.com');
});

test('normalizeEmail: null/lege → null', () => {
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail('   '), null);
});

test('hashedEmail: known-vector voor test@example.com', () => {
  // SHA-256 van 'test@example.com' (lowercase)
  assert.equal(hashedEmail('test@example.com'), '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
});

test('hashedEmail: hoofdletters + spaties geven zelfde hash', () => {
  const a = hashedEmail('  TEST@EXAMPLE.COM  ');
  const b = hashedEmail('test@example.com');
  assert.equal(a, b);
});

// ─── normalizePhoneE164 / hashedPhone (NL) ────────────────────────────────

test('normalizePhoneE164: NL 06-nummer → 316...', () => {
  assert.equal(normalizePhoneE164('06 12345678'), '31612345678');
  assert.equal(normalizePhoneE164('0612345678'),   '31612345678');
});

test('normalizePhoneE164: al met +31 / 0031 → 316...', () => {
  assert.equal(normalizePhoneE164('+31612345678'),  '31612345678');
  assert.equal(normalizePhoneE164('0031612345678'), '31612345678');
});

test('normalizePhoneE164: al pure digits met landcode → laat staan', () => {
  assert.equal(normalizePhoneE164('31612345678'), '31612345678');
});

test('normalizePhoneE164: te kort → null', () => {
  assert.equal(normalizePhoneE164('123'), null);
  assert.equal(normalizePhoneE164(''), null);
  assert.equal(normalizePhoneE164(null), null);
});

test('hashedPhone: NL-varianten geven allemaal ZELFDE hash', () => {
  const a = hashedPhone('06 12 34 56 78');
  const b = hashedPhone('+31 6 12345678');
  const c = hashedPhone('0031612345678');
  assert.equal(a, b);
  assert.equal(b, c);
});

// ─── extractFbAttribution ─────────────────────────────────────────────────

test('extractFbAttribution: fbc/fbp uit attributionSource', () => {
  const raw = {
    attributionSource: { fbc: 'fb.1.123.abc', fbp: 'fb.1.456.def' },
    lastAttributionSource: null,
  };
  const r = extractFbAttribution(raw);
  assert.equal(r.fbc, 'fb.1.123.abc');
  assert.equal(r.fbp, 'fb.1.456.def');
});

test('extractFbAttribution: lastAttributionSource fallback als first ontbreekt', () => {
  const raw = {
    attributionSource: {},
    lastAttributionSource: { fbc: 'fb.1.999.xyz' },
  };
  const r = extractFbAttribution(raw);
  assert.equal(r.fbc, 'fb.1.999.xyz');
  assert.equal(r.fbp, undefined);
});

test('extractFbAttribution: ip/ua uit meerdere key-varianten', () => {
  const raw = {
    attributionSource: { ipAddress: '1.2.3.4', userAgent: 'Mozilla/5.0' },
    lastAttributionSource: null,
  };
  const r = extractFbAttribution(raw);
  assert.equal(r.client_ip_address, '1.2.3.4');
  assert.equal(r.client_user_agent, 'Mozilla/5.0');
});

test('extractFbAttribution: null/undefined → {}', () => {
  assert.deepEqual(extractFbAttribution(null), {});
  assert.deepEqual(extractFbAttribution(undefined), {});
});

// ─── buildUserData ────────────────────────────────────────────────────────

test('buildUserData: alleen email → { em:[hash] }', () => {
  const ud = buildUserData({ customer: { email: 'test@example.com' }, attrRaw: null });
  assert.ok(Array.isArray(ud.em));
  assert.equal(ud.em.length, 1);
  assert.equal(ud.em[0], hashedEmail('test@example.com'));
  assert.equal(ud.ph, undefined);
  assert.equal(ud.fbc, undefined);
});

test('buildUserData: email + phone + fbc → alle 3 velden', () => {
  const ud = buildUserData({
    customer: { email: 'test@example.com', phone: '0612345678' },
    attrRaw: { attributionSource: { fbc: 'fb.1.x' } },
  });
  assert.ok(ud.em);
  assert.ok(ud.ph);
  assert.equal(ud.fbc, 'fb.1.x');
});

test('buildUserData: geen data → leeg object', () => {
  const ud = buildUserData({ customer: null, attrRaw: null });
  assert.deepEqual(ud, {});
});

test('buildUserData: lege email/phone → geen em/ph keys', () => {
  const ud = buildUserData({ customer: { email: '  ', phone: '' }, attrRaw: null });
  assert.equal(ud.em, undefined);
  assert.equal(ud.ph, undefined);
});

// ─── hasUsableMatchKey ────────────────────────────────────────────────────

test('hasUsableMatchKey: em → true', () => {
  assert.equal(hasUsableMatchKey({ em: ['x'] }), true);
});
test('hasUsableMatchKey: ph → true', () => {
  assert.equal(hasUsableMatchKey({ ph: ['x'] }), true);
});
test('hasUsableMatchKey: fbc → true', () => {
  assert.equal(hasUsableMatchKey({ fbc: 'x' }), true);
});
test('hasUsableMatchKey: alleen ip/ua → false (Meta vereist meer)', () => {
  assert.equal(hasUsableMatchKey({ client_ip_address: '1.1.1.1', client_user_agent: 'x' }), false);
});
test('hasUsableMatchKey: leeg → false', () => {
  assert.equal(hasUsableMatchKey({}), false);
  assert.equal(hasUsableMatchKey(null), false);
});

// ─── buildCapiEvent ───────────────────────────────────────────────────────

test('buildCapiEvent: event_name = CRMCustomer, currency = EUR, event_id deterministic', () => {
  const dealId = '11111111-2222-3333-4444-555555555555';
  const { event, matchKeys } = buildCapiEvent({
    dealId,
    dealCreatedAt: '2026-07-19T10:00:00Z',
    value: 1234.56,
    customer: { email: 'test@example.com', phone: '0612345678' },
    attrRaw: { attributionSource: { fbc: 'fb.1.x', fbp: 'fb.1.y' } },
  });
  assert.equal(event.event_name, DEFAULT_EVENT_NAME);
  assert.equal(event.event_name, 'CRMCustomer');
  assert.equal(event.custom_data.currency, 'EUR');
  assert.equal(event.custom_data.value, 1234.56);
  assert.equal(event.event_id, 'crm_customer_' + dealId);
  assert.equal(event.action_source, 'system_generated');
  // event_time = unix-sec van 2026-07-19T10:00:00Z
  assert.equal(event.event_time, Math.floor(new Date('2026-07-19T10:00:00Z').getTime() / 1000));
  // user_data-shape
  assert.ok(Array.isArray(event.user_data.em));
  assert.ok(Array.isArray(event.user_data.ph));
  assert.equal(event.user_data.fbc, 'fb.1.x');
  // matchKeys
  assert.equal(matchKeys.em, true);
  assert.equal(matchKeys.ph, true);
  assert.equal(matchKeys.fbc, true);
  assert.equal(matchKeys.client_ip, false);
});

test('buildCapiEvent: value null → 0, currency default EUR', () => {
  const { event } = buildCapiEvent({
    dealId: 'abc', dealCreatedAt: Date.now(),
    value: null, customer: { email: 'a@b.c' }, attrRaw: null,
  });
  assert.equal(event.custom_data.value, 0);
  assert.equal(event.custom_data.currency, 'EUR');
});

// ─── computeAppsecretProof (known-vector) ────────────────────────────────

test('computeAppsecretProof: known HMAC-SHA256 vector', () => {
  // HMAC-SHA256(key='key', msg='The quick brown fox jumps over the lazy dog') = ...
  // We gebruiken de docs-canonical vector uit RFC 4231-adjacent:
  const proof = computeAppsecretProof('The quick brown fox jumps over the lazy dog', 'key');
  assert.equal(proof, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
});

// ─── getMetaCapiConfigStatus ─────────────────────────────────────────────

test('getMetaCapiConfigStatus: geen env-vars → configured:false + missing', () => {
  // De setup.js zet SUPABASE-vars, maar géén META_CAPI_*. Sla ze op voor
  // restore, wis, check, restore.
  const orig = {
    id: process.env.META_CAPI_DATASET_ID,
    tok: process.env.META_CAPI_ACCESS_TOKEN,
  };
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  try {
    const s = getMetaCapiConfigStatus();
    assert.equal(s.configured, false);
    assert.ok(s.missing.includes('META_CAPI_DATASET_ID'));
    assert.ok(s.missing.includes('META_CAPI_ACCESS_TOKEN'));
  } finally {
    if (orig.id  != null) process.env.META_CAPI_DATASET_ID   = orig.id;
    if (orig.tok != null) process.env.META_CAPI_ACCESS_TOKEN = orig.tok;
  }
});

test('getMetaCapiConfigStatus: alle env gezet → configured:true; test_mode volgt env', () => {
  process.env.META_CAPI_DATASET_ID   = '1234';
  process.env.META_CAPI_ACCESS_TOKEN = 'tok';
  process.env.META_CAPI_TEST_EVENT_CODE = 'TEST12345';
  try {
    const s = getMetaCapiConfigStatus();
    assert.equal(s.configured, true);
    assert.equal(s.test_mode,  true);
  } finally {
    delete process.env.META_CAPI_DATASET_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_CAPI_TEST_EVENT_CODE;
  }
});

test('META_API_VERSION = v20.0', () => {
  assert.equal(META_API_VERSION, 'v20.0');
});

// ─── isWithinCapiWindow (7d-venster met 6.5d marge) ──────────────────────

test('CAPI_MAX_AGE_MS = 6.5 dagen (marge onder Meta 7d)', () => {
  assert.equal(CAPI_MAX_AGE_MS, 6.5 * 24 * 3600 * 1000);
});

test('isWithinCapiWindow: nu → true', () => {
  const now = 1_800_000_000_000; // vaste referentie
  assert.equal(isWithinCapiWindow(new Date(now).toISOString(), now), true);
});

test('isWithinCapiWindow: 3 dagen oud → true (binnen venster)', () => {
  const now  = 1_800_000_000_000;
  const then = now - 3 * 24 * 3600 * 1000;
  assert.equal(isWithinCapiWindow(new Date(then).toISOString(), now), true);
});

test('isWithinCapiWindow: 7 dagen oud → false (buiten 6.5d marge)', () => {
  const now  = 1_800_000_000_000;
  const then = now - 7 * 24 * 3600 * 1000;
  assert.equal(isWithinCapiWindow(new Date(then).toISOString(), now), false);
});

test('isWithinCapiWindow: precies op de grens (6.5d) → true (inclusive)', () => {
  const now  = 1_800_000_000_000;
  const then = now - CAPI_MAX_AGE_MS;
  assert.equal(isWithinCapiWindow(new Date(then).toISOString(), now), true);
});

test('isWithinCapiWindow: net over de grens (6.5d + 1ms) → false', () => {
  const now  = 1_800_000_000_000;
  const then = now - CAPI_MAX_AGE_MS - 1;
  assert.equal(isWithinCapiWindow(new Date(then).toISOString(), now), false);
});

test('isWithinCapiWindow: ongeldige datum → false (defensief)', () => {
  assert.equal(isWithinCapiWindow(null, Date.now()), false);
  assert.equal(isWithinCapiWindow('not-a-date', Date.now()), false);
  assert.equal(isWithinCapiWindow(undefined, Date.now()), false);
});
