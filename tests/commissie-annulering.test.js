// tests/commissie-annulering.test.js
//
// Commissie volgt annulatie (regels A, B, C, E — Maxim 12 nov 2026):
// api/_lib/commissie-annulering.js + de keuze in "Definitief verwijderen".

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
const meldingen = [];
const tlCalls = [];
let tlOk = true;
let kolommenOntbreken = false;

// Wrapper: simuleert "migratie niet gedraaid" (42703 op de nieuwe kolommen).
const NIEUW = /geannuleerd_op|geannuleerd_door|geannuleerd_reden|geannuleerd_soort|status_voor_annulering/;
const client = {
  rpc: db.client.rpc,
  from(t) {
    const k = db.client.from(t);
    if (t !== 'mentor_ledger_entries') return k;
    const fout = { data: null, error: { code: '42703', message: 'column mentor_ledger_entries.geannuleerd_op does not exist' } };
    const wrap = (inner, kapot) => new Proxy(inner, {
      get(target, prop) {
        if (prop === 'then' && kapot()) return (res) => Promise.resolve(fout).then(res);
        const v = target[prop];
        if (typeof v !== 'function') return v;
        return (...args) => {
          const r = v.apply(target, args);
          if (prop === 'select' && kolommenOntbreken && NIEUW.test(String(args[0] || ''))) return wrap(r, () => true);
          if (prop === 'update' && kolommenOntbreken && NIEUW.test(Object.keys(args[0] || {}).join(' '))) return wrap(r, () => true);
          return r === target ? wrap(r, kapot) : r;
        };
      },
    });
    return wrap(k, () => false);
  },
};

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: client, createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: ACTOR } } }) } }) } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async (o) => { meldingen.push(o); return { ok: true }; } } });
mock.module(url('api/_lib/roles.js'), { namedExports: { getEffectiveRoles: async () => ['super_admin'], hasAnyRole: () => true, computeHighestRole: () => 'super_admin' } });
mock.module(url('api/_lib/teamleader-token.js'), { namedExports: {
  getActiveToken: async () => 'tok',
  tlFetch: async (path) => { tlCalls.push(path); return { ok: tlOk, status: tlOk ? 200 : 400, text: async () => (tlOk ? '' : 'weigert') }; },
} });
mock.module(url('api/mailer.js'), { namedExports: { sendMail: async () => ({ success: true }), wrapEmailHtml: (t, h) => h } });

const A_ = await import(url('api/_lib/commissie-annulering.js'));
const hardDelete = (await import(url('api/sales-hard-delete-quotation.js'))).default;

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const B = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const EV = 'e0000000-0000-4000-8000-0000000000e1';
const ACTOR = 'f0000000-0000-4000-8000-0000000000f0';
const ATTR = '0a000000-0000-4000-8000-0000000000a1';

function zet({ attr = false, kids = true } = {}) {
  meldingen.length = 0; tlCalls.length = 0; tlOk = true; kolommenOntbreken = false;
  db.reset({
    customers: [{ id: K, first_name: 'Larissa', last_name: 'V' }],
    deals: [
      { id: D1, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_id: 'q1', tl_deal_id: 'td1', quote_reference: 'OFF-1' },
      { id: D2, customer_id: K, tl_quotation_status: 'accepted', quote_reference: 'OFF-2' },
    ],
    events: [{ id: EV, title: 'Event Gent', starts_at: '2026-11-07T18:00:00Z' }],
    team_members: [{ id: 'tm-a', name: 'Chesney', user_id: A }, { id: 'tm-b', name: 'Bart', user_id: B }],
    profiles: [{ id: ACTOR, role: 'super_admin', is_active: true, email: 'x@y.z' }],
    invoices: [], bonuses: [], setter_ledger_entries: [], payment_arrangements: [],
    subscriptions: [], deal_line_items: [], meta_capi_events: [], event_attendees: [],
    agent_audit_log: [],
    mentor_sale_attributions: attr ? [{ id: ATTR, deal_id: D1, customer_id: K, reden: 'verlenging', pct: 3, basis: 7200, basis_incl_btw: true, status: 'actief', created_at: '2026-11-08T00:00:00Z' }] : [],
    mentor_ledger_entries: [
      { id: 'p-a', mentor_user_id: A, event_id: attr ? null : EV, attribution_id: attr ? ATTR : null, entry_type: 'bonus', customer_id: K, basis: 7200, basis_incl_btw: true, pct: 3,
        amount: 99, original_amount: 108, status: 'wachten_op_betaling', parent_entry_id: null, source_quote_id: D1, note: 'Bonus 3% van EUR 7200.00 incl BTW / 2 mentor(en)', created_at: '2026-11-07T20:00:00Z', idempotency_key: 'k-a' },
      { id: 'p-b', mentor_user_id: B, event_id: attr ? null : EV, attribution_id: attr ? ATTR : null, entry_type: 'bonus', customer_id: K, basis: 7200, basis_incl_btw: true, pct: 3,
        amount: 108, status: 'pending', parent_entry_id: null, source_quote_id: D1, note: 'Bonus 3%', created_at: '2026-11-07T20:00:00Z', idempotency_key: 'k-b' },
      ...(kids ? [{ id: 'c-a', mentor_user_id: A, entry_type: 'bonus', customer_id: K, amount: 9, status: 'vrijgegeven', parent_entry_id: 'p-a', idempotency_key: 'k-c', event_id: EV }] : []),
    ],
  });
}
const rij = (id) => db.rows('mentor_ledger_entries').find((e) => e.id === id);

