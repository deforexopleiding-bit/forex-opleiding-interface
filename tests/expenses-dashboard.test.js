// tests/expenses-dashboard.test.js
//
// Unit-tests voor api/_lib/expenses-dashboard.js — puur JS, geen Supabase.
// Focus: aggregatie-consistentie (totalen van drie aggregaties moeten
// exact matchen als input identiek is).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateByMonth,
  aggregateByGroup,
  aggregateByCategory,
} from '../api/_lib/expenses-dashboard.js';

function mkTx(id, date, cents) {
  return { id, booking_date: date, amount_cents: cents };
}

// ── aggregateByMonth ─────────────────────────────────────────────────────

test('byMonth: groepeert per YYYY-MM, chronologisch', () => {
  const txs = [
    mkTx('t1', '2025-01-15', -100),
    mkTx('t2', '2025-01-20', -200),
    mkTx('t3', '2025-02-05', -300),
    mkTx('t4', '2024-12-10', -50),
  ];
  const out = aggregateByMonth(txs);
  assert.deepEqual(out.map(m => m.month), ['2024-12', '2025-01', '2025-02']);
  assert.equal(out.find(m => m.month === '2025-01').total_cents, -300);
  assert.equal(out.find(m => m.month === '2025-01').tx_count, 2);
});

test('byMonth: lege input → lege array', () => {
  assert.deepEqual(aggregateByMonth([]), []);
  assert.deepEqual(aggregateByMonth(null), []);
});

test('byMonth: skipt ongeldige datums', () => {
  const txs = [
    mkTx('t1', '2025-01-15', -100),
    mkTx('t2', '', -200),
    mkTx('t3', null, -300),
    mkTx('t4', 'geen-datum', -400),
  ];
  const out = aggregateByMonth(txs);
  assert.equal(out.length, 1);
  assert.equal(out[0].total_cents, -100);
});

// ── aggregateByGroup ─────────────────────────────────────────────────────

const CAT_META = new Map([
  ['cat-marketing', { id: 'cat-marketing', slug: 'marketing_advertenties', label: 'Marketing' }],
  ['cat-partners',  { id: 'cat-partners',  slug: 'winstuitkering-vennoten', label: 'Vennoten' }],
  ['cat-taxes',     { id: 'cat-taxes',     slug: 'belastingen_heffingen',   label: 'Belasting' }],
  ['cat-overig',    { id: 'cat-overig',    slug: 'overig',                  label: 'Overig' }],
]);

test('byGroup: partners + taxes apart, rest = operational', () => {
  const txs = [
    mkTx('t1', '2025-01-01', -1000),   // marketing → operational
    mkTx('t2', '2025-01-02', -500),    // partners
    mkTx('t3', '2025-01-03', -300),    // taxes
    mkTx('t4', '2025-01-04', -200),    // overig → operational
    mkTx('t5', '2025-01-05', -100),    // ongecategoriseerd → operational
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-partners' }],
    ['t3', { category_id: 'cat-taxes' }],
    ['t4', { category_id: 'cat-overig' }],
    // t5 heeft geen entry
  ]);
  const g = aggregateByGroup(txs, catByTxId, CAT_META);
  assert.equal(g.operational_cents, -1000 + -200 + -100);
  assert.equal(g.operational_count, 3);
  assert.equal(g.partners_cents, -500);
  assert.equal(g.partners_count, 1);
  assert.equal(g.taxes_cents, -300);
  assert.equal(g.taxes_count, 1);
});

test('byGroup: som van 3 groepen = som van alle tx (invariant)', () => {
  const txs = [
    mkTx('t1', '2025-01-01', -1000),
    mkTx('t2', '2025-01-02', -500),
    mkTx('t3', '2025-01-03', -300),
    mkTx('t4', '2025-01-04', -200),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-partners' }],
    ['t3', { category_id: 'cat-taxes' }],
    ['t4', { category_id: 'cat-overig' }],
  ]);
  const g = aggregateByGroup(txs, catByTxId, CAT_META);
  const totalGroups = g.operational_cents + g.partners_cents + g.taxes_cents;
  const totalTxs = txs.reduce((s, t) => s + t.amount_cents, 0);
  assert.equal(totalGroups, totalTxs, '3-way split moet optellen tot volledige som');
});

test('byGroup: lege input → alle 0', () => {
  const g = aggregateByGroup([], new Map(), new Map());
  assert.equal(g.operational_cents, 0);
  assert.equal(g.partners_cents, 0);
  assert.equal(g.taxes_cents, 0);
});

// ── aggregateByCategory ──────────────────────────────────────────────────

test('byCategory: som van categorieën + uncat = total_cents (invariant)', () => {
  const txs = [
    mkTx('t1', '2025-01-01', -1000),
    mkTx('t2', '2025-01-02', -500),
    mkTx('t3', '2025-01-03', -300),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-marketing' }],
    // t3 ongecategoriseerd
  ]);
  const r = aggregateByCategory(txs, catByTxId, CAT_META);
  const mkt = r.categories.find(c => c.id === 'cat-marketing');
  assert.equal(mkt.total_cents, -1500);
  assert.equal(mkt.tx_count, 2);
  assert.equal(r.uncategorized.total_cents, -300);
  assert.equal(r.uncategorized.tx_count, 1);
  assert.equal(r.total_cents, -1800);
  // invariant
  const totalCats = r.categories.reduce((s, c) => s + c.total_cents, 0);
  assert.equal(totalCats + r.uncategorized.total_cents, r.total_cents);
});

test('byCategory: pct is percentage van absolute som', () => {
  const txs = [
    mkTx('t1', '2025-01-01', -1000),
    mkTx('t2', '2025-01-02', -1000),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-partners' }],
  ]);
  const r = aggregateByCategory(txs, catByTxId, CAT_META);
  const mkt = r.categories.find(c => c.id === 'cat-marketing');
  const p = r.categories.find(c => c.id === 'cat-partners');
  assert.equal(mkt.pct, 50);
  assert.equal(p.pct, 50);
});

test('byCategory: sortering meest-negatief eerst (grootste uitgave bovenaan)', () => {
  const txs = [
    mkTx('t1', '2025-01-01', -500),
    mkTx('t2', '2025-01-02', -1000),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-partners' }],
  ]);
  const r = aggregateByCategory(txs, catByTxId, CAT_META);
  assert.equal(r.categories[0].id, 'cat-partners', 'grootste uitgave bovenaan');
});

// ── Cross-aggregatie invariant: alle 3 aggregaties = zelfde totaal ─────

test('invariant: byCategory total + uncat == byMonth-som == byGroup-som', () => {
  const txs = [
    mkTx('t1', '2025-01-01', -1000),
    mkTx('t2', '2025-01-15', -500),
    mkTx('t3', '2025-02-05', -300),
    mkTx('t4', '2025-03-10', -200),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-partners' }],
    ['t3', { category_id: 'cat-taxes' }],
    // t4 ongecategoriseerd → operational
  ]);
  const cat = aggregateByCategory(txs, catByTxId, CAT_META);
  const mon = aggregateByMonth(txs);
  const grp = aggregateByGroup(txs, catByTxId, CAT_META);
  const catSum = cat.total_cents;
  const monSum = mon.reduce((s, m) => s + m.total_cents, 0);
  const grpSum = grp.operational_cents + grp.partners_cents + grp.taxes_cents;
  assert.equal(monSum, catSum, 'maand-som moet matchen categorie-total');
  assert.equal(grpSum, catSum, 'groep-som moet matchen categorie-total');
  assert.equal(catSum, -2000);
});
