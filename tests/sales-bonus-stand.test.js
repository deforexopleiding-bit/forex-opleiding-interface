// tests/sales-bonus-stand.test.js
//
// Regel 4 (Maxim, 6 nov 2026): een sales-bonus is pas verdiend en telt pas mee
// als er effectief betaald is, in verhouding tot wat betaald is. Geannuleerde
// of gecrediteerde termijnen tellen nooit. Fixtures naar de echte gevallen
// (bedragen uit de productie-stand van 6 nov, ids ingekort).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berekenBonusStand, totalen, exclFactor, pctVoor } from '../api/_lib/sales-bonus-stand.js';

const DAVE = 'dave', SEPP = 'sepp', AMIGO = 'amigo';
const profielen = new Map([
  [DAVE, { full_name: 'Dave Heylen', role: 'sales' }],
  [SEPP, { full_name: 'Seppe Hellin', role: 'mentor' }],
  [AMIGO, { full_name: 'Amigo Biemold', role: 'super_admin' }],
]);
const leegCtx = { krediet: new Map(), handmatig: new Map(), incasso: [] };
const VANDAAG = '2026-11-06';
const reken = (p) => berekenBonusStand({ profielen, regCtx: leegCtx, vandaag: VANDAAG, ...p });
const offerte = (id, cust, extra = {}) => ({ id, customer_id: cust, sales_user_id: DAVE, source: null, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-09-15T10:00:00Z', created_at: '2026-09-15T10:00:00Z', archived_at: null, ...extra });
const ghost = (id, cust, extra = {}) => ({ id, customer_id: cust, sales_user_id: DAVE, source: 'subscription_only', tl_quotation_status: 'no_quotation', created_at: '2026-08-06T10:00:00Z', archived_at: null, ...extra });
const factuur = (id, cust, extra = {}) => ({ id, customer_id: cust, deal_id: null, tl_subscription_id: null, amount_total: 0, amount_paid: 0, vat_amount: 0, credited_amount: 0, status: 'open', issue_date: '2026-10-01', ...extra });

test('hulpjes: excl-factor en percentage', () => {
  assert.equal(exclFactor({ amount_total: 1800.01, vat_amount: 257.81 }).toFixed(4), (1542.2 / 1800.01).toFixed(4));
  assert.equal(exclFactor({ amount_total: 0 }), 1);
  assert.equal(pctVoor([], DAVE, '2026-10-01'), 3, 'sales_bonus_configs leeg → 3%');
  assert.equal(pctVoor([{ user_id: DAVE, percentage: 5, active_from: '2026-01-01', active_until: null }], DAVE, '2026-10-01'), 5);
});

// ── Marc De Bock ────────────────────────────────────────────────────────
// Offerte van Dave (12.000 excl, bonus 360). Origineel abonnement geannuleerd,
// factuur 2245 gecrediteerd; Sepp maakte op 5 nov een aanpassing (ghost-deal,
// bonus al ongeldig gemaakt). Nieuwe factuur 2306 (11.900 incl) zonder deal_id,
// handmatig gekoppeld in commissie_factuur_koppeling. Fee 1902 (82,64) betaald,
// staat op een DUBBEL klantrecord met deal_id = de offerte.
function marc({ betaald2306 = 0 } = {}) {
  const C = 'marc', C2 = 'marc-dubbel', SALE = 'ba36', GH = '2495';
  return {
    bonussen: [
      { id: 'b-dave', deal_id: SALE, sales_user_id: DAVE, amount: 360, status: 'pending', created_at: '2026-09-22T10:00:00Z' },
      { id: 'b-sepp', deal_id: GH, sales_user_id: SEPP, amount: 305.96, status: 'voided', created_at: '2026-11-05T13:40:00Z' },
    ],
    deals: [offerte(SALE, C, { reservation_fee_invoice_id: 'f1902' }), ghost(GH, C, { sales_user_id: SEPP, created_at: '2026-11-05T13:40:00Z' })],
    subs: [
      { id: 's1', deal_id: SALE, status: 'cancelled', term_count: 1, amount: 12000, start_date: '2026-11-01', created_at: '2026-09-22', soort: 'origineel', sale_deal_id: SALE, teamleader_subscription_id: 'tl1' },
      { id: 's2', deal_id: GH, status: 'cancelled', term_count: 1, amount: 10198.65, start_date: '2026-11-05', created_at: '2026-11-05', soort: 'aanpassing', aanpassing_type: 'lager_bedrag', sale_deal_id: SALE, teamleader_subscription_id: 'tl2' },
    ],
    facturen: [
      factuur('f1902', C2, { deal_id: SALE, invoice_number: '2026 / 1902', amount_total: 82.64, amount_paid: 82.64, status: 'paid', issue_date: '2026-09-22', tl_invoice_id: 'tl-f' }),
      factuur('f2245', C2, { invoice_number: '2026 / 2245', amount_total: 12000, credited_amount: 12000, status: 'credited', issue_date: '2026-11-01' }),
      factuur('f2306', C, { invoice_number: '2026 / 2306', amount_total: 11900, vat_amount: 1701.35, amount_paid: betaald2306, status: betaald2306 >= 11900 ? 'paid' : 'open', issue_date: '2026-11-05' }),
    ],
    regCtx: { krediet: new Map(), handmatig: new Map([['f2306', { deal_id: SALE, bron: 'handmatig' }]]), incasso: [] },
    klanten: new Map([[C, { naam: 'Marc De Bock' }]]),
  };
}

test('Marc: alleen de betaalde fee telt nu; 2306 open → houden, max 308,44 (niet 360)', () => {
  const st = reken(marc());
  const dave = st.find((s) => s.bonus_id === 'b-dave');
  assert.equal(dave.verdiend, 2.48, '3% van de betaalde fee 82,64');
  assert.equal(dave.max_haalbaar, 308.44, '3% van 82,64 + 10.198,65 (2306 excl)');
  assert.equal(dave.voorstel, 'houden');
  assert.equal(dave.abonnement_status, 'geannuleerd');
  assert.ok(dave.facturen.some((f) => f.nummer === '2026 / 2306' && f.via === 'koppeling'), 'koppeling via commissie_factuur_koppeling');
  assert.ok(!dave.facturen.some((f) => f.nummer === '2026 / 2245' && f.betaald > 0), 'gecrediteerd telt nooit');
  assert.ok(dave.signalen.some((x) => /ander klantrecord/.test(x)), 'dubbele klant gemeld');
  const sepp = st.find((s) => s.bonus_id === 'b-sepp');
  assert.equal(sepp.verdiend, 0, 'de ongeldige bonus van Sepp telt nooit');
});

test('Marc: 2306 betaald → Dave verdient 308,44 (voorstel: bonus naar 308,44) en de bonus van Sepp blijft 0', () => {
  const st = reken(marc({ betaald2306: 11900 }));
  const dave = st.find((s) => s.bonus_id === 'b-dave');
  assert.equal(dave.verdiend, 308.44);
  assert.equal(dave.voorstel, 'aanpassen', 'afgerond tegen de lagere prijs van de aanpassing');
  assert.equal(dave.voorstel_bedrag, 308.44);
  assert.equal(st.find((s) => s.bonus_id === 'b-sepp').verdiend, 0);
});

// ── Andy De Landtsheer ──────────────────────────────────────────────────
// Offerte 7.200 (4 × 1.800, geen aanbetaling → geen bonus), daarna door Dave
// vier losse kwartaalabonnementen van 1.542,20 ingevoerd (elk een ghost-deal en
// een bonus van 46,27). Alles geannuleerd en gearchiveerd. Betaald: 2026/1574
// (1.800,01 incl, termijn 1) en 2026/2214 (1.000, deelbetaling). Gecrediteerd:
// 1903, 2091, 2164. Geen enkele factuur heeft deal_id of tl_subscription_id.
function andy() {
  const C = 'andy', SALE = '9a5b';
  const arch = { archived_at: '2026-10-29T15:23:41Z' };
  const kw = [['g1', '2026-08-06'], ['g2', '2026-11-06'], ['g3', '2027-02-06'], ['g4', '2027-05-06']];
  return {
    bonussen: kw.map(([g], i) => ({ id: 'b' + (i + 1), deal_id: g, sales_user_id: DAVE, amount: 46.27, status: 'pending', created_at: `2026-08-06T10:0${i}:00Z` })),
    deals: [offerte(SALE, C, { tl_quotation_accepted_at: '2026-08-05T14:45:00Z', created_at: '2026-08-05T14:45:00Z', ...arch }),
      ...kw.map(([g]) => ghost(g, C, arch))],
    subs: [
      { id: 'so', deal_id: SALE, status: 'cancelled', term_count: 4, amount: 1800, start_date: '2026-09-22', created_at: '2026-08-05', teamleader_subscription_id: 'tlo' },
      ...kw.map(([g, start]) => ({ id: 's-' + g, deal_id: g, status: 'cancelled', term_count: 1, amount: 1542.2, start_date: start, created_at: '2026-08-06', teamleader_subscription_id: 'tl-' + g })),
    ],
    facturen: [
      factuur('i1574', C, { invoice_number: '2026 / 1574', amount_total: 1800.01, vat_amount: 257.81, amount_paid: 1800.01, status: 'paid', issue_date: '2026-08-06' }),
      factuur('i1903', C, { invoice_number: '2026 / 1903', amount_total: 1800, credited_amount: 1800, status: 'credited', issue_date: '2026-09-22' }),
      factuur('i2091', C, { invoice_number: '2026 / 2091', amount_total: 1000, credited_amount: 1000, status: 'credited', issue_date: '2026-10-12' }),
      factuur('i2164', C, { invoice_number: '2026 / 2164', amount_total: 1800, credited_amount: 1800, status: 'credited', issue_date: '2026-10-22' }),
      factuur('i2214', C, { invoice_number: '2026 / 2214', amount_total: 1000, amount_paid: 1000, status: 'paid', issue_date: '2026-10-29' }),
    ],
    klanten: new Map([[C, { naam: 'Andy De Landtsheer' }]]),
  };
}

test('Andy: enkel betaalde termijnen tellen — termijn 1 volledig, de deelbetaling naar verhouding, de rest ongeldig', () => {
  const st = reken(andy());
  const per = Object.fromEntries(st.map((s) => [s.bonus_id, s]));
  assert.equal(per.b1.verdiend, 46.27);
  assert.equal(per.b1.voorstel, 'houden');
  assert.equal(per.b2.verdiend, 30, '3% van de deelbetaling van 1.000');
  assert.equal(per.b2.voorstel, 'aanpassen');
  assert.equal(per.b2.voorstel_bedrag, 30);
  assert.equal(per.b3.verdiend, 0); assert.equal(per.b3.voorstel, 'ongeldig');
  assert.equal(per.b4.verdiend, 0); assert.equal(per.b4.voorstel, 'ongeldig');
  for (const s of st) assert.equal(s.sale_deal_id, '9a5b', 'de gearchiveerde offerte blijft de sale');
  assert.equal(Math.round(st.reduce((t, s) => t + s.verdiend, 0) * 100) / 100, 76.27);
});

// ── Eenmalige betaling van Dave ─────────────────────────────────────────
// Somchai Management Fund: offerte 3.950, één termijn; eerste factuur
// gecrediteerd, de vervangende betaald. Factuur zonder deal_id → de enige sale.
function eenmalig({ betaald = true } = {}) {
  const C = 'somchai', SALE = '7c09';
  return {
    bonussen: [{ id: 'b', deal_id: SALE, sales_user_id: DAVE, amount: 118.5, status: 'pending', created_at: '2026-07-20T10:00:00Z' }],
    deals: [offerte(SALE, C, { tl_quotation_accepted_at: '2026-07-20T10:00:00Z', created_at: '2026-07-20T10:00:00Z' })],
    subs: [{ id: 's', deal_id: SALE, status: 'active', term_count: 1, amount: 3950, start_date: '2026-07-28', created_at: '2026-07-20', soort: 'origineel', sale_deal_id: SALE, teamleader_subscription_id: 'tl' }],
    facturen: [
      factuur('a', C, { invoice_number: '2026 / 5002', amount_total: 3950, credited_amount: 3950, status: 'credited', issue_date: '2026-07-28' }),
      factuur('b', C, { invoice_number: '2026 / 5004', amount_total: 3950, amount_paid: betaald ? 3950 : 0, status: betaald ? 'paid' : 'open', issue_date: '2026-08-18' }),
    ],
    klanten: new Map([[C, { naam: 'Somchai Management Fund' }]]),
  };
}

test('eenmalige betaling van Dave: betaald → volledig verdiend; open → telt nog niet mee', () => {
  const [s] = reken(eenmalig());
  assert.equal(s.verdiend, 118.5);
  assert.equal(s.voorstel, 'houden');
  assert.equal(s.reden, 'volledig betaald');
  const [o] = reken(eenmalig({ betaald: false }));
  assert.equal(o.verdiend, 0);
  assert.equal(o.max_haalbaar, 118.5);
  assert.equal(o.voorstel, 'houden', 'factuur staat nog open: wachten op betaling');
  assert.equal(totalen([o]).verdiend_open, 0, 'het dashboard telt een onbetaalde bonus niet als openstaand');
  assert.equal(totalen([s]).verdiend_open, 118.5);
});

test('dubbele bonus op dezelfde sale (offerte + ghost-deal) → de ghost-bonus ongeldig', () => {
  const C = 'eb', SALE = '8866', GH = 'fb04';
  const st = reken({
    bonussen: [
      { id: 'op', deal_id: SALE, sales_user_id: DAVE, amount: 185.06, status: 'pending', created_at: '2026-08-01' },
      { id: 'gh', deal_id: GH, sales_user_id: DAVE, amount: 185.06, status: 'pending', created_at: '2026-08-10' },
    ],
    deals: [offerte(SALE, C), ghost(GH, C)],
    subs: [
      { id: 's1', deal_id: SALE, status: 'cancelled', term_count: 1, amount: 6168.77, start_date: '2026-09-01', soort: 'origineel', sale_deal_id: SALE },
      { id: 's2', deal_id: GH, status: 'active', term_count: 1, amount: 6168.77, start_date: '2026-12-01', soort: 'origineel', sale_deal_id: SALE },
    ],
    facturen: [],
    klanten: new Map([[C, { naam: 'X' }]]),
  });
  assert.equal(st.find((s) => s.bonus_id === 'gh').voorstel, 'ongeldig');
  assert.equal(st.find((s) => s.bonus_id === 'op').voorstel, 'houden', 'de vervanging (ghost-abonnement) laat de bonus van de offerte lopen');
});

test('ontvanger is niet de verkoper van de offerte → voorstel aanpassen naar de verkoper; systeemaccount nooit voorgesteld', () => {
  const C = 'k', SALE = 'd';
  const basis = {
    deals: [offerte(SALE, C)],
    subs: [{ id: 's', deal_id: SALE, status: 'active', term_count: 1, amount: 5000, start_date: '2026-12-01' }],
    facturen: [], klanten: new Map([[C, { naam: 'K' }]]),
  };
  const [a] = reken({ ...basis, bonussen: [{ id: 'b', deal_id: SALE, sales_user_id: SEPP, amount: 150, status: 'pending', created_at: '2026-09-20' }] });
  assert.equal(a.voorstel, 'aanpassen');
  assert.equal(a.voorstel_ontvanger_id, DAVE);
  const [b] = reken({ ...basis, deals: [offerte(SALE, C, { sales_user_id: AMIGO })], bonussen: [{ id: 'b', deal_id: SALE, sales_user_id: DAVE, amount: 150, status: 'pending', created_at: '2026-09-20' }] });
  assert.notEqual(b.voorstel_ontvanger_id, AMIGO);
  assert.ok(b.signalen.some((x) => /niet zeker/.test(x)));
});

test('testklant → ongeldig en telt niet in de totalen', () => {
  const st = reken({ ...eenmalig(), klanten: new Map([['somchai', { naam: 'T', is_test: true }]]) });
  assert.equal(st[0].voorstel, 'ongeldig');
  assert.equal(totalen(st).verdiend_open, 0);
});

test('handmatig toegekend zonder basis telt volledig (uitzondering van een admin)', () => {
  const p = eenmalig({ betaald: false });
  const st = reken({ ...p, toekenningen: new Map([['b', { reden: 'uitzondering', telt_volledig: true }]]) });
  assert.equal(st[0].verdiend, 118.5);
});