test('leesAnnulering: formaat van de rechtzetting van 12 nov en oudere vormen', () => {
  const a = A_.leesAnnulering({ status: 'geannuleerd', note: 'Bonus 3% van EUR 7200.00 incl BTW / 2 mentor(en) | Geannuleerd (klant geannuleerd: offerte gearchiveerd, abonnement geannuleerd, niets betaald — was: pending) op 2026-11-12' });
  assert.equal(a.op, '2026-11-12');
  assert.equal(a.was, 'pending');
  assert.equal(a.soort, 'klant_annuleert');
  assert.match(a.reden, /^klant geannuleerd: offerte gearchiveerd/);
  const b = A_.leesAnnulering({ status: 'geannuleerd', note: 'x · [2026-10-30] Toewijzing geannuleerd: dubbel' });
  assert.equal(b.op, '2026-10-30');
  assert.equal(b.reden, 'dubbel');
  assert.equal(A_.leesAnnulering({ status: 'pending', note: 'Geannuleerd (x) op 2026-01-01' }), null);
  assert.equal(A_.herstelStatus({ status: 'geannuleerd', note: 'Geannuleerd (x — was: wachten_op_betaling) op 2026-01-01' }), 'wachten_op_betaling');
  assert.equal(A_.herstelStatus({ status: 'geannuleerd', note: 'zonder' }), 'pending');
});

test('A — klant annuleert: open ouders → geannuleerd met reden/datum/door; stukken blijven staan; audit', async () => {
  zet();
  const r = await A_.annuleerCommissie(client, { dealId: D1, soort: 'klant_annuleert', actorId: ACTOR, bron: 'hard_delete', extraNote: 'Offerte OFF-1 definitief verwijderd' });
  assert.equal(r.geannuleerd_regels, 2);
  assert.equal(r.reden, 'Klant geannuleerd');
  assert.equal(r.al_vrijgegeven, 9);
  for (const id of ['p-a', 'p-b']) {
    const p = rij(id);
    assert.equal(p.status, 'geannuleerd');
    assert.match(p.note, /\| Offerte OFF-1 definitief verwijderd \| Geannuleerd \(Klant geannuleerd — was: (pending|wachten_op_betaling)\) op \d{4}-\d{2}-\d{2}$/);
    assert.equal(p.geannuleerd_door, ACTOR);
    assert.equal(p.geannuleerd_soort, 'klant_annuleert');
  }
  assert.equal(rij('p-a').status_voor_annulering, 'wachten_op_betaling');
  assert.equal(rij('c-a').status, 'vrijgegeven', 'vrijgegeven stuk blijft staan');
  const au = db.rows('agent_audit_log');
  assert.equal(au.length, 1);
  assert.equal(au[0].action, 'commissie.annuleren');
  assert.equal(au[0].triggered_by, ACTOR);
  const s = await A_.commissieVanDeal(client, D1);
  assert.equal(s.status, 'geannuleerd');
  assert.equal(s.annulering.reden, 'Klant geannuleerd');
  assert.equal(s.totaal_oorspronkelijk, 216);
  assert.equal(s.mentoren[0].naam, 'Chesney');
  // Tweede keer: niets meer open, geen tweede audit.
  const r2 = await A_.annuleerCommissie(client, { dealId: D1, soort: 'klant_annuleert', actorId: ACTOR });
  assert.equal(r2.geannuleerd_regels, 0);
  assert.equal(db.rows('agent_audit_log').length, 1);
});

