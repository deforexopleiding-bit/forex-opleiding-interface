// tests/expenses-recurring.test.js
//
// Unit-tests voor api/_lib/expenses-recurring.js — puur JS, geen Supabase.
// Focus: interval-detectie (mediaan-methode), naam-normalisatie, "ongebruikt"-
// signaal, "dubbel"-signaal, edge-cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCounterparty,
  daysSinceEpoch,
  median,
  classifyInterval,
  detectRecurringForGroup,
  detectRecurringAll,
} from '../api/_lib/expenses-recurring.js';

// ── normalizeCounterparty ─────────────────────────────────────────────────

test('normalize: trim + lowercase', () => {
  assert.equal(normalizeCounterparty('  Google Ads  '), 'google ads');
});

test('normalize: strip trailing digits (GOOGLE*ADS2258929925 → google*ads)', () => {
  assert.equal(normalizeCounterparty('GOOGLE*ADS2258929925'), 'google*ads');
});

test('normalize: strip trailing whitespace + punctuatie', () => {
  assert.equal(normalizeCounterparty('HOSTINGER.COM   '), 'hostinger.com');
});

test('normalize: collapse interne whitespace', () => {
  assert.equal(normalizeCounterparty('Meta   Platforms,  Inc.'), 'meta platforms, inc');
});

test('normalize: alleen trailing cijfers strippen, niet in het midden', () => {
  // "3M Company" moet NIET "" worden.
  assert.equal(normalizeCounterparty('3M Company'), '3m company');
});

test('normalize: null / undefined / empty → lege string', () => {
  assert.equal(normalizeCounterparty(null), '');
  assert.equal(normalizeCounterparty(undefined), '');
  assert.equal(normalizeCounterparty(''), '');
  assert.equal(normalizeCounterparty('   '), '');
});

// ── daysSinceEpoch + median ───────────────────────────────────────────────

test('daysSinceEpoch: parseert YYYY-MM-DD', () => {
  const a = daysSinceEpoch('2025-01-01');
  const b = daysSinceEpoch('2025-01-31');
  assert.equal(b - a, 30);
});

test('daysSinceEpoch: invalide → NaN', () => {
  assert.ok(Number.isNaN(daysSinceEpoch('niet-een-datum')));
  assert.ok(Number.isNaN(daysSinceEpoch('')));
  assert.ok(Number.isNaN(daysSinceEpoch(null)));
});

test('median: oneven', () => assert.equal(median([1,2,3]), 2));
test('median: even (gemiddelde middelste)', () => assert.equal(median([1,2,3,4]), 2.5));
test('median: 1 element', () => assert.equal(median([42]), 42));
test('median: leeg → NaN', () => assert.ok(Number.isNaN(median([]))));

// ── classifyInterval ──────────────────────────────────────────────────────

test('classifyInterval: 30 dagen → monthly', () => assert.equal(classifyInterval(30), 'monthly'));
test('classifyInterval: 28 → monthly (februari)', () => assert.equal(classifyInterval(28), 'monthly'));
test('classifyInterval: 31 → monthly', () => assert.equal(classifyInterval(31), 'monthly'));
test('classifyInterval: 91 → quarterly', () => assert.equal(classifyInterval(91), 'quarterly'));
test('classifyInterval: 365 → yearly', () => assert.equal(classifyInterval(365), 'yearly'));
test('classifyInterval: 45 dagen → null (niet in tolerantie)', () => assert.equal(classifyInterval(45), null));
test('classifyInterval: 7 dagen → null (te kort voor onze categorieën)', () => assert.equal(classifyInterval(7), null));
test('classifyInterval: NaN / negatief → null', () => {
  assert.equal(classifyInterval(NaN), null);
  assert.equal(classifyInterval(-1), null);
  assert.equal(classifyInterval(0), null);
});

// ── detectRecurringForGroup ───────────────────────────────────────────────

function mkTx(id, date, cents = -1000) {
  return { id, booking_date: date, amount_cents: cents };
}

