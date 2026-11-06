// tests/sales-bonus-aanmaak.test.js
//
// Regels van Maxim (6 nov 2026): wie een abonnement aanmaakt of aanpast krijgt
// daardoor nooit automatisch een bonus; een aanpassing/regeling/incasso maakt
// nooit een nieuwe bonus. Aanleiding: 5 nov maakte Sepp als administratieve
// handeling een abonnement aan voor Marc De Bock (soort aanpassing op de offerte
// van Dave). Dat gaf een ghost-deal met Sepp als verkoper en meteen 3% bonus.
// Echte api/sales-subscription-create.js, nep-database.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';
import { magAutomatischeBonus, bonusVolgensRegeling, isGhostDeal } from '../api/_lib/sales-bonus-regels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const SEPP = '162994ff-a21d-446f-bf0b-eea8e7978967';
const DAVE = '70e492cb-90b3-4c03-9822-6a97a2039071';
const MARC = 'a0e5df67-6f90-411c-9ea6-a1c667226bd3';
const SALE = 'ba36f142-db4e-4ad8-ad05-cd61984be850';

// ── Pure regels ─────────────────────────────────────────────────────────
test('regels: standalone of ghost-deal → nooit automatisch', () => {
  assert.equal(magAutomatischeBonus({ standalone: true, deal: { id: 'g', sales_user_id: SEPP } }).ok, false);
  assert.equal(magAutomatischeBonus({ deal: { id: 'g', sales_user_id: DAVE, source: 'subscription_only' } }).ok, false);
  assert.equal(magAutomatischeBonus({ deal: { id: 'g', sales_user_id: DAVE, tl_quotation_status: 'no_quotation' } }).ok, false);
  assert.equal(isGhostDeal({ source: null, tl_quotation_status: 'accepted' }), false);
});

test('regels: aanpassing / incasso / andere sale / vervanging → geen nieuwe bonus', () => {
  const deal = { id: SALE, sales_user_id: DAVE, tl_quotation_status: 'accepted' };
  assert.equal(magAutomatischeBonus({ deal, soorten: [{ soort: 'aanpassing', sale_deal_id: SALE }] }).ok, false);
  assert.equal(magAutomatischeBonus({ deal, soorten: [{ soort: 'incasso_regeling', sale_deal_id: SALE }] }).ok, false);
  assert.equal(magAutomatischeBonus({ deal, soorten: [{ soort: 'origineel', sale_deal_id: 'andere' }] }).ok, false);
  assert.equal(magAutomatischeBonus({ deal, soorten: [{ soort: 'origineel', sale_deal_id: SALE }], eerdereAbonnementen: 1 }).ok, false);
  const ok = magAutomatischeBonus({ deal, soorten: [{ soort: 'origineel', sale_deal_id: SALE }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.ontvanger, DAVE, 'de verkoper van de offerte, niet wie het invoert');
});

test('regeling: 3% over de aanbetaling excl. btw vanaf € 1.000 (sales_bonus_configs leeg)', () => {
  assert.equal(bonusVolgensRegeling(12000), 360);
  assert.equal(bonusVolgensRegeling(1542.20), 46.27);
  assert.equal(bonusVolgensRegeling(999.99), null);
  assert.equal(bonusVolgensRegeling(1000), 30);
  assert.equal(bonusVolgensRegeling(2000, { percentage: 5, threshold_amount: 500 }), 100);
});

// ── Handler ─────────────────────────────────────────────────────────────
const db = maakNepDb();
let ingelogd = SEPP;
mock.module(url('api/supabase.js'), {
  namedExports: {
    supabaseAdmin: db.client,
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: ingelogd } } }) } }),
  },
});
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/teamleader-token.js'), { namedExports: { tlFetch: async () => ({}), getActiveToken: async () => null } });
mock.module(url('api/_lib/teamleader-contact.js'), { namedExports: { getOrCreateTlCustomer: async () => null } });
mock.module(url('api/_lib/teamleader-quotation.js'), { namedExports: { taxRateIdFor: () => 'tax' } });
mock.module(url('api/_lib/invoice-create-core.js'), { namedExports: { createTlInvoice: async () => ({}) } });
const { default: handler } = await import(url('api/sales-subscription-create.js'));