test('B — vervangen: reden + melding; nieuwe offerte toont voorstel; na nieuwe koppeling niet meer', async () => {
  zet();
  const r = await A_.annuleerCommissie(client, { dealId: D1, soort: 'vervangen', actorId: ACTOR });
  assert.equal(r.reden, 'Vervangen door nieuwe offerte');
  assert.match(r.melding, /Sale toewijzen/);
  const v = await A_.vorigeVervangenCommissie(client, { customerId: K, dealId: D2 });
  assert.ok(v);
  assert.equal(v.vorige_deal_id, D1);
  assert.equal(v.vorige_offerte, 'OFF-1');
  assert.deepEqual(v.mentoren.map((m) => m.naam).sort(), ['Bart', 'Chesney']);
  assert.equal(v.pct, 3);
  assert.equal(v.basis_incl_btw, true);
  assert.equal(v.bron.soort, 'event');
  assert.equal(v.bron.titel, 'Event Gent');
  // Nieuwe commissie op D2 → banner weg.
  db.rows('mentor_ledger_entries').push({ id: 'p-n', mentor_user_id: A, attribution_id: 'x', entry_type: 'bonus', customer_id: K, status: 'pending', parent_entry_id: null, source_quote_id: D2, created_at: new Date().toISOString(), amount: 100 });
  assert.equal(await A_.vorigeVervangenCommissie(client, { customerId: K, dealId: D2 }), null);
});

test('E — herstellen: terug naar de vorige status, toewijzing weer actief, motor mag inhalen', async () => {
  zet({ attr: true });
  await A_.annuleerCommissie(client, { dealId: D1, soort: 'handmatig', reden: 'Per ongeluk gekoppeld', actorId: ACTOR });
  assert.equal(db.rows('mentor_sale_attributions')[0].status, 'geannuleerd');
  await assert.rejects(A_.herstelCommissie(client, { dealId: D1, reden: '' }), (e) => e.code === 'REDEN_VERPLICHT');
  let ingehaald = null;
  const r = await A_.herstelCommissie(client, { dealId: D1, reden: 'Toch geldig', actorId: ACTOR, vrijgave: async (c) => { ingehaald = c; return { ok: true }; } });
  assert.equal(r.hersteld_regels, 2);
  assert.equal(rij('p-a').status, 'wachten_op_betaling');
  assert.equal(rij('p-b').status, 'pending');
  assert.match(rij('p-a').note, /Hersteld \(Toch geldig — terug naar: wachten_op_betaling\) op /);
  assert.equal(db.rows('mentor_sale_attributions')[0].status, 'actief');
  assert.equal(ingehaald, K);
  await assert.rejects(A_.herstelCommissie(client, { dealId: D1, reden: 'nog eens' }), (e) => e.code === 'NIETS_TE_HERSTELLEN');
});

test('E — handmatig zonder reden → 400; al uitbetaald → in-app melding, uitbetaald blijft', async () => {
  zet();
  await assert.rejects(A_.annuleerCommissie(client, { dealId: D1, soort: 'handmatig', reden: '' }), (e) => e.code === 'REDEN_VERPLICHT');
  rij('c-a').status = 'uitbetaald';
  const r = await A_.annuleerCommissie(client, { dealId: D1, soort: 'klant_annuleert', actorId: ACTOR });
  assert.equal(r.al_uitbetaald, 9);
  assert.equal(rij('c-a').status, 'uitbetaald');
  assert.equal(meldingen.length, 1);
  assert.equal(meldingen[0].type, 'finance.mentor_commissie_clawback');
});

