// tests/deal-classify.test.js
//
// Verifieert dat api/_lib/deal-classify.js EXACT overeenkomt met de
// classificatie-regels die Jeffrey heeft goedgekeurd (aug 2026).
// Elke sample die faalt = mapping uit sync met de productie-data-heuristiek.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeal, CATEGORY_LABELS, CATEGORY_ORDER, _internals } from '../api/_lib/deal-classify.js';

const { normalize, classifyLineItemFamily, extractDurationMonths, lineItemCategory } = _internals;

// ── normalize ─────────────────────────────────────────────────────

test('normalize: strip non-alfanum + collapse whitespace + lowercase', () => {
  assert.equal(normalize('Alpha-Gramma 12 MND!!'), 'alpha gramma 12 mnd');
  assert.equal(normalize('  1-OP-1  BEGELEIDING  '), '1 op 1 begeleiding');
  assert.equal(normalize('E-book'), 'e book');
  assert.equal(normalize(null), '');
});

// ── Family — E-book eerst ────────────────────────────────────────

test('family: E-book wint van andere keywords', () => {
  assert.equal(classifyLineItemFamily('E-book'), 'ebook');
  assert.equal(classifyLineItemFamily('E book'), 'ebook');
  assert.equal(classifyLineItemFamily('Ebook (welkomsboek)'), 'ebook');
});

// ── Family — Non-traject ─────────────────────────────────────────

test('family: non-traject producten', () => {
  assert.equal(classifyLineItemFamily('Lascursus 6 maanden'), 'non_traject');
  assert.equal(classifyLineItemFamily('IT Consultancy'), 'non_traject');
  assert.equal(classifyLineItemFamily('Commisie in zake See Finance'), 'non_traject');
  assert.equal(classifyLineItemFamily('Commissie See Finance'), 'non_traject');
});

// ── Family — 1-op-1 keywords + Delta + typfouten ─────────────────

test('family: Alpha varianten', () => {
  assert.equal(classifyLineItemFamily('Alpha programma 12 maanden'), '1-op-1');
  assert.equal(classifyLineItemFamily('ALPHA'), '1-op-1');
  assert.equal(classifyLineItemFamily('Alfha 6 maanden'), '1-op-1');
  assert.equal(classifyLineItemFamily('Apha programma'), '1-op-1');
  assert.equal(classifyLineItemFamily('Alpha Gramma'), '1-op-1'); // Alpha wint van Gramma
});

test('family: Delta varianten (nieuwe)', () => {
  assert.equal(classifyLineItemFamily('Delta programma 12 maanden'), '1-op-1');
  assert.equal(classifyLineItemFamily('Delta program'), '1-op-1');
  assert.equal(classifyLineItemFamily('DELTA'), '1-op-1');
  assert.equal(classifyLineItemFamily('Deltha 6 mnd'), '1-op-1');
});

test('family: Mentorship + varianten', () => {
  assert.equal(classifyLineItemFamily('Mentorship 12 maanden'), '1-op-1');
  assert.equal(classifyLineItemFamily('Mentorshiptraject'), '1-op-1');
  assert.equal(classifyLineItemFamily('Mentorship Management'), '1-op-1');
  assert.equal(classifyLineItemFamily('1-1 Mentorship 12M'), '1-op-1');
});

test('family: 1-op-1 spelvarianten', () => {
  assert.equal(classifyLineItemFamily('1-OP-1 BEGELEIDING 12 MAANDEN'), '1-op-1');
  assert.equal(classifyLineItemFamily('1 op 1 begeleiding'), '1-op-1');
  assert.equal(classifyLineItemFamily('Begeleiding 24 maanden'), '1-op-1');
});

// ── Family — Membership + Lifetime + typfouten ───────────────────

test('family: membership varianten', () => {
  assert.equal(classifyLineItemFamily('Gamma programma 12 maanden'), 'membership');
  assert.equal(classifyLineItemFamily('Membership 36 maanden'), 'membership');
  assert.equal(classifyLineItemFamily('Memberschip 36 maanden'), 'membership'); // typfout
  assert.equal(classifyLineItemFamily('ZELFSTUDIETRAJECT 12 MAANDEN'), 'membership');
  assert.equal(classifyLineItemFamily('Zelfstudie'), 'membership');            // zonder 'traject'
  assert.equal(classifyLineItemFamily('ZFSTUDIETRAJECT'), 'membership');       // typfout
  assert.equal(classifyLineItemFamily('Lidmaatschap'), 'membership');
});

