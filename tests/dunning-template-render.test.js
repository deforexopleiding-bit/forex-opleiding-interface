// tests/dunning-template-render.test.js
//
// Regressietest voor api/_lib/dunning-template-render.js na de dot-notation-
// uitbreiding. Focus:
//   - Backward-compat: bestaande HOOFDLETTER-placeholders renderen identiek.
//   - Nieuwe dot-notation keys (klant.*, factuur.*) werken via delegatie
//     naar template-variables.resolveVariables.
//   - Gemengde templates (hoofdletter + dot-notation) renderen beide.
//   - Multi-factuur: totaal_open = som, factuur_lijst = alle, aantal_open = N.
//   - factuur.* single-keys wijzen naar de OUDSTE openstaande invoice.
//   - Onbekende placeholders blijven staan (geen throw, geen replace).
//   - Lege openInvoices → totaal 0, lege lijst, geen crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, pickOldestInvoice } from '../api/_lib/dunning-template-render.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeCustomer(overrides = {}) {
  return {
    first_name: 'Jeffrey',
    last_name:  'Biemold',
    company_name: null,
    email: 'jeffrey@example.com',
    phone: '+31612345678',
    ...overrides,
  };
}

function makeInvoice(overrides = {}) {
  return {
    id:             'inv-1',
    invoice_number: '2026-0001',
    amount_total:   100,
    amount_paid:    20,
    credited_amount: 0,
    due_date:       '2026-06-15',
    ...overrides,
  };
}

// ── Backward-compat (regressie-anker voor 12 productie-templates) ────────

test('BACKWARD-COMPAT: HOOFDLETTER-template rendert identiek aan pre-patch', () => {
  const customer = makeCustomer();
  const inv = makeInvoice(); // open = 100 - 20 = 80
  const r = renderTemplate({
    subject:      'Herinnering {{FACTUUR_NR}}',
    body:         'Hoi {{NAAM}}, je hebt {{TOTAAL_BEDRAG}} openstaand:\n{{FACTUUR_LIJST}}',
    customer,
    openInvoices: [inv],
  });
  assert.equal(r.subject, 'Herinnering 2026-0001');
  assert.equal(
    r.body,
    'Hoi Jeffrey Biemold, je hebt EUR 80,00 openstaand:\n- 2026-0001 (EUR 80,00)',
  );
  assert.equal(r.variables_used.NAAM, 'Jeffrey Biemold');
  assert.equal(r.variables_used.TOTAAL_BEDRAG, 'EUR 80,00');
  assert.equal(r.variables_used.FACTUUR_NR, '2026-0001');
});

test('BACKWARD-COMPAT: DAGEN_OVERDUE + VERVAL_DATUM werken op oudste due_date', () => {
  const customer = makeCustomer();
  const oud   = makeInvoice({ id: 'a', invoice_number: 'A', due_date: '2026-05-01' });
  const nieuw = makeInvoice({ id: 'b', invoice_number: 'B', due_date: '2026-06-15' });
  const r = renderTemplate({
    subject: '',
    body:    'Verval: {{VERVAL_DATUM}}, dagen: {{DAGEN_OVERDUE}}',
    customer,
    openInvoices: [nieuw, oud],
  });
  assert.match(r.body, /Verval: 01-05-2026/);
});

// ── Dot-notation: klant.* aggregates ─────────────────────────────────────

test('klant.totaal_open: 1 invoice → dat open bedrag', () => {
  const r = renderTemplate({
    subject: '',
    body:    'Totaal: {{klant.totaal_open}}',
    customer:     makeCustomer(),
    openInvoices: [makeInvoice({ amount_total: 100, amount_paid: 20 })], // open 80
  });
  assert.equal(r.body, 'Totaal: EUR 80,00');
});

test('klant.totaal_open: 3 invoices → som over alle open', () => {
  const r = renderTemplate({
    subject: '',
    body:    'Totaal: {{klant.totaal_open}}',
    customer:     makeCustomer(),
    openInvoices: [
      makeInvoice({ id: 'a', amount_total: 100, amount_paid: 0 }),   // 100
      makeInvoice({ id: 'b', amount_total: 50,  amount_paid: 0 }),   // 50
      makeInvoice({ id: 'c', amount_total: 30,  amount_paid: 10 }),  // 20
    ],
  });
  assert.equal(r.body, 'Totaal: EUR 170,00');
});

test('klant.factuur_lijst: multi-invoice → bullet-lijst met alle', () => {
  const r = renderTemplate({
    subject: '',
    body:    '{{klant.factuur_lijst}}',
    customer:     makeCustomer(),
    openInvoices: [
      makeInvoice({ id: 'a', invoice_number: 'A-1', amount_total: 50, amount_paid: 0 }),
      makeInvoice({ id: 'b', invoice_number: 'B-2', amount_total: 30, amount_paid: 0 }),
    ],
  });
  assert.equal(r.body, '- A-1 (EUR 50,00)\n- B-2 (EUR 30,00)');
});

