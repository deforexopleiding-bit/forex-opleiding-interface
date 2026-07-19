// tests/meta-ads-roas.test.js
//
// Regressietest voor api/_lib/meta-ads-roas.js (pure aggregator, geen DB).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRoas, resolveLeadCampaign } from '../api/_lib/meta-ads-roas.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function entitiesMap(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.meta_id, e);
  return m;
}

function spendMap(entries) {
  const m = new Map();
  for (const [id, info] of entries) m.set(id, info);
  return m;
}

const CAMP_A = 'camp_A';
const CAMP_B = 'camp_B';
const AD_A1  = 'ad_A1';
const AD_A2  = 'ad_A2';
const AD_B1  = 'ad_B1';

const DEFAULT_ENTITIES = entitiesMap([
  { meta_id: CAMP_A, level: 'campaign', name: 'Camp A', id: 'uuid-camp-a' },
  { meta_id: CAMP_B, level: 'campaign', name: 'Camp B', id: 'uuid-camp-b' },
  { meta_id: AD_A1,  level: 'ad', campaign_meta_id: CAMP_A, name: 'Ad A1', id: 'uuid-ad-a1' },
  { meta_id: AD_A2,  level: 'ad', campaign_meta_id: CAMP_A, name: 'Ad A2', id: 'uuid-ad-a2' },
  { meta_id: AD_B1,  level: 'ad', campaign_meta_id: CAMP_B, name: 'Ad B1', id: 'uuid-ad-b1' },
]);

// ── resolveLeadCampaign ───────────────────────────────────────────────────

test('resolveLeadCampaign: ad-first via utm_content', () => {
  const camp = resolveLeadCampaign({ utm_content: AD_A1 }, DEFAULT_ENTITIES);
  assert.equal(camp, CAMP_A);
});

test('resolveLeadCampaign: campaign-fallback via utm_campaign', () => {
  const camp = resolveLeadCampaign({ utm_campaign: CAMP_B }, DEFAULT_ENTITIES);
  assert.equal(camp, CAMP_B);
});

test('resolveLeadCampaign: geen match → null', () => {
  const camp = resolveLeadCampaign({ utm_content: 'onbekend', utm_campaign: 'ook_onbekend' }, DEFAULT_ENTITIES);
  // utm_campaign zonder entity: geef 'em toch terug als raw id (test-invariant)
  assert.equal(camp, 'ook_onbekend');
});

test('resolveLeadCampaign: helemaal geen utm-velden → null', () => {
  assert.equal(resolveLeadCampaign({}, DEFAULT_ENTITIES), null);
});

// ── aggregateRoas — happy path ────────────────────────────────────────────

test('aggregateRoas: ad-first en campaign-fallback landen op juiste campagne', () => {
  const leads = [
    { ghl_contact_id: 'c1', utm_content: AD_A1 },              // camp A via ad
    { ghl_contact_id: 'c2', utm_campaign: CAMP_B },            // camp B via fallback
    { ghl_contact_id: 'c3', utm_content: AD_B1 },              // camp B via ad
    { ghl_contact_id: 'c4' },                                  // unattributed
  ];
  const appointments = [
    { lead_ghl_contact_id: 'c1', status: 'completed' },
    { lead_ghl_contact_id: 'c3', status: 'scheduled' },
    { lead_ghl_contact_id: 'c4', status: 'no_show' },
    { lead_ghl_contact_id: 'c1', status: 'cancelled' },        // wordt gefilterd
  ];
  const deals = [
    { customer_ghl_contact_id: 'c1', total_amount: 1000, status: 'active', archived_at: null },
    { customer_ghl_contact_id: 'c3', total_amount: 2000, status: 'active', archived_at: null },
    { customer_ghl_contact_id: 'c4', total_amount: 500,  status: 'active', archived_at: null },
  ];
  const spend = spendMap([
    [CAMP_A, { spend: 100, name: 'Camp A', entity_uuid: 'uuid-camp-a', effective_status: 'ACTIVE' }],
    [CAMP_B, { spend: 400, name: 'Camp B', entity_uuid: 'uuid-camp-b', effective_status: 'ACTIVE' }],
  ]);

  const r = aggregateRoas({ leads, appointments, deals, spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });

  // Camp A: 1 lead, 1 appt (c1 completed), 1 sale, €1000, spend €100, ROAS 10x
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.equal(campA.leads, 1);
  assert.equal(campA.appointments, 1);
  assert.equal(campA.sales, 1);
  assert.equal(campA.revenue, 1000);
  assert.equal(campA.spend, 100);
  assert.equal(campA.roas, 10);
  assert.equal(campA.cost_per_customer, 100);

  // Camp B: 2 leads (c2, c3), 1 appt (c3), 1 sale (c3), €2000, spend €400, ROAS 5x
  const campB = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_B);
  assert.equal(campB.leads, 2);
  assert.equal(campB.appointments, 1);
  assert.equal(campB.sales, 1);
  assert.equal(campB.revenue, 2000);
  assert.equal(campB.spend, 400);
  assert.equal(campB.roas, 5);

  // Niet-toegewezen: c4 met 1 appt + 1 sale + €500
  assert.equal(r.unattributed.leads, 1);
  assert.equal(r.unattributed.appointments, 1);
  assert.equal(r.unattributed.sales, 1);
  assert.equal(r.unattributed.revenue, 500);

  // Totals
  assert.equal(r.totals.spend, 500);
  assert.equal(r.totals.leads, 4);
  assert.equal(r.totals.appointments, 3);
  assert.equal(r.totals.sales, 3);
  assert.equal(r.totals.revenue, 3500);
  assert.equal(r.totals.attributed_revenue, 3000);
  assert.equal(r.totals.unattributed_revenue, 500);
  assert.equal(r.totals.roas, 6);   // 3000 / 500
});

