// tests/commissie-zicht.test.js
//
// Zichtbaarheid van commissie + incasso per sale (12 nov 2026):
// api/_lib/commissie-zicht.js en api/_lib/commissie-incasso-overzicht.js.
// Geen eigen rekenwerk: grootboek + factuurmotor-koppeling + incassostatus.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async () => ({ ok: true }) } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
const Z = await import(url('api/_lib/commissie-zicht.js'));
const O = await import(url('api/_lib/commissie-incasso-overzicht.js'));

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const V = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const EV = 'e0000000-0000-4000-8000-0000000000e1';

test('statusPil: wacht / deels / volledig / achterstallig / incasso / geannuleerd', () => {
  const c = (x) => ({ heeft_commissie: true, status: 'actief', totaal: 100, vrijgegeven: 0, ...x });
  assert.equal(Z.statusPil({ commissie: c({}) }).k, 'wacht');
  assert.equal(Z.statusPil({ commissie: c({ vrijgegeven: 30 }) }).k, 'deels');
  assert.equal(Z.statusPil({ commissie: c({ vrijgegeven: 100 }) }).k, 'volledig');
  assert.equal(Z.statusPil({ commissie: c({}), achterstallig: 50 }).k, 'achterstallig');
  assert.equal(Z.statusPil({ commissie: c({}), incasso: { status: 'bij_incasso' } }).k, 'incasso');
  assert.equal(Z.statusPil({ commissie: c({}), incasso: { status: 'incasso_regeling' } }).k, 'wacht', 'regeling: betalingen tellen weer');
  assert.equal(Z.statusPil({ commissie: c({ status: 'geannuleerd' }) }).k, 'geannuleerd');
  assert.equal(Z.statusPil({ commissie: { heeft_commissie: false } }).k, 'geen');
});

test('teChecken: verkoper is mentor / zonder abonnement / soort ontbreekt; membership telt niet', () => {
  const deal = { id: D1, tl_quotation_status: 'accepted' };
  const geen = { heeft_commissie: false, open: false };
  assert.deepEqual(Z.teChecken({ deal, commissie: geen, verkoper: { is_mentor: true }, membership: false, subs: [] }), ['verkoper_mentor_geen_commissie']);
  assert.deepEqual(Z.teChecken({ deal, commissie: geen, verkoper: { is_mentor: true }, membership: true, subs: [] }), []);
  const open = { heeft_commissie: true, open: true };
  assert.deepEqual(Z.teChecken({ deal: { ...deal, archived_at: '2026-11-01' }, commissie: open, verkoper: null, subs: [] }), ['commissie_zonder_abonnement']);
  assert.deepEqual(Z.teChecken({ deal, commissie: open, subs: [{ id: 's', status: 'cancelled', soort: 'origineel' }] }), ['commissie_zonder_abonnement']);
  assert.deepEqual(Z.teChecken({ deal, commissie: open, subs: [{ id: 's', status: 'active', soort: null }] }), ['soort_ontbreekt']);
  assert.deepEqual(Z.teChecken({ deal, commissie: open, subs: [{ id: 's', status: 'active', soort: 'origineel' }] }), []);
});

test('vrijkomenTekst: aanbetaling + termijnen', () => {
  assert.match(Z.vrijkomenTekst([{ term_count: 1, status: 'active' }, { term_count: 12, status: 'active' }]), /^aanbetaling \+ 12 termijnen/);
  assert.match(Z.vrijkomenTekst([]), /per betaalde factuur/);
});

