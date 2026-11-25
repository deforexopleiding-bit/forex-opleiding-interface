// tests/event-afgewezen.test.js
//
// Afgewezen event-aanmeldingen zichtbaar in het CRM (2026-11-25):
//   1. rekenkern: wie = exact wie de dashboardtegel telt, één rij per persoon,
//      reden = knock-outs en/of onder de drempel, bron-label, WhatsApp-cijfers;
//   2. venster: standaard deze maand, period/from/to zoals leads-per-traject-count;
//   3. endpoint: alleen GET, auth + events.attendee.view, leest het venster;
//   4. bedrading: Inschrijvingen-chip, dashboardklik, cache-bust.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── nep-Supabase ────────────────────────────────────────────────────────────
const db = { tabellen: {}, filters: [], zonderBron: false };
function bouwer(tabel) {
  const f = { tabel, gte: null, lt: null, inIds: null, select: '' };
  const q = {
    select(kol) { f.select = kol; return q; },
    gte(k, v) { f.gte = [k, v]; return q; },
    lt(k, v) { f.lt = [k, v]; return q; },
    order() { return q; },
    in(k, ids) { f.inIds = ids; return q; },
    range(a, b) { db.filters.push({ ...f }); return Promise.resolve(uitvoeren(f, a, b)); },
    then(ok, nok) { db.filters.push({ ...f }); return Promise.resolve(uitvoeren(f, 0, 9999)).then(ok, nok); },
  };
  return q;
}
function uitvoeren(f, a, b) {
  if (db.zonderBron && f.tabel === 'event_kwalificatie_submissions' && f.select.includes('bron')) {
    return { data: null, error: { code: '42703', message: 'column bron does not exist' } };
  }
  let rijen = db.tabellen[f.tabel] || [];
  if (f.gte) rijen = rijen.filter((r) => r[f.gte[0]] >= f.gte[1]);
  if (f.lt) rijen = rijen.filter((r) => r[f.lt[0]] < f.lt[1]);
  if (f.inIds) rijen = rijen.filter((r) => f.inIds.includes(r.id));
  return { data: rijen.slice(a, b + 1), error: null };
}
const auth = { user: { id: 'u1' }, toegestaan: true, gevraagd: [] };
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from: (t) => bouwer(t) },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async (req, sleutel) => { auth.gevraagd.push(sleutel); return auth.toegestaan; } },
});

const L = await import('../api/_lib/event-afgewezen.js');
const A = await import('../api/_lib/aanmeldingen-per-funnel.js');
const E = await import('../api/events-afgewezen.js');
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const ko = (vraag, gekozen_label) => ({ vraag, gekozen_label, punten: 0, afwijzer: true });
const ok = (vraag, gekozen_label, punten) => ({ vraag, gekozen_label, punten, afwijzer: false });
const inz = (o) => ({ id: o.id, created_at: o.op, event_id: 'E1', naam: o.naam ?? null, email: o.email, telefoon: o.tel ?? null,
  bron: o.bron ?? null, score: o.score ?? 0, drempel: 6, resultaat: o.res || 'afgewezen', antwoorden: o.antw || [] });

function voorbeeld() {
  return {
    eventInzendingen: [
      inz({ id: 1, op: '2026-11-03T10:00:00Z', email: 'Piet@x.nl', naam: 'Piet', tel: '+31612345678', bron: 'event-3',
        score: 5, antw: [ko('Wat is je werk-/inkomenssituatie?', 'Werkloos of uitkering'), ok('Intentie', 'Leren', 5)] }),
      inz({ id: 2, op: '2026-11-05T10:00:00Z', email: 'piet@x.nl', naam: 'Piet de Vries', bron: null,
        score: 4, antw: [ok('Intentie', 'Leren', 4)] }),                                       // 2e poging, alleen drempel
      inz({ id: 3, op: '2026-11-04T09:00:00Z', email: 'kees@x.nl', naam: 'Kees', score: 7,
        antw: [ko('Ben je bereid te investeren?', 'Nee, alleen gratis'), ok('Intentie', 'Leren', 7)] }),
      inz({ id: 4, op: '2026-11-06T09:00:00Z', email: 'jan@x.nl', naam: 'Jan', score: 2 }),                 // afgewezen …
      inz({ id: 5, op: '2026-11-06T09:05:00Z', email: 'jan@x.nl', naam: 'Jan', score: 8, res: 'toegelaten' }), // … daarna toegelaten
      inz({ id: 6, op: '2026-11-07T09:00:00Z', email: 'anna@x.nl', naam: 'Anna', score: 3 }),               // wel aangemeld
      inz({ id: 7, op: '2026-11-07T09:00:00Z', email: 'test-bot@x.nl', naam: 'Test', score: 0 }),           // test
    ],
    eventAanmeldingen: [
      { email: 'anna@x.nl', status: 'registered', is_test: false },
      { email: 'zoe@x.nl', status: 'registered', is_test: false },
    ],
    events: [{ id: 'E1', title: 'Live event Utrecht', starts_at: '2026-11-20T18:00:00Z' }],
  };
}

