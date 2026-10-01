// tests/setter-commissie-core.test.js
//
// Setter-commissie op facturen: koppeling factuur → deal, reconcile-delta,
// idempotentie, deelbetaling, creditnota (correctie), effective_from, en de
// cron die in dry-run NIETS schrijft.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  koppelFacturenAanDeals, berekenCommissieMutaties, commissieVoorStap, maandOverzicht, planCommissie,
} from '../api/_lib/setter-commissie-core.js';

const SETTER = '11111111-1111-4111-8111-111111111111';
const CFG = { user_id: SETTER, pct: 3, is_active: true, effective_from: '2026-08-31' };
const DEAL = { id: 'deal-1', customer_id: 'c1', setter_user_id: SETTER, tl_quotation_status: 'accepted', archived_at: null, reservation_fee_invoice_id: null };
const inv = (o) => ({ id: 'inv-1', invoice_number: '2026 / 1', customer_id: 'c1', deal_id: 'deal-1', status: 'paid', amount_total: 600, amount_paid: 600, credited_amount: 0, paid_date: '2026-10-05', ...o });
const reken = (facturen, bestaand = [], cfg = CFG) =>
  berekenCommissieMutaties({ setterId: SETTER, cfg, facturen, bestaand, vandaag: '2026-10-20' });
const alsRegel = (m) => ({ invoice_id: m.invoice_id, basis: m.basis, amount: m.amount });

test('koppeling: deal_id, abonnement (tl_subscription_id), reserveringsfee; deal_id van een andere deal wint', () => {
  const deals = [{ ...DEAL, reservation_fee_invoice_id: 'fee-uuid' }, { id: 'deal-2', setter_user_id: SETTER, reservation_fee_invoice_id: 'TL-FEE-9' }];
  const subs = [{ deal_id: 'deal-2', teamleader_subscription_id: 'tl-sub-2' }];
  const k = koppelFacturenAanDeals({ deals, subs, invoices: [
    { id: 'a', deal_id: 'deal-1' },
    { id: 'b', deal_id: null, tl_subscription_id: 'tl-sub-2' },
    { id: 'fee-uuid', deal_id: null },
    { id: 'c', deal_id: null, tl_invoice_id: 'TL-FEE-9' },
    { id: 'd', deal_id: 'andere-deal', tl_subscription_id: 'tl-sub-2' },
    { id: 'e', deal_id: 'deal-1' },
  ] });
  assert.equal(k.get('a').bron, 'deal');
  assert.equal(k.get('b').deal.id, 'deal-2');
  assert.equal(k.get('b').bron, 'abonnement');
  assert.equal(k.get('fee-uuid').bron, 'reserveringsfee');
  assert.equal(k.get('c').deal.id, 'deal-2');
  assert.equal(k.has('d'), false, 'deal_id van een andere deal → niet van deze setter');
});

test('eerste betaling → één regel van 3 %, basis incl. btw, betaaldatum = paid_date', () => {
  const { mutaties } = reken([{ inv: inv(), deal: DEAL, bron: 'deal' }]);
  assert.equal(mutaties.length, 1);
  const m = mutaties[0];
  assert.equal(m.basis, 600);
  assert.equal(m.amount, 18);
  assert.equal(m.basis_incl_btw, true);
  assert.equal(m.status, 'vrijgegeven');
  assert.equal(m.betaal_datum, '2026-10-05');
  assert.equal(m.idempotency_key, `${SETTER}:inv:inv-1:0:60000`);
  assert.equal(m.payment_id, null);
});

test('idempotent: tweede run met de geboekte regel → niets', () => {
  const eerste = reken([{ inv: inv(), deal: DEAL, bron: 'deal' }]).mutaties.map(alsRegel);
  const r = reken([{ inv: inv(), deal: DEAL, bron: 'deal' }], eerste);
  assert.equal(r.mutaties.length, 0);
  assert.equal(r.facturen[0].reden, 'al_geboekt');
});

