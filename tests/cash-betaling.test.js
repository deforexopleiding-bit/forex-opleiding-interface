// tests/cash-betaling.test.js
//
// CASHBETALING REGISTREREN (Maxim, 6 nov 2026).
//   * de factuur blijft staan, NIETS wordt gecrediteerd;
//   * gewone betaalflow: Teamleader registerPayment (met payment_method_id
//     van "cash"), payments-rij met payment_method 'cash', factuurmotor;
//   * deelbetaling mag; notitie en "ontvangen door" verplicht;
//   * ontvangstbewijs (PDF) zonder interne notitie; niets wordt verstuurd;
//   * een gecrediteerde factuur krijgt geen cashbetaling en telt nooit als betaald;
//   * zonder migratie: 503, niets naar Teamleader.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
const tl = { calls: [], methodes: [{ id: 'pm-bank', name: 'Overschrijving', status: 'active' }, { id: 'pm-cash', name: 'Contant', status: 'active' }], registerStatus: 204 };
const motor = { calls: [] };
const meldingen = [];

function antwoord(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/teamleader-token.js'), {
  namedExports: {
    tlFetch: async (path, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      tl.calls.push({ path, body });
      if (path === '/paymentMethods.list') return antwoord(200, { data: tl.methodes });
      if (path === '/invoices.registerPayment') {
        if (tl.registerStatus !== 204) return antwoord(tl.registerStatus, { errors: [{ title: 'payment_method_id is invalid' }] });
        const inv = db.rows('invoices').find((i) => i.tl_invoice_id === body.id);
        inv._tlBetaald = (inv._tlBetaald ?? inv.amount_paid) + body.payment.amount;
        return new Response(null, { status: 204 });
      }
      if (path === '/invoices.info') {
        const inv = db.rows('invoices').find((i) => i.tl_invoice_id === body.id);
        const betaald = inv._tlBetaald ?? inv.amount_paid;
        return antwoord(200, { data: { status: 'outstanding', paid: betaald >= inv.amount_total, total: { payable: { amount: inv.amount_total }, due: { amount: inv.amount_total - betaald } } } });
      }
      return antwoord(404, { errors: [{ title: 'onbekend pad ' + path }] });
    },
  },
});
mock.module(url('api/_lib/mentor-ledger-engine.js'), { namedExports: { releaseProportionalForPaidAmount: async (o) => { motor.calls.push(o); return { total_released: 0 }; } } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async (n) => { meldingen.push(n); return { ok: true }; } } });
mock.module(url('api/_lib/factuurstand-spiegel.js'), { namedExports: { spiegelFactuurstandNaWijziging: async () => {} } });
mock.module(url('api/_lib/dunning-pipeline.js'), { namedExports: { isAutoEnabled: async () => false, schedulePaidResolve: async () => {} } });
mock.module(url('api/_lib/sales-bonus.js'), { namedExports: { earnBonusForPaidInvoice: async () => {} } });

const cash = await import(url('api/_lib/cash-betaling.js'));
const { betaalmethodenVan } = await import(url('api/_lib/betaalmethode.js'));
const { bewijsRegels, bouwOntvangstbewijsPdf } = await import(url('api/_lib/cash-ontvangstbewijs-pdf.js'));
const { bouwMaandlijst } = await import(url('api/_lib/incasso-maandlijst.js'));

const INV = 'aaaaaaaa-0000-4000-8000-000000000001';
const KLANT = 'cccccccc-0000-4000-8000-000000000001';
const USER = 'eeeeeeee-0000-4000-8000-000000000001';
const VANDAAG = '2026-11-06';

