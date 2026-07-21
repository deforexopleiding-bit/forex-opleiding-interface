// tests/dunning-wa-enkel-factuur.test.js
//
// Regressietest: enkel-factuur dag-7 dot-notation body -> exact 5 Meta-
// params in de juiste volgorde. Voorkomt de Meta #132000 die optrad toen
// de body 4 hoofdletter-vars had (mismatch met de goedgekeurde 5-var
// Meta-template).
//
// Test dekt:
//   - renderTemplate rendert alle 5 dot-notation placeholders
//   - buildMetaTemplateVariables bouwt exact 5 params in body-volgorde
//   - factuur.bedrag_kaal levert kaal bedrag (geen dubbele EUR met "EUR "
//     die vóór de placeholder in de body staat)
//   - factuur.betaal_link wordt correct opgepikt uit invoice.payment_url
//     (pre-fetch is executor-verantwoordelijkheid; hier simuleren we door
//     invoice.payment_url vooraf te setten)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../api/_lib/dunning-template-render.js';
import { buildMetaTemplateVariables } from '../api/_lib/dunning-step-executors.js';

const DAG7_BODY =
  'Hoi {{klant.voornaam}},\n' +
  'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag_kaal}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' +
  'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' +
  'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}\n' +
  'Met vriendelijke groeten,\n' +
  'Team De Forex Opleiding';

function fixtureCustomer() {
  return { first_name: 'Karl', last_name: 'Test', company_name: null };
}
function fixtureInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    invoice_number: '2026-0001',
    amount_total: 160,
    amount_paid: 0,
    credited_amount: 0,
    due_date: '2026-07-14',
    payment_url: 'https://focus.teamleader.eu/pay/abc123',
    ...overrides,
  };
}

test('dag7 body: renderTemplate resolvet alle 5 dot-notation keys', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice()],
  });
  // Alle 5 placeholders zijn vervangen (geen {{...}} meer in de body).
  assert.equal(/\{\{[^}]+\}\}/.test(r.body), false, 'geen niet-gerenderde placeholders in body');
  // Concrete waarden aanwezig
  assert.match(r.body, /Hoi Karl,/);
  assert.match(r.body, /factuur 2026-0001/);
  assert.match(r.body, /EUR 160,00 staat nog open/); // "EUR " + kaal "160,00" = geen dubbele EUR
  assert.match(r.body, /De vervaldatum was 14-07-2026/);
  assert.match(r.body, /te betalen https:\/\/focus\.teamleader\.eu\/pay\/abc123/);
});

test('dag7 body: geen dubbele EUR (bedrag_kaal doet z\'n werk)', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice({ amount_total: 1234.56 })],
  });
  assert.match(r.body, /EUR 1\.234,56 staat/);
  assert.equal(/EUR EUR/.test(r.body), false, 'geen dubbele EUR-prefix');
});

test('dag7 body: buildMetaTemplateVariables → exact 5 params in body-volgorde', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [fixtureInvoice()],
  });
  const params = buildMetaTemplateVariables(DAG7_BODY, r.variables_used || {});
  assert.equal(params.length, 5, 'exact 5 positionele params (Meta #132000-fix)');
  // Volgorde: klant.voornaam, factuur.nummer, factuur.bedrag_kaal, factuur.vervaldatum, factuur.betaal_link
  assert.equal(params[0], 'Karl');
  assert.equal(params[1], '2026-0001');
  assert.equal(params[2], '160,00');
  assert.equal(params[3], '14-07-2026');
  assert.equal(params[4], 'https://focus.teamleader.eu/pay/abc123');
});

test('dag7 body: factuur.betaal_link uit invoice.payment_url (pre-fetch-simulatie)', () => {
  const inv = fixtureInvoice({ payment_url: 'https://focus.teamleader.eu/pay/karl-secret-token' });
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [inv],
  });
  assert.match(r.body, /karl-secret-token/);
  const params = buildMetaTemplateVariables(DAG7_BODY, r.variables_used || {});
  assert.equal(params[4], 'https://focus.teamleader.eu/pay/karl-secret-token');
});

test('dag7 body: zonder payment_url op invoice → betaal_link leeg (bewijst noodzaak pre-fetch)', () => {
  // Deze test bewijst WAAROM de executor de link pre-fetcht. Zonder pre-fetch
  // zou de 5e param leeg zijn → Meta #132000 of kaal bericht met "…te
  // betalen ." Daarom fail-CLOSED skip in executor als link niet beschikbaar.
  const inv = fixtureInvoice({ payment_url: null });
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: fixtureCustomer(),
    openInvoices: [inv],
  });
  const params = buildMetaTemplateVariables(DAG7_BODY, r.variables_used || {});
  assert.equal(params.length, 5, 'aantal blijft 5 — placeholder was in body');
  assert.equal(params[4], '', 'link is leeg zonder pre-fetch');
});

test('dag7 body: voornaam leeg → param blijft aanwezig als lege string', () => {
  const r = renderTemplate({
    subject: '',
    body: DAG7_BODY,
    customer: { first_name: '', last_name: 'Test' },
    openInvoices: [fixtureInvoice()],
  });
  const params = buildMetaTemplateVariables(DAG7_BODY, r.variables_used || {});
  assert.equal(params.length, 5);
  assert.equal(params[0], '');
});
