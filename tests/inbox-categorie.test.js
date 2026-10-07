// tests/inbox-categorie.test.js
//
// Categorie per inbox-gesprek (2026-10-07), afgeleid uit de CRM-status:
//   1. telSleutel: elke notatie → dezelfde cijfersleutel (beide kanten);
//   2. prioriteit wanbetaler > onboarding > leadsonderhoud > lead_aanmelding > events > klant > onbekend;
//   3. signalen: achterstallige factuur, gepland/recent gesprek, event-lead;
//   4. bepaalCategorieen op een nep-databank met gemengde notaties, unieke-klant-regel,
//      fail-soft en een index die per minuut wordt hergebruikt;
//   5. de lijst-endpoints en views gebruiken het.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Nep-databank ────────────────────────────────────────────────────────────
const db = { tabellen: {}, faal: new Set(), leesTelling: {} };
function from(tabel) {
  const f = [];
  let bereik = null;
  const match = (r) => f.every(([op, c, v]) =>
    op === 'eq' ? String(r[c]) === String(v)
      : op === 'in' ? v.map(String).includes(String(r[c]))
        : op === 'is' ? (r[c] ?? null) === v
          : op === 'notnull' ? r[c] != null : true);
  const run = () => {
    db.leesTelling[tabel] = (db.leesTelling[tabel] || 0) + 1;
    if (db.faal.has(tabel)) return { data: null, error: { message: 'kapot' } };
    let rijen = (db.tabellen[tabel] || []).filter(match);
    if (bereik) rijen = rijen.slice(bereik[0], bereik[1] + 1);
    return { data: rijen, error: null };
  };
  const k = {
    select: () => k,
    eq: (c, v) => { f.push(['eq', c, v]); return k; },
    in: (c, v) => { f.push(['in', c, v]); return k; },
    is: (c, v) => { f.push(['is', c, v]); return k; },
    not: (c) => { f.push(['notnull', c]); return k; },
    order: () => k,
    range: (a, b) => { bereik = [a, b]; return k; },
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  return k;
}
const sb = { from };
mock.module('../api/supabase.js', { namedExports: { supabaseAdmin: sb, supabase: sb, createUserClient: () => sb } });

const C = await import('../api/_lib/inbox-categorie.js');
const NU = new Date('2026-10-07T10:00:00Z');
const dag = (n) => new Date(NU.getTime() + n * 86400000).toISOString();

// ── 1. Normaliseren ─────────────────────────────────────────────────────────
test('telSleutel: elke notatie van hetzelfde nummer geeft dezelfde sleutel', () => {
  for (const v of ['+31612345678', '+31 6 12345678', '0612345678', '06-12 34 56 78', '0031612345678', "'+31612345678", '612345678', '31612345678']) {
    assert.equal(C.telSleutel(v), '31612345678', v);
  }
  for (const v of ['+32470123456', '+32 470 12 34 56', '0470123456', '0032470123456', '470123456']) {
    assert.equal(C.telSleutel(v), '32470123456', v);
  }
  assert.equal(C.telSleutel('+44 7700 900123'), '447700900123');
  assert.equal(C.telSleutel(''), null);
  assert.equal(C.telSleutel('12345'), null);
  assert.equal(C.telSleutel(null), null);
});

// ── 2. Prioriteit ───────────────────────────────────────────────────────────
test('kiesCategorie: hoogste wint, de rest als tags; niets = onbekend', () => {
  assert.deepEqual(C.kiesCategorie({ klant: true, events: true, wanbetaler: true }), { categorie: 'wanbetaler', tags: ['events', 'klant'] });
  assert.deepEqual(C.kiesCategorie({ onboarding: true, leadsonderhoud: true }), { categorie: 'onboarding', tags: ['leadsonderhoud'] });
  assert.deepEqual(C.kiesCategorie({ lead_aanmelding: true, events: true }), { categorie: 'lead_aanmelding', tags: ['events'] });
  assert.deepEqual(C.kiesCategorie({}), { categorie: 'onbekend', tags: [] });
});

// ── 3. Signalen ─────────────────────────────────────────────────────────────
test('factuurAchterstallig: open + bedrag > 0 + vervaldag verstreken; test/betaald/nog niet vervallen telt niet', () => {
  const v = '2026-10-07';
  assert.equal(C.factuurAchterstallig({ status: 'open', amount_total: 100, amount_paid: 0, due_date: '2026-10-01' }, v), true);
  assert.equal(C.factuurAchterstallig({ status: 'overdue', amount_total: 100, amount_paid: 40, due_date: '2026-09-01' }, v), true);
  assert.equal(C.factuurAchterstallig({ status: 'open', amount_total: 100, amount_paid: 0, due_date: '2026-10-07' }, v), false);
  assert.equal(C.factuurAchterstallig({ status: 'open', amount_total: 100, amount_paid: 100, due_date: '2026-10-01' }, v), false);
  assert.equal(C.factuurAchterstallig({ status: 'paid', amount_total: 100, amount_paid: 0, due_date: '2026-10-01' }, v), false);
  assert.equal(C.factuurAchterstallig({ status: 'open', amount_total: 100, credited_amount: 100, due_date: '2026-10-01' }, v), false);
  assert.equal(C.factuurAchterstallig({ status: 'open', amount_total: 100, due_date: '2026-10-01', is_test: true }, v), false);
});

test('afspraakTelt: gepland of de laatste 30 dagen; geannuleerd of ouder niet', () => {
  const nu = NU.getTime();
  assert.equal(C.afspraakTelt({ status: 'scheduled', scheduled_at: dag(3) }, nu), true);
  assert.equal(C.afspraakTelt({ status: 'completed', scheduled_at: dag(-10) }, nu), true);
  assert.equal(C.afspraakTelt({ status: 'no_show', scheduled_at: dag(-29) }, nu), true);
  assert.equal(C.afspraakTelt({ status: 'completed', scheduled_at: dag(-45) }, nu), false);
  assert.equal(C.afspraakTelt({ status: 'cancelled', scheduled_at: dag(2) }, nu), false);
  assert.equal(C.afspraakTelt({ status: 'scheduled', scheduled_at: dag(2), is_test: true }, nu), false);
});

test('isEventLead: bron begint met "event"', () => {
  for (const b of ['event', 'event · ghl', 'Event · webflow', 'event · event-1']) assert.equal(C.isEventLead({ bron: b }), true, b);
  for (const b of ['website', '7-daagse-v2', 'kennismakingscursus-v1', null]) assert.equal(C.isEventLead({ bron: b }), false, String(b));
});

// ── 4. Volledige run ────────────────────────────────────────────────────────
function vul() {
  C._resetIndex();
  db.faal = new Set(); db.leesTelling = {};
  db.tabellen = {
    customers: [
      { id: 'k-wan', phone: '+31 6 11111111' },        // spaties, gesprek zonder customer_id
      { id: 'k-onb', phone: "'+31622222222" },          // apostrof
      { id: 'k-klant', phone: '+32 470 33 33 33' },     // BE met spaties
      { id: 'k-dub1', phone: '+31 6 99999999' },        // twee klanten op één nummer
      { id: 'k-dub2', phone: '0699999999' },
      { id: 'k-arch', phone: '+31655555555', archived_at: '2026-01-01' },
    ],
    leads: [
      { id: 'l1', telefoon: '0644444444', telefoon_e164: null, bron: '7-daagse-v2', status: 'nieuw' },
      { id: 'l2', telefoon: '+31 6 66666666', telefoon_e164: '+31666666666', bron: 'event · ghl', status: 'nieuw' },
      { id: 'l3', telefoon: '0677777777', telefoon_e164: null, bron: 'website', status: 'nieuw', afspraak_op: dag(2) },
    ],
    event_attendees: [{ id: 'att-1', phone: '+31688888888', status: 'aangemeld', is_test: false, customer_id: null }],
    follow_up_appointments: [],
    opvolging_taken: [], follow_up_leads: [], event_signup_inbox: [], toegang_aanvragen: [],
    invoices: [{ customer_id: 'k-wan', status: 'open', amount_total: 100, amount_paid: 0, due_date: '2026-09-01' }],
    dunning_workflow_runs: [], dunning_pipeline_customers: [],
    onboardings: [{ customer_id: 'k-onb', status: 'bezig' }],
  };
}
const p = (sleutel, telefoon, extra = {}) => ({ sleutel, telefoon, ...extra });

test('bepaalCategorieen: koppelt op cijfersleutel, ongeacht notatie aan beide kanten', async () => {
  vul();
  const m = await C.bepaalCategorieen(sb, [
    p('wan', '+31611111111'),
    p('onb', '+31622222222'),
    p('klant', '+32470333333'),
    p('lead', '+31644444444'),
    p('event-lead', '+31666666666'),
    p('gesprek', '+31677777777'),
    p('att', '+31688888888'),
    p('dub', '+31699999999'),
    p('arch', '+31655555555'),
    p('niks', '+31600000000'),
    p('via-id', '+31600000001', { customer_id: 'k-onb' }),
  ], { nu: NU });
  const c = (k) => m.get(k).categorie;
  assert.equal(c('wan'), 'wanbetaler');
  assert.deepEqual(m.get('wan').tags, ['klant']);
  assert.equal(c('onb'), 'onboarding');
  assert.equal(c('klant'), 'klant');
  assert.equal(c('lead'), 'lead_aanmelding');
  assert.equal(c('event-lead'), 'events');
  assert.equal(c('gesprek'), 'leadsonderhoud');
  assert.equal(c('att'), 'events');
  assert.equal(c('dub'), 'onbekend', 'twee klanten op één nummer → niet koppelen');
  assert.equal(c('arch'), 'onbekend', 'gearchiveerde klant telt niet');
  assert.equal(c('niks'), 'onbekend');
  assert.equal(c('via-id'), 'onboarding', 'customer_id op het gesprek wint');
  assert.equal(m.get('wan').label, 'Wanbetaler');
});

test('index wordt binnen een minuut hergebruikt; klant-signalen blijven live', async () => {
  vul();
  await C.bepaalCategorieen(sb, [p('a', '+31611111111')], { nu: NU });
  await C.bepaalCategorieen(sb, [p('a', '+31611111111')], { nu: NU });
  assert.equal(db.leesTelling.customers > 0, true);
  assert.equal(db.leesTelling.leads, 1, 'telefoon-index één keer gelezen');
  assert.equal(db.leesTelling.invoices, 2, 'facturen elke keer live');
  db.tabellen.invoices = []; // factuur betaald → label verandert meteen
  const m = await C.bepaalCategorieen(sb, [p('a', '+31611111111')], { nu: NU });
  assert.equal(m.get('a').categorie, 'klant');
});

test('fail-soft: een kapotte tabel levert geen signaal, de rest werkt', async () => {
  vul();
  db.faal.add('leads');
  db.faal.add('invoices');
  const m = await C.bepaalCategorieen(sb, [p('onb', '+31622222222'), p('lead', '+31644444444'), p('wan', '+31611111111')], { nu: NU });
  assert.equal(m.get('onb').categorie, 'onboarding');
  assert.equal(m.get('lead').categorie, 'onbekend');
  assert.equal(m.get('wan').categorie, 'klant');
});

test('voegCategorieToe zet categorie/label/tags op de items', async () => {
  vul();
  const items = [{ id: 'x', phone_number: '+31622222222' }, { id: 'y', phone_number: null }];
  await C.voegCategorieToe(sb, items, (it) => ({ sleutel: it.id, telefoon: it.phone_number }));
  assert.equal(items[0].categorie, 'onboarding');
  assert.equal(items[0].categorie_label, 'Onboarding');
  assert.equal(items[1].categorie, 'onbekend');
  assert.deepEqual(items[1].categorie_tags, []);
});

// ── 5. Bedrading ────────────────────────────────────────────────────────────
test('lijst-endpoints en views gebruiken de categorie; index laadt het gedeelde script', () => {
  const lees = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  assert.match(lees('api/inbox-conversations-list.js'), /voegCategorieToe\(supabaseAdmin, items/);
  assert.match(lees('api/leadsonderhoud-gesprekken.js'), /voegCategorieToe\(supabaseAdmin, schoon/);
  for (const v of ['inbox-v2', 'wanbetalers-v2', 'events-v2', 'onboarding-v2', 'leadsonderhoud-v2']) {
    assert.match(lees(`modules/klanten-v2/views/${v}.js`), /INBOX_CATEGORIE/, v);
  }
  const html = lees('modules/klanten-v2/index.html');
  const shared = html.indexOf('../shared/inbox-categorie.js');
  assert.ok(shared > 0 && shared < html.indexOf('views/inbox-v2.js'), 'gedeeld script vóór de views');
});

// ── 6. Zichtbaarheid in de lead-inboxen (2026-10-07) ────────────────────────
test('voorLeadInbox: verbergt hoofdcategorie Wanbetaler/Onboarding, op de server-categorie', async () => {
  const vm = await import('node:vm');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../modules/shared/inbox-categorie.js', import.meta.url), 'utf8'), ctx);
  const IC = ctx.window.INBOX_CATEGORIE;
  const rows = [
    { id: 1, categorie: 'wanbetaler' },
    { id: 2, categorie: 'onboarding', categorie_tags: ['events'] },
    { id: 3, categorie: 'events', categorie_tags: ['wanbetaler'] }, // alleen een TAG → blijft
    { id: 4, categorie: 'leadsonderhoud' },
    { id: 5, categorie: 'klant' },
    { id: 6, categorie: null },                                    // geen categorie → blijft
  ];
  assert.deepEqual(IC.voorLeadInbox(rows).map((r) => r.id), [3, 4, 5, 6]);
  assert.deepEqual([...IC.VERBORGEN_IN_LEAD_INBOX], ['wanbetaler', 'onboarding']);
  // Chips tellen over de zichtbare set: Wanbetaler/Onboarding komen er niet in voor.
  const chips = IC.chips(IC.voorLeadInbox(rows), 'alles', '__x');
  assert.doesNotMatch(chips, /Wanbetaler|Onboarding/);
  assert.match(chips, /Alles <span class="cnt">4<\/span>/);
});

test('alleen Events- en Leadsonderhoud-inbox filteren; hub, Wanbetalers en Onboarding niet', () => {
  const lees = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const ev = lees('modules/klanten-v2/views/events-v2.js');
  assert.match(ev, /st\.data = _evAlleenEventGesprekken\(asArr\(j\?\.items\)\)/, 'eerste load');
  assert.match(ev, /const newItems = _evAlleenEventGesprekken\(asArr\(j\?\.items\)\)/, 'live verversen');
  const ls = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(ls, /st\.items = _lsInbAlleenLeadGesprekken\(asArr\(j\.items\)\)/, 'eerste load');
  assert.match(ls, /_lsInb\.convs\.items = _lsInbAlleenLeadGesprekken\(jList\.items\)/, 'poll');
  for (const v of ['inbox-v2', 'wanbetalers-v2', 'onboarding-v2']) {
    assert.doesNotMatch(lees(`modules/klanten-v2/views/${v}.js`), /voorLeadInbox|hoortInLeadInbox/, v);
  }
});
