// tests/commissie-toewijzing-core.test.js
//
// Handmatige sale-toewijzing (api/_lib/commissie-core.js): aanmaken, dubbel
// uitsluiten, meteen vrijgeven op de eigen deal, annuleren (forward-only +
// clawback-melding), preview-termijnen en het platformbrede overzicht.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
const meldingen = [];
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async (o) => { meldingen.push(o); return { ok: true }; } } });
const core = await import(url('api/_lib/commissie-core.js'));

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const B = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const C = 'cccccccc-0000-4000-8000-0000000000cc';
const EV = 'e0000000-0000-4000-8000-0000000000e1';
const ACTOR = 'f0000000-0000-4000-8000-0000000000f0';

function zet({ missing = [], eventBonusOpD2 = false } = {}) {
  meldingen.length = 0;
  db.reset({
    customers: [{ id: K, first_name: 'Jan', last_name: 'Peeters', email: 'jan@x.be' }],
    deals: [
      { id: D1, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2025-01-05T00:00:00Z', quote_reference: 'OFF-1' },
      { id: D2, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-09-20T00:00:00Z', quote_reference: 'OFF-2' },
    ],
    deal_line_items: [
      { deal_id: D1, quantity: 1, unit_price: 6000, vat_percentage: 21, price_includes_vat: true },
      { deal_id: D2, quantity: 1, unit_price: 1000, vat_percentage: 21, price_includes_vat: true },
    ],
    subscriptions: [
      { id: 's2', deal_id: D2, teamleader_subscription_id: 'tl-2', amount: 250, vat_percentage: 0, term_count: 4,
        billing_cycle: 'per_month', start_date: '2026-10-01', status: 'active' },
    ],
    invoices: [
      { id: 'o1', customer_id: K, deal_id: D1, tl_subscription_id: null, amount_total: 6000, amount_paid: 6000, credited_amount: 0, status: 'paid', due_date: '2025-02-01', paid_date: '2025-02-01' },
      { id: 'n1', customer_id: K, deal_id: null, tl_subscription_id: 'tl-2', amount_total: 250, amount_paid: 250, credited_amount: 0, status: 'paid', due_date: '2026-10-01', paid_date: '2026-10-03' },
    ],
    team_members: [
      { id: 'tm-a', name: 'Anna', user_id: A, is_active: true },
      { id: 'tm-b', name: 'Bart', user_id: B, is_active: true },
      { id: 'tm-c', name: 'Cas', user_id: C, is_active: true },
    ],
    profiles: [],
    events: [{ id: EV, title: 'Event Gent', starts_at: '2025-01-10T09:00:00Z' }],
    mentor_sale_attributions: [],
    mentor_ledger_entries: [
      { id: 'p-event', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 6000, pct: 3,
        amount: 180, status: 'pending', parent_entry_id: null, source_quote_id: eventBonusOpD2 ? D2 : D1,
        idempotency_key: `${EV}:bonus:att:${A}`, created_at: '2025-01-10T00:00:00Z' },
    ],
  }, missing);
}
const attrParents = () => db.rows('mentor_ledger_entries').filter((e) => e.attribution_id && !e.parent_entry_id);
const kidsVan = (id) => db.rows('mentor_ledger_entries').filter((e) => e.parent_entry_id === id);

async function verwachtFout(p, code) {
  await assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });
}

test('opslaan: attribution + 1 parent per mentor (3 mentoren, afronding op centen)', async () => {
  zet();
  const r = await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A, B, C] }, { actorId: ACTOR });
  assert.equal(r.ok, true);
  const attr = db.rows('mentor_sale_attributions')[0];
  assert.equal(attr.deal_id, D2);
  assert.equal(attr.reden, 'verlenging');
  assert.equal(attr.pct, 3);
  assert.equal(attr.basis, 1000);
  assert.equal(attr.created_by, ACTOR);
  const ps = attrParents();
  assert.equal(ps.length, 3);
  for (const p of ps) {
    assert.equal(p.event_id, null);
    assert.equal(p.status, 'pending');
    assert.equal(p.source_quote_id, D2);
    assert.equal(p.basis, 1000);
    assert.equal(p.pct, 3);
    assert.match(p.idempotency_key, new RegExp(`^attr:${attr.id}:`));
  }
  assert.equal(r.per_mentor, 10, '3% × 1000 / 3');
  assert.equal(r.totaal_commissie, 30);
});

test('opslaan: meteen vrijgave op ALLEEN de eigen deal (1 van 4 termijnen betaald)', async () => {
  zet();
  const r = await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A] }, { actorId: ACTOR });
  const p = attrParents()[0];
  const kids = kidsVan(p.id);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].amount, 7.5, '250/1000 × 30 — oude deal (6000 betaald) telt niet');
  assert.equal(r.vrijgave.vrijgegeven, 7.5);
  assert.equal(db.rows('mentor_ledger_entries').find((e) => e.id === 'p-event').status, 'pending', 'event-parent onaangeroerd behalve vrijgave');
});