function zet({ factuur = {}, missing = [], instelling = null } = {}) {
  db.reset({
    invoices: [{ id: INV, customer_id: KLANT, invoice_number: '2026 / 3001', tl_invoice_id: 'tl-3001', amount_total: 400, amount_paid: 0, credited_amount: 0, status: 'open', ...factuur }],
    payments: [], cash_ontvangsten: [], audit_log: [],
    app_settings: instelling ? [{ key: 'teamleader_cash_payment_method_id', value: instelling }] : [],
  }, missing);
  tl.calls = []; motor.calls = []; meldingen.length = 0; tl.registerStatus = 204;
  tl.methodes = [{ id: 'pm-bank', name: 'Overschrijving', status: 'active' }, { id: 'pm-cash', name: 'Contant', status: 'active' }];
}
const body = (extra = {}) => ({ invoice_id: INV, amount: 150, paid_at: '2026-11-05', ontvangen_door: 'Dave', notitie: 'Betaald na de masterclass', ...extra });
const opts = { userId: USER, ipAddress: '1.2.3.4', vandaag: VANDAAG };

beforeEach(() => zet());

// ── Invoer ───────────────────────────────────────────────────────────────
test('invoer: notitie en "ontvangen door" zijn verplicht, geen datum in de toekomst', () => {
  assert.equal(cash.valideerCashInvoer(body(), { vandaag: VANDAAG }).ok, true);
  assert.ok(cash.valideerCashInvoer(body({ notitie: '  ok ' }), { vandaag: VANDAAG }).fouten.notitie);
  assert.ok(cash.valideerCashInvoer(body({ ontvangen_door: ' ' }), { vandaag: VANDAAG }).fouten.ontvangen_door);
  assert.ok(cash.valideerCashInvoer(body({ paid_at: '2026-11-07' }), { vandaag: VANDAAG }).fouten.paid_at);
  assert.ok(cash.valideerCashInvoer(body({ amount: 0 }), { vandaag: VANDAAG }).fouten.amount);
  assert.ok(cash.valideerCashInvoer(body({ amount: 10.123 }), { vandaag: VANDAAG }).fouten.amount);
});

test('factuurcheck: deelbetaling mag, meer dan open niet; concept en gecrediteerd nooit', () => {
  const open = { status: 'open', tl_invoice_id: 'x', amount_total: 400, amount_paid: 100, credited_amount: 0 };
  assert.equal(cash.controleerFactuur(open, 300), null);
  assert.equal(cash.controleerFactuur(open, 300.01).code, 'TE_VEEL');
  assert.equal(cash.controleerFactuur({ ...open, status: 'credited' }, 10).code, 'FACTUUR_GECREDITEERD');
  assert.equal(cash.controleerFactuur({ ...open, status: 'paid', credited_amount: 400, amount_paid: 400 }, 10).code, 'FACTUUR_GECREDITEERD', 'oude rij paid + volledig gecrediteerd');
  assert.equal(cash.controleerFactuur({ ...open, status: 'concept' }, 10).code, 'FACTUUR_CONCEPT');
  assert.equal(cash.controleerFactuur({ ...open, amount_paid: 400, status: 'paid' }, 10).code, 'NIET_OPEN');
  assert.equal(cash.controleerFactuur({ ...open, tl_invoice_id: null }, 10).code, 'GEEN_TEAMLEADER');
});

test('Teamleader-methode: "Contant"/"Cash" gevonden, gearchiveerd telt niet', () => {
  assert.equal(cash.kiesCashMethode([{ id: 'a', name: 'Bank' }, { id: 'b', name: 'Cash' }]).id, 'b');
  assert.equal(cash.kiesCashMethode([{ id: 'a', name: 'Contant', status: 'archived' }]), null);
  assert.equal(cash.kiesCashMethode([{ id: 'a', name: 'Kas' }]).id, 'a');
  assert.equal(cash.kiesCashMethode([{ id: 'a', name: 'Overschrijving' }]), null);
});

