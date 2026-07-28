// tests/expenses-grouping.test.js
//
// Unit-tests voor api/_lib/expenses-grouping.js. Pure functies zonder
// Supabase — deterministisch en snel. Deze helpers dragen de belangrijkste
// business-logica van de uitgaven-analyse (grouping + consensus + filters
// + sort + breakdown). Regressie hier = onjuiste bedragen in UI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERNAL_NAMES,
  EMPTY_NAME,
  groupByCounterparty,
  consensusCategoryForGroup,
  buildCounterpartyRows,
  sortCounterparties,
  filterTransactionsForBreakdown,
  computeBreakdown,
  aiSuggestionsByCounterparty,
  excludePaypalFundingLegs,
} from '../api/_lib/expenses-grouping.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const CAT_META_ROWS = [
  { id: 'cat-marketing', slug: 'marketing', label: 'Marketing & advertenties', color: '#f97316' },
  { id: 'cat-software',  slug: 'software',  label: 'Software & abonnementen',  color: '#3b82f6' },
  { id: 'cat-reis',      slug: 'reis',      label: 'Reis & verblijf',          color: '#10b981' },
];
const CAT_META = new Map(CAT_META_ROWS.map(c => [c.id, c]));

function mkTx(id, name, cents, date, source = 'camt') {
  return { id, counterparty_name: name, amount_cents: cents, booking_date: date, source };
}

// ── groupByCounterparty ───────────────────────────────────────────────────

test('groupByCounterparty: 3 tx van dezelfde tegenpartij → 1 groep met total + count + date-range', () => {
  const txs = [
    mkTx('t1', 'Meta Platforms', -10000, '2026-01-05'),
    mkTx('t2', 'Meta Platforms', -20000, '2026-01-12'),
    mkTx('t3', 'Meta Platforms', -5000,  '2026-01-20'),
  ];
  const groups = groupByCounterparty(txs, new Map());
  assert.equal(groups.size, 1);
  const g = groups.get('Meta Platforms');
  assert.equal(g.total, -35000);
  assert.equal(g.count, 3);
  assert.equal(g.first, '2026-01-05');
  assert.equal(g.last,  '2026-01-20');
});

test('groupByCounterparty: 2 tegenpartijen → 2 groepen apart', () => {
  const txs = [
    mkTx('t1', 'Meta', -100, '2026-01-01'),
    mkTx('t2', 'Google', -200, '2026-01-02'),
    mkTx('t3', 'Meta', -50, '2026-01-03'),
  ];
  const groups = groupByCounterparty(txs, new Map());
  assert.equal(groups.size, 2);
  assert.equal(groups.get('Meta').total, -150);
  assert.equal(groups.get('Google').total, -200);
});

test('groupByCounterparty: null/empty naam valt in "(leeg)"-bucket', () => {
  const txs = [
    mkTx('t1', null, -100, '2026-01-01'),
    mkTx('t2', '',   -200, '2026-01-02'),
    mkTx('t3', '   ', -300, '2026-01-03'),   // alleen whitespace
  ];
  const groups = groupByCounterparty(txs, new Map());
  assert.equal(groups.size, 1);
  assert.equal(groups.get(EMPTY_NAME).total, -600);
  assert.equal(groups.get(EMPTY_NAME).count, 3);
});

test('groupByCounterparty: cat-counts + manualCount worden bijgehouden', () => {
  const txs = [
    mkTx('t1', 'Meta', -100, '2026-01-01'),
    mkTx('t2', 'Meta', -100, '2026-01-02'),
    mkTx('t3', 'Meta', -100, '2026-01-03'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing', source: 'rule' }],
    ['t2', { category_id: 'cat-marketing', source: 'rule' }],
    ['t3', { category_id: 'cat-reis',      source: 'manual' }],  // uitzondering
  ]);
  const groups = groupByCounterparty(txs, catByTxId);
  const g = groups.get('Meta');
  assert.equal(g.catCounts.get('cat-marketing'), 2);
  assert.equal(g.catCounts.get('cat-reis'), 1);
  assert.equal(g.manualCount, 1);
});

// ── consensusCategoryForGroup ─────────────────────────────────────────────

test('consensus: 3/3 zelfde categorie → 100% coverage, rule-source', () => {
  const g = { count: 3, manualCount: 0, catCounts: new Map([['cat-marketing', 3]]) };
  const c = consensusCategoryForGroup(g);
  assert.equal(c.categoryId, 'cat-marketing');
  assert.equal(c.source, 'rule');
  assert.equal(c.coverage, 1);
});

