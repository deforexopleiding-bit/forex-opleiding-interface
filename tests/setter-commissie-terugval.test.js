// tests/setter-commissie-terugval.test.js
//
// Setter-commissie, koppelregel 4 (2026-11-02): een factuur zonder deal_id én
// zonder tl_subscription_id hoort bij de setter-deal als de klant precies ÉÉN
// getekende, niet-gearchiveerde deal heeft (zoals de mentorcommissie). Bij
// twijfel niet koppelen maar melden als `te_controleren` in de cron-uitvoer.
// Gecrediteerd en gearchiveerd blijven uitgesloten. Btw blijft incl.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { koppelFacturen, koppelFacturenAanDeals, planCommissie } from '../api/_lib/setter-commissie-core.js';

const ROMY = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';
const SEPPE = '162994ff-a21d-446f-bf0b-eea8e7978967';
const KARL = 'fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7';
const deal = (o) => ({ customer_id: 'c', setter_user_id: null, archived_at: null, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-09-26T10:00:00Z', created_at: '2026-09-26T09:00:00Z', reservation_fee_invoice_id: null, ...o });
const inv = (o) => ({ invoice_number: '2026 / 1', customer_id: 'c', deal_id: null, tl_subscription_id: null, tl_invoice_id: null, status: 'paid', amount_total: 600, amount_paid: 600, credited_amount: 0, issue_date: '2026-10-30', paid_date: '2026-11-13', is_test: false, ...o });

test('terugval: enige getekende deal van de klant met setter → gekoppeld (bron enige_deal_klant)', () => {
  const d = deal({ id: 'john', setter_user_id: ROMY });
  const { koppeling, teControleren } = koppelFacturen({ deals: [d], subs: [], invoices: [inv({ id: 'i1' })], klantDeals: [d] });
  assert.equal(koppeling.get('i1').deal.id, 'john');
  assert.equal(koppeling.get('i1').bron, 'enige_deal_klant');
  assert.equal(teControleren.length, 0);
});

test('terugval: meerdere getekende deals → niet gekoppeld, wel te controleren met de kandidaten', () => {
  const oud = deal({ id: 'oud', tl_quotation_accepted_at: '2025-04-09T00:00:00Z', created_at: '2025-04-09T00:00:00Z' });
  const seppe = deal({ id: 'seppe', setter_user_id: SEPPE });
  const { koppeling, teControleren } = koppelFacturen({ deals: [seppe], invoices: [inv({ id: 'i1' })], klantDeals: [oud, seppe] });
  assert.equal(koppeling.has('i1'), false);
  assert.equal(teControleren.length, 1);
  assert.equal(teControleren[0].reden, 'meerdere_getekende_deals');
  assert.deepEqual(teControleren[0].kandidaten.map((k) => k.deal_id).sort(), ['oud', 'seppe']);
});

test('terugval telt alleen getekende, actieve deals: ghost/concept/gearchiveerd/afgewezen niet', () => {
  const romy = deal({ id: 'romy', setter_user_id: ROMY });
  const andere = [
    deal({ id: 'ghost', tl_quotation_status: 'no_quotation', tl_quotation_accepted_at: null }),
    deal({ id: 'concept', tl_quotation_status: 'draft', tl_quotation_accepted_at: null }),
    deal({ id: 'archief', archived_at: '2026-10-01T00:00:00Z' }),
    deal({ id: 'afgewezen', tl_quotation_status: 'declined' }),
  ];
  const k = koppelFacturenAanDeals({ deals: [romy], invoices: [inv({ id: 'i1' })], klantDeals: [romy, ...andere] });
  assert.equal(k.get('i1').deal.id, 'romy');
});

test('terugval: gearchiveerde setter-deal → geen koppeling (ook geen melding); deal zonder setter → niet van ons', () => {
  const gearch = deal({ id: 'ev', setter_user_id: KARL, archived_at: '2026-11-02T14:10:15Z' });
  const r1 = koppelFacturen({ deals: [gearch], invoices: [inv({ id: 'i1', status: 'credited', amount_paid: 0, credited_amount: 600 })], klantDeals: [gearch] });
  assert.equal(r1.koppeling.size, 0);
  assert.equal(r1.teControleren.length, 0);
  const zonderSetter = deal({ id: 'zs' });
  const setterDealAndereKlant = deal({ id: 'sd', customer_id: 'ander', setter_user_id: ROMY });
  const r2 = koppelFacturen({ deals: [setterDealAndereKlant], invoices: [inv({ id: 'i2' })], klantDeals: [zonderSetter, setterDealAndereKlant] });
  assert.equal(r2.koppeling.has('i2'), false);
  assert.equal(r2.teControleren.length, 0);
});

test('terugval: factuur van vóór de deal of zonder datum → te controleren; concept doet niet mee', () => {
  const d = deal({ id: 'd', setter_user_id: ROMY, created_at: '2026-09-07T09:00:00Z' });
  const { koppeling, teControleren } = koppelFacturen({
    deals: [d], klantDeals: [d],
    invoices: [inv({ id: 'oud', issue_date: '2026-05-28', paid_date: '2026-06-11' }), inv({ id: 'geen', issue_date: null, paid_date: null, status: 'open', amount_paid: 0 }), inv({ id: 'concept', status: 'concept', amount_paid: 0 })],
  });
  assert.equal(koppeling.size, 0);
  assert.deepEqual(teControleren.map((t) => [t.invoice_id, t.reden]).sort(), [['geen', 'datum_onbekend'], ['oud', 'factuur_ouder_dan_deal']]);
});

test('bestaande regels winnen: deal_id, abonnement en reserveringsfee gaan vóór de terugval; abonnement van een andere deal → geen terugval', () => {
  const d = deal({ id: 'd', setter_user_id: ROMY, reservation_fee_invoice_id: 'fee' });
  const { koppeling } = koppelFacturen({
    deals: [d], subs: [{ deal_id: 'd', teamleader_subscription_id: 'tl-1' }], klantDeals: [d],
    invoices: [inv({ id: 'fee' }), inv({ id: 'abo', tl_subscription_id: 'tl-1' }), inv({ id: 'vreemd-abo', tl_subscription_id: 'tl-andere' }), inv({ id: 'dl', deal_id: 'd' })],
  });
  assert.equal(koppeling.get('fee').bron, 'reserveringsfee');
  assert.equal(koppeling.get('abo').bron, 'abonnement');
  assert.equal(koppeling.get('dl').bron, 'deal');
  assert.equal(koppeling.has('vreemd-abo'), false);
});

test('zonder klantDeals (oude aanroepers) blijft alles bij het oude: geen terugval', () => {
  const d = deal({ id: 'd', setter_user_id: ROMY });
  assert.equal(koppelFacturenAanDeals({ deals: [d], invoices: [inv({ id: 'i1' })] }).size, 0);
});

// ── De echte situatie van 2 nov 2026 (gemeten, alleen lezen) ────────────
const REAL = {
  setterIds: [ROMY, SEPPE, KARL],
  configs: [
    { user_id: ROMY, pct: 3, is_active: true, effective_from: '2026-08-31' },
    { user_id: KARL, pct: 3, is_active: true, effective_from: '2026-10-12' },
  ],
  deals: [
    deal({ id: 'john-vliet', customer_id: 'c-john', setter_user_id: ROMY }),
    deal({ id: 'abder', customer_id: 'c-abder', setter_user_id: SEPPE, created_at: '2026-10-17T00:00:00Z' }),
    deal({ id: 'barbara-seppe', customer_id: 'c-barbara', setter_user_id: SEPPE, created_at: '2026-09-07T00:00:00Z' }),
    deal({ id: 'evertjan-karl', customer_id: 'c-ev', setter_user_id: KARL, archived_at: '2026-11-02T14:10:15Z' }),
  ],
  klantDeals: [
    deal({ id: 'abder-ghost', customer_id: 'c-abder', tl_quotation_status: 'no_quotation', tl_quotation_accepted_at: null }),
    deal({ id: 'barbara-2025', customer_id: 'c-barbara', created_at: '2025-04-09T00:00:00Z', tl_quotation_accepted_at: '2025-04-09T00:00:00Z' }),
    deal({ id: 'evertjan-3okt', customer_id: 'c-ev', archived_at: '2026-11-02T14:10:16Z' }),
  ],
  subs: [],
  invoices: [
    inv({ id: 'i-2221', invoice_number: '2026 / 2221', customer_id: 'c-john', status: 'open', amount_paid: 0, paid_date: null, issue_date: '2026-10-30' }),
    inv({ id: 'i-2166', invoice_number: '2026 / 2166', customer_id: 'c-abder', status: 'open', amount_paid: 0, paid_date: null, issue_date: '2026-10-22' }),
    inv({ id: 'i-10014', invoice_number: '2026 / 10014', customer_id: 'c-barbara', amount_total: 80, amount_paid: 80, issue_date: '2026-10-07', paid_date: '2026-10-10' }),
    inv({ id: 'i-2160', invoice_number: '2026 / 2160', customer_id: 'c-ev', status: 'credited', amount_total: 80, amount_paid: 0, credited_amount: 80, issue_date: '2026-10-20', paid_date: null }),
  ],
  entries: [],
};
REAL.klantDeals = REAL.klantDeals.concat(REAL.deals);

test('echte situatie: John Vliet en Abder gekoppeld, Barbara te controleren, Evertjan niets; vandaag € 0 te boeken', () => {
  const plan = planCommissie(REAL);
  const per = Object.fromEntries(plan.map((p) => [p.setter_user_id, p]));
  const romy = per[ROMY];
  assert.deepEqual(romy.facturen.map((f) => [f.factuurnummer, f.bron, f.reden]), [['2026 / 2221', 'enige_deal_klant', 'nog_niet_betaald']]);
  assert.equal(romy.te_boeken, 0, 'nog niet betaald');
  assert.deepEqual(per[SEPPE].facturen.map((f) => [f.factuurnummer, f.reden]), [['2026 / 2166', 'geen_setter_config']]);
  assert.deepEqual(per[SEPPE].te_controleren.map((t) => [t.factuurnummer, t.reden]), [['2026 / 10014', 'meerdere_getekende_deals']]);
  assert.equal(per[KARL].facturen.length, 0, 'Evertjan: beide deals gearchiveerd');
  assert.equal(per[KARL].te_controleren.length, 0);
  assert.equal(plan.reduce((s, p) => s + p.mutaties.length, 0), 0);
});

test('echte situatie: betaalt John Vliet € 600 → Romy € 18 (3 % incl. btw), één regel', () => {
  const data = { ...REAL, invoices: REAL.invoices.map((i) => (i.id === 'i-2221' ? { ...i, status: 'paid', amount_paid: 600, paid_date: '2026-11-13' } : i)) };
  const romy = planCommissie(data).find((p) => p.setter_user_id === ROMY);
  assert.equal(romy.mutaties.length, 1);
  assert.deepEqual([romy.mutaties[0].invoice_id, romy.mutaties[0].basis, romy.mutaties[0].amount, romy.mutaties[0].basis_incl_btw, romy.mutaties[0].betaal_datum], ['i-2221', 600, 18, true, '2026-11-13']);
  const tweede = planCommissie({ ...data, entries: [{ setter_user_id: ROMY, invoice_id: 'i-2221', basis: 600, amount: 18 }] });
  assert.equal(tweede.find((p) => p.setter_user_id === ROMY).mutaties.length, 0, 'idempotent: tweede run boekt niets');
});

// ── Cron-uitvoer + laden (fake db, alleen lezen) ────────────────────────
function fakeDb(tables, writes) {
  return { from(name) {
    const rows = tables[name] || [];
    const f = [];
    const b = {
      select() { return b; },
      eq(c, v) { f.push((r) => r[c] === v); return b; },
      in(c, vs) { f.push((r) => vs.includes(r[c])); return b; },
      not(c, op, v) { f.push((r) => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle: async () => ({ data: rows.filter((r) => f.every((x) => x(r)))[0] || null, error: null }),
      insert: async (row) => { writes.push({ table: name, row }); return { error: null }; },
      update() { throw new Error('update niet verwacht'); },
      delete() { throw new Error('delete niet verwacht'); },
      then: (ok, nok) => Promise.resolve({ data: rows.filter((r) => f.every((x) => x(r))), error: null }).then(ok, nok),
    };
    return b;
  } };
}

test('cron (dry-run): laadt klantdeals + losse facturen, toont gekoppeld_via_terugval en te_controleren, schrijft niets', async () => {
  const writes = [];
  const tables = {
    deals: REAL.klantDeals,
    setter_config: REAL.configs,
    subscriptions: [],
    invoices: REAL.invoices,
    setter_ledger_entries: [],
    app_settings: [{ key: 'setter_commissie_dry_run', value: { enabled: true } }],
  };
  const m = mock.module(new URL('../api/supabase.js', import.meta.url).href, {
    namedExports: { supabaseAdmin: fakeDb(tables, writes), checkCronAuth: () => ({ ok: true }) },
  });
  try {
    const { default: handler } = await import(`../api/cron-setter-cash-release.js?t=${Math.random()}`);
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query: {}, headers: {} }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.dry_run, true);
    assert.equal(res.body.te_boeken_regels, 0);
    assert.deepEqual(res.body.te_controleren.map((t) => [t.factuurnummer, t.reden]), [['2026 / 10014', 'meerdere_getekende_deals']]);
    const romy = res.body.per_setter.find((p) => p.setter_user_id === ROMY);
    assert.deepEqual(romy.gekoppeld_via_terugval.map((x) => x.factuurnummer), ['2026 / 2221']);
    assert.equal(writes.length, 0);
  } finally {
    m.restore();
  }
});