test('family: lifetime → membership', () => {
  assert.equal(classifyLineItemFamily('Lifetime toegang'), 'membership');
  assert.equal(classifyLineItemFamily('Membership lifetime toegang'), 'membership');
  assert.equal(classifyLineItemFamily('Gamma programma lifetime toegang'), 'membership');
});

test('family: unknown voor echt onbekende producten', () => {
  assert.equal(classifyLineItemFamily('Setup fee'), 'unknown');
  assert.equal(classifyLineItemFamily('Coaching sessie'), 'unknown');
  assert.equal(classifyLineItemFamily(''), 'unknown');
});

// ── Duration extract inclusief typfouten ─────────────────────────

test('duration: standaard', () => {
  assert.equal(extractDurationMonths('Alpha programma 12 maanden'), 12);
  assert.equal(extractDurationMonths('6 mnd traject'), 6);
  assert.equal(extractDurationMonths('24 maand'), 24);
  assert.equal(extractDurationMonths('1-1 Mentorship 12M'), 12);
  assert.equal(extractDurationMonths('Membership 36 maanden'), 36);
  assert.equal(extractDurationMonths('Membership 48 maanden'), 48);
});

test('duration: typfouten (maaanden = 3×a)', () => {
  assert.equal(extractDurationMonths('Membership 36 maaanden'), 36);
  assert.equal(extractDurationMonths('12 maaand'), 12);
});

test('duration: null als lifetime of geen getal', () => {
  assert.equal(extractDurationMonths('Lifetime toegang'), null);
  assert.equal(extractDurationMonths('Alpha programma'), null);
  assert.equal(extractDurationMonths('E-book'), null);
});

// ── Line-item categorie ──────────────────────────────────────────

test('lineItemCategory: 1-op-1 buckets', () => {
  assert.equal(lineItemCategory('Alpha programma 6 maanden'), 'm6');
  assert.equal(lineItemCategory('Delta programma 12 maanden'), 'm12');
  assert.equal(lineItemCategory('Alpha 24 mnd'), 'm24');
  assert.equal(lineItemCategory('Alpha programma 3 maanden'), 'm_other');
  assert.equal(lineItemCategory('Alfha programma'), 'm_other'); // geen duur
});

test('lineItemCategory: membership samengevoegd (incl lifetime)', () => {
  assert.equal(lineItemCategory('Gamma programma 3 maanden'), 'mem');
  assert.equal(lineItemCategory('Membership 36 maaanden'), 'mem');
  assert.equal(lineItemCategory('Membership 48 maanden'), 'mem');
  assert.equal(lineItemCategory('Lifetime toegang'), 'mem');
  assert.equal(lineItemCategory('Zelfstudie'), 'mem');
});

test('lineItemCategory: non-traject → other_product', () => {
  assert.equal(lineItemCategory('Lascursus 6 maanden'), 'other_product');
  assert.equal(lineItemCategory('IT Consultancy'), 'other_product');
  assert.equal(lineItemCategory('Commisie in zake See Finance'), 'other_product');
});

test('lineItemCategory: ebook + unknown behouden hun sentinel', () => {
  assert.equal(lineItemCategory('E-book'), 'ebook');
  assert.equal(lineItemCategory('Setup fee'), 'unknown');
});

// ── classifyDeal: variant-route (nieuwe deals) ────────────────────

test('classifyDeal: variant-route wint als traject_variant_id gezet', () => {
  const variantById = new Map([
    ['v1', { id: 'v1', name: '1op1 6mnd', default_duration_months: 6, trajects: { name: '1-op-1' } }],
    ['v2', { id: 'v2', name: 'Membership', default_duration_months: 12, trajects: { name: 'Membership' } }],
  ]);
  assert.equal(classifyDeal({ traject_variant_id: 'v1' }, { variantById }).category, 'm6');
  assert.equal(classifyDeal({ traject_variant_id: 'v2' }, { variantById }).category, 'mem');
});