test('detect: 6 maandelijkse tx → monthly, correct interval + monthly_cents', () => {
  const txs = [
    mkTx('t1', '2025-01-15', -1200),
    mkTx('t2', '2025-02-15', -1200),
    mkTx('t3', '2025-03-15', -1200),
    mkTx('t4', '2025-04-15', -1200),
    mkTx('t5', '2025-05-15', -1200),
    mkTx('t6', '2025-06-15', -1200),
  ];
  const r = detectRecurringForGroup(txs);
  assert.equal(r.interval, 'monthly');
  assert.equal(r.tx_count, 6);
  assert.equal(r.avg_amount_cents, 1200);
  assert.equal(r.monthly_cents, 1200);
});

test('detect: 4 kwartaal-tx → quarterly, monthly_cents = 1/3 van avg', () => {
  const txs = [
    mkTx('t1', '2024-01-15', -3000),
    mkTx('t2', '2024-04-15', -3000),
    mkTx('t3', '2024-07-15', -3000),
    mkTx('t4', '2024-10-15', -3000),
  ];
  const r = detectRecurringForGroup(txs);
  assert.equal(r.interval, 'quarterly');
  assert.equal(r.monthly_cents, 1000);
});

test('detect: 3 jaar-tx → yearly, monthly_cents = 1/12 van avg', () => {
  const txs = [
    mkTx('t1', '2023-06-15', -12000),
    mkTx('t2', '2024-06-15', -12000),
    mkTx('t3', '2025-06-15', -12000),
  ];
  const r = detectRecurringForGroup(txs);
  assert.equal(r.interval, 'yearly');
  assert.equal(r.monthly_cents, 1000);
});

test('detect: 1 transactie → null (te weinig)', () => {
  const r = detectRecurringForGroup([mkTx('t1', '2025-01-15')]);
  assert.equal(r, null);
});

test('detect: 2 transacties → null (< minTxCount=3)', () => {
  const r = detectRecurringForGroup([
    mkTx('t1', '2025-01-15'),
    mkTx('t2', '2025-02-15'),
  ]);
  assert.equal(r, null);
});

test('detect: 3 tx binnen 1 week → null (geen geldig interval)', () => {
  const r = detectRecurringForGroup([
    mkTx('t1', '2025-01-01'),
    mkTx('t2', '2025-01-03'),
    mkTx('t3', '2025-01-05'),
  ]);
  assert.equal(r, null, '3 dagen mediaan valt buiten monthly/quarterly/yearly range');
});

test('detect: onregelmatig (mediaan 45 dagen) → null', () => {
  const r = detectRecurringForGroup([
    mkTx('t1', '2025-01-01'),
    mkTx('t2', '2025-02-15'),   // 45 dagen
    mkTx('t3', '2025-04-01'),   // 45 dagen
    mkTx('t4', '2025-05-15'),   // 44 dagen
  ]);
  assert.equal(r, null);
});

test('detect: 3 tx in dezelfde maand → null (distinct_months=1)', () => {
  const r = detectRecurringForGroup([
    mkTx('t1', '2025-01-05'),
    mkTx('t2', '2025-01-15'),
    mkTx('t3', '2025-01-25'),
  ]);
  assert.equal(r, null);
});

// ── possible_unused signaal ───────────────────────────────────────────────

test('possible_unused: maandelijks abo, last date 100 dagen geleden → true', () => {
  const txs = [
    mkTx('t1', '2025-01-15'),
    mkTx('t2', '2025-02-15'),
    mkTx('t3', '2025-03-15'),
  ];
  // Vandaag = 2025-06-23 → 100 dagen na last_date.
  const today = daysSinceEpoch('2025-06-23');
  const r = detectRecurringForGroup(txs, { todayDayNum: today });
  assert.equal(r.interval, 'monthly');
  assert.equal(r.possible_unused, true);
});

test('possible_unused: maandelijks abo, last date 30 dagen geleden → false (conservatief)', () => {
  const txs = [
    mkTx('t1', '2025-01-15'),
    mkTx('t2', '2025-02-15'),
    mkTx('t3', '2025-03-15'),
  ];
  const today = daysSinceEpoch('2025-04-15');   // 31 dagen na last
  const r = detectRecurringForGroup(txs, { todayDayNum: today });
  assert.equal(r.possible_unused, false);
});