function morgen() {
  const d = new Date(Date.now() + 86400000);
  return d.toISOString().slice(0, 10);
}
function basis() {
  return {
    customers: [{ id: MARC, first_name: 'Marc', last_name: 'De Bock', is_test: false }],
    deals: [{ id: SALE, customer_id: MARC, sales_user_id: DAVE, source: null, tl_quotation_status: 'accepted',
      tl_quotation_accepted_at: '2026-09-15T10:00:00Z', created_at: '2026-09-15T10:00:00Z', archived_at: null }],
    subscriptions: [],
    bonuses: [],
    sales_bonus_configs: [],
    company_entities: [{ tl_department_id: 'dep', is_active: true }],
    app_settings: [],
  };
}
async function roep(body) {
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body }, res);
  return res;
}
const abo = (extra = {}) => ({ description: '1-op-1', start_date: morgen(), term_count: 1, line_items: [{ description: '1-op-1', amount: 10198.65, vat_percentage: 21 }], ...extra });

test('5 nov: Sepp maakt een aanpassing (standalone) op de sale van Dave → GEEN bonus, ook niet voor Sepp', async () => {
  db.reset(basis());
  ingelogd = SEPP;
  const r = await roep({
    mode: 'standalone', matched_customer_id: MARC, tl_department_id: 'dep',
    subscriptions: [abo({ soort: 'aanpassing', aanpassing_type: 'lager_bedrag', sale_deal_id: SALE })],
  });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.bonus, null);
  assert.match(r.body.bonus_skip, /regel 1/);
  assert.equal(db.rows('bonuses').length, 0, 'geen enkele bonus aangemaakt');
  const sub = db.rows('subscriptions')[0];
  assert.equal(sub.soort, 'aanpassing');
  assert.equal(sub.sale_deal_id, SALE, 'de aanpassing hangt aan de sale van Dave');
});

test('standalone "origineel" (eenmalige betaling zonder offerte) → geen automatische bonus', async () => {
  db.reset(basis());
  ingelogd = DAVE;
  const r = await roep({ mode: 'standalone', matched_customer_id: MARC, tl_department_id: 'dep', subscriptions: [abo({ soort: 'origineel' })] });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.rows('bonuses').length, 0);
});

test('offerte van Dave, abonnement ingevoerd door Sepp (origineel) → bonus voor DAVE', async () => {
  db.reset(basis());
  ingelogd = SEPP;
  const r = await roep({ deal_id: SALE, tl_department_id: 'dep', subscriptions: [abo({ soort: 'origineel', line_items: [{ description: 'x', amount: 12000, vat_percentage: 0 }] })] });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const b = db.rows('bonuses');
  assert.equal(b.length, 1);
  assert.equal(b[0].sales_user_id, DAVE);
  assert.equal(b[0].amount, 360);
});

test('aanpassing in deal-modus op de offerte → geen nieuwe bonus', async () => {
  db.reset(basis());
  ingelogd = DAVE;
  const r = await roep({ deal_id: SALE, tl_department_id: 'dep', subscriptions: [abo({ soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: SALE })] });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.rows('bonuses').length, 0);
});

test('offerte had al een (geannuleerd) abonnement → vervanging, geen nieuwe bonus', async () => {
  const t = basis();
  t.subscriptions.push({ id: 'oud', deal_id: SALE, status: 'cancelled', term_count: 1, amount: 12000 });
  db.reset(t);
  ingelogd = DAVE;
  const r = await roep({ deal_id: SALE, tl_department_id: 'dep', subscriptions: [abo({ soort: 'origineel' })] });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.rows('bonuses').length, 0);
  assert.match(r.body.bonus_skip, /vervanging/);
});
