// tests/setter-sale-plan.test.js
//
// Setter-salesoverzicht: betaalplan, aansluiting op total_amount, welke deals
// meetellen, forecast-buckets. Fixtures = de echte deals van Romy (okt 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bouwBetaalplan, isUitgeslotenDeal, quotationStatus, reserveringsfeeVanToepassing,
  addMonthsIso, forecastUitPlan, bouwSaleRegel, RESERVATION_FEE_INCL,
} from '../api/_lib/setter-sale-plan.js';

const JOHN = {
  id: 'john', total_amount: 7200, tl_quotation_status: 'accepted',
  payment_term_count: 12, payment_term_amount: 600, payment_term_start_date: '2026-10-30',
  payment_downpayment_amount: null, exception_flagged: false, exception_fee_agreed: false,
};
const SALIH = {
  id: 'salih', total_amount: 7200, tl_quotation_status: 'accepted',
  payment_term_count: 1, payment_term_amount: 7100, payment_term_start_date: '2026-12-29',
  exception_flagged: true, exception_reasons: 'late_start', exception_fee_agreed: true,
  reservation_fee_invoice_id: null,
};
const DENZEL = {
  id: 'denzel', total_amount: 7200, tl_quotation_status: 'sent',
  payment_downpayment_amount: 1000, payment_downpayment_date: '2027-01-01',
  payment_term_count: 13, payment_term_amount: 469.23, payment_term_start_date: '2027-01-01',
  exception_flagged: true, exception_reasons: 'late_start', exception_fee_agreed: true,
};
const TESTDEAL = {
  id: 'test', total_amount: 3950, tl_quotation_status: 'draft',
  archived_at: '2026-09-21T11:37:45Z', tl_quotation_declined_at: '2026-09-21T11:37:45Z',
};

test('John: 12 × 600 sluit exact aan op 7.200, 3% = 18 per termijn', () => {
  const p = bouwBetaalplan(JOHN, { pct: 3 });
  assert.equal(p.aansluiting.status, 'ok');
  assert.equal(p.aansluiting.som, 7200);
  assert.equal(p.schema.length, 12);
  assert.ok(p.schema.every((r) => r.soort === 'termijn' && r.commissie === 18));
  assert.equal(p.commissie_totaal, 216);
  assert.equal(p.schema[0].datum, '2026-10-30');
  assert.equal(p.schema[4].datum, '2027-02-28', '30 jan + 1 maand → einde februari');
});

test('Salih: € 100 reserveringsfee + 7.100 = 7.200 (fee uit late_start + akkoord)', () => {
  assert.equal(reserveringsfeeVanToepassing(SALIH), true);
  const p = bouwBetaalplan(SALIH, { pct: 3 });
  assert.equal(p.reserveringsfee.bedrag, RESERVATION_FEE_INCL);
  assert.equal(p.schema[0].soort, 'reserveringsfee');
  assert.equal(p.schema[0].datum, null, 'fee heeft pas een datum als de factuur geboekt is');
  assert.equal(p.aansluiting.status, 'ok');
  assert.equal(p.commissie_totaal, 216);
});

test('Denzel: fee + 1.000 + 13 × 469,23 = 7.199,99 → afrondingsverschil, geen mismatch', () => {
  const p = bouwBetaalplan(DENZEL, { pct: 3 });
  assert.equal(p.aansluiting.som, 7199.99);
  assert.equal(p.aansluiting.verschil, 0.01);
  assert.equal(p.aansluiting.status, 'afronding');
  assert.match(p.aansluiting.melding, /0,01/);
  assert.deepEqual(p.schema.slice(0, 2).map((r) => r.soort), ['reserveringsfee', 'aanbetaling']);
});

test('zonder fee-vlag sluit Denzel NIET aan (100 euro gat) → mismatch met melding', () => {
  const p = bouwBetaalplan({ ...DENZEL, exception_fee_agreed: false }, { pct: 3 });
  assert.equal(p.aansluiting.status, 'mismatch');
  assert.equal(p.aansluiting.verschil, 100.01);
  assert.match(p.aansluiting.melding, /MINDER/);
});

test('plan hoger dan offerte → mismatch', () => {
  const p = bouwBetaalplan({ ...JOHN, payment_term_amount: 650 }, { pct: 3 });
  assert.equal(p.aansluiting.status, 'mismatch');
  assert.match(p.aansluiting.melding, /HOGER/);
});