test('klant.aantal_open: klopt bij 1 en bij 3', () => {
  const r1 = renderTemplate({
    subject: '', body: '{{klant.aantal_open}} facturen',
    customer: makeCustomer(), openInvoices: [makeInvoice()],
  });
  const r3 = renderTemplate({
    subject: '', body: '{{klant.aantal_open}} facturen',
    customer: makeCustomer(),
    openInvoices: [makeInvoice({id:'a'}), makeInvoice({id:'b'}), makeInvoice({id:'c'})],
  });
  assert.equal(r1.body, '1 facturen');
  assert.equal(r3.body, '3 facturen');
});

test('klant.naam: persoon → voornaam+achternaam; bedrijf → bedrijfsnaam', () => {
  const rP = renderTemplate({
    subject: '', body: '{{klant.naam}}',
    customer:     makeCustomer(),
    openInvoices: [makeInvoice()],
  });
  const rB = renderTemplate({
    subject: '', body: '{{klant.naam}}',
    customer:     makeCustomer({ first_name: null, last_name: null, company_name: 'Acme B.V.' }),
    openInvoices: [makeInvoice()],
  });
  assert.equal(rP.body, 'Jeffrey Biemold');
  assert.equal(rB.body, 'Acme B.V.');
});

test('klant.voornaam: alleen de voornaam', () => {
  const r = renderTemplate({
    subject: '', body: 'Hoi {{klant.voornaam}}',
    customer:     makeCustomer(),
    openInvoices: [makeInvoice()],
  });
  assert.equal(r.body, 'Hoi Jeffrey');
});

// ── Gemengde template (hoofdletter + dot-notation) ───────────────────────

test('GEMENGD: hoofdletter en dot-notation door elkaar → beide renderen', () => {
  const r = renderTemplate({
    subject: '',
    body:    'Hoi {{klant.voornaam}} ({{NAAM}}), {{klant.totaal_open}} = {{TOTAAL_BEDRAG}}',
    customer:     makeCustomer(),
    openInvoices: [makeInvoice({ amount_total: 100, amount_paid: 20 })], // 80
  });
  assert.equal(r.body, 'Hoi Jeffrey (Jeffrey Biemold), EUR 80,00 = EUR 80,00');
  // Beide sets in variables_used gemeld.
  assert.equal(r.variables_used['klant.voornaam'], 'Jeffrey');
  assert.equal(r.variables_used['klant.totaal_open'], 'EUR 80,00');
  assert.equal(r.variables_used.NAAM, 'Jeffrey Biemold');
  assert.equal(r.variables_used.TOTAAL_BEDRAG, 'EUR 80,00');
});

// ── factuur.* single-keys → OUDSTE invoice ───────────────────────────────

test('factuur.nummer bij multi-invoice → OUDSTE (grootste dagen-overdue)', () => {
  const oud   = makeInvoice({ id: 'a', invoice_number: 'OUD',   due_date: '2026-05-01' });
  const nieuw = makeInvoice({ id: 'b', invoice_number: 'NIEUW', due_date: '2026-06-15' });
  const r = renderTemplate({
    subject: '',
    body:    'Oudste: {{factuur.nummer}} verval {{factuur.vervaldatum}}',
    customer:     makeCustomer(),
    openInvoices: [nieuw, oud],
  });
  assert.match(r.body, /Oudste: OUD/);
  assert.match(r.body, /verval 01-05-2026/);
});

test('pickOldestInvoice: geen due_date → fallback naar eerste invoice', () => {
  const invs = [makeInvoice({ id: 'x', due_date: null }), makeInvoice({ id: 'y', due_date: null })];
  const picked = pickOldestInvoice(invs);
  assert.equal(picked?.id, 'x');
});

test('pickOldestInvoice: lege lijst → null', () => {
  assert.equal(pickOldestInvoice([]), null);
  assert.equal(pickOldestInvoice(null), null);
});

// ── Onbekende placeholder / edge cases ───────────────────────────────────

test('Onbekende placeholder (dot) blijft staan (geen throw)', () => {
  const r = renderTemplate({
    subject: '',
    body:    'Iets: {{onbestaand.key}} en {{FOOBAR}}',
    customer: makeCustomer(),
    openInvoices: [makeInvoice()],
  });
  // Onbekende named-key + onbekende hoofdletter-key blijven allebei staan.
  assert.equal(r.body, 'Iets: {{onbestaand.key}} en {{FOOBAR}}');
});

test('Lege openInvoices → totaal 0, lege lijst, geen crash', () => {
  const r = renderTemplate({
    subject: '',
    body:    '{{klant.totaal_open}} | {{klant.aantal_open}} | [{{klant.factuur_lijst}}] | {{TOTAAL_BEDRAG}}',
    customer:     makeCustomer(),
    openInvoices: [],
  });
  assert.equal(r.body, 'EUR 0,00 | 0 | [] | EUR 0,00');
});

test('subject null / body null → geen crash, lege strings terug', () => {
  const r = renderTemplate({ subject: null, body: null, customer: makeCustomer(), openInvoices: [] });
  assert.equal(r.subject, '');
  assert.equal(r.body, '');
});