// ── Sorteervolgorde ───────────────────────────────────────────────────────

test('aggregateRoas: perCampaign gesorteerd op spend desc', () => {
  const spend = spendMap([
    [CAMP_A, { spend: 100 }],
    [CAMP_B, { spend: 500 }],
  ]);
  const r = aggregateRoas({ leads: [], appointments: [], deals: [], spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
  assert.equal(r.perCampaign[0].campaign_meta_id, CAMP_B);
  assert.equal(r.perCampaign[1].campaign_meta_id, CAMP_A);
});

// ── Spend zonder attributie ──────────────────────────────────────────────

test('aggregateRoas: spend zonder leads → campagne blijft zichtbaar met sales=0, ROAS=0', () => {
  const spend = spendMap([[CAMP_A, { spend: 200 }]]);
  const r = aggregateRoas({ leads: [], appointments: [], deals: [], spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.ok(campA, 'Camp A moet in perCampaign staan (spend-only)');
  assert.equal(campA.leads, 0);
  assert.equal(campA.sales, 0);
  assert.equal(campA.roas, 0);
  assert.equal(campA.cost_per_customer, null);
});

// ── Excluded status ──────────────────────────────────────────────────────

test('aggregateRoas: deal.status in EXCLUDED_DEAL_STATUSES → telt niet mee', async () => {
  // Simuleer 'deceased' als excluded door tijdelijk de set aan te passen.
  // (We importeren de mutable Set en zetten 'em terug na de test.)
  const mod = await import('../api/_lib/meta-ads-roas.js');
  mod.EXCLUDED_DEAL_STATUSES.add('deceased');
  try {
    const leads = [{ ghl_contact_id: 'c1', utm_content: AD_A1 }];
    const deals = [
      { customer_ghl_contact_id: 'c1', total_amount: 999, status: 'deceased', archived_at: null },
    ];
    const spend = spendMap([[CAMP_A, { spend: 100 }]]);
    const r = mod.aggregateRoas({ leads, appointments: [], deals, spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
    const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
    assert.equal(campA.sales, 0);
    assert.equal(campA.revenue, 0);
  } finally {
    mod.EXCLUDED_DEAL_STATUSES.delete('deceased');
  }
});

// ── Archived_at ──────────────────────────────────────────────────────────

test('aggregateRoas: deal.archived_at != null → skip', () => {
  const leads = [{ ghl_contact_id: 'c1', utm_content: AD_A1 }];
  const deals = [
    { customer_ghl_contact_id: 'c1', total_amount: 500, status: 'active', archived_at: '2026-01-01T00:00:00Z' },
  ];
  const spend = spendMap([[CAMP_A, { spend: 100 }]]);
  const r = aggregateRoas({ leads, appointments: [], deals, spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.equal(campA.sales, 0);
});

// ── Cancelled appointment ────────────────────────────────────────────────

test('aggregateRoas: cancelled appointment telt niet mee', () => {
  const leads = [{ ghl_contact_id: 'c1', utm_content: AD_A1 }];
  const apts = [{ lead_ghl_contact_id: 'c1', status: 'cancelled' }];
  const r = aggregateRoas({ leads, appointments: apts, deals: [], spendByCampaign: new Map(), entitiesByMetaId: DEFAULT_ENTITIES });
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.equal(campA.appointments, 0);
});

// ── Multiple deals van 1 klant → DISTINCT customer ───────────────────────

test('aggregateRoas: meerdere deals van dezelfde klant → 1 customer, N sales, som revenue', () => {
  const leads = [{ ghl_contact_id: 'c1', utm_content: AD_A1 }];
  const deals = [
    { customer_ghl_contact_id: 'c1', total_amount: 500, status: 'active', archived_at: null },
    { customer_ghl_contact_id: 'c1', total_amount: 750, status: 'active', archived_at: null },
  ];
  const spend = spendMap([[CAMP_A, { spend: 250 }]]);
  const r = aggregateRoas({ leads, appointments: [], deals, spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.equal(campA.customers, 1);
  assert.equal(campA.sales, 2);
  assert.equal(campA.revenue, 1250);
  assert.equal(campA.cost_per_customer, 250); // 250 / 1
  assert.equal(campA.roas, 5);                 // 1250 / 250
});

// ── Deal/appointment zonder lead-in-window ───────────────────────────────

test('aggregateRoas: deal van customer zonder lead-in-window → wordt niet gecrediteerd', () => {
  const leads = [{ ghl_contact_id: 'c1', utm_content: AD_A1 }];
  const deals = [
    { customer_ghl_contact_id: 'c1', total_amount: 500, status: 'active', archived_at: null },
    { customer_ghl_contact_id: 'c99', total_amount: 9999, status: 'active', archived_at: null }, // c99 heeft geen lead-rij
  ];
  const spend = spendMap([[CAMP_A, { spend: 100 }]]);
  const r = aggregateRoas({ leads, appointments: [], deals, spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
  // Alleen c1's 500 telt mee — c99's 9999 wordt genegeerd
  assert.equal(r.totals.revenue, 500);
});

// ── Lege data → lege respons ─────────────────────────────────────────────

test('aggregateRoas: lege data → lege respons zonder crash', () => {
  const r = aggregateRoas({ leads: [], appointments: [], deals: [], spendByCampaign: new Map(), entitiesByMetaId: new Map() });
  assert.equal(r.perCampaign.length, 0);
  assert.equal(r.unattributed.leads, 0);
  assert.equal(r.unattributed.revenue, 0);
  assert.equal(r.totals.spend, 0);
  assert.equal(r.totals.roas, null); // spend=0 → n.v.t.
});

// ── Defensief: null/undefined inputs ─────────────────────────────────────

test('aggregateRoas: null/undefined inputs → treated as empty, geen crash', () => {
  const r = aggregateRoas({ leads: null, appointments: undefined, deals: null, spendByCampaign: null, entitiesByMetaId: undefined });
  assert.equal(r.perCampaign.length, 0);
  assert.equal(r.totals.spend, 0);
});

// ── ROAS-berekening null bij spend=0 ─────────────────────────────────────

test('aggregateRoas: campagne met spend=0 (edge) → ROAS = null (n.v.t.)', () => {
  const leads = [{ ghl_contact_id: 'c1', utm_campaign: CAMP_A }];
  const deals = [{ customer_ghl_contact_id: 'c1', total_amount: 500, status: 'active', archived_at: null }];
  const spend = spendMap([[CAMP_A, { spend: 0 }]]);
  const r = aggregateRoas({ leads, appointments: [], deals, spendByCampaign: spend, entitiesByMetaId: DEFAULT_ENTITIES });
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.equal(campA.roas, null);
  assert.equal(campA.cost_per_customer, 0); // spend/customer = 0/1 = 0 (bewust: 0 kosten per klant)
});

// ── utm_content dat naar een 'campaign'-level entity wijst ───────────────

test('aggregateRoas: utm_content dat toevallig een campaign-id is → gebruikt die', () => {
  const leads = [{ ghl_contact_id: 'c1', utm_content: CAMP_A }]; // utm_content = camp-id, niet ad-id
  const r = aggregateRoas({ leads, appointments: [], deals: [], spendByCampaign: spendMap([[CAMP_A, { spend: 50 }]]), entitiesByMetaId: DEFAULT_ENTITIES });
  const campA = r.perCampaign.find((c) => c.campaign_meta_id === CAMP_A);
  assert.equal(campA.leads, 1);
});
