// tests/setter-annulering.test.js
//
// Annulering zichtbaar in het setter-scherm (2026-11-02). Een GETEKENDE sale
// die daarna gearchiveerd/afgewezen werd, of waarvan alle abonnementen
// gestopt zijn, blijft zichtbaar met het label "Geannuleerd" — in "Mijn
// calls" (api/setter-calls.js) en in het Overzicht (api/setter-overview.js),
// buiten de forecast en meegeteld in "vervallen door annulering". Een nooit
// getekende offerte die gearchiveerd werd blijft weg, zoals voorheen.
// Grafiek en commissie per maand worden niet aangeraakt.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const KARL = 'fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7';
const ANDER = '22222222-2222-4222-8222-222222222222';

// ── In-memory databank (alleen lezen) ───────────────────────────────────
const db = { tabellen: {}, log: [] };
function from(tabel) {
  const q = { tabel, filters: [] };
  const k = {
    select: () => k,
    eq: (c, v) => { q.filters.push((r) => r[c] === v); return k; },
    in: (c, v) => { q.filters.push((r) => v.includes(r[c])); return k; },
    is: (c, v) => { q.filters.push((r) => (r[c] ?? null) === v); return k; },
    not: (c, op, v) => { q.filters.push((r) => (op === 'is' ? (r[c] ?? null) !== v : true)); return k; },
    gte: () => k, lt: () => k, lte: () => k, order: () => k, limit: () => k, range: () => k,
    insert: () => { throw new Error('insert verboden'); },
    update: () => { throw new Error('update verboden'); },
    upsert: () => { throw new Error('upsert verboden'); },
    delete: () => { throw new Error('delete verboden'); },
    maybeSingle: () => run().then((r) => ({ data: (r.data || [])[0] || null, error: null })),
    then: (ok, nok) => run().then(ok, nok),
  };
  async function run() {
    db.log.push(tabel);
    const rijen = db.tabellen[tabel];
    if (!rijen) return { data: null, error: null };
    return { data: rijen.filter((r) => q.filters.every((f) => f(r))), error: null };
  }
  return k;
}
const st = { user: KARL, perms: new Set(['setter.ledger.view']) };
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from, rpc: () => { throw new Error('rpc verboden'); } },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user ? { id: st.user } : null } }) } }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async (req, key) => st.perms.has(key) },
});

const L = await import('../api/_lib/setter-calls.js');
const { default: callsHandler } = await import('../api/setter-calls.js');
const { default: overviewHandler } = await import('../api/setter-overview.js');

async function get(handler, query = {}) {
  const uit = { code: null, body: null };
  const res = { setHeader() {}, status(c) { uit.code = c; return this; }, json(b) { uit.body = b; return this; } };
  await handler({ method: 'GET', headers: {}, query }, res);
  return uit;
}

let _n = 0;
const deal = (x = {}) => ({
  id: 'd' + (++_n), customer_id: 'c' + _n, setter_user_id: KARL, total_amount: 2880, status: null,
  quote_reference: null, created_at: '2026-10-20T13:29:12Z', start_date: '2026-10-20',
  archived_at: null, traject_variant_id: null, tl_quotation_status: 'accepted',
  tl_quotation_accepted_at: '2026-10-20T13:32:06Z', payment_start_date: null,
  payment_downpayment_amount: null, payment_downpayment_date: null,
  payment_term_count: 36, payment_term_amount: 80, payment_term_start_date: '2026-10-20',
  exception_flagged: false, exception_reasons: null, exception_fee_agreed: false, reservation_fee_invoice_id: null,
  ...x,
});

// ═══════════════════════════════════════════════════════════════════════
// 1. De regel
// ═══════════════════════════════════════════════════════════════════════

test('annuleringVanDeal: gearchiveerd, afgewezen na tekenen, alle abonnementen gestopt', () => {
  const arch = L.annuleringVanDeal(deal({ archived_at: '2026-11-03T09:00:00Z' }));
  assert.deepEqual(arch, { reden: 'gearchiveerd', label: 'Deal gearchiveerd', op: '2026-11-03' });
  assert.equal(L.annuleringVanDeal(deal({ tl_quotation_status: 'declined' })).reden, 'afgewezen', 'acceptatiedatum blijft → was getekend');
  assert.equal(L.annuleringVanDeal(deal(), [{ status: 'cancelled' }, { status: 'deactivated' }]).reden, 'abonnement_gestopt');
  assert.equal(L.annuleringVanDeal(deal(), [{ status: 'cancelled' }, { status: 'active' }]), null, 'één abonnement loopt nog');
  assert.equal(L.annuleringVanDeal(deal(), []), null, 'geen abonnementen = niet geannuleerd');
  assert.equal(L.annuleringVanDeal(deal()), null);
});