test('opslaan: tweede toewijzing op dezelfde deal → 409 AL_TOEGEWEZEN', async () => {
  zet();
  await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A] }, { actorId: ACTOR });
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [B] }, { actorId: ACTOR }), 'AL_TOEGEWEZEN');
  assert.equal(attrParents().length, 1);
});

test('opslaan: deal met event-bonus → 409, met toch_toevoegen + reden → ok', async () => {
  zet({ eventBonusOpD2: true });
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [B] }, { actorId: ACTOR }), 'AL_EVENT_BONUS');
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [B], toch_toevoegen: true }, { actorId: ACTOR }), 'AL_EVENT_BONUS');
  const r = await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [B], toch_toevoegen: true, toch_reden: 'Bart deed de verlenging' }, { actorId: ACTOR });
  assert.equal(r.ok, true);
  assert.match(attrParents()[0].note, /Toch toegevoegd naast event-bonus: Bart deed de verlenging/);
});

test('opslaan zonder migratie → 503 MIGRATIE_ONTBREEKT, niets geschreven', async () => {
  zet({ missing: ['mentor_sale_attributions'] });
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A] }, { actorId: ACTOR }), 'MIGRATIE_ONTBREEKT');
  assert.equal(attrParents().length, 0);
});

test('opslaan: validatie (niet getekend, onbekende mentor, pct)', async () => {
  zet();
  db.tables.deals[1].tl_quotation_status = 'sent';
  db.tables.deals[1].tl_quotation_accepted_at = null;
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A] }, {}), 'NIET_GETEKEND');
  zet();
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: ['99999999-0000-4000-8000-000000000099'] }, {}), 'MENTOR_ONBEKEND');
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A], pct: 0 }, {}), 'PCT_ONGELDIG');
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [] }, {}), 'GEEN_MENTOR');
  await verwachtFout(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A], reden: 'cadeau' }, {}), 'REDEN_ONGELDIG');
});

test('opslaan: mislukte ledger-insert draait attribution + parents terug', async () => {
  zet();
  // Mentor B heeft al een parent met dezelfde key → tweede insert faalt (23505).
  const echteFrom = db.client.from;
  let teller = 0;
  db.client.from = (t) => {
    const q = echteFrom(t);
    if (t !== 'mentor_ledger_entries') return q;
    const insert = q.insert;
    q.insert = (row) => { teller += 1; if (teller === 2) row = { ...row, idempotency_key: 'p-dubbel' }; return insert(row); };
    return q;
  };
  db.tables.mentor_ledger_entries.push({ id: 'blok', idempotency_key: 'p-dubbel', entry_type: 'uitgave' });
  await assert.rejects(core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A, B] }, { actorId: ACTOR }));
  db.client.from = echteFrom;
  assert.equal(db.rows('mentor_sale_attributions').length, 0);
  assert.equal(attrParents().length, 0);
});

test('annuleren: open parents geannuleerd, vrijgegeven blijft, bevestiging verplicht', async () => {
  zet();
  const r = await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A, B] }, { actorId: ACTOR });
  await verwachtFout(core.annuleerToewijzing({ attribution_id: r.attribution_id }, { actorId: ACTOR }), 'BEVESTIGING');
  const out = await core.annuleerToewijzing({ attribution_id: r.attribution_id, bevestiging: 'ANNULEER', reden: 'fout' }, { actorId: ACTOR });
  assert.equal(out.geannuleerd_regels, 2);
  assert.equal(out.al_vrijgegeven, 7.5, '2 × 3.75 bleef staan');
  assert.equal(out.clawback_melding, false);
  for (const p of attrParents()) {
    assert.equal(p.status, 'geannuleerd');
    for (const k of kidsVan(p.id)) assert.equal(k.status, 'vrijgegeven');
  }
  const attr = db.rows('mentor_sale_attributions')[0];
  assert.equal(attr.status, 'geannuleerd');
  assert.equal(attr.cancelled_by, ACTOR);
  await verwachtFout(core.annuleerToewijzing({ attribution_id: r.attribution_id, bevestiging: 'ANNULEER' }, {}), 'AL_GEANNULEERD');
  // Na annuleren mag de deal opnieuw toegewezen worden.
  const r2 = await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [B] }, { actorId: ACTOR });
  assert.equal(r2.ok, true);
});

test('annuleren: al uitbetaald → zichtbare melding (geen stille terugdraai)', async () => {
  zet();
  const r = await core.opslaanToewijzing({ deal_id: D2, mentor_user_ids: [A] }, { actorId: ACTOR });
  for (const k of kidsVan(attrParents()[0].id)) k.status = 'uitbetaald';
  const out = await core.annuleerToewijzing({ attribution_id: r.attribution_id, bevestiging: 'ANNULEER' }, { actorId: ACTOR });
  assert.equal(out.al_uitbetaald, 7.5);
  assert.equal(meldingen.length, 1);
  assert.equal(meldingen[0].type, 'finance.mentor_commissie_clawback');
});

