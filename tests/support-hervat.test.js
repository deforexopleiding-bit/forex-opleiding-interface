// tests/support-hervat.test.js
//
// De weg terug in een gesprek vanaf een ander apparaat. Wat hier getest wordt
// is de vorm van de link en de strengheid van het kenmerk: dat laatste is de
// enige invoer die een buitenstaander zelf kiest, dus het moet vaststaan
// vóórdat er een query mee gedaan wordt.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  siteUrl, hervatLink, kenmerkUitBody, maakCode, gelijkeHash,
} from '../api/_lib/support-hervat.js';

const OORSPRONKELIJK = process.env.SUPPORT_SITE_URL;
afterEach(() => {
  if (OORSPRONKELIJK === undefined) delete process.env.SUPPORT_SITE_URL;
  else process.env.SUPPORT_SITE_URL = OORSPRONKELIJK;
});

describe('siteUrl', () => {
  test('valt terug op de productiesite', () => {
    delete process.env.SUPPORT_SITE_URL;
    assert.equal(siteUrl(), 'https://www.deforexopleiding.nl');
  });

  test('neemt een geldige override over, zonder slash op het eind', () => {
    process.env.SUPPORT_SITE_URL = 'https://staging.deforexopleiding.nl/';
    assert.equal(siteUrl(), 'https://staging.deforexopleiding.nl');
  });

  test('negeert onzin en http zonder s', () => {
    // Een verkeerd gezette env-var mag geen link naar een vreemde host in
    // onze mails zetten, en al helemaal geen onversleutelde.
    for (const slecht of ['http://kwaadaardig.nl', 'javascript:alert(1)', 'zomaar wat', '']) {
      process.env.SUPPORT_SITE_URL = slecht;
      assert.equal(siteUrl(), 'https://www.deforexopleiding.nl', 'faalt op ' + JSON.stringify(slecht));
    }
  });
});

describe('hervatLink', () => {
  test('bouwt een link met alleen het kenmerk erin', () => {
    delete process.env.SUPPORT_SITE_URL;
    const link = hervatLink('SUP-Z3HB8F');
    assert.equal(link, 'https://www.deforexopleiding.nl/?dfo-support=SUP-Z3HB8F');
    // De belofte uit de kop van support-hervat.js: geen sleutel in de URL.
    assert.ok(!/token/i.test(link));
    assert.ok(!link.includes('@'));
  });

  test('normaliseert naar hoofdletters', () => {
    delete process.env.SUPPORT_SITE_URL;
    assert.equal(hervatLink('sup-z3hb8f'), 'https://www.deforexopleiding.nl/?dfo-support=SUP-Z3HB8F');
  });

  test('geen link bij iets dat geen kenmerk is', () => {
    for (const slecht of [null, '', 'SUP-Z3HB0F', 'SUP-ABC', 'SUP-Z3HB8FF', '../etc', 'SUP-Z3HB8F&x=1']) {
      assert.equal(hervatLink(slecht), null, 'faalt op ' + JSON.stringify(slecht));
    }
  });
});

describe('kenmerkUitBody', () => {
  test('accepteert een geldig kenmerk en maakt er hoofdletters van', () => {
    assert.equal(kenmerkUitBody({ kenmerk: ' sup-z3hb8f ' }), 'SUP-Z3HB8F');
  });

  test('weigert alles wat niet exact de vorm heeft', () => {
    // 0/O/1/I/L zitten niet in het alfabet van maakKenmerk, en een kenmerk
    // met iets erachter is precies hoe je een query probeert om te buigen.
    const slecht = [
      undefined, null, {}, { kenmerk: '' }, { kenmerk: 'SUP-' },
      { kenmerk: 'SUP-Z3HB0F' }, { kenmerk: 'SUP-Z3HBIF' }, { kenmerk: 'SUP-Z3HBLF' },
      { kenmerk: 'SUP-Z3HB8F%' }, { kenmerk: 'SUP-Z3HB8F OR 1=1' },
      { kenmerk: 'XXX-Z3HB8F' }, { kenmerk: 'SUP-Z3HB8FZ' },
    ];
    for (const b of slecht) assert.equal(kenmerkUitBody(b), null, 'faalt op ' + JSON.stringify(b));
  });
});

describe('maakCode', () => {
  test('altijd zes cijfers, ook als het getal klein is', () => {
    for (let i = 0; i < 300; i++) {
      const c = maakCode();
      assert.match(c, /^\d{6}$/);
    }
  });

  test('geen constante', () => {
    const set = new Set();
    for (let i = 0; i < 50; i++) set.add(maakCode());
    assert.ok(set.size > 1);
  });
});

describe('gelijkeHash', () => {
  test('gelijk is gelijk', () => {
    assert.equal(gelijkeHash('a'.repeat(64), 'a'.repeat(64)), true);
  });

  test('verschil is verschil, ook bij afwijkende lengte', () => {
    assert.equal(gelijkeHash('a'.repeat(64), 'b'.repeat(64)), false);
    assert.equal(gelijkeHash('a'.repeat(64), 'a'.repeat(63)), false);
    assert.equal(gelijkeHash(null, 'a'.repeat(64)), false);
    assert.equal(gelijkeHash(undefined, undefined), false);
  });
});
