// tests/lead-attribution.test.js
//
// Regressietest voor de pure normalizeGhlAttribution-functie in
// api/_lib/lead-attribution.js. De DB-upsert (upsertLeadAttribution) test ik
// hier NIET — die vereist een Supabase-mock. Focus op de veld-mapping en
// de shape-detectie (contact vs losse attributionSource).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGhlAttribution } from '../api/_lib/lead-attribution.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shape A: volledig GHL-contact met .attributionSource + .lastAttributionSource
// ─────────────────────────────────────────────────────────────────────────────

test('normalize: volledig contact met firstTouch attributie', () => {
  const contact = {
    id: 'abc',
    email: 'jan@example.com',
    attributionSource: {
      utmSource:   'facebook',
      utmMedium:   'paid',
      utmCampaign: 'zomer-2026',
      utmContent:  'ad-video-1',
      utmTerm:     null,
      fbclid:      'fb_click_123',
      sessionSource: 'Direct',
      medium:      'social',
      referrer:    'https://facebook.com/x',
      url:         'https://deforexopleiding.nl/lp/masterclass?utm=1',
    },
    lastAttributionSource: null,
  };
  const n = normalizeGhlAttribution(contact);
  assert.equal(n.utm_source,     'facebook');
  assert.equal(n.utm_medium,     'paid');
  assert.equal(n.utm_campaign,   'zomer-2026');
  assert.equal(n.utm_content,    'ad-video-1');
  assert.equal(n.utm_term,       null);
  assert.equal(n.fbclid,         'fb_click_123');
  assert.equal(n.session_source, 'Direct');
  assert.equal(n.medium,         'social');
  assert.equal(n.referrer,       'https://facebook.com/x');
  assert.equal(n.landing_url,    'https://deforexopleiding.nl/lp/masterclass?utm=1');
  assert.deepEqual(n.raw.attributionSource, contact.attributionSource);
  assert.equal(n.raw.lastAttributionSource, null);
});

test('normalize: firstTouch mist utm_source → fallback op lastTouch', () => {
  const contact = {
    attributionSource:     { utmMedium: 'paid' },                        // geen utm_source
    lastAttributionSource: { utmSource: 'google', utmMedium: 'cpc' },
  };
  const n = normalizeGhlAttribution(contact);
  // utm_source ontbreekt in firstTouch → moet uit lastTouch komen.
  assert.equal(n.utm_source, 'google');
  // utm_medium zit al in firstTouch → firstTouch wint.
  assert.equal(n.utm_medium, 'paid');
});

test('normalize: contact zonder attribution → alle velden null', () => {
  const contact = { id: 'x', email: 'a@b.c' };
  const n = normalizeGhlAttribution(contact);
  // Geen attributionSource / lastAttributionSource → contact wordt behandeld
  // als LOSSE attributionSource-shape. Dit contact heeft geen utm_*-velden dus
  // alles null. Raw bevat het contact-object als firstTouch.
  assert.equal(n.utm_source, null);
  assert.equal(n.utm_campaign, null);
  assert.equal(n.raw.attributionSource, contact);
  assert.equal(n.raw.lastAttributionSource, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape B: losse attributionSource (geen contact-wrapper)
// ─────────────────────────────────────────────────────────────────────────────

test('normalize: losse attributionSource-object direct', () => {
  const attr = {
    utmSource:   'google',
    utmCampaign: 'brand',
    utmContent:  'headline-a',
    fbclid:      null,
  };
  const n = normalizeGhlAttribution(attr);
  assert.equal(n.utm_source,   'google');
  assert.equal(n.utm_campaign, 'brand');
  assert.equal(n.utm_content,  'headline-a');
  assert.equal(n.fbclid,       null);
  // Losse shape wordt als firstTouch behandeld.
  assert.equal(n.raw.attributionSource, attr);
  assert.equal(n.raw.lastAttributionSource, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Randgevallen
// ─────────────────────────────────────────────────────────────────────────────

test('normalize: null/undefined → alle velden null + raw null', () => {
  const n1 = normalizeGhlAttribution(null);
  const n2 = normalizeGhlAttribution(undefined);
  for (const n of [n1, n2]) {
    assert.equal(n.utm_source, null);
    assert.equal(n.utm_medium, null);
    assert.equal(n.utm_campaign, null);
    assert.equal(n.utm_content, null);
    assert.equal(n.utm_term, null);
    assert.equal(n.fbclid, null);
    assert.equal(n.session_source, null);
    assert.equal(n.medium, null);
    assert.equal(n.referrer, null);
    assert.equal(n.landing_url, null);
    assert.equal(n.raw, null);
  }
});

test('normalize: lege string wordt behandeld als null', () => {
  const attr = { utmSource: '', utmCampaign: '   ', utmContent: 'echte-content' };
  const n = normalizeGhlAttribution(attr);
  assert.equal(n.utm_source,   null);
  assert.equal(n.utm_campaign, null);
  assert.equal(n.utm_content,  'echte-content');
});

test('normalize: snake_case alias-velden werken ook (utm_source vs utmSource)', () => {
  const attr = {
    utm_source:   'linkedin',   // snake_case alternatief
    utm_medium:   'organic',
    utmCampaign:  'launch',     // camelCase
  };
  const n = normalizeGhlAttribution(attr);
  assert.equal(n.utm_source,   'linkedin');
  assert.equal(n.utm_medium,   'organic');
  assert.equal(n.utm_campaign, 'launch');
});

test('normalize: landing_url pakt "url" (GHL name) én "landingUrl"', () => {
  const attr1 = { url: 'https://a.example' };
  assert.equal(normalizeGhlAttribution(attr1).landing_url, 'https://a.example');
  const attr2 = { landingUrl: 'https://b.example' };
  assert.equal(normalizeGhlAttribution(attr2).landing_url, 'https://b.example');
});

test('normalize: trims values', () => {
  const attr = { utmSource: '  facebook  ' };
  assert.equal(normalizeGhlAttribution(attr).utm_source, 'facebook');
});