test('preview: termijnen tellen exact op tot het aandeel, schrijft niets', async () => {
  zet();
  const p = await core.previewToewijzing({ deal_id: D2, mentor_user_ids: [A, B, C], pct: 3 });
  assert.equal(p.totaal_commissie, 30);
  assert.equal(p.mentoren.length, 3);
  assert.equal(p.termijnen.length, 4);
  assert.equal(Math.round(p.termijnen.reduce((s, t) => s + t.aandeel, 0) * 100) / 100, 10);
  assert.equal(p.termijnen[0].status, 'betaald');
  assert.equal(p.betaald_op_deal, 250);
  assert.equal(p.valt_meteen_vrij_per_mentor, 2.5);
  assert.equal(p.blokkeert, false);
  assert.equal(attrParents().length, 0);
  assert.equal(db.rows('mentor_sale_attributions').length, 0);
});

test('zoeken: toont bestaande event-bonus als waarschuwing', async () => {
  zet({ eventBonusOpD2: true });
  const r = await core.zoekOffertes({ q: D2 });
  assert.equal(r.resultaten.length, 1);
  const d = r.resultaten[0];
  assert.equal(d.basis_incl, 1000);
  assert.equal(d.betaald, 250);
  assert.equal(d.bestaand.event_bonus.aantal_mentoren, 1);
  assert.equal(d.bestaand.event_bonus.events[0].title, 'Event Gent');
  assert.equal(d.waarschuwingen.length, 1);
  assert.equal(d.abonnementen[0].term_count, 4);
});

test('termijnSchema: zonder sub en zonder facturen → één termijn met het volle aandeel', () => {
  const t = core.termijnSchema({ subs: [], facturen: [], basis: 1000, aandeel: 30, startFallback: '2026-10-22' });
  assert.equal(t.length, 1);
  assert.equal(t[0].aandeel, 30);
  assert.equal(t[0].schema_onbekend, true);
});

test('bouwOverzicht: KPI\'s, per mentor, per event en risico uit de mentor-overzichten', () => {
  const nu = new Date().toISOString().slice(0, 7);
  const mentoren = [{ user_id: A, naam: 'Anna' }, { user_id: B, naam: 'Bart' }];
  const sale = (extra) => ({
    customer_id: K, customer_label: 'Jan Peeters', basis: 6000, pct: 3, term_count: 2, paid_term_count: 1,
    status: 'actief', has_overdue: false, overdue_amount: 0, bron: 'event',
    termijnen: [{ index: 1, due_date: '2025-02-01', amount: 45, status: 'betaald' }, { index: 2, due_date: '2027-01-01', amount: 45, status: 'open' }],
    ...extra,
  });
  const overzichten = new Map([
    [A, { projection_12m: [{ month: nu, paid: 0, expected: 10 }], per_event: [
      { event_id: EV, event_title: 'Event Gent', starts_at: '2025-01-10T09:00:00Z', sales: [sale({ mentor_share_total: 90, released_share: 45 })] },
      { event_id: null, event_title: 'Handmatig toegewezen · Verlenging', is_handmatig: true, reden: 'verlenging', sales: [
        sale({ bron: 'handmatig', reden: 'verlenging', attribution_id: 'x1', deal_id: D2, basis: 1000, mentor_share_total: 30, released_share: 0, has_overdue: true, overdue_amount: 250, created_at: '2026-10-01T00:00:00Z' }),
      ] },
    ] }],
    [B, { projection_12m: [{ month: nu, paid: 0, expected: 5 }], per_event: [
      { event_id: EV, event_title: 'Event Gent', starts_at: '2025-01-10T09:00:00Z', sales: [sale({ mentor_share_total: 90, released_share: 90 })] },
    ] }],
  ]);
  const o = core.bouwOverzicht({ mentoren, overzichten });
  assert.equal(o.kpis.geboekt, 210);
  assert.equal(o.kpis.vrijgegeven, 135);
  assert.equal(o.kpis.open, 75);
  assert.equal(o.kpis.deze_maand_verwacht, 15);
  assert.equal(o.kpis.risico, 30);
  assert.equal(o.sales.length, 2);
  const ev = o.sales.find((s) => s.bron === 'event');
  assert.equal(ev.mentoren.length, 2);
  assert.equal(ev.status, 'deels');
  assert.equal(ev.termijnen[1].aandeel, 90, 'termijn-aandeel opgeteld over mentoren');
  const hm = o.sales.find((s) => s.bron === 'handmatig');
  assert.equal(hm.bron_label, 'Verlenging');
  assert.equal(hm.status, 'achterstallig');
  assert.deepEqual(hm.risico_redenen, ['vervallen facturen']);
  const anna = o.per_mentor.find((m) => m.user_id === A);
  assert.equal(anna.closes, 2);
  assert.equal(anna.geboekt, 120);
  assert.equal(anna.open, 75);
  const pe = o.per_event.find((e) => e.event_id === EV);
  assert.equal(pe.pot, 180);
  assert.equal(pe.omzet, 6000);
  assert.equal(pe.verdeling.length, 2);
  assert.equal(o.per_event.at(-1).is_handmatig, true);
});