test('possible_unused: zonder todayDayNum → nooit true (defensief)', () => {
  const txs = [
    mkTx('t1', '2025-01-15'),
    mkTx('t2', '2025-02-15'),
    mkTx('t3', '2025-03-15'),
  ];
  const r = detectRecurringForGroup(txs);  // geen todayDayNum
  assert.equal(r.possible_unused, false);
  assert.equal(r.days_since_last, null);
});

// ── detectRecurringAll: end-to-end + duplicate-detectie ─────────────────

test('detectAll: 2 recurring in dezelfde categorie → possible_duplicate=true', () => {
  const txs = [
    // Recurring #1 — cat A
    mkTx('a1', '2025-01-15', -1000), mkTx('a2', '2025-02-15', -1000), mkTx('a3', '2025-03-15', -1000),
    mkTx('a4', '2025-04-15', -1000), mkTx('a5', '2025-05-15', -1000),
    // Recurring #2 — ook cat A
    mkTx('b1', '2025-01-20', -500), mkTx('b2', '2025-02-20', -500), mkTx('b3', '2025-03-20', -500),
    mkTx('b4', '2025-04-20', -500), mkTx('b5', '2025-05-20', -500),
  ];
  txs[0].counterparty_name = 'Tool A';  txs[1].counterparty_name = 'Tool A';
  txs[2].counterparty_name = 'Tool A';  txs[3].counterparty_name = 'Tool A';
  txs[4].counterparty_name = 'Tool A';
  txs[5].counterparty_name = 'Tool B';  txs[6].counterparty_name = 'Tool B';
  txs[7].counterparty_name = 'Tool B';  txs[8].counterparty_name = 'Tool B';
  txs[9].counterparty_name = 'Tool B';
  const catByTxId = new Map();
  for (const t of txs) catByTxId.set(t.id, { category_id: 'cat-software', source: 'rule' });
  const catMetaById = new Map([['cat-software', { id: 'cat-software', slug: 'software_tools', label: 'Software', color: '#3b82f6' }]]);
  const r = detectRecurringAll(txs, { categoryByTxId: catByTxId, categoryMetaById: catMetaById });
  assert.equal(r.recurring.length, 2);
  assert.equal(r.recurring.every(x => x.possible_duplicate), true);
});

test('detectAll: overig-categorie triggert GEEN duplicate-vlag', () => {
  const mk = (name, prefix) => [1,2,3,4,5].map(i => {
    const d = new Date(Date.UTC(2025, i - 1, 15));
    return { id: prefix + i, counterparty_name: name, booking_date: d.toISOString().slice(0, 10), amount_cents: -1000 };
  });
  const txs = [...mk('X', 'x'), ...mk('Y', 'y')];
  const catByTxId = new Map();
  for (const t of txs) catByTxId.set(t.id, { category_id: 'cat-overig', source: 'rule' });
  const catMetaById = new Map([['cat-overig', { id: 'cat-overig', slug: 'overig', label: 'Overig', color: '#94a3b8' }]]);
  const r = detectRecurringAll(txs, { categoryByTxId: catByTxId, categoryMetaById: catMetaById });
  assert.equal(r.recurring.every(x => x.possible_duplicate === false), true);
});

test('detectAll: totaal_monthly_cents = som van alle recurring monthly_cents', () => {
  const mk = (name, prefix, cents) => [1,2,3,4,5].map(i => {
    const d = new Date(Date.UTC(2025, i - 1, 15));
    return { id: prefix + i, counterparty_name: name, booking_date: d.toISOString().slice(0, 10), amount_cents: cents };
  });
  const txs = [...mk('A', 'a', -1000), ...mk('B', 'b', -500)];
  const r = detectRecurringAll(txs, {});
  assert.equal(r.total_monthly_cents, 1500);
});

test('detectAll: naam-varianten (whitespace/case) → 1 groep', () => {
  // HOSTINGER.COM en 'hostinger.com   ' normaliseren beide naar 'hostinger.com'.
  const txs = [
    { id: 'h1', counterparty_name: 'HOSTINGER.COM',    booking_date: '2025-01-15', amount_cents: -1000 },
    { id: 'h2', counterparty_name: 'HOSTINGER.COM',    booking_date: '2025-02-15', amount_cents: -1000 },
    { id: 'h3', counterparty_name: 'hostinger.com   ', booking_date: '2025-03-15', amount_cents: -1000 },
    { id: 'h4', counterparty_name: 'hostinger.com',    booking_date: '2025-04-15', amount_cents: -1000 },
    { id: 'h5', counterparty_name: 'Hostinger.com',    booking_date: '2025-05-15', amount_cents: -1000 },
  ];
  const r = detectRecurringAll(txs, {});
  assert.equal(r.recurring.length, 1, 'whitespace/case-varianten moeten 1 recurring vormen');
  assert.equal(r.recurring[0].tx_count, 5);
});