// ── Flow ─────────────────────────────────────────────────────────────────
test('cash deelbetaling: Teamleader met betaalmethode cash, payments "cash", factuur NIET gecrediteerd, factuurmotor draait', async () => {
  const r = await cash.registreerCashBetaling(body(), opts);

  const reg = tl.calls.find((c) => c.path === '/invoices.registerPayment');
  assert.equal(reg.body.payment.amount, 150);
  assert.equal(reg.body.payment_method_id, 'pm-cash', 'betaalmethode cash gaat mee naar Teamleader');
  assert.ok(!tl.calls.some((c) => /credit/i.test(c.path)), 'geen creditnota');
  assert.deepEqual(tl.calls.map((c) => c.path), ['/paymentMethods.list', '/invoices.registerPayment', '/invoices.info'], 'niets anders naar Teamleader (geen mail, geen verzending)');

  const [p] = db.rows('payments');
  assert.equal(p.payment_method, 'cash');
  assert.equal(p.amount, 150);
  const inv = db.rows('invoices')[0];
  assert.equal(inv.status, 'partially_paid', 'deelbetaling: de factuur blijft open voor de rest');
  assert.equal(inv.amount_paid, 150);
  assert.equal(inv.credited_amount, 0);

  assert.deepEqual(motor.calls, [{ customerId: KLANT }], 'de commissie volgt via de gewone factuurmotor');

  const [b] = db.rows('cash_ontvangsten');
  assert.equal(b.payment_id, p.id);
  assert.equal(b.ontvangen_door, 'Dave');
  assert.equal(b.notitie, 'Betaald na de masterclass');
  assert.equal(b.tl_betaalmethode_id, 'pm-cash');

  const acties = db.rows('audit_log').map((a) => a.action);
  assert.deepEqual(acties.sort(), ['finance_invoice.register_cash', 'finance_invoice.register_payment']);
  assert.equal(r.teamleader.betaalmethode, 'meegestuurd');
  assert.deepEqual(r.waarschuwingen, []);
  assert.equal(meldingen.length, 0, 'deelbetaling: geen melding');
});

test('volledige cashbetaling: factuur betaald', async () => {
  const r = await cash.registreerCashBetaling(body({ amount: 400 }), opts);
  assert.equal(r.status, 'paid');
  assert.equal(db.rows('invoices')[0].credited_amount, 0);
});

test('vaste instelling: de ingestelde methode, geen opzoeking in Teamleader', async () => {
  zet({ instelling: { id: 'pm-vast', naam: 'Contant (kassa)' } });
  await cash.registreerCashBetaling(body(), opts);
  assert.ok(!tl.calls.some((c) => c.path === '/paymentMethods.list'));
  assert.equal(tl.calls.find((c) => c.path === '/invoices.registerPayment').body.payment_method_id, 'pm-vast');
});

test('geen cash-methode in Teamleader: betaling wel naar Teamleader, methode niet — luid gemeld', async () => {
  tl.methodes = [{ id: 'pm-bank', name: 'Overschrijving' }];
  const r = await cash.registreerCashBetaling(body(), opts);
  const reg = tl.calls.find((c) => c.path === '/invoices.registerPayment');
  assert.equal('payment_method_id' in reg.body, false);
  assert.equal(r.teamleader.betaalmethode, 'niet_overgenomen');
  assert.match(r.waarschuwingen[0], /Betaalmethode niet naar Teamleader/);
  assert.equal(db.rows('payments')[0].payment_method, 'cash', 'in het CRM wel contant');
  assert.match(db.rows('audit_log').find((a) => a.action === 'finance_invoice.register_cash').after_json.tl_betaalmethode_reden, /Geen betaalmethode/);
});

test('Teamleader weigert de betaalmethode: niets geregistreerd', async () => {
  tl.registerStatus = 422;
  await assert.rejects(cash.registreerCashBetaling(body(), opts), (e) => e.status === 422 && /betaalmethode/.test(e.message));
  assert.equal(db.rows('payments').length, 0);
  assert.equal(db.rows('cash_ontvangsten').length, 0);
  assert.equal(motor.calls.length, 0);
});

test('zonder migratie: 503 CASH_NIET_ACTIEF en niets naar Teamleader', async () => {
  zet({ missing: ['cash_ontvangsten'] });
  await assert.rejects(cash.registreerCashBetaling(body(), opts), (e) => e.status === 503 && e.code === 'CASH_NIET_ACTIEF');
  assert.equal(tl.calls.length, 0);
  assert.equal(db.rows('payments').length, 0);
});