test('wie = exact de tegel: zonder toegelaten poging/aanmelding/test, één rij per persoon', () => {
  const v = voorbeeld();
  const rijen = L.bouwAfgewezenLijst(v);
  assert.deepEqual(rijen.map((r) => r.email), ['piet@x.nl', 'kees@x.nl']);
  const tegel = A.telAanmeldingen({ eventAanmeldingen: v.eventAanmeldingen, eventInzendingen: v.eventInzendingen }).tegels.event;
  assert.equal(tegel.afgewezen, rijen.length, 'lijst en tegel tellen hetzelfde');
  assert.equal(tegel.toegelaten, 2);
});

test('jongste poging leidend, eerdere mee; naam/telefoon uit de eerste die ze heeft', () => {
  const [piet] = L.bouwAfgewezenLijst(voorbeeld());
  assert.equal(piet.op, '2026-11-05T10:00:00Z');
  assert.equal(piet.naam, 'Piet de Vries');
  assert.equal(piet.telefoon, '+31612345678');
  assert.equal(piet.whatsapp, '31612345678');
  assert.equal(piet.bron_label, 'Sitepagina');
  assert.deepEqual(piet.knockouts, []);
  assert.equal(piet.onder_drempel, true);
  assert.equal(piet.pogingen, 2);
  assert.equal(piet.eerdere[0].bron_label, 'Event-3');
  assert.deepEqual(piet.eerdere[0].knockouts, [{ vraag: 'Wat is je werk-/inkomenssituatie?', antwoord: 'Werkloos of uitkering' }]);
  assert.deepEqual(piet.event, { id: 'E1', title: 'Live event Utrecht', starts_at: '2026-11-20T18:00:00Z' });
});

test('reden: knock-out en/of onder de drempel; boven de drempel met knock-out = alleen knock-out', () => {
  const kees = L.bouwAfgewezenLijst(voorbeeld())[1];
  assert.deepEqual(kees.knockouts, [{ vraag: 'Ben je bereid te investeren?', antwoord: 'Nee, alleen gratis' }]);
  assert.equal(kees.onder_drempel, false);
  const beide = L.redenVanInzending({ score: 3, drempel: 6, antwoorden: [ko('Nederlands?', 'Nee')] });
  assert.equal(beide.onder_drempel, true);
  assert.equal(beide.knockouts.length, 1);
  assert.equal(L.redenVanInzending({ score: null, drempel: 6, antwoorden: null }).onder_drempel, false);
});

test('bron-label en WhatsApp-cijfers', () => {
  assert.equal(L.bronLabel('event-7'), 'Event-7');
  assert.equal(L.bronLabel(''), 'Sitepagina');
  assert.equal(L.bronLabel(null), 'Sitepagina');
  assert.equal(L.bronLabel('event-forex-1'), 'event-forex-1');
  assert.equal(L.whatsappCijfers('+32 470 12 34 56'), '32470123456');
  assert.equal(L.whatsappCijfers('123'), null);
  assert.equal(L.whatsappCijfers(null), null);
});

test('samenvatting: knock-outs geteld, alleen-drempel apart, per bron', () => {
  const sv = L.vatSamen(L.bouwAfgewezenLijst(voorbeeld()));
  assert.equal(sv.totaal, 2);
  assert.deepEqual(sv.knockouts, [{ label: 'Ben je bereid te investeren? → Nee, alleen gratis', aantal: 1 }]);
  assert.equal(sv.onder_drempel, 1);
  assert.equal(sv.alleen_drempel, 1);
  assert.deepEqual(sv.per_bron, [{ label: 'Sitepagina', aantal: 2 }]);
});

