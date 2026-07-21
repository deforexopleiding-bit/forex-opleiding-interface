// tests/dunning-wa-enkel-factuur.test.js
//
// Regressietest: enkel-factuur dot-notation body's -> exact het juiste
// aantal Meta-params in de juiste volgorde per template. Voorkomt Meta
// #132000 die optrad toen de body's 4 hoofdletter-vars hadden (mismatch
// met de 5-var dag7 / 4-var dag14-37 Meta-templates).
//
// Test dekt:
//   - dag7: 5 dot-notation placeholders (voornaam · nummer · bedrag ·
//     vervaldatum · betaal_link)
//   - dag14: 4 dot-notation placeholders (voornaam · nummer · bedrag ·
//     dagen_overdue) — factuur.dagen_overdue bestond al in
//     template-variables.js, wordt hier expliciet getest.
//   - factuur.bedrag levert KAAL bedrag (geen dubbele EUR met de "EUR "
//     die vóór de placeholder in de body staat)
//   - factuur.betaal_link uit invoice.payment_url (pre-fetch simulatie)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../api/_lib/dunning-template-render.js';
import { buildMetaTemplateVariables } from '../api/_lib/dunning-step-executors.js';

const DAG7_BODY =
  'Hoi {{klant.voornaam}},\n' +
  'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' +
  'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' +
  'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}\n' +
  'Met vriendelijke groeten,\n' +
  'Team De Forex Opleiding';

const DAG14_BODY =
  'Hoi {{klant.voornaam}},\n' +
  'Factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat inmiddels {{factuur.dagen_overdue}} dagen open. We hebben nog geen betaling ontvangen.\n' +
  'Wil je vandaag betalen, of laat je ons even weten wanneer het lukt? Dan houden we het netjes samen.\n' +
  'Team De Forex Opleiding';

function fixtureCustomer() {
  return { first_name: 'Karl', last_name: 'Test', company_name: null };
}
function fixtureInvoice(overrides = {}) {
  // due_date = ver in het verleden zodat factuur.dagen_overdue >0 is
  // (relatief aan test-run tijd — precieze waarde niet asserten).
  return {
    id: 'inv-1',
    invoice_number: '2026-0001',
    amount_total: 160,
    amount_paid: 0,
    credited_amount: 0,
    due_date: '2020-01-01',
    payment_url: 'https://focus.teamleader.eu/pay/abc123',
    ...overrides,
  };
}

// ── dag7 (5 params) ───────────────────────────────────────────────────────

test('dag7: renderTemplate resolvet alle 5 dot-notation keys', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ due_date: '2026-07-14' })],
  });
  assert.equal(/\{\{[^}]+\}\}/.test(r.body), false, 'geen niet-gerenderde placeholders');
  assert.match(r.body, /Hoi Karl,/);
  assert.match(r.body, /factuur 2026-0001/);
  assert.match(r.body, /EUR 160,00 staat nog open/); // "EUR " + kaal "160,00" = geen dubbele EUR
  assert.match(r.body, /De vervaldatum was 14-07-2026/);
  assert.match(r.body, /te betalen https:\/\/focus\.teamleader\.eu\/pay\/abc123/);
});

test('dag7: buildMetaTemplateVariables -> exact 5 params in body-volgorde', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ due_date: '2026-07-14' })],
  });
  const params = buildMetaTemplateVariables(DAG7_BODY, r.variables_used || {});
  assert.equal(params.length, 5, 'exact 5 positionele params (Meta #132000-fix)');
  assert.equal(params[0], 'Karl');
  assert.equal(params[1], '2026-0001');
  assert.equal(params[2], '160,00');            // KAAL, geen "EUR " prefix
  assert.equal(params[3], '14-07-2026');
  assert.equal(params[4], 'https://focus.teamleader.eu/pay/abc123');
});

test('dag7: geen dubbele EUR (bedrag is kaal)', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ amount_total: 1234.56, due_date: '2026-07-14' })],
  });
  assert.match(r.body, /EUR 1\.234,56 staat/);
  assert.equal(/EUR EUR/.test(r.body), false, 'geen dubbele EUR-prefix');
});

test('dag7: zonder payment_url op invoice -> betaal_link leeg (bewijst noodzaak pre-fetch)', () => {
  // Deze test bewijst WAAROM de executor de link pre-fetcht. Zonder pre-
  // fetch zou de 5e param leeg zijn -> Meta #132000 of kaal bericht.
  // Executor zit fail-CLOSED: whatsapp_skipped_no_payment_link.
  const inv = fixtureInvoice({ payment_url: null, due_date: '2026-07-14' });
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [inv],
  });
  const params = buildMetaTemplateVariables(DAG7_BODY, r.variables_used || {});
  assert.equal(params.length, 5, 'aantal blijft 5 (placeholder aanwezig)');
  assert.equal(params[4], '', 'link leeg zonder pre-fetch');
});

// ── dag14 (4 params: dagen_overdue) ───────────────────────────────────────

test('dag14: renderTemplate resolvet alle 4 dot-notation keys', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG14_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice()],
  });
  assert.equal(/\{\{[^}]+\}\}/.test(r.body), false, 'geen niet-gerenderde placeholders');
  assert.match(r.body, /Hoi Karl,/);
  assert.match(r.body, /Factuur 2026-0001 van EUR 160,00/);
  assert.match(r.body, /staat inmiddels \d+ dagen open/, 'dagen_overdue is een getal');
});

test('dag14: buildMetaTemplateVariables -> exact 4 params in body-volgorde', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG14_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice()],
  });
  const params = buildMetaTemplateVariables(DAG14_BODY, r.variables_used || {});
  assert.equal(params.length, 4, 'exact 4 positionele params (dag14/17/21/37 pattern)');
  assert.equal(params[0], 'Karl');
  assert.equal(params[1], '2026-0001');
  assert.equal(params[2], '160,00');
  // 4e param = dagen_overdue — getal-string, >=0
  assert.match(params[3], /^\d+$/, 'dagen_overdue = getal-string');
  assert.ok(Number(params[3]) > 0, 'dagen_overdue > 0 met due_date in verre verleden');
});

test('dag14: factuur.dagen_overdue = 0 als due_date in toekomst', () => {
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const r = renderTemplate({
    subject: '',
    body: DAG14_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ due_date: future })],
  });
  const params = buildMetaTemplateVariables(DAG14_BODY, r.variables_used || {});
  assert.equal(params[3], '0', 'dagen_overdue = 0 bij toekomstige due_date');
});

// ── factuur.bedrag kaal (breaking change regressie) ──────────────────────

test('factuur.bedrag levert KAAL bedrag (breaking change 2026-07-21)', () => {
  const r = renderTemplate({
    subject: '',
    body: 'Bedrag: {{factuur.bedrag}}',
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ amount_total: 100 })],
  });
  assert.equal(r.body, 'Bedrag: 100,00', 'factuur.bedrag zonder EUR-prefix');
  assert.equal(r.variables_used['factuur.bedrag'], '100,00');
});

test('factuur.bedrag met eigen "EUR " ervoor -> geen dubbele prefix', () => {
  const r = renderTemplate({
    subject: '',
    body: 'Openstaand: EUR {{factuur.bedrag}}',
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ amount_total: 42.5 })],
  });
  assert.equal(r.body, 'Openstaand: EUR 42,50');
});
