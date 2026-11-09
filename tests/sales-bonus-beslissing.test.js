// tests/sales-bonus-beslissing.test.js
//
// Maxim beslist per sales-bonus (houden / ongeldig / aanpassen) of kent er een
// met de hand toe. Niets automatisch; elke actie gelogd in agent_audit_log en
// teruggelezen door de rekenkern. Echte api/sales-bonus-beslissing.js, nep-DB.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const MAXIM = 'cf66585a-49a4-47bc-b3c9-50df2a0faf74';
const DAVE = '70e492cb-90b3-4c03-9822-6a97a2039071';
const SEPP = '162994ff-a21d-446f-bf0b-eea8e7978967';
const B1 = '11111111-1111-4111-8111-111111111111';
const DEAL = '22222222-2222-4222-8222-222222222222';
const DEAL2 = '33333333-3333-4333-8333-333333333333';

const db = maakNepDb();
let rol = 'super_admin';
const meldingen = [];
mock.module(url('api/supabase.js'), {
  namedExports: { supabaseAdmin: db.client, verifyAdmin: async () => ({ user: { id: MAXIM }, profile: { role: rol } }) },
});
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async (n) => { meldingen.push(n); } } });
const { default: handler } = await import(url('api/sales-bonus-beslissing.js'));
const { laadBeslissingen } = await import(url('api/_lib/sales-bonus-stand.js'));

function reset(status = 'pending') {
  meldingen.length = 0;
  db.reset({
    bonuses: [{ id: B1, deal_id: DEAL, sales_user_id: DAVE, amount: 46.27, status }],
    deals: [{ id: DEAL, customer_id: 'c', quote_reference: 'OFF-1' }, { id: DEAL2, customer_id: 'c', quote_reference: 'OFF-2' }],
    profiles: [{ id: DAVE, full_name: 'Dave', role: 'sales', is_active: true }, { id: SEPP, full_name: 'Sepp', role: 'mentor', is_active: true }],
    agent_audit_log: [],
  });
}
async function roep(body) {
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body }, res);
  return res;
}

test('alleen super_admin/admin; reden verplicht', async () => {
  reset();
  rol = 'manager';
  assert.equal((await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'houden', reden: 'ok ok' })).code, 403);
  rol = 'super_admin';
  assert.equal((await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'houden', reden: '' })).code, 400);
  assert.equal(db.rows('agent_audit_log').length, 0);
});

test('houden → bonus ongemoeid, beslissing gelogd en teruggelezen', async () => {
  reset();
  const r = await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'houden', reden: 'termijn 1 betaald' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.rows('bonuses')[0].status, 'pending');
  const log = db.rows('agent_audit_log');
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'sales.bonus.beslissing');
  assert.equal(log[0].triggered_by, MAXIM);
  const { beslissingen } = await laadBeslissingen(db.client);
  assert.equal(beslissingen.get(B1).beslissing, 'houden');
});

test('ongeldig → voided met reden; al uitbetaald → clawback + finance-melding', async () => {
  reset();
  let r = await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'ongeldig', reden: 'niets betaald, geannuleerd' });
  assert.equal(r.code, 200);
  assert.equal(db.rows('bonuses')[0].status, 'voided');
  assert.match(db.rows('bonuses')[0].void_reason, /niets betaald/);
  assert.equal(meldingen.length, 0);
  r = await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'houden', reden: 'toch houden' });
  assert.equal(r.code, 409, 'een ongeldige bonus kan niet meer beslist worden');

  reset('paid');
  r = await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'ongeldig', reden: 'te veel uitbetaald' });
  assert.equal(r.body.clawback, true);
  assert.equal(db.rows('bonuses')[0].clawback_pending, true);
  assert.equal(meldingen[0].type, 'finance.bonus_clawback');
});

test('aanpassen → nieuw bedrag en/of ontvanger, oud + nieuw gelogd; niet bij uitbetaald', async () => {
  reset();
  const r = await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'aanpassen', reden: 'deelbetaling', bedrag: '30', ontvanger_id: SEPP });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.rows('bonuses')[0].amount, 30);
  assert.equal(db.rows('bonuses')[0].sales_user_id, SEPP);
  const p = db.rows('agent_audit_log')[0].payload;
  assert.deepEqual([p.oud.amount, p.nieuw.amount], [46.27, 30]);
  assert.equal((await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'aanpassen', reden: 'niets', bedrag: '30' })).code, 400, 'niets gewijzigd');
  reset('paid');
  assert.equal((await roep({ actie: 'beslis', bonus_id: B1, beslissing: 'aanpassen', reden: 'x y z', bedrag: '10' })).code, 409);
});

test('handmatig toekennen: ontvanger + reden + (basis of telt volledig), gelogd; niet als de deal al een bonus heeft', async () => {
  reset();
  assert.equal((await roep({ actie: 'toekennen', deal_id: DEAL, ontvanger_id: SEPP, bedrag: 50, basis: 1000, reden: 'event zelf gedaan' })).code, 409, 'deal heeft al een actieve bonus');
  assert.equal((await roep({ actie: 'toekennen', quote_reference: 'OFF-2', ontvanger_id: SEPP, bedrag: 50, reden: 'event zelf gedaan' })).code, 400, 'basis of telt volledig verplicht');
  const r = await roep({ actie: 'toekennen', quote_reference: 'OFF-2', ontvanger_id: SEPP, bedrag: 50, basis: 1666.67, reden: 'event zelf gedaan' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const nieuw = db.rows('bonuses').find((b) => b.deal_id === DEAL2);
  assert.equal(nieuw.sales_user_id, SEPP);
  assert.equal(nieuw.status, 'pending');
  const { toekenningen } = await laadBeslissingen(db.client);
  assert.equal(toekenningen.get(nieuw.id).basis, 1666.67);
  assert.equal(toekenningen.get(nieuw.id).telt_volledig, false);
});