test('gecrediteerde factuur: geweigerd, niets naar Teamleader', async () => {
  zet({ factuur: { status: 'credited', credited_amount: 400 } });
  await assert.rejects(cash.registreerCashBetaling(body(), opts), (e) => e.code === 'FACTUUR_GECREDITEERD');
  assert.equal(tl.calls.length, 0);
});

test('meer dan open: geweigerd vóór Teamleader', async () => {
  zet({ factuur: { amount_paid: 300, status: 'partially_paid' } });
  await assert.rejects(cash.registreerCashBetaling(body({ amount: 150 }), opts), (e) => e.code === 'TE_VEEL');
  assert.equal(tl.calls.length, 0);
});

test('dubbelklik: tweede keer hetzelfde → eerst bevestigen; met bevestiging wél', async () => {
  await cash.registreerCashBetaling(body({ amount: 100 }), opts);
  db.rows('cash_ontvangsten')[0].created_at = new Date().toISOString();
  db.rows('cash_ontvangsten')[0].bewijsnummer = 'KAS-2026-0001';
  await assert.rejects(cash.registreerCashBetaling(body({ amount: 100 }), opts), (e) => e.code === 'MOGELIJK_DUBBEL' && e.status === 409);
  assert.equal(db.rows('payments').length, 1);
  await cash.registreerCashBetaling(body({ amount: 100, bevestig_dubbel: true }), opts);
  assert.equal(db.rows('payments').length, 2);
});

// ── Weergave ─────────────────────────────────────────────────────────────
test('betaalmethode: contant, bank, Teamleader; gecrediteerd telt nooit als betaald', () => {
  assert.equal(betaalmethodenVan([{ amount: 100, payment_method: 'cash' }]).label, 'Contant');
  assert.equal(betaalmethodenVan([{ amount: 100, payment_method: 'cash' }, { amount: 50, source: 'camt_match' }]).label, 'Contant + Bank (afschrift)');
  assert.equal(betaalmethodenVan([{ amount: 100, payment_method: 'cash' }]).cash, 100);
  assert.equal(betaalmethodenVan([], { amount_total: 400, amount_paid: 400, status: 'paid' }).label, 'Teamleader');
  assert.equal(betaalmethodenVan([], { amount_total: 400, amount_paid: 400, credited_amount: 400, status: 'paid' }).label, null, 'gecrediteerd: geen betaling');
});

test('maandlijst toont de betaalmethode per factuur', () => {
  const m = bouwMaandlijst({
    facturen: [{ id: 'f1', invoice_number: 'F1', amount_total: 300, amount_paid: 300, credited_amount: 0, status: 'paid', due_date: '2026-11-01' }],
    betalingen: new Map([['f1', [{ amount: 300, payment_date: '2026-11-02', payment_method: 'cash' }]]]),
    vandaag: VANDAAG,
  });
  const f = m.maanden.flatMap((x) => x.facturen)[0];
  assert.equal(f.betaalmethode, 'Contant');
});

test('ontvangstbewijs: PDF zonder interne notitie, met bewijsnummer en restbedrag', async () => {
  const bewijs = { bewijsnummer: 'KAS-2026-0007', bedrag: 150, ontvangen_op: '2026-11-05', ontvangen_door: 'Dave', notitie: 'GEHEIM-INTERN' };
  const factuur = { invoice_number: '2026 / 3001', amount_total: 400, amount_paid: 150, credited_amount: 0 };
  const regels = bewijsRegels({ bewijs, factuur, klantNaam: 'Jan Peeters' });
  const tekst = regels.flat().join(' | ');
  assert.match(tekst, /KAS-2026-0007/);
  assert.match(tekst, /5 november 2026/);
  assert.match(tekst, /250,00/, 'nog open');
  assert.doesNotMatch(tekst, /GEHEIM-INTERN/);
  const pdf = await bouwOntvangstbewijsPdf({ bewijs, factuur, klantNaam: 'Jan Peeters' });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});