test('consensus: 2/3 zelfde + 1 andere → 66% > 50%, wint', () => {
  const g = { count: 3, manualCount: 0, catCounts: new Map([['cat-marketing', 2], ['cat-reis', 1]]) };
  const c = consensusCategoryForGroup(g);
  assert.equal(c.categoryId, 'cat-marketing');
  assert.ok(c.coverage > 0.5);
});

test('consensus: 1/3 + 1/3 + 1/3 → geen consensus → null', () => {
  const g = { count: 3, manualCount: 0, catCounts: new Map([['a', 1], ['b', 1], ['c', 1]]) };
  const c = consensusCategoryForGroup(g);
  assert.equal(c.categoryId, null);
  assert.equal(c.source, null);
});

test('consensus: 3/3 en alle zijn manual → source=manual', () => {
  const g = { count: 3, manualCount: 3, catCounts: new Map([['cat-reis', 3]]) };
  const c = consensusCategoryForGroup(g);
  assert.equal(c.source, 'manual');
});

test('consensus: 2 rule + 1 manual → source=rule (want manual != winning-count)', () => {
  const g = { count: 3, manualCount: 1, catCounts: new Map([['cat-marketing', 2], ['cat-reis', 1]]) };
  const c = consensusCategoryForGroup(g);
  assert.equal(c.categoryId, 'cat-marketing');
  assert.equal(c.source, 'rule');
});

test('consensus: lege catCounts → null', () => {
  const g = { count: 5, manualCount: 0, catCounts: new Map() };
  const c = consensusCategoryForGroup(g);
  assert.equal(c.categoryId, null);
  assert.equal(c.coverage, 0);
});

// ── buildCounterpartyRows: filters ────────────────────────────────────────