test('geen termijnen en geen aanbetaling → geen_plan', () => {
  const p = bouwBetaalplan({ total_amount: 2880 }, { pct: 3 });
  assert.equal(p.aansluiting.status, 'geen_plan');
  assert.equal(p.schema.length, 0);
});

test('fee alleen bij late_start + akkoord + uitzondering', () => {
  assert.equal(reserveringsfeeVanToepassing({ exception_flagged: true, exception_reasons: 'low_term_amount', exception_fee_agreed: true }), false);
  assert.equal(reserveringsfeeVanToepassing({ exception_flagged: false, exception_reasons: 'late_start', exception_fee_agreed: true }), false);
  assert.equal(reserveringsfeeVanToepassing({ exception_flagged: true, exception_reasons: 'low_term_amount, late_start', exception_fee_agreed: true }), true);
});

test('gearchiveerde deal en afgewezen offerte tellen niet mee; declined_at alleen niet', () => {
  assert.equal(isUitgeslotenDeal(TESTDEAL), true);
  assert.equal(isUitgeslotenDeal({ tl_quotation_status: 'declined' }), true);
  assert.equal(isUitgeslotenDeal({ tl_quotation_status: 'accepted', tl_quotation_declined_at: '2026-09-01' }), false);
  assert.equal(isUitgeslotenDeal(JOHN), false);
});

test('offertestatus: verstuurd = in afwachting, geaccepteerd niet', () => {
  assert.deepEqual(quotationStatus(DENZEL), { key: 'sent', label: 'verstuurd', pending: true });
  assert.equal(quotationStatus(JOHN).pending, false);
  assert.equal(quotationStatus({}).label, 'geen offerte');
});

test('addMonthsIso clampt op maandeinde en rolt over het jaar', () => {
  assert.equal(addMonthsIso('2026-12-29', 2), '2027-02-28');
  assert.equal(addMonthsIso('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonthsIso('2026-10-30', 0), '2026-10-30');
  assert.equal(addMonthsIso('nope', 1), null);
});

test('forecast: ontvangen wordt van voren afgeboekt, achterstand schuift naar volgende maand', () => {
  const p = bouwBetaalplan(JOHN, { pct: 3 });
  const now = new Date('2027-01-15T10:00:00Z');
  // 2 termijnen ontvangen; termijn 3 (30-12-2026) is achterstallig → feb 2027.
  const b = forecastUitPlan(p, { ontvangen: 1200, now });
  const feb = b.find((x) => x.ym === '2027-02');
  assert.equal(feb.commissie, 36, 'achterstallige dec-termijn + feb-termijn');
  assert.equal(b.find((x) => x.ym === '2027-01').commissie, 18);
  assert.equal(b.reduce((s, x) => s + x.commissie, 0), 180, '10 termijnen × 18');
});

test('forecast: fee zonder datum valt in de volgende maand', () => {
  const p = bouwBetaalplan(SALIH, { pct: 3 });
  const b = forecastUitPlan(p, { now: new Date('2026-10-01T06:00:00Z') });
  assert.deepEqual(b.map((x) => [x.ym, x.commissie]), [['2026-11', 3], ['2026-12', 213]]);
});

test('bouwSaleRegel: kolommen + betaalstatus', () => {
  const r = bouwSaleRegel({
    deal: { ...JOHN, customer_id: 'c1', start_date: '2026-09-26', payment_start_date: '2026-11-02' },
    klant: { first_name: 'John', last_name: 'Vliet' }, traject: '1-op-1 begeleiding (12 maanden)', pct: 3, ontvangen: 600,
  });
  assert.equal(r.customer, 'John Vliet');
  assert.equal(r.bedrag, 7200);
  assert.equal(r.eerste_termijn, '2026-10-30');
  assert.equal(r.start_cursus, '2026-11-02');
  assert.equal(r.aantal_termijnen, 12);
  assert.equal(r.offerte_status_label, 'geaccepteerd');
  assert.equal(r.betaal_status, 'gedeeltelijk');
  assert.equal(r.verwachte_commissie, 216);
  assert.equal(r.ontvangen_regels, null, 'fase A: alleen gepland');
});