test('zonder migratie: annuleren werkt via de note, herstellen leest "was:" terug', async () => {
  zet();
  kolommenOntbreken = true;
  const r = await A_.annuleerCommissie(client, { dealId: D1, soort: 'klant_annuleert', actorId: ACTOR });
  assert.equal(r.geannuleerd_regels, 2);
  assert.equal(r.kolommen_ok, false);
  assert.equal(rij('p-a').status, 'geannuleerd');
  assert.equal(rij('p-a').geannuleerd_door, undefined);
  const s = await A_.commissieVanDeal(client, D1);
  assert.equal(s.annulering.reden, 'Klant geannuleerd');
  await A_.herstelCommissie(client, { dealId: D1, reden: 'terug', actorId: ACTOR });
  assert.equal(rij('p-a').status, 'wachten_op_betaling');
});

test('C — salesZonderAbonnementNa: aanpassing houdt de sale; laatste abonnement weg → vraag', () => {
  const met = new Set([D1]);
  const subs = [
    { id: 's1', deal_id: D1, status: 'active', soort: 'origineel', sale_deal_id: D1 },
    { id: 's2', deal_id: D2, status: 'active', soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: D1 },
  ];
  assert.deepEqual(A_.salesZonderAbonnementNa(subs, 's1', met), [], 'gelinkte aanpassing houdt commissie');
  assert.deepEqual(A_.salesZonderAbonnementNa(subs, 's2', met), [], 'origineel loopt nog');
  subs[1].status = 'cancelled';
  assert.deepEqual(A_.salesZonderAbonnementNa(subs, 's1', met), [D1], 'laatste actieve abonnement van de sale');
  // Nieuwe offerte telt niet als "zelfde sale".
  const subs2 = [
    { id: 's1', deal_id: D1, status: 'active' },
    { id: 's3', deal_id: D2, status: 'active', soort: 'nieuwe_offerte', sale_deal_id: D2 },
  ];
  assert.deepEqual(A_.salesZonderAbonnementNa(subs2, 's1', met), [D1]);
  assert.deepEqual(A_.salesZonderAbonnementNa(subs2, 's1', new Set()), [], 'geen commissie → geen vraag');
});

function nepRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const req = (body) => ({ method: 'POST', body, headers: {}, query: {} });

test('B — Definitief verwijderen: open commissie zonder keuze → 409, niets naar Teamleader', async () => {
  zet();
  const res = nepRes();
  await hardDelete(req({ deal_id: D1, confirm: 'VERWIJDER' }), res);
  assert.equal(res.code, 409);
  assert.equal(res.body.error, 'COMMISSIE_KEUZE_VEREIST');
  assert.equal(tlCalls.length, 0);
  assert.ok(db.rows('deals').some((d) => d.id === D1));
  assert.equal(rij('p-a').status, 'wachten_op_betaling');
});

test('B — met keuze "vervangen": commissie geannuleerd, dan TL + lokale delete', async () => {
  zet();
  const res = nepRes();
  await hardDelete(req({ deal_id: D1, confirm: 'VERWIJDER', commissie_keuze: 'vervangen' }), res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.commissie.reden, 'Vervangen door nieuwe offerte');
  assert.equal(rij('p-a').status, 'geannuleerd');
  assert.match(rij('p-a').note, /Offerte OFF-1 definitief verwijderd/);
  assert.ok(!db.rows('deals').some((d) => d.id === D1));
  assert.deepEqual(tlCalls, ['/quotations.delete']);
});

test('B — Teamleader weigert: commissie wordt teruggezet', async () => {
  zet();
  tlOk = false;
  const res = nepRes();
  await hardDelete(req({ deal_id: D1, confirm: 'VERWIJDER', commissie_keuze: 'klant_annuleert' }), res);
  assert.equal(res.code, 502);
  assert.equal(rij('p-a').status, 'wachten_op_betaling');
  assert.equal(rij('p-b').status, 'pending');
  assert.ok(db.rows('deals').some((d) => d.id === D1));
});

test('B — handmatige toewijzing op de offerte → blocker (deal kan niet weg zonder partial)', async () => {
  zet({ attr: true });
  const res = nepRes();
  await hardDelete(req({ deal_id: D1, confirm: 'VERWIJDER', commissie_keuze: 'klant_annuleert' }), res);
  assert.equal(res.code, 409);
  assert.equal(res.body.blocker.type, 'mentor_sale_attributions');
  assert.equal(tlCalls.length, 0);
  assert.equal(rij('p-a').status, 'wachten_op_betaling');
});