test('annuleringVanDeal: een nooit getekende offerte is nooit een geannuleerde sale', () => {
  const concept = deal({ tl_quotation_status: 'draft', tl_quotation_accepted_at: null, archived_at: '2026-09-21T11:37:45Z' });
  const verstuurd = deal({ tl_quotation_status: 'sent', tl_quotation_accepted_at: null }, );
  assert.equal(L.annuleringVanDeal(concept), null);
  assert.equal(L.annuleringVanDeal(verstuurd, [{ status: 'cancelled' }]), null);
  assert.equal(L.isGetekendeDeal(concept), false);
  assert.equal(L.isGetekendeDeal(deal({ tl_quotation_status: 'signed', tl_quotation_accepted_at: null })), true);
});

test('matchSaleDeal: actieve deal eerst, anders de geannuleerde getekende; ongetekend gearchiveerd nooit', () => {
  const klant = { email: 'evertjan@x.nl', phone: null };
  const a = { lead_email: 'Evertjan@x.nl', scheduled_at: '2026-10-20T12:30:00Z' };
  const geannuleerd = deal({ archived_at: '2026-11-03T09:00:00Z', created_at: '2026-10-20T13:00:00Z' });
  const actief = deal({ created_at: '2026-08-01T00:00:00Z' });
  const concept = deal({ tl_quotation_status: 'draft', tl_quotation_accepted_at: null, archived_at: '2026-10-21T00:00:00Z' });
  assert.equal(L.matchSaleDeal(a, [geannuleerd, actief].map((d) => ({ deal: d, klant }))).id, actief.id);
  assert.equal(L.matchSaleDeal(a, [geannuleerd, concept].map((d) => ({ deal: d, klant }))).id, geannuleerd.id);
  assert.equal(L.matchSaleDeal(a, [concept].map((d) => ({ deal: d, klant }))), null);
});