test('classifyDeal: variant met membership-naam → mem ongeacht duur', () => {
  const variantById = new Map([
    ['vm6', { id: 'vm6', name: 'Membership kort', default_duration_months: 6, trajects: { name: 'Membership' } }],
  ]);
  assert.equal(classifyDeal({ traject_variant_id: 'vm6' }, { variantById }).category, 'mem');
});

// ── classifyDeal: line-item route (TL-imports) ────────────────────

test('classifyDeal: TL-import Alpha 12mnd → m12', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    { lineItems: [{ product_name: 'Alpha programma 12 maanden', unit_price: 3500, quantity: 1 }], variantById: new Map() }
  );
  assert.equal(r.category, 'm12');
  assert.equal(r.source, 'lineitems');
});

test('classifyDeal: TL-import Delta 12mnd → m12 (nieuwe familie)', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    { lineItems: [{ product_name: 'Delta programma 12 maanden', unit_price: 3500, quantity: 1 }], variantById: new Map() }
  );
  assert.equal(r.category, 'm12');
});

test('classifyDeal: TL-import Lifetime → mem', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    { lineItems: [{ product_name: 'Gamma programma lifetime toegang', unit_price: 1500, quantity: 1 }], variantById: new Map() }
  );
  assert.equal(r.category, 'mem');
});

test('classifyDeal: TL-import Memberschip 36 maaanden → mem', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    { lineItems: [{ product_name: 'Memberschip 36 maaanden', unit_price: 1200, quantity: 1 }], variantById: new Map() }
  );
  assert.equal(r.category, 'mem');
});

test('classifyDeal: TL-import met E-book + Alpha 12mnd → m12 (E-book genegeerd)', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    {
      lineItems: [
        { product_name: 'E-book', unit_price: 39, quantity: 1 },
        { product_name: 'Alpha programma 12 maanden', unit_price: 3500, quantity: 1 },
      ],
      variantById: new Map(),
    }
  );
  assert.equal(r.category, 'm12');
});

test('classifyDeal: TL-import met Non-traject + Alpha 12mnd → m12 (non-traject genegeerd voor typebepaling)', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    {
      lineItems: [
        { product_name: 'IT Consultancy', unit_price: 500, quantity: 1 },
        { product_name: 'Alpha programma 12 maanden', unit_price: 3500, quantity: 1 },
      ],
      variantById: new Map(),
    }
  );
  assert.equal(r.category, 'm12');
});

test('classifyDeal: conflict — Alpha 12mnd + Gamma 6mnd → duurste wint (Alpha)', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    {
      lineItems: [
        { product_name: 'Gamma programma 6 maanden', unit_price: 800,  quantity: 1 },
        { product_name: 'Alpha programma 12 maanden', unit_price: 3500, quantity: 1 },
      ],
      variantById: new Map(),
    }
  );
  assert.equal(r.category, 'm12');
});

test('classifyDeal: Lascursus alleen (geen traject) → other_product', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    { lineItems: [{ product_name: 'Lascursus 6 maanden', unit_price: 1500, quantity: 1 }], variantById: new Map() }
  );
  assert.equal(r.category, 'other_product');
});

test('classifyDeal: alleen E-book + unknown → unknown', () => {
  const r = classifyDeal(
    { traject_variant_id: null, source: 'tl_import' },
    {
      lineItems: [
        { product_name: 'E-book', unit_price: 39, quantity: 1 },
        { product_name: 'Setup fee', unit_price: 100, quantity: 1 },
      ],
      variantById: new Map(),
    }
  );
  assert.equal(r.category, 'unknown');
});

test('classifyDeal: geen line-items en geen variant → unknown', () => {
  const r = classifyDeal({ traject_variant_id: null }, { lineItems: [], variantById: new Map() });
  assert.equal(r.category, 'unknown');
  assert.equal(r.source, 'fallback');
});

// ── UI-labels ────────────────────────────────────────────────────

test('CATEGORY_LABELS bevat alle 7 categorieën', () => {
  for (const key of CATEGORY_ORDER) {
    assert.ok(CATEGORY_LABELS[key], `label mist voor ${key}`);
  }
  assert.equal(CATEGORY_ORDER.length, 7);
});