test('filter default: verbergt (intern PayPal) + (leeg) + positieve netto', () => {
  const groups = new Map([
    ['Meta',            { total: -100, count: 1, first: '2026-01-01', last: '2026-01-01', catCounts: new Map(), manualCount: 0 }],
    ['(intern PayPal)', { total: -500, count: 3, first: '2026-01-01', last: '2026-01-05', catCounts: new Map(), manualCount: 0 }],
    ['(leeg)',          { total: -50,  count: 1, first: '2026-01-01', last: '2026-01-01', catCounts: new Map(), manualCount: 0 }],
    ['Klant X',         { total: +2000, count: 1, first: '2026-01-01', last: '2026-01-01', catCounts: new Map(), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Meta');
});

test('filter include_internal: toont ook (intern PayPal) + (leeg)', () => {
  const groups = new Map([
    ['Meta',            { total: -100, count: 1, first: null, last: null, catCounts: new Map(), manualCount: 0 }],
    ['(intern PayPal)', { total: -500, count: 3, first: null, last: null, catCounts: new Map(), manualCount: 0 }],
    ['(leeg)',          { total: -50,  count: 1, first: null, last: null, catCounts: new Map(), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, { includeInternal: true });
  assert.equal(rows.length, 3);
});

test('filter include_incoming: toont ook counterparties met netto positief', () => {
  const groups = new Map([
    ['Meta',    { total: -100, count: 1, first: null, last: null, catCounts: new Map(), manualCount: 0 }],
    ['Klant X', { total: +2000, count: 1, first: null, last: null, catCounts: new Map(), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, { includeIncoming: true });
  assert.equal(rows.length, 2);
});

test('filter onlyUncategorized: toont alleen counterparties zonder categorie', () => {
  const groups = new Map([
    ['Meta',   { total: -100, count: 2, first: null, last: null, catCounts: new Map([['cat-marketing', 2]]), manualCount: 0 }],
    ['Google', { total: -200, count: 1, first: null, last: null, catCounts: new Map(), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, { onlyUncategorized: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Google');
});

test('filter categoryFilter: toont alleen counterparties met specifieke categorie', () => {
  const groups = new Map([
    ['Meta',   { total: -100, count: 2, first: null, last: null, catCounts: new Map([['cat-marketing', 2]]), manualCount: 0 }],
    ['GitHub', { total: -200, count: 1, first: null, last: null, catCounts: new Map([['cat-software', 1]]),  manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, { categoryFilter: 'cat-marketing' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Meta');
  assert.equal(rows[0].category.id, 'cat-marketing');
});

test('build: rijen bevatten juist category-object uit catMetaById', () => {
  const groups = new Map([
    ['Meta', { total: -100, count: 2, first: '2026-01-01', last: '2026-01-05', catCounts: new Map([['cat-marketing', 2]]), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, {});
  assert.equal(rows[0].category.label, 'Marketing & advertenties');
  assert.equal(rows[0].category.color, '#f97316');
  assert.equal(rows[0].category_source, 'rule');
});

// ── sortCounterparties ────────────────────────────────────────────────────

test('sort total_desc (default): meest-negatief eerst', () => {
  const rows = [
    { name: 'a', total_cents: -100, tx_count: 1 },
    { name: 'b', total_cents: -500, tx_count: 1 },
    { name: 'c', total_cents: -50,  tx_count: 1 },
  ];
  const sorted = sortCounterparties(rows, 'total_desc');
  assert.deepEqual(sorted.map(r => r.name), ['b', 'a', 'c']);
});

test('sort total_abs_desc: grootste absoluut eerst (ook positief)', () => {
  const rows = [
    { name: 'a', total_cents: -100, tx_count: 1 },
    { name: 'b', total_cents: +500, tx_count: 1 },
    { name: 'c', total_cents: -50,  tx_count: 1 },
  ];
  const sorted = sortCounterparties(rows, 'total_abs_desc');
  assert.deepEqual(sorted.map(r => r.name), ['b', 'a', 'c']);
});

test('sort count_desc: meeste transacties eerst', () => {
  const rows = [
    { name: 'a', total_cents: -10, tx_count: 3 },
    { name: 'b', total_cents: -10, tx_count: 10 },
    { name: 'c', total_cents: -10, tx_count: 1 },
  ];
  const sorted = sortCounterparties(rows, 'count_desc');
  assert.deepEqual(sorted.map(r => r.name), ['b', 'a', 'c']);
});

test('sort name_asc: alfabetisch nl-locale', () => {
  const rows = [
    { name: 'Édouard', total_cents: -10, tx_count: 1 },
    { name: 'Anna',    total_cents: -10, tx_count: 1 },
    { name: 'Zara',    total_cents: -10, tx_count: 1 },
  ];
  const sorted = sortCounterparties(rows, 'name_asc');
  assert.equal(sorted[0].name, 'Anna');
  assert.equal(sorted[2].name, 'Zara');
});

test('sort: onbekende key → val terug op total_desc', () => {
  const rows = [
    { name: 'a', total_cents: -100, tx_count: 1 },
    { name: 'b', total_cents: -500, tx_count: 1 },
  ];
  const sorted = sortCounterparties(rows, 'onzin');
  assert.deepEqual(sorted.map(r => r.name), ['b', 'a']);
});

test('sort: input-array wordt niet gemuteerd', () => {
  const rows = [
    { name: 'a', total_cents: -100 },
    { name: 'b', total_cents: -500 },
  ];
  const orig = [...rows];
  sortCounterparties(rows, 'total_desc');
  assert.deepEqual(rows, orig);
});

// ── filterTransactionsForBreakdown ────────────────────────────────────────

test('breakdown-filter default: verbergt intern + inkomsten', () => {
  const txs = [
    mkTx('t1', 'Meta', -100, '2026-01-01'),
    mkTx('t2', '(intern PayPal)', -50, '2026-01-01'),
    mkTx('t3', 'Klant', +1000, '2026-01-01'),
  ];
  const out = filterTransactionsForBreakdown(txs, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 't1');
});

test('breakdown-filter includeInternal: laat intern binnen', () => {
  const txs = [
    mkTx('t1', 'Meta', -100, '2026-01-01'),
    mkTx('t2', '(intern PayPal)', -50, '2026-01-01'),
  ];
  const out = filterTransactionsForBreakdown(txs, { includeInternal: true });
  assert.equal(out.length, 2);
});

// ── computeBreakdown ──────────────────────────────────────────────────────

test('breakdown: 2 gecategoriseerde tx + 1 uncategorized → 2 buckets + uncat', () => {
  const txs = [
    mkTx('t1', 'Meta',   -10000, '2026-01-01'),
    mkTx('t2', 'GitHub', -5000,  '2026-01-01'),
    mkTx('t3', 'Anders', -1000,  '2026-01-01'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-software'  }],
    // t3 heeft geen categorisatie
  ]);
  const bd = computeBreakdown(txs, catByTxId, CAT_META_ROWS);
  const mkt = bd.categories.find(c => c.id === 'cat-marketing');
  const sft = bd.categories.find(c => c.id === 'cat-software');
  const reis = bd.categories.find(c => c.id === 'cat-reis');
  assert.equal(mkt.total_cents, -10000);
  assert.equal(mkt.tx_count, 1);
  assert.equal(sft.total_cents, -5000);
  assert.equal(reis.total_cents, 0);           // zero-bucket voor unused cat
  assert.equal(reis.tx_count, 0);
  assert.equal(bd.uncategorized.total_cents, -1000);
  assert.equal(bd.uncategorized.tx_count, 1);
  assert.equal(bd.totalAll, -16000);
});

test('breakdown: pct berekend op absolute som', () => {
  const txs = [
    mkTx('t1', 'Meta',   -10000, '2026-01-01'),
    mkTx('t2', 'GitHub', -10000, '2026-01-01'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-software'  }],
  ]);
  const bd = computeBreakdown(txs, catByTxId, CAT_META_ROWS);
  const mkt = bd.categories.find(c => c.id === 'cat-marketing');
  const sft = bd.categories.find(c => c.id === 'cat-software');
  assert.equal(mkt.pct, 50);
  assert.equal(sft.pct, 50);
});

test('breakdown: sort meest-negatief eerst (grootste uitgave bovenaan)', () => {
  const txs = [
    mkTx('t1', 'Meta',   -1000, '2026-01-01'),
    mkTx('t2', 'GitHub', -5000, '2026-01-01'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-software'  }],
  ]);
  const bd = computeBreakdown(txs, catByTxId, CAT_META_ROWS);
  const nonZero = bd.categories.filter(c => c.total_cents !== 0);
  assert.equal(nonZero[0].id, 'cat-software');  // -5000 komt eerst
  assert.equal(nonZero[1].id, 'cat-marketing'); // -1000 daarna
});

test('breakdown: totalAbs=0 → pct=0 (geen div-by-zero)', () => {
  const bd = computeBreakdown([], new Map(), CAT_META_ROWS);
  bd.categories.forEach(c => assert.equal(c.pct, 0));
  assert.equal(bd.uncategorized.pct, 0);
});

// ── INTERNAL_NAMES + EMPTY_NAME constants (public API) ────────────────────

test('constants: INTERNAL_NAMES bevat exact "(intern PayPal)"', () => {
  assert.ok(INTERNAL_NAMES.has('(intern PayPal)'));
  assert.equal(INTERNAL_NAMES.size, 1);
});

test('constants: EMPTY_NAME = "(leeg)"', () => {
  assert.equal(EMPTY_NAME, '(leeg)');
});

// ── Internal transfers (is_internal category-flag) ───────────────────────

const CAT_META_WITH_INTERNAL = new Map([
  ...CAT_META_ROWS.map(c => [c.id, c]),
  ['cat-internal', { id: 'cat-internal', slug: 'intern-overboeking', label: 'Interne overboeking', color: '#94a3b8', is_internal: true }],
]);

test('buildCounterpartyRows: default verbergt counterparties met is_internal category (ING→PayPal)', () => {
  const groups = new Map([
    ['Meta',           { total: -100, count: 1, first: null, last: null, catCounts: new Map([['cat-marketing', 1]]), manualCount: 0 }],
    ['PayPal Europe',  { total: -50000, count: 10, first: null, last: null, catCounts: new Map([['cat-internal', 10]]), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META_WITH_INTERNAL, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Meta');
});

test('buildCounterpartyRows: includeInternalTransfers=true toont ook ING→PayPal', () => {
  const groups = new Map([
    ['Meta',           { total: -100, count: 1, first: null, last: null, catCounts: new Map([['cat-marketing', 1]]), manualCount: 0 }],
    ['PayPal Europe',  { total: -50000, count: 10, first: null, last: null, catCounts: new Map([['cat-internal', 10]]), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META_WITH_INTERNAL, { includeInternalTransfers: true });
  assert.equal(rows.length, 2);
});

test('filterTransactionsForBreakdown: default excludeert tx met is_internal category', () => {
  const txs = [
    mkTx('t1', 'Meta',          -10000, '2026-01-01'),
    mkTx('t2', 'PayPal Europe', -50000, '2026-01-02'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-internal' }],
  ]);
  const out = filterTransactionsForBreakdown(txs, catByTxId, CAT_META_WITH_INTERNAL, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 't1');
});

test('filterTransactionsForBreakdown: includeInternalTransfers=true laat interne tx binnen', () => {
  const txs = [
    mkTx('t1', 'Meta',          -10000, '2026-01-01'),
    mkTx('t2', 'PayPal Europe', -50000, '2026-01-02'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing' }],
    ['t2', { category_id: 'cat-internal' }],
  ]);
  const out = filterTransactionsForBreakdown(txs, catByTxId, CAT_META_WITH_INTERNAL, { includeInternalTransfers: true });
  assert.equal(out.length, 2);
});

test('filterTransactionsForBreakdown: oude signature (2e arg = filters-object) blijft werken', () => {
  const txs = [
    mkTx('t1', 'Meta',           -100, '2026-01-01'),
    mkTx('t2', '(intern PayPal)', -50, '2026-01-01'),
  ];
  const out = filterTransactionsForBreakdown(txs, { includeInternal: true });
  assert.equal(out.length, 2);
});

test('computeBreakdown: interne categorie verschijnt NIET in de output-lijst', () => {
  const txs = [
    mkTx('t1', 'Meta', -10000, '2026-01-01'),
    // Interne tx zou al gefilterd zijn door filterTransactionsForBreakdown;
    // deze test bewijst dat óók als 'ie er zou zijn, hij niet in output komt.
  ];
  const catByTxId = new Map([['t1', { category_id: 'cat-marketing' }]]);
  const bd = computeBreakdown(txs, catByTxId, [...CAT_META_WITH_INTERNAL.values()]);
  const internal = bd.categories.find(c => c.slug === 'intern-overboeking');
  assert.equal(internal, undefined, 'is_internal categorie mag niet in breakdown output');
  const mkt = bd.categories.find(c => c.id === 'cat-marketing');
  assert.equal(mkt.total_cents, -10000);
});

// ── AI-suggest: ai_suggest telt NIET mee in consensus ─────────────────────

test('groupByCounterparty: ai_suggest wordt overgeslagen in catCounts', () => {
  const txs = [
    mkTx('t1', 'Meta', -100, '2026-01-01'),
    mkTx('t2', 'Meta', -200, '2026-01-02'),
    mkTx('t3', 'Meta', -300, '2026-01-03'),
  ];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing', source: 'ai_suggest' }],
    ['t2', { category_id: 'cat-marketing', source: 'ai_suggest' }],
    ['t3', { category_id: 'cat-marketing', source: 'ai_suggest' }],
  ]);
  const groups = groupByCounterparty(txs, catByTxId);
  const g = groups.get('Meta');
  assert.equal(g.catCounts.size, 0, 'ai_suggest mag niet in catCounts komen');
  assert.equal(g.count, 3, 'tx-count blijft correct (aggregatie werkt)');
  assert.equal(g.total, -600);
});

test('buildCounterpartyRows: rij zonder rule/manual (alleen ai_suggest) heeft category=null', () => {
  const txs = [mkTx('t1', 'Meta', -100, '2026-01-01')];
  const catByTxId = new Map([
    ['t1', { category_id: 'cat-marketing', source: 'ai_suggest' }],
  ]);
  const groups = groupByCounterparty(txs, catByTxId);
  const rows = buildCounterpartyRows(groups, CAT_META, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, null, 'ai_suggest telt NIET als bevestigde categorie');
});

// ── aiSuggestionsByCounterparty: aggregatie per counterparty ──────────────

test('aiSuggestionsByCounterparty: mode-category + avg confidence per counterparty', () => {
  const txs = [
    mkTx('t1', 'Meta', -100, '2026-01-01'),
    mkTx('t2', 'Meta', -200, '2026-01-02'),
    mkTx('t3', 'Meta', -300, '2026-01-03'),
  ];
  const aiSuggestByTxId = new Map([
    ['t1', { category_id: 'cat-marketing', ai_confidence: 0.9, ai_reason: 'Meta = ads platform' }],
    ['t2', { category_id: 'cat-marketing', ai_confidence: 0.8, ai_reason: 'Meta = ads platform' }],
    ['t3', { category_id: 'cat-marketing', ai_confidence: 0.85, ai_reason: 'Meta = ads platform' }],
  ]);
  const out = aiSuggestionsByCounterparty(txs, aiSuggestByTxId);
  assert.equal(out.size, 1);
  const meta = out.get('Meta');
  assert.equal(meta.category_id, 'cat-marketing');
  assert.equal(meta.tx_count, 3);
  assert.ok(meta.avg_confidence >= 0.84 && meta.avg_confidence <= 0.86);
  assert.equal(meta.sample_reason, 'Meta = ads platform');
});

test('aiSuggestionsByCounterparty: tegenpartijen zonder ai_suggest zijn niet in output', () => {
  const txs = [mkTx('t1', 'Meta', -100, '2026-01-01')];
  const aiSuggestByTxId = new Map();
  const out = aiSuggestionsByCounterparty(txs, aiSuggestByTxId);
  assert.equal(out.size, 0);
});

// ── filterTransactionsForBreakdown: per-tx incoming filter ──────────────
// PayPal-financieringslegs zijn al door excludePaypalFundingLegs eruit
// gehaald voordat deze filter draait. Wat als +tx binnenkomt is een echte
// klant-inkomst (Bas Express Checkout, 360dialog refund, etc.) en wordt
// standaard geskipt tenzij includeIncoming=true.

test('filterTransactionsForBreakdown: per-tx amount>=0 wordt geskipt (default)', () => {
  const txs = [
    mkTx('t1', 'Twilio', -3831, '2026-04-24'),   // echte pasbetaling
    mkTx('t2', 'Bas Van Leijden', 9625, '2026-01-15'),   // klant-inkomst
  ];
  const out = filterTransactionsForBreakdown(txs, null, null, { includeIncoming: false });
  assert.equal(out.length, 1, 'alleen -Af blijft');
  assert.equal(out[0].id, 't1');
});

test('filterTransactionsForBreakdown: includeIncoming=true laat +tx binnen', () => {
  const txs = [
    mkTx('t1', 'Twilio', -3831, '2026-04-24'),
    mkTx('t2', 'Bas Van Leijden', 9625, '2026-01-15'),
  ];
  const out = filterTransactionsForBreakdown(txs, null, null, { includeIncoming: true });
  assert.equal(out.length, 2);
});

test('filterTransactionsForBreakdown: -Af telt VOL (geen groep-som-netting meer)', () => {
  // Regressie-guard voor #973/#974: die netten -Af + +Bij van dezelfde
  // counterparty tot netto ~€0, waardoor Twilio als "geen uitgave" werd
  // geclassificeerd. Dit test bewijst dat -Af NU vol telt.
  const txs = [
    mkTx('t1', 'Twilio', -3831, '2026-04-24'),
    mkTx('t2', 'Twilio', -3514, '2025-11-24'),
    mkTx('t3', 'Twilio', -4305, '2025-08-24'),
  ];
  const out = filterTransactionsForBreakdown(txs, null, null, { includeIncoming: false });
  assert.equal(out.length, 3, 'alle 3 -Af pasbetalingen blijven zichtbaar');
  const sum = out.reduce((s, t) => s + t.amount_cents, 0);
  assert.equal(sum, -11650, 'som = -€116,50 (grondwaarheid Twilio)');
});

test('buildCounterpartyRows: uitgave-groep (negatieve g.total) blijft, inkomst-groep (positief) verdwijnt', () => {
  // Na excludePaypalFundingLegs bevat de groep alleen echte -Af of echte +Bij.
  // Twilio (na exclude): g.total = -11650 → blijft. Bas: g.total = +9625 → weg.
  const groups = new Map([
    ['Twilio', { total: -11650, count: 3, first: '2025-08-24', last: '2026-04-24', catCounts: new Map(), manualCount: 0 }],
    ['Bas',    { total:   9625, count: 1, first: '2026-01-15', last: '2026-01-15', catCounts: new Map(), manualCount: 0 }],
  ]);
  const rows = buildCounterpartyRows(groups, CAT_META, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Twilio');
  assert.equal(rows[0].total_cents, -11650, 'Twilio staat vol als -€116,50 uitgave (geen netting)');
});

test('aiSuggestionsByCounterparty: bij tie op cnt wint hoogste avg confidence', () => {
  const txs = [
    mkTx('t1', 'X', -1, '2026-01-01'),
    mkTx('t2', 'X', -1, '2026-01-01'),
  ];
  const aiSuggestByTxId = new Map([
    ['t1', { category_id: 'cat-a', ai_confidence: 0.6, ai_reason: 'A' }],
    ['t2', { category_id: 'cat-b', ai_confidence: 0.9, ai_reason: 'B' }],
  ]);
  const out = aiSuggestionsByCounterparty(txs, aiSuggestByTxId);
  const x = out.get('X');
  assert.equal(x.category_id, 'cat-b', 'tie → hoogste confidence wint');
});

// ── excludePaypalFundingLegs — financierings-leg + vasthouding uitsluiten ─
//
// Grondwaarheid (2860 rijen productie-data, bewezen tegen PayPal's eigen
// transactie-overzicht):
//   Twilio (3 pasbetalingen):  -€116,50 = -€38,31 + -€35,14 + -€43,05
//   Financieringslegs op Twilio: 3× +Overige (ref-join anchor) → uit
//   Netto na exclude:           -€116,50 (NIET €0,48, NIET €0)
//
// De -Af-pasbetaling TELT VOL. De +Overige-financieringsleg wordt UIT-
// gesloten (niet weggestreept). Detail-popup laat dus de 3 pasbetalingen
// apart zien.

function mkPayTx(id, name, cents, date, code, entryRef, endToEndId) {
  return {
    id,
    counterparty_name: name,
    amount_cents:      cents,
    booking_date:      date,
    source:            'paypal',
    transaction_code:  code || 'Algemene PayPal-bankpastransactie',
    entry_reference:   entryRef || null,
    end_to_end_id:     endToEndId || null,
  };
}

test('excludePaypalFundingLegs: Twilio Apr → -Af blijft VOL (€38,31), +Overige-leg weg', () => {
  const items = [
    mkPayTx('a1', 'TWILIO.COM', -3831, '2026-04-24', 'Algemene PayPal-bankpastransactie', 'REF-APR-24', null),
    mkPayTx('b1', 'TWILIO.COM',  3783, '2026-04-24', 'Overige',                             null,       'REF-APR-24'),
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 1, 'financieringsleg weg, -Af blijft');
  assert.equal(out[0].id, 'a1');
  assert.equal(out[0].amount_cents, -3831, '-Af TELT VOL (geen netting naar €0,48)');
});

test('excludePaypalFundingLegs: Twilio grondwaarheid = -€116,50 na exclude (3 pasbetalingen)', () => {
  // Regressie-guard tegen #972/#973/#974: die maakten hier respectievelijk
  // ~€116 (te veel), €0,48 en €0 van. Correcte antwoord = -€116,50.
  const items = [
    mkPayTx('af1', 'TWILIO.COM', -3831, '2026-04-24', 'Algemene PayPal-bankpastransactie', 'R-APR', null),
    mkPayTx('bg1', 'TWILIO.COM',  3783, '2026-04-24', 'Overige',                             null,   'R-APR'),
    mkPayTx('af2', 'TWILIO.COM', -3514, '2025-11-24', 'Algemene PayPal-bankpastransactie', 'R-NOV', null),
    mkPayTx('bg2', 'TWILIO.COM',  3514, '2025-11-24', 'Overige',                             null,   'R-NOV'),
    mkPayTx('af3', 'TWILIO.COM', -4305, '2025-08-24', 'Algemene PayPal-bankpastransactie', 'R-AUG', null),
    mkPayTx('bg3', 'TWILIO.COM',  4243, '2025-08-24', 'Overige',                             null,   'R-AUG'),
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 3, '3 pasbetalingen blijven, 3 financieringslegs weg');
  const sum = out.reduce((s, t) => s + t.amount_cents, 0);
  assert.equal(sum, -11650, 'totaal Twilio uitgaven = -€116,50 (grondwaarheid)');
  assert.ok(out.every(t => t.amount_cents < 0), 'alle overgebleven rijen zijn -Af');
});

test('excludePaypalFundingLegs: echte klant-inkomst (+Overige zonder -Af-parent) BLIJFT', () => {
  // 6 echte inkomsten op main-PayPal (2860-rijs analyse): 360dialog, Walmart,
  // Vercel, Linktree, Facebook. Signaal: +Overige met end_to_end_id dat GEEN
  // enkele -Af.entry_reference matcht → blijft doorgaan.
  const items = [
    mkPayTx('inc1', '360dialog GmbH', 1500, '2026-05-10', 'Overige', null, 'EXTERNAL-REF-XYZ'),
    mkPayTx('af1',  'Meta Platforms', -50000, '2026-05-10', 'Algemene PayPal-bankpastransactie', 'META-REF', null),
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 2, 'echte inkomst en -Af blijven beide');
  assert.ok(out.some(t => t.id === 'inc1'), '360dialog +Overige (geen -Af-parent) blijft');
  assert.ok(out.some(t => t.id === 'af1'), 'Meta -Af blijft');
});

test('excludePaypalFundingLegs: vasthouding uit — BEIDE zijden weg', () => {
  const items = [
    mkPayTx('hold1', 'PayPal', -20000, '2026-03-01', 'Vastgehouden - algemeen', 'HOLD-A', null),
    mkPayTx('rel1',  'PayPal',  20000, '2026-03-05', 'Terugboeking algemene vasthouding op rekeningniveau', 'HOLD-B', null),
    mkPayTx('af1',   'Zoom',   -10000, '2026-03-02', 'Algemene PayPal-bankpastransactie', 'ZOOM-REF', null),
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 1, 'vasthouding + terugboeking allebei weg');
  assert.equal(out[0].id, 'af1', 'echte -Af blijft');
});

test('excludePaypalFundingLegs: klant-inkomst Express Checkout blijft (geen -Af-parent)', () => {
  const items = [
    mkPayTx('k1', 'Bas Van Leijden', 9625, '2026-01-15', 'Express Checkout-betaling', null, null),
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].amount_cents, 9625, 'Express Checkout blijft — geen "Overige"-code, geen ref-join');
});

test('excludePaypalFundingLegs: CAMT-tx (source=camt) volledig onaangeroerd', () => {
  const items = [
    { id: 'c1', counterparty_name: 'Huurbaas', amount_cents: -100000, booking_date: '2026-01-01', source: 'camt', transaction_code: null, entry_reference: null, end_to_end_id: null },
    { id: 'c2', counterparty_name: 'ING klant', amount_cents: 50000,  booking_date: '2026-01-01', source: 'camt', transaction_code: null, entry_reference: null, end_to_end_id: null },
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 2, 'CAMT nooit gefilterd — dat is bank-data, geen PayPal-mechaniek');
});

test('excludePaypalFundingLegs: +Overige ZONDER end_to_end_id blijft (geen ref-join mogelijk)', () => {
  const items = [
    mkPayTx('af1',  'Merchant', -1000, '2026-03-10', 'Algemene PayPal-bankpastransactie', 'REF-A', null),
    mkPayTx('inc1', 'Anoniem',   500, '2026-03-11', 'Overige', null, null),   // geen ref
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 2, 'zonder ref kan geen leg-koppeling → blijft als (mogelijk) inkomst');
});

test('excludePaypalFundingLegs: vasthouding wordt GEEN anchor (voorkomt vals-positief)', () => {
  // Een +Overige met end_to_end_id gelijk aan een vasthouding's entry_reference
  // zou anders per ongeluk als "financieringsleg" worden uitgesloten. Test
  // bewijst dat de anchor-set alleen echte pasbetalingen bevat.
  const items = [
    mkPayTx('hold1', 'PayPal',  -5000, '2026-02-01', 'Vastgehouden - algemeen', 'HOLD-REF', null),
    mkPayTx('inc1',  'Klant X',  3000, '2026-02-02', 'Overige', null, 'HOLD-REF'),
  ];
  const out = excludePaypalFundingLegs(items);
  // Hold zelf weg (transaction_code check), maar inc1 blijft want vasthouding
  // is geen valid anchor voor de ref-join.
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'inc1', 'inkomst NIET verward met financieringsleg');
});

test('excludePaypalFundingLegs: lege input → lege output', () => {
  assert.deepEqual(excludePaypalFundingLegs([]), []);
  assert.deepEqual(excludePaypalFundingLegs(null), []);
});

test('excludePaypalFundingLegs: gemengde set (financiering + echte refund) — refund blijft', () => {
  // Refund via "Terugbetaling"-code (echte credit-terugbetaling, geen leg)
  // moet blijven. Alleen +Overige met -Af-parent is een financieringsleg.
  const items = [
    mkPayTx('af1',  'Merchant', -1000, '2026-03-10', 'Algemene PayPal-bankpastransactie', 'REF-A', null),
    mkPayTx('leg1', 'Merchant',   800, '2026-03-10', 'Overige',      null, 'REF-A'),      // leg → weg
    mkPayTx('ref1', 'Merchant',   500, '2026-03-15', 'Terugbetaling', null, null),         // echte refund → blijft
  ];
  const out = excludePaypalFundingLegs(items);
  assert.equal(out.length, 2, '-Af blijft + refund blijft; alleen leg weg');
  assert.ok(out.some(t => t.id === 'af1'));
  assert.ok(out.some(t => t.id === 'ref1'));
  assert.ok(!out.some(t => t.id === 'leg1'));
});