test('laadZicht: grootboek, facturen van de sale (ook zonder abonnement-id), incasso, verkoper', async () => {
  db.reset({
    customers: [{ id: K, first_name: 'Larissa', last_name: 'Vlaar' }],
    deals: [
      { id: D1, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-11-07T00:00:00Z', quote_reference: 'OFF-1', sales_user_id: V, created_at: '2026-11-07T00:00:00Z' },
      { id: D2, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-11-09T00:00:00Z', quote_reference: 'OFF-2', sales_user_id: V, created_at: '2026-11-09T00:00:00Z' },
    ],
    deal_line_items: [{ deal_id: D1, quantity: 1, unit_price: 3600, vat_percentage: 21, price_includes_vat: true }],
    subscriptions: [
      { id: 's1', deal_id: D1, teamleader_subscription_id: 'tl-1', amount: 300, vat_percentage: 0, term_count: 12, start_date: '2026-11-15', status: 'active', soort: 'origineel', sale_deal_id: D1 },
      { id: 's2', deal_id: D2, teamleader_subscription_id: 'tl-2', amount: 300, vat_percentage: 0, term_count: 6, start_date: '2027-01-01', status: 'active', soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: D1 },
    ],
    invoices: [
      // Sinds aug geen tl_subscription_id meer: losse factuur → enige commissie-sale.
      { id: 'i1', customer_id: K, deal_id: null, tl_subscription_id: null, amount_total: 300, amount_paid: 300, credited_amount: 0, status: 'paid', due_date: '2026-11-15', paid_date: '2026-11-15' },
      { id: 'i2', customer_id: K, deal_id: D1, tl_subscription_id: null, amount_total: 300, amount_paid: 0, credited_amount: 0, status: 'open', due_date: '2026-11-01' },
    ],
    team_members: [{ id: 'tm', name: 'Chesney', user_id: A, type: 'mentor' }, { id: 'tv', name: 'Dave', user_id: V, type: 'employee' }],
    profiles: [{ id: V, full_name: 'Dave', role: 'sales' }],
    events: [{ id: EV, title: 'Event 7/11', starts_at: '2026-11-07T18:00:00Z' }],
    mentor_sale_attributions: [],
    mentor_commissie_incasso: [],
    payments: [],
    mentor_ledger_entries: [
      { id: 'p1', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 3600, basis_incl_btw: true, pct: 3, amount: 105, original_amount: 108,
        status: 'pending', parent_entry_id: null, source_quote_id: D1, idempotency_key: 'k1', created_at: '2026-11-07T20:00:00Z' },
      { id: 'c1', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, amount: 3, status: 'vrijgegeven', parent_entry_id: 'p1', source_quote_id: D1, idempotency_key: 'k2' },
    ],
  });
  const m = await Z.laadZicht(db.client, [D1, D2], { metFacturen: true });
  const z1 = m.get(D1);
  assert.equal(z1.commissie.totaal, 108);
  assert.equal(z1.commissie.vrijgegeven, 3);
  assert.equal(z1.commissie.bron.titel, 'Event 7/11');
  assert.equal(z1.status.k, 'achterstallig', 'i2 vervallen en open');
  assert.equal(z1.facturen.betaald, 300, 'losse factuur hoort bij de enige commissie-sale');
  assert.deepEqual(z1.abonnementen.map((s) => s.id).sort(), ['s1', 's2'], 'gelinkte aanpassing hangt aan de sale');
  assert.equal(z1.abonnementen.find((s) => s.id === 's2').soort_label, 'Aanpassing · uitstel');
  assert.equal(z1.verkoper.is_mentor, false);
  assert.equal(z1.incasso, null);
  const z2 = m.get(D2);
  assert.equal(z2.commissie.heeft_commissie, false);
  assert.deepEqual(z2.abonnementen, [], 's2 hoort bij D1, niet bij D2');

  db.tables.mentor_commissie_incasso = [{ id: 'mi', customer_id: K, deal_id: null, sinds: '2026-11-10', status: 'bij_incasso', opgeheven_op: null }];
  const m2 = await Z.laadZicht(db.client, [D1], { metFacturen: false });
  assert.equal(m2.get(D1).incasso.status, 'bij_incasso');
  assert.equal(m2.get(D1).status.k, 'incasso');
});

test('Te checken uit Controle: zelfde rijen → soort ontbreekt per abonnement + event-sale zonder commissie', () => {
  const rijen = [
    { klant: 'A', customer_id: K, deal_id: D1, afwijkingen: ['soort_ontbreekt'], zonder_soort: [{ id: 's1' }, { id: 's2' }], mentoren: ['Chesney'] },
    { klant: 'B', customer_id: K, deal_id: D2, event_id: EV, event: 'Event 7/11', afwijkingen: ['geen_commissie'], deelnemer_status: 'aangemeld', uitleg: 'x' },
    { klant: 'C', afwijkingen: ['achter'] },
  ];
  const t = O.teCheckenUitControle(rijen);
  assert.deepEqual(t.map((x) => x.code), ['soort_ontbreekt', 'soort_ontbreekt', 'event_sale_niet_aanwezig']);
  assert.equal(t[0].subscription_id, 's1');
  assert.equal(t[2].event_id, EV);
});
