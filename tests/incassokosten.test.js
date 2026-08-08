// tests/incassokosten.test.js
//
// Unit-tests voor berekenIncassokosten (wettelijke BIK-staffel) + de twee nieuwe
// brief-variabelen klant.incassokosten en klant.totaal_na_termijn via de resolver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berekenIncassokosten, berekenTotaalResterend, resolveVariableValue } from '../api/_lib/template-variables.js';

// ── BIK-staffel ──────────────────────────────────────────────────────────────

test('minimum: klein bedrag → EUR 40,00 (15% van 200 = 30, opgehoogd naar min)', () => {
  assert.equal(berekenIncassokosten(200), 40);
});

test('geen schuld: 0 en negatief → 0 (minimum geldt alleen bij echte kosten)', () => {
  assert.equal(berekenIncassokosten(0), 0);
  assert.equal(berekenIncassokosten(-500), 0);
  assert.equal(berekenIncassokosten(NaN), 0);
});

test('schijf 1: 2.500 → 375,00 (15%)', () => {
  assert.equal(berekenIncassokosten(2500), 375);
});

test('schijf 1+2: 5.000 → 625,00 (375 + 250)', () => {
  assert.equal(berekenIncassokosten(5000), 625);
});

test('schijf 1+2+3: 10.000 → 875,00 (375 + 250 + 250)', () => {
  assert.equal(berekenIncassokosten(10000), 875);
});

test('schijf 1..4: 200.000 → 2.775,00 (875 + 1.900)', () => {
  assert.equal(berekenIncassokosten(200000), 2775);
});

test('maximum: 1.000.000 → 6.775,00 (cap exact bereikt)', () => {
  assert.equal(berekenIncassokosten(1000000), 6775);
});

test('boven maximum: 5.000.000 → 6.775,00 (geclamped)', () => {
  assert.equal(berekenIncassokosten(5000000), 6775);
});

test('afronden op centen: 2.500,10 → 375,01 (375 + 0,01)', () => {
  assert.equal(berekenIncassokosten(2500.10), 375.01);
});

// ── Resolver-integratie (EUR-NL notatie, zoals klant.totaal_open) ────────────

test('klant.incassokosten resolvet als EUR-NL string', () => {
  const ctx = { openInvoices: [{ amount_total: 200, amount_paid: 0 }] };
  assert.equal(resolveVariableValue('klant.incassokosten', ctx), 'EUR 40,00');
});

test('klant.totaal_na_termijn = totaal_open + incassokosten', () => {
  const ctx = { openInvoices: [{ amount_total: 200, amount_paid: 0 }] };
  assert.equal(resolveVariableValue('klant.totaal_open', ctx), 'EUR 200,00');
  assert.equal(resolveVariableValue('klant.totaal_na_termijn', ctx), 'EUR 240,00');
});

test('grote schuld: duizendtal-punt + komma-decimaal (EUR 10.875,00)', () => {
  const ctx = { openInvoices: [{ amount_total: 6000, amount_paid: 0 }, { amount_total: 4000, amount_paid: 0 }] };
  assert.equal(resolveVariableValue('klant.incassokosten', ctx), 'EUR 875,00');
  assert.equal(resolveVariableValue('klant.totaal_na_termijn', ctx), 'EUR 10.875,00');
});

test('meerdere facturen met deelbetaling: open = som van resterend', () => {
  const ctx = { openInvoices: [
    { amount_total: 1000, amount_paid: 250 },              // open 750
    { amount_total: 500,  amount_paid: 0, credited_amount: 100 }, // open 400
  ] };
  // totaal open = 1150 → incassokosten 15% = 172,50
  assert.equal(resolveVariableValue('klant.incassokosten', ctx), 'EUR 172,50');
  assert.equal(resolveVariableValue('klant.totaal_na_termijn', ctx), 'EUR 1.322,50');
});

// ── berekenTotaalResterend (subscriptions × incl. btw − betaald) ─────────────

test('geen subscriptions → fallback naar totaalOpen', () => {
  assert.equal(berekenTotaalResterend({ totaalOpen: 200 }), 200);
  assert.equal(berekenTotaalResterend({ subscriptions: [], totaalOpen: 200 }), 200);
});

test('subscription: amount × term_count × (1+btw) − betaald', () => {
  // 1000 × 3 × 1,21 = 3630; betaald 630 → 3000
  const subs = [{ amount: 1000, term_count: 3, vat_percentage: 21 }];
  assert.equal(berekenTotaalResterend({ subscriptions: subs, betaaldTotaal: 630 }), 3000);
  assert.equal(berekenTotaalResterend({ subscriptions: subs, betaaldTotaal: 0 }), 3630);
});

test('nooit negatief: betaald > contract → 0', () => {
  const subs = [{ amount: 1000, term_count: 3, vat_percentage: 21 }];
  assert.equal(berekenTotaalResterend({ subscriptions: subs, betaaldTotaal: 5000 }), 0);
});

test('btw-default 21% als vat_percentage ontbreekt', () => {
  // 100 × 2 × 1,21 = 242
  assert.equal(berekenTotaalResterend({ subscriptions: [{ amount: 100, term_count: 2 }], betaaldTotaal: 0 }), 242);
});

test('meerdere subscriptions worden gesommeerd', () => {
  const subs = [
    { amount: 500, term_count: 2, vat_percentage: 21 }, // 1210
    { amount: 100, term_count: 5, vat_percentage: 9 },  // 545
  ];
  assert.equal(berekenTotaalResterend({ subscriptions: subs, betaaldTotaal: 0 }), 1755);
});

// ── Resolver-integratie: totaal_resterend + indicaties (×1,5 / ×1,6) ─────────

test('klant.totaal_resterend + indicaties resolven als EUR-NL', () => {
  const ctx = {
    openInvoices: [{ amount_total: 500, amount_paid: 0 }],
    subscriptions: [{ amount: 1000, term_count: 3, vat_percentage: 21 }],
    betaaldTotaal: 630,
  };
  // resterend = 3000
  assert.equal(resolveVariableValue('klant.totaal_resterend', ctx), 'EUR 3.000,00');
  assert.equal(resolveVariableValue('klant.indicatie_laag', ctx), 'EUR 4.500,00'); // ×1,5
  assert.equal(resolveVariableValue('klant.indicatie_hoog', ctx), 'EUR 4.800,00'); // ×1,6
});

test('resolver-fallback: geen subscriptions → totaal_resterend = totaal_open', () => {
  const ctx = { openInvoices: [{ amount_total: 200, amount_paid: 0 }] };
  assert.equal(resolveVariableValue('klant.totaal_resterend', ctx), 'EUR 200,00');
});