test('bouwCallRegel: sale-blok krijgt `geannuleerd` (gearchiveerd én abonnement gestopt); actieve sale ongewijzigd', () => {
  const opts = (deals) => ({ nuMs: Date.parse('2026-11-04T00:00:00Z'), startdatum: '2026-10-02', dealsMetKlant: deals });
  const a = { id: 'x', lead_email: 'e@x.nl', scheduled_at: '2026-10-20T12:30:00Z', status: 'completed', uitkomst: 'sale' };
  const klant = { email: 'e@x.nl' };
  const arch = deal({ archived_at: '2026-11-03T09:00:00Z' });
  const r1 = L.bouwCallRegel(a, opts([{ deal: arch, klant, subs: [] }]));
  assert.equal(r1.categorie.key, 'sale', 'de call-uitkomst blijft wat de closer vastlegde');
  assert.equal(r1.sale.gekoppeld, true);
  assert.equal(r1.sale.bedrag, 2880);
  assert.equal(r1.sale.geannuleerd.reden, 'gearchiveerd');
  const gestopt = deal();
  const r2 = L.bouwCallRegel(a, opts([{ deal: gestopt, klant, subs: [{ status: 'cancelled' }] }]));
  assert.equal(r2.sale.geannuleerd.reden, 'abonnement_gestopt');
  const r3 = L.bouwCallRegel(a, opts([{ deal: deal(), klant, subs: [{ status: 'active' }] }]));
  assert.equal('geannuleerd' in r3.sale, false);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Endpoints
// ═══════════════════════════════════════════════════════════════════════

function vul({ deals, subs = [], klanten, rijen = [] }) {
  db.log = [];
  db.tabellen = {
    app_settings: [],
    follow_up_appointments: rijen,
    deals,
    customers: klanten,
    subscriptions: subs,
    setter_config: [{ user_id: KARL, pct: 3, is_active: true, effective_from: '2026-10-12' }],
    setter_ledger_entries: [],
    invoices: [],
    traject_variants: [],
  };
}

test('setter-calls: de geannuleerde getekende deal staat bij de sale-call met reden; geen schrijfactie', async () => {
  const evertjan = deal({ id: 'd-evertjan', customer_id: 'c-ev', archived_at: '2026-11-03T09:00:00Z' });
  vul({
    deals: [evertjan],
    klanten: [{ id: 'c-ev', email: 'evertjandetuinman@gmail.com', phone: null }],
    rijen: [{ id: 'r1', lead_name: 'Evertjan Graeff', lead_email: 'evertjandetuinman@gmail.com', lead_phone: null,
      scheduled_at: '2026-10-20T12:30:00Z', duration_minutes: 30, status: 'completed', uitkomst: 'sale',
      parent_appointment_id: null, setter_user_id: KARL, is_test: false }],
  });
  st.user = KARL; st.perms = new Set(['setter.ledger.view']);
  const r = await get(callsHandler);
  assert.equal(r.code, 200);
  const call = [...r.body.gedaan, ...r.body.komend, ...r.body.eerder].find((c) => c.id === 'r1');
  assert.equal(call.sale.deal_id, 'd-evertjan');
  assert.deepEqual(call.sale.geannuleerd, { reden: 'gearchiveerd', label: 'Deal gearchiveerd', op: '2026-11-03' });
  assert.ok(db.log.includes('subscriptions'), 'abonnementen worden gelezen voor "abonnement gestopt"');
  assert.doesNotMatch(JSON.stringify(r.body), /evertjandetuinman/, 'geen e-mail naar het scherm');
});

test('setter-overview: geannuleerde sales blijven met label, buiten de forecast, in "vervallen door annulering"', async () => {
  const actief = deal({ id: 'd-ljupce', customer_id: 'c1', total_amount: 7200, created_at: '2026-10-26T12:56:13Z' });
  const gearchiveerd = deal({ id: 'd-evertjan', customer_id: 'c2', total_amount: 2880, archived_at: '2026-11-03T09:00:00Z' });
  const abboGestopt = deal({ id: 'd-gestopt', customer_id: 'c3', total_amount: 1000 });
  const concept = deal({ id: 'd-concept', customer_id: 'c4', total_amount: 3950, tl_quotation_status: 'draft', tl_quotation_accepted_at: null, archived_at: '2026-09-21T11:37:45Z' });
  const verstuurd = deal({ id: 'd-verstuurd', customer_id: 'c5', total_amount: 500, tl_quotation_status: 'sent', tl_quotation_accepted_at: null });
  const vanAnder = deal({ id: 'd-ander', customer_id: 'c6', setter_user_id: ANDER, archived_at: '2026-11-01T00:00:00Z' });
  vul({
    deals: [actief, gearchiveerd, abboGestopt, concept, verstuurd, vanAnder],
    subs: [
      { id: 's1', deal_id: 'd-ljupce', status: 'active', teamleader_subscription_id: 'tl1' },
      { id: 's2', deal_id: 'd-evertjan', status: 'active', teamleader_subscription_id: 'tl2' },
      { id: 's3', deal_id: 'd-gestopt', status: 'cancelled', teamleader_subscription_id: 'tl3' },
    ],
    klanten: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ id, first_name: 'K', last_name: id, is_company: false })),
  });
  st.user = KARL; st.perms = new Set(['setter.ledger.view']);
  const r = await get(overviewHandler);
  assert.equal(r.code, 200);
  const ids = r.body.sales.map((s) => s.deal_id).sort();
  assert.deepEqual(ids, ['d-evertjan', 'd-gestopt', 'd-ljupce', 'd-verstuurd'], 'concept-gearchiveerd blijft weg, andermans deal ook');
  const per = Object.fromEntries(r.body.sales.map((s) => [s.deal_id, s]));
  assert.equal(per['d-evertjan'].geannuleerd.reden, 'gearchiveerd');
  assert.equal(per['d-gestopt'].geannuleerd.reden, 'abonnement_gestopt');
  assert.equal(per['d-ljupce'].geannuleerd, null);
  assert.equal(per['d-verstuurd'].geannuleerd, null);
  assert.equal(r.body.totals.forecast_nog_te_verwachten, 216, '3% van € 7.200 — alleen de lopende sale');
  assert.equal(r.body.totals.vervallen_door_annulering, 116.4, '3% van € 2.880 + 3% van € 1.000');
  assert.equal(r.body.totals.in_afwachting_offerte, 15, '3% van € 500 (ongewijzigd)');
});