test('deelbetaling: 250 dan 600 → twee regels met de delta, samen exact 3 % van 600', () => {
  const r1 = reken([{ inv: inv({ status: 'partially_paid', amount_paid: 250 }), deal: DEAL, bron: 'deal' }]);
  assert.equal(r1.mutaties[0].basis, 250);
  assert.equal(r1.mutaties[0].amount, 7.5);
  const r2 = reken([{ inv: inv(), deal: DEAL, bron: 'deal' }], r1.mutaties.map(alsRegel));
  assert.equal(r2.mutaties.length, 1);
  assert.equal(r2.mutaties[0].basis, 350);
  assert.equal(r2.mutaties[0].amount, 10.5);
  assert.equal(r2.mutaties[0].idempotency_key, `${SETTER}:inv:inv-1:1:60000`, 'n = aantal bestaande regels');
});

test('afronding telescopisch: 3 × 33,33 → Σ = round2(99,99 × 3 %)', () => {
  let bestaand = [];
  for (const paid of [33.33, 66.66, 99.99]) {
    const r = reken([{ inv: inv({ amount_total: 99.99, amount_paid: paid }), deal: DEAL, bron: 'deal' }], bestaand);
    bestaand = bestaand.concat(r.mutaties.map(alsRegel));
  }
  const som = Math.round(bestaand.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  assert.equal(som, Math.round(99.99 * 3) / 100);
});

test('forward-only: creditnota NA boeking → geen nieuwe regel, niets negatiefs, geboekte commissie blijft', () => {
  const geboekt = reken([{ inv: inv(), deal: DEAL, bron: 'deal' }]).mutaties.map(alsRegel);
  // Na PR #1699: volledig gecrediteerd → status credited, amount_paid 0.
  const vol = reken([{ inv: inv({ status: 'credited', amount_paid: 0, credited_amount: 600 }), deal: DEAL, bron: 'deal' }], geboekt);
  assert.equal(vol.mutaties.length, 0);
  assert.equal(vol.facturen[0].reden, 'gecrediteerd_na_boeking_blijft_staan');
  assert.equal(vol.facturen[0].gewenste_commissie, 18, 'de geboekte 18 blijft de stand');
  // Deels gecrediteerd (200 terug) → ook niets.
  const deels = reken([{ inv: inv({ amount_paid: 400, credited_amount: 200 }), deal: DEAL, bron: 'deal' }], geboekt);
  assert.equal(deels.mutaties.length, 0);
});

test('forward-only: creditnota VÓÓR boeking → geen regel (ook niet via een oude "paid"-rij)', () => {
  const nieuw = reken([{ inv: inv({ status: 'credited', amount_paid: 0, credited_amount: 600 }), deal: DEAL, bron: 'deal' }]);
  assert.equal(nieuw.mutaties.length, 0);
  assert.equal(nieuw.facturen[0].reden, 'gecrediteerd_geen_commissie');
  const oudeRij = reken([{ inv: inv({ status: 'paid', amount_paid: 600, credited_amount: 600 }), deal: DEAL, bron: 'deal' }]);
  assert.equal(oudeRij.mutaties.length, 0);
});

test('forward-only: herbetaling na creditnota telt niet dubbel (geboekte basis = hoogwatermerk)', () => {
  let bestaand = reken([{ inv: inv({ amount_paid: 300, status: 'partially_paid' }), deal: DEAL, bron: 'deal' }]).mutaties.map(alsRegel);
  // 300 betaald en geboekt; daarna creditnota → betaald zakt naar 0: niets.
  assert.equal(reken([{ inv: inv({ amount_paid: 0, credited_amount: 300, status: 'open' }), deal: DEAL, bron: 'deal' }], bestaand).mutaties.length, 0);
  // Opnieuw 300 betaald → nog steeds ≤ geboekte basis → niets.
  assert.equal(reken([{ inv: inv({ amount_paid: 300, credited_amount: 300 }), deal: DEAL, bron: 'deal' }], bestaand).mutaties.length, 0);
  // Daarna 600 betaald → alleen de 300 boven het hoogwatermerk.
  const r = reken([{ inv: inv({ amount_paid: 600, credited_amount: 0 }), deal: DEAL, bron: 'deal' }], bestaand);
  assert.equal(r.mutaties.length, 1);
  assert.equal(r.mutaties[0].basis, 300);
  assert.equal(r.mutaties[0].amount, 9);
  bestaand = bestaand.concat(r.mutaties.map(alsRegel));
  assert.equal(bestaand.reduce((s, e) => s + e.amount, 0), 18, 'nooit meer dan 3 % van 600');
});

test('forward-only: elke mutatie is strikt positief; stap die op € 0,00 afrondt wordt niet geboekt', () => {
  const stappen = [100, 250, 250, 600, 0, 600];
  let bestaand = [];
  for (const paid of stappen) {
    const r = reken([{ inv: inv({ amount_paid: paid }), deal: DEAL, bron: 'deal' }], bestaand);
    for (const m of r.mutaties) { assert.ok(m.amount > 0 && m.basis > 0, `positief: ${m.amount}`); }
    bestaand = bestaand.concat(r.mutaties.map(alsRegel));
  }
  assert.equal(bestaand.length, 3, '100, +150, +350');
  assert.equal(Math.round(bestaand.reduce((s, e) => s + e.amount, 0) * 100) / 100, 18);
  // 1 cent × 3 % = 0,0003 → afgerond 0 → geen regel.
  assert.equal(reken([{ inv: inv({ amount_paid: 0.01, amount_total: 0.01 }), deal: DEAL, bron: 'deal' }]).mutaties.length, 0);
});

test('boekMutaties weigert een regel van <= 0 (vangnet)', async () => {
  const { boekMutaties } = await import('../api/_lib/setter-commissie-core.js');
  const inserts = [];
  const db = { from: () => ({ insert: async (row) => { inserts.push(row); return { error: null }; } }) };
  const r = await boekMutaties(db, [
    { idempotency_key: 'a', amount: -3, basis: -100 },
    { idempotency_key: 'b', amount: 0, basis: 0.01 },
    { idempotency_key: 'c', amount: 3, basis: 100 },
  ]);
  assert.equal(r.created, 1);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(inserts.map((x) => x.idempotency_key), ['c']);
});

test('alleen betalingen vanaf effective_from; inactieve config / geen config → niets', () => {
  const oud = reken([{ inv: inv({ paid_date: '2026-08-30' }), deal: DEAL, bron: 'deal' }]);
  assert.equal(oud.mutaties.length, 0);
  assert.equal(oud.overgeslagen[0].reden, 'betaald_voor_effective_from');
  assert.equal(reken([{ inv: inv({ paid_date: '2026-08-31' }), deal: DEAL, bron: 'deal' }]).mutaties.length, 1, 'op de dag zelf telt mee');
  assert.equal(reken([{ inv: inv(), deal: DEAL, bron: 'deal' }], [], { ...CFG, is_active: false }).overgeslagen[0].reden, 'setter_config_inactief');
  assert.equal(reken([{ inv: inv(), deal: DEAL, bron: 'deal' }], [], null).overgeslagen[0].reden, 'geen_setter_config');
});

test('gearchiveerde deal en testfactuur → overgeslagen, nooit geboekt', () => {
  assert.equal(reken([{ inv: inv(), deal: { ...DEAL, archived_at: '2026-09-04' }, bron: 'deal' }]).mutaties.length, 0);
  assert.equal(reken([{ inv: inv({ is_test: true }), deal: DEAL, bron: 'deal' }]).overgeslagen[0].reden, 'testfactuur');
});

test('nog niet betaald → geen regel, geen overgeslagen-melding', () => {
  const r = reken([{ inv: inv({ status: 'open', amount_paid: 0, paid_date: null }), deal: DEAL, bron: 'deal' }]);
  assert.equal(r.mutaties.length, 0);
  assert.equal(r.overgeslagen.length, 0);
  assert.equal(r.facturen[0].reden, 'nog_niet_betaald');
});

test('pct-wijziging raakt alleen nieuw geld', () => {
  const geboekt = [{ invoice_id: 'inv-1', basis: 600, amount: 18 }];
  const r = reken([{ inv: inv({ amount_total: 1200, amount_paid: 1200 }), deal: DEAL, bron: 'deal' }], geboekt, { ...CFG, pct: 5 });
  assert.equal(r.mutaties[0].basis, 600);
  assert.equal(r.mutaties[0].amount, 30, '5 % over de nieuwe 600, de oude 18 blijft');
  assert.equal(commissieVoorStap(600, 1200, 5), 30);
});

test('maandoverzicht: maand = betaal_datum (anders created_at), berekend uit facturen', () => {
  const plan = reken([
    { inv: inv(), deal: DEAL, bron: 'deal' },
    { inv: inv({ id: 'inv-2', paid_date: '2026-09-12', amount_total: 100, amount_paid: 100 }), deal: DEAL, bron: 'reserveringsfee' },
  ]);
  const maanden = maandOverzicht({
    entries: [
      { amount: 18, status: 'uitbetaald', betaal_datum: '2026-10-05', created_at: '2026-11-01T06:00:00Z' },
      { amount: 3, status: 'vrijgegeven', created_at: '2026-09-13T06:00:00Z' },
    ],
    facturen: plan.facturen, pct: 3,
  });
  assert.deepEqual(maanden.map((m) => [m.maand, m.ontvangen, m.berekend, m.geboekt, m.uitbetaald]), [
    ['2026-10', 600, 18, 18, 18],
    ['2026-09', 100, 3, 3, 0],
  ]);
});

test('planCommissie: alleen facturen van de deals van déze setter', () => {
  const ANDER = '22222222-2222-4222-8222-222222222222';
  const plan = planCommissie({
    setterIds: [SETTER, ANDER],
    deals: [DEAL, { id: 'deal-x', setter_user_id: ANDER, tl_quotation_status: 'accepted' }],
    configs: [CFG],
    subs: [],
    invoices: [inv(), inv({ id: 'inv-x', deal_id: 'deal-x' })],
    entries: [],
  }, { vandaag: '2026-10-20' });
  assert.equal(plan[0].mutaties.length, 1);
  assert.equal(plan[0].te_boeken, 18);
  assert.equal(plan[1].mutaties.length, 0);
  assert.equal(plan[1].overgeslagen[0].reden, 'geen_setter_config');
});

// ── Cron: dry-run schrijft niets, live wél (met fake db) ─────────────────
function fakeDb(tables, writes) {
  return {
    from(name) {
      const rows = tables[name] || [];
      const filters = [];
      const b = {
        select() { return b; },
        eq(c, v) { filters.push((r) => r[c] === v); return b; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
        not(c, op, v) { filters.push((r) => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] || null, error: null }),
        insert: async (row) => { writes.push({ table: name, row }); return { error: null }; },
        update() { throw new Error('update niet verwacht'); },
        delete() { throw new Error('delete niet verwacht'); },
        then: (res, rej) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
      };
      return b;
    },
  };
}

async function draaiCron(dryRunWaarde, query = {}) {
  const writes = [];
  const tables = {
    deals: [DEAL],
    setter_config: [CFG],
    subscriptions: [],
    invoices: [inv()],
    setter_ledger_entries: [],
    app_settings: dryRunWaarde == null ? [] : [{ key: 'setter_commissie_dry_run', value: { enabled: dryRunWaarde } }],
  };
  const db = fakeDb(tables, writes);
  const m = mock.module(new URL('../api/supabase.js', import.meta.url).href, {
    namedExports: { supabaseAdmin: db, checkCronAuth: () => ({ ok: true }) },
  });
  try {
    const { default: handler } = await import(`../api/cron-setter-cash-release.js?t=${Math.random()}`);
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query, headers: {} }, res);
    return { res, writes };
  } finally {
    m.restore();
  }
}

test('cron: zonder vlag-rij = dry-run → 0 writes, toont wat geboekt zou worden', async () => {
  const { res, writes } = await draaiCron(null);
  assert.equal(res.code, 200);
  assert.equal(res.body.dry_run, true);
  assert.equal(res.body.te_boeken_regels, 1);
  assert.equal(res.body.te_boeken_bedrag, 18);
  assert.equal(writes.length, 0);
});

test('cron: vlag uit → boekt; ?dry_run=1 forceert dry-run', async () => {
  const live = await draaiCron(false);
  assert.equal(live.res.body.dry_run, false);
  assert.equal(live.res.body.created, 1);
  assert.equal(live.writes.length, 1);
  assert.equal(live.writes[0].table, 'setter_ledger_entries');
  assert.equal(live.writes[0].row.betaal_datum, '2026-10-05');
  const geforceerd = await draaiCron(false, { dry_run: '1' });
  assert.equal(geforceerd.writes.length, 0);
});