test('venster: standaard deze maand (NL), period en from/to zoals de dashboardtegel', () => {
  const nu = new Date('2026-11-25T12:00:00Z');
  const m = E.leesVenster({}, nu);
  assert.equal(m.period, 'month');
  assert.equal(m.range.start.toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(m.range.endExclusive.toISOString(), '2026-11-30T23:00:00.000Z');
  assert.equal(E.leesVenster({ period: 'all' }, nu).range, null);
  assert.equal(E.leesVenster({ period: 'week' }, nu).period, 'week');
  assert.equal(E.leesVenster({ period: 'onzin' }, nu).period, 'month');
  const c = E.leesVenster({ from: '2026-10-01', to: '2026-10-31', period: 'all' }, nu);
  assert.equal(c.period, 'custom');
  assert.equal(c.range.start.toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(c.range.endExclusive.toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(E.leesVenster({ from: '2026-10-31', to: '2026-10-01' }, nu).period, 'month', 'omgekeerd = ongeldig');
});

function nepRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('endpoint: alleen GET, auth + events.attendee.view', async () => {
  let res = nepRes();
  await E.default({ method: 'POST', query: {}, headers: {} }, res);
  assert.equal(res.code, 405);
  auth.user = null; res = nepRes();
  await E.default({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.code, 401);
  auth.user = { id: 'u1' }; auth.toegestaan = false; auth.gevraagd = []; res = nepRes();
  await E.default({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.code, 403);
  assert.deepEqual(auth.gevraagd, ['events.attendee.view']);
  auth.toegestaan = true;
});

test('endpoint: leest het venster, geeft rijen + samenvatting; zonder kolom bron valt terug', async () => {
  const v = voorbeeld();
  db.tabellen = {
    event_kwalificatie_submissions: [...v.eventInzendingen, inz({ id: 9, op: '2026-10-02T09:00:00Z', email: 'oud@x.nl', score: 1 })],
    event_attendees: v.eventAanmeldingen.map((a) => ({ ...a, created_at: '2026-11-08T09:00:00Z' })),
    events: v.events,
  };
  db.filters = [];
  let res = nepRes();
  await E.default({ method: 'GET', query: { from: '2026-11-01', to: '2026-11-30' }, headers: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.rows.map((r) => r.email), ['piet@x.nl', 'kees@x.nl']);
  assert.equal(res.body.samenvatting.totaal, 2);
  assert.equal(res.body.rows[0].event.title, 'Live event Utrecht');
  assert.deepEqual(res.body.bronfouten, []);
  const sub = db.filters.find((f) => f.tabel === 'event_kwalificatie_submissions');
  assert.deepEqual(sub.gte, ['created_at', '2026-10-31T23:00:00.000Z']);
  assert.deepEqual(db.filters.find((f) => f.tabel === 'event_attendees').gte, ['created_at', '2026-10-31T23:00:00.000Z']);

  res = nepRes();
  await E.default({ method: 'GET', query: { period: 'all' }, headers: {} }, res);
  assert.ok(res.body.rows.some((r) => r.email === 'oud@x.nl'), 'alles = geen venster');

  db.zonderBron = true; res = nepRes();
  await E.default({ method: 'GET', query: { from: '2026-11-01', to: '2026-11-30' }, headers: {} }, res);
  db.zonderBron = false;
  assert.equal(res.code, 200);
  assert.equal(res.body.rows.length, 2);
  assert.deepEqual(res.body.bronfouten, []);
});

test('bedrading: tegel gebruikt de gedeelde definitie, Inschrijvingen-chip, dashboardklik, cache-bust', () => {
  const funnel = lees('api/_lib/aanmeldingen-per-funnel.js');
  assert.match(funnel, /afgewezenEventMails\(\{ eventAanmeldingen, eventInzendingen \}\)\.size/);
  const ev = lees('modules/klanten-v2/views/events-v2.js');
  assert.match(ev, /'\/api\/events-afgewezen\?' \+ key/);
  assert.match(ev, /if \(status === 'afgewezen'\) return afgewezenView\(\);/);
  assert.match(ev, /window\.__evOpenAfgewezen = /);
  const dash = lees('modules/klanten-v2/views/dashboard-v2.js');
  assert.match(dash, /DFO_openAfgewezen\(\)/);
  assert.match(dash, /window\.__evOpenAfgewezen\(\{ period: p === 'year' \? 'all' : p \}\)/);
  const idx = lees('modules/klanten-v2/index.html');
  assert.match(idx, /views\/events-v2\.js\?v=66/);
  assert.match(idx, /views\/dashboard-v2\.js\?v=37/);
  const api = lees('api/events-afgewezen.js');
  assert.doesNotMatch(api, /\.(insert|update|upsert|delete)\(/, 'alleen lezen');
});