test('setter-overview: een andere setter opvragen zonder setter.ledger.admin blijft 403', async () => {
  st.user = KARL; st.perms = new Set(['setter.ledger.view']);
  assert.equal((await get(overviewHandler, { setter_user_id: ANDER })).code, 403);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. De weergave
// ═══════════════════════════════════════════════════════════════════════

const VIEW = readFileSync(new URL('../modules/klanten-v2/views/setter-payout-v2.js', import.meta.url), 'utf8');
const MAPPING = readFileSync(new URL('../modules/shared/call-uitkomst-categorie.js', import.meta.url), 'utf8');

function scherm(antwoorden) {
  const ctx = { console: { log() {}, warn() {}, error() {}, debug() {} }, queueMicrotask: (f) => queueMicrotask(f), setTimeout, clearTimeout };
  ctx.window = ctx;
  ctx.KV_V2 = { helpers: {} };
  ctx.KV = { authedFetch: async (url) => {
    const k = Object.keys(antwoorden).find((p) => url.startsWith(p));
    return { ok: true, status: 200, json: async () => (k ? antwoorden[k] : {}) };
  } };
  ctx.DFO = { VIEWS: {}, render: () => {} };
  ctx.RBAC = { ensurePermissionsLoaded: async () => {}, canSync: () => false };
  createContext(ctx);
  runInContext(MAPPING, ctx);
  runInContext(VIEW, ctx);
  return ctx;
}
const wacht = () => new Promise((r) => setTimeout(r, 0));

test('weergave Mijn calls: rood label "Geannuleerd" met reden naast het bedrag', async () => {
  const ctx = scherm({ '/api/setter-calls': {
    startdatum: '2026-10-02', telling: { totaal: 1, per_categorie: [{ key: 'sale', aantal: 1 }] }, komend: [], eerder: [],
    gedaan: [{ id: 'g1', lead_name: 'Evertjan Graeff', datum_nl: '2026-10-20', tijd_nl: '14:30', categorie: { key: 'sale', label: 'Sale', kleur: '#16a34a' },
      sale: { gekoppeld: true, deal_id: 'd', bedrag: 2880, offerte_status: 'accepted', offerte_status_label: 'geaccepteerd', in_afwachting: false,
        geannuleerd: { reden: 'gearchiveerd', label: 'Deal gearchiveerd', op: '2026-11-03' } } }],
  } });
  const view = ctx.DFO.VIEWS['setter-payout/Mijn calls'];
  view(); await wacht(); await wacht();
  const html = view();
  assert.match(html, /€\s?2\.880,00/);
  assert.match(html, /✕ Geannuleerd/);
  assert.match(html, /color:var\(--rose\)/);
  assert.match(html, /Deal gearchiveerd/);
});

test('weergave Overzicht: geannuleerde sale met label, commissie doorgestreept als vervallen', async () => {
  const sale = (x) => ({ deal_id: 'd', customer: 'Evertjan Graeff', bedrag: 2880, traject: null, eerste_termijn: '2026-10-20',
    aantal_termijnen: 36, offerte_status: 'accepted', offerte_status_label: 'geaccepteerd', in_afwachting: false, betaald: 0,
    verwachte_commissie: 86.4, plan: { pct: 3, schema: [], termijnen: {}, aanbetaling: {}, reserveringsfee: {}, aansluiting: { status: 'ok' } }, ontvangen_regels: [], ...x });
  const ctx = scherm({
    '/api/setter-overview': { setter_user_id: KARL, pct: 3, config: { pct: 3 }, totals: { vervallen_door_annulering: 86.4 }, regels: [],
      sales: [sale({ geannuleerd: { reden: 'abonnement_gestopt', label: 'Abonnement gestopt', op: null } }), sale({ deal_id: 'd2', customer: 'Ljupce Trajkov', geannuleerd: null })] },
    '/api/setter-commission-timeline': { months: [] },
    '/api/setter-commission-monthly': { maanden: [] },
  });
  const view = ctx.DFO.VIEWS['setter-payout/Overzicht'];
  view(); await wacht(); await wacht(); await wacht();
  const html = view();
  assert.match(html, /Evertjan Graeff/);
  assert.match(html, /✕ Geannuleerd/);
  assert.match(html, /Abonnement gestopt/);
  assert.match(html, /<s[^>]*>€\s?86,40<\/s> <span[^>]*>vervallen<\/span>/);
  assert.equal((html.match(/✕ Geannuleerd/g) || []).length, 2, 'label in de klantkolom en de offertekolom, alleen voor de geannuleerde sale');
  ctx.__spToggleSale('d');
  assert.match(view(), /telt niet in de forecast/);
});

test('grafiek en commissie per maand zijn niet aangeraakt (geen annulerings-uitzondering)', () => {
  for (const f of ['api/setter-commission-timeline.js', 'api/setter-commission-monthly.js', 'api/_lib/setter-commissie-core.js']) {
    assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /annuleringVanDeal|isGetekendeDeal/, f);
  }
});