test('detectAll: trailing-id-varianten (SUMUP*111 vs SUMUP*222 vs SUMUP) → 1 groep', () => {
  const txs = [
    { id: 's1', counterparty_name: 'SUMUP*111', booking_date: '2025-01-15', amount_cents: -1000 },
    { id: 's2', counterparty_name: 'SUMUP*222', booking_date: '2025-02-15', amount_cents: -1000 },
    { id: 's3', counterparty_name: 'SUMUP',     booking_date: '2025-03-15', amount_cents: -1000 },
  ];
  const r = detectRecurringAll(txs, {});
  assert.equal(r.recurring.length, 1);
  assert.equal(r.recurring[0].normalized_name, 'sumup');
});

// ── PayPal-financieringslegs zijn al door caller uitgesloten ────────────
// Deze tests gaan uit van "zuivere" input (geen +Overige-legs meer, geen
// vasthoudingen). De detector krijgt puur -Af-pasbetalingen binnen. Per-dag-
// som blijft als edge-case voor "meerdere pasbetalingen op één dag", maar
// nette de -Af NIET meer tegen een +Bij (die is er niet meer).

test('detect: 3 -Af pasbetalingen op 3 opeenvolgende maanden → monthly recurring (Twilio-grondwaarheid)', () => {
  // Na excludePaypalFundingLegs zijn de +Overige-financieringslegs al weg.
  // Detector ziet 3 pure -Af's — elk vol als eigen bedrag (NIET netto ~€0).
  const txs = [
    mkTx('a1', '2026-01-24', -3831),
    mkTx('a2', '2026-02-24', -3514),
    mkTx('a3', '2026-03-24', -4305),
  ];
  const r = detectRecurringForGroup(txs);
  assert.ok(r, 'wordt gedetecteerd als recurring');
  assert.equal(r.interval, 'monthly');
  assert.equal(r.tx_count, 3, '3 pasbetalingen = 3 datapunten');
  // avg = (3831+3514+4305)/3 = 3883
  assert.equal(r.avg_amount_cents, 3883, 'avg = -€38,83 (grondwaarheid, NIET €0,48)');
});

test('detect: meerdere -Af pasbetalingen op zelfde dag consolideren tot 1 datapunt', () => {
  // Zeldzaam maar mogelijk: merchant charged 2× op zelfde dag. Per-dag-som
  // consolideert tot 1 datapunt zodat mediaan-diff niet verstoord raakt.
  const txs = [
    mkTx('a1a', '2025-01-15', -1000),   // twee pasbetalingen op 15 jan
    mkTx('a1b', '2025-01-15', -2000),
    mkTx('a2',  '2025-02-15', -3000),
    mkTx('a3',  '2025-03-15', -3000),
  ];
  const r = detectRecurringForGroup(txs);
  assert.ok(r);
  assert.equal(r.tx_count, 3, '3 unieke dagen na per-dag consolidatie');
  assert.equal(r.avg_amount_cents, 3000, 'jan-dag = -1000+-2000 = -3000');
});

test('detectAll: insights-counts kloppen', () => {
  const mk = (name, prefix, dates, cents) => dates.map((d, i) => ({
    id: prefix + i, counterparty_name: name, booking_date: d, amount_cents: cents,
  }));
  const monthly = mk('M', 'm', ['2025-01-15','2025-02-15','2025-03-15','2025-04-15'], -1000);
  const yearly  = mk('Y', 'y', ['2023-06-15','2024-06-15','2025-06-15'], -12000);
  const r = detectRecurringAll([...monthly, ...yearly], {});
  assert.equal(r.insights.count_total, 2);
  assert.equal(r.insights.count_monthly, 1);
  assert.equal(r.insights.count_yearly, 1);
  assert.equal(r.insights.count_quarterly, 0);
});
