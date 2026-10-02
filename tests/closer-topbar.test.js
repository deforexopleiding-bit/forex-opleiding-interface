// tests/closer-topbar.test.js
//
// DE CLOSER-TOPBAR — "Maak je dagrapportage in orde — X/Y beoordeeld".
//
//   1. de telling (api/mijn-calls-vandaag.js telMijnCalls): Amsterdamse dag,
//      ook rond de wintertijd, de 15 minuten speling, de startdatum, testrijen,
//      gisteren;
//   2. de rechtenpoort (401 / 403 / 200) en de melding van de volgende dag;
//   3. de bannerbeslissing (closer-topbar.js bannerStaat): tonen, verbergen,
//      een uur wegklikken, de dringende variant;
//   4. de bannerstapel (banner-stapel.js): beide balken tegelijk, één marge
//      (in een kleine nep-DOM, zie laadDom);
//   5. de bedrading: scripts, recht, migratie, event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import {
  telMijnCalls, vensterVoor, meldingSleutel, meldGisterenOpen, maakHandler,
  CLOSER_RECHT, MELDING_TYPE,
} from '../api/mijn-calls-vandaag.js';
import { parseStartdatum, STANDAARD_STARTDATUM } from '../api/_lib/call-rapportage-start.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const MIN = 60 * 1000;
const START = '2026-09-01';   // ruim vóór alle testdagen, tenzij een test anders zegt

/** Een afspraak van 30 minuten. */
function call(id, scheduled_at, extra = {}) {
  return { id, scheduled_at, duration_minutes: 30, status: 'scheduled', uitkomst: null,
    parent_appointment_id: null, is_test: false, ...extra };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE TELLING
// ═══════════════════════════════════════════════════════════════════════════

test('Amsterdamse dag, niet de UTC-dag: 00:30 lokaal hoort bij vandaag', () => {
  // 1 oktober 2026, zomertijd (UTC+2). 00:30 lokaal = 30 sep 22:30 UTC.
  const nu = Date.parse('2026-10-01T10:00:00Z');   // 12:00 lokaal
  const t = telMijnCalls([
    call('a', '2026-09-30T22:30:00Z'),   // 1 okt 00:30 lokaal → vandaag
    call('b', '2026-09-30T21:30:00Z'),   // 30 sep 23:30 lokaal → gisteren
    call('c', '2026-10-01T22:30:00Z'),   // 2 okt 00:30 lokaal → morgen, telt niet
  ], { nuMs: nu, startdatum: START });
  assert.equal(t.dag, '2026-10-01');
  assert.equal(t.gisteren, '2026-09-30');
  assert.deepEqual(t.rows.map((r) => r.id), ['a']);
  assert.equal(t.gisteren_open, 1);
});

test('rond de wintertijd (25 okt, een dag van 25 uur) klopt de daggrens', () => {
  // 26 oktober 2026 10:00 lokaal, wintertijd (UTC+1).
  const nu = Date.parse('2026-10-26T09:00:00Z');
  const v = vensterVoor(nu, START);
  assert.equal(v.dag, '2026-10-26');
  assert.equal(v.gisteren, '2026-10-25');
  // Gisteren begon om 00:00 zomertijd = 24 okt 22:00 UTC; vandaag om 00:00
  // wintertijd = 25 okt 23:00 UTC. Daartussen zitten 25 uur.
  assert.equal(new Date(v.vanMs).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(new Date(v.totMs).toISOString(), '2026-10-26T23:00:00.000Z');

  const t = telMijnCalls([
    call('vroeg-gisteren', '2026-10-24T22:30:00Z'),  // 25 okt 00:30 (UTC+2) → gisteren
    call('laat-gisteren',  '2026-10-25T22:30:00Z'),  // 25 okt 23:30 (UTC+1) → gisteren
    call('vroeg-vandaag',  '2026-10-25T23:30:00Z'),  // 26 okt 00:30 (UTC+1) → vandaag
    call('eergisteren',    '2026-10-24T21:30:00Z'),  // 24 okt 23:30 → buiten het venster
  ], { nuMs: nu, startdatum: START });
  assert.deepEqual(t.rows.map((r) => r.id), ['vroeg-vandaag']);
  assert.equal(t.gisteren_open, 2);
});

test('een call is pas te beoordelen na duur + 15 minuten', () => {
  const begin = Date.parse('2026-10-01T08:00:00Z');   // 10:00 lokaal
  const a = [call('a', '2026-10-01T08:00:00Z')];
  const net = telMijnCalls(a, { nuMs: begin + 44 * MIN, startdatum: START });
  assert.equal(net.te_beoordelen, 0);
  assert.equal(net.gepland_nog, 1);
  assert.equal(net.open, 0);
  const daarna = telMijnCalls(a, { nuMs: begin + 45 * MIN, startdatum: START });
  assert.equal(daarna.te_beoordelen, 1);
  assert.equal(daarna.open, 1);
  assert.equal(daarna.gepland_nog, 0);
  assert.equal(daarna.rows[0].staat, 'te_beoordelen');
});

test('X/Y: vastgelegd telt de calls met een uitkomst, open de rest', () => {
  const nu = Date.parse('2026-10-01T15:00:00Z');
  const t = telMijnCalls([
    call('a', '2026-10-01T08:00:00Z', { uitkomst: 'sale', status: 'completed' }),
    call('b', '2026-10-01T09:00:00Z'),
    call('c', '2026-10-01T10:00:00Z', { uitkomst: 'no_show', status: 'no_show' }),
    call('d', '2026-10-01T17:00:00Z'),                                  // nog gepland
  ], { nuMs: nu, startdatum: START });
  assert.deepEqual(
    { totaal: t.totaal, te: t.te_beoordelen, vast: t.vastgelegd, open: t.open, gepland: t.gepland_nog },
    { totaal: 4, te: 3, vast: 2, open: 1, gepland: 1 });
});

test('geen interesse zet de afspraak op cancelled — en telt toch als beoordeeld', () => {
  // De motor zet wilt_niet_meer/niet_geschikt op 'cancelled'. Zonder de
  // uitzondering zou de noemer zakken op het moment dat Dave zijn werk doet.
  const nu = Date.parse('2026-10-01T15:00:00Z');
  const t = telMijnCalls([
    call('a', '2026-10-01T08:00:00Z', { uitkomst: 'wilt_niet_meer', status: 'cancelled' }),
    call('b', '2026-10-01T09:00:00Z', { uitkomst: 'niet_geschikt', status: 'cancelled' }),
    call('c', '2026-10-01T10:00:00Z', { status: 'cancelled' }),         // echte annulering
  ], { nuMs: nu, startdatum: START });
  assert.equal(t.te_beoordelen, 2);
  assert.equal(t.vastgelegd, 2);
  assert.equal(t.open, 0);
});

test('een verzette call met opvolger telt één keer; zonder uitkomst valt verzet weg', () => {
  const nu = Date.parse('2026-10-01T15:00:00Z');
  const t = telMijnCalls([
    call('oud', '2026-10-01T08:00:00Z', { status: 'verplaatst', uitkomst: 'verzetten' }),
    call('nieuw', '2026-10-01T11:00:00Z', { parent_appointment_id: 'oud' }),
    call('weg', '2026-10-01T09:00:00Z', { status: 'verwijderd', uitkomst: 'sale' }),
    call('wacht', '2026-10-01T09:30:00Z', { status: 'wacht_op_reschedule' }),
  ], { nuMs: nu, startdatum: START });
  assert.deepEqual(t.rows.map((r) => r.id), ['nieuw']);
  assert.equal(t.open, 1);
});

test('een uitkomst vóór het einde van de call telt meteen als beoordeeld', () => {
  const begin = Date.parse('2026-10-01T08:00:00Z');
  const t = telMijnCalls([call('a', '2026-10-01T08:00:00Z', { uitkomst: 'no_show', status: 'no_show' })],
    { nuMs: begin + 10 * MIN, startdatum: START });
  assert.equal(t.te_beoordelen, 1);
  assert.equal(t.vastgelegd, 1);
  assert.equal(t.gepland_nog, 0);
});

test('testrijen tellen nergens mee', () => {
  const nu = Date.parse('2026-10-01T15:00:00Z');
  const t = telMijnCalls([
    call('echt', '2026-10-01T08:00:00Z'),
    call('test', '2026-10-01T09:00:00Z', { is_test: true }),
    call('test-gisteren', '2026-09-30T09:00:00Z', { is_test: true }),
  ], { nuMs: nu, startdatum: START });
  assert.equal(t.totaal, 1);
  assert.equal(t.gisteren_open, 0);
});

test('vóór de startdatum is niets achterstand', () => {
  const nu = Date.parse('2026-10-02T08:00:00Z');   // 2 okt 10:00 lokaal
  const rijen = [
    call('gisteren', '2026-10-01T08:00:00Z'),
    call('vandaag', '2026-10-02T06:00:00Z'),
  ];
  const vanaf2 = telMijnCalls(rijen, { nuMs: nu, startdatum: '2026-10-02' });
  assert.equal(vanaf2.gisteren_open, 0, 'gisteren lag vóór de startdatum');
  assert.equal(vanaf2.open, 1);
  const vanaf1 = telMijnCalls(rijen, { nuMs: nu, startdatum: '2026-10-01' });
  assert.equal(vanaf1.gisteren_open, 1);

  // Startdatum in de toekomst: het venster is leeg.
  const v = vensterVoor(nu, '2026-10-05');
  assert.ok(v.vanMs >= v.totMs);
  const t = telMijnCalls(rijen, { nuMs: nu, startdatum: '2026-10-05' });
  assert.equal(t.totaal + t.gisteren_open, 0);
});

test('gisteren: alleen te beoordelen calls zonder uitkomst', () => {
  const nu = Date.parse('2026-10-01T08:00:00Z');
  const t = telMijnCalls([
    call('a', '2026-09-30T08:00:00Z'),
    call('b', '2026-09-30T09:00:00Z', { uitkomst: 'gesprek_gehad', status: 'completed' }),
    call('c', '2026-09-30T10:00:00Z', { status: 'cancelled' }),
    // 23:50 lokaal, 30 min: tot 00:35 nog 'gepland' — om 00:20 dus nog niet open.
    call('d', '2026-09-30T21:50:00Z'),
  ], { nuMs: Date.parse('2026-09-30T22:20:00Z'), startdatum: START });
  assert.equal(t.gisteren_open, 1);
  const later = telMijnCalls([call('d', '2026-09-30T21:50:00Z')], { nuMs: nu, startdatum: START });
  assert.equal(later.gisteren_open, 1);
});

test('de startdatum: standaard 2026-10-02, alleen een geldige datum telt', () => {
  assert.equal(STANDAARD_STARTDATUM, '2026-10-02');
  assert.equal(parseStartdatum({ datum: '2026-11-01' }), '2026-11-01');
  assert.equal(parseStartdatum({ datum: '1-11-2026' }), STANDAARD_STARTDATUM);
  assert.equal(parseStartdatum(null), STANDAARD_STARTDATUM);
  assert.equal(parseStartdatum('2026-11-01'), STANDAARD_STARTDATUM);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE RECHTENPOORT EN DE MELDING
// ═══════════════════════════════════════════════════════════════════════════

/** Neppe supabase: elke keten is awaitable; antwoord per tabel. */
function nepDb(antwoorden = {}) {
  const log = [];
  const db = {
    from(tabel) {
      const q = { tabel, stappen: [] };
      log.push(q);
      const keten = {
        then(ok, nok) {
          const a = antwoorden[tabel];
          const r = typeof a === 'function' ? a(q) : (a || { data: [], error: null });
          return Promise.resolve(r).then(ok, nok);
        },
        maybeSingle() { q.stappen.push(['maybeSingle']); return keten; },
      };
      for (const m of ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'in', 'is']) {
        keten[m] = (...args) => { q.stappen.push([m, ...args]); return keten; };
      }
      return keten;
    },
  };
  return { db, log };
}

function nepRes() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

const DAVE = '70e492cb-90b3-4c03-9822-6a97a2039071';

test('zonder sessie 401, zonder calls.closer 403 — en dan geen enkele query', async () => {
  const { db, log } = nepDb();
  const geenUser = maakHandler({ db, userVan: async () => null, magHet: async () => true });
  const r1 = nepRes(); await geenUser({ method: 'GET', headers: {} }, r1);
  assert.equal(r1.code, 401);

  let gevraagd = null;
  const geenRecht = maakHandler({ db, userVan: async () => ({ id: DAVE }),
    magHet: async (req) => { gevraagd = req; return false; } });
  const r2 = nepRes(); await geenRecht({ method: 'GET', headers: {} }, r2);
  assert.equal(r2.code, 403);
  assert.match(r2.body.error, /calls\.closer/);
  assert.ok(gevraagd, 'de poort is gevraagd');
  assert.equal(log.length, 0, 'geen databankvraag zonder recht');
});

test('de poort is de strikte requirePermission op calls.closer', () => {
  const bron = lees('api/mijn-calls-vandaag.js');
  assert.equal(CLOSER_RECHT, 'calls.closer');
  assert.match(bron, /requirePermission\(req, CLOSER_RECHT\)/);
  assert.doesNotMatch(bron, /requirePermissionFailOpen/);
});

test('met recht: één afsprakenquery op eigen owner_id, zonder testrijen', async () => {
  const nu = Date.parse('2026-10-03T10:00:00Z');
  const { db, log } = nepDb({
    app_settings: { data: { value: { datum: '2026-10-02' } }, error: null },
    follow_up_appointments: (q) => (q.stappen.some((s) => s[0] === 'gte')
      ? { data: [call('a', '2026-10-03T07:00:00Z'), call('b', '2026-10-03T12:00:00Z')], error: null }
      : { count: 1, error: null }),
  });
  const meldingen = [];
  const h = maakHandler({ db, userVan: async () => ({ id: DAVE }), magHet: async () => true,
    notify: async (o) => { meldingen.push(o); return { ok: true, count: 1 }; }, nu: () => nu });
  const res = nepRes(); await h({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.dag, '2026-10-03');
  assert.equal(res.body.open, 1);
  assert.equal(res.body.gepland_nog, 1);
  assert.equal(res.body.heeft_afspraken, true);
  assert.equal(res.body.melding, null);

  const afspraken = log.filter((q) => q.tabel === 'follow_up_appointments');
  assert.equal(afspraken.length, 1, 'niet-lege set: geen tweede vraag');
  const st = afspraken[0].stappen;
  assert.ok(st.some((s) => s[0] === 'eq' && s[1] === 'owner_id' && s[2] === DAVE));
  assert.ok(st.some((s) => s[0] === 'eq' && s[1] === 'is_test' && s[2] === false));
  // Venster: niet vóór de startdatum (2 okt 00:00 lokaal = 1 okt 22:00 UTC).
  const gte = st.find((s) => s[0] === 'gte');
  assert.equal(gte[2], '2026-10-01T22:00:00.000Z');
  assert.equal(meldingen.length, 0);
});

test('lege set: heeft_afspraken uit één goedkope telling', async () => {
  const { db } = nepDb({
    follow_up_appointments: (q) => (q.stappen.some((s) => s[0] === 'gte')
      ? { data: [], error: null } : { count: 0, error: null }),
  });
  const h = maakHandler({ db, userVan: async () => ({ id: 'iemand' }), magHet: async () => true,
    nu: () => Date.parse('2026-10-03T10:00:00Z') });
  const res = nepRes(); await h({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.heeft_afspraken, false);
});

test('gisteren open → één melding aan de closer en één aan super_admin, ontdubbeld per dag', async () => {
  const nu = Date.parse('2026-10-03T07:00:00Z');
  const { db } = nepDb({
    app_settings: { data: { value: { datum: '2026-10-02' } }, error: null },
    follow_up_appointments: { data: [call('g', '2026-10-02T08:00:00Z')], error: null },
    notifications: { data: [], error: null },
    profiles: { data: { full_name: 'Dave Heylen' }, error: null },
  });
  const meldingen = [];
  const h = maakHandler({ db, userVan: async () => ({ id: DAVE }), magHet: async () => true,
    notify: async (o) => { meldingen.push(o); return { ok: true, count: 1 }; }, nu: () => nu });
  const res = nepRes(); await h({ method: 'GET', headers: {} }, res);
  assert.equal(res.body.gisteren_open, 1);
  assert.equal(res.body.melding.verstuurd, 2);
  assert.equal(meldingen.length, 2);
  const [closer, admin] = meldingen;
  assert.equal(closer.toUserId, DAVE);
  assert.equal(admin.toRole, 'super_admin');
  for (const m of meldingen) {
    assert.equal(m.type, MELDING_TYPE);
    assert.equal(m.entityId, meldingSleutel(DAVE, '2026-10-02'));
    assert.ok(m.dedupWithinMs > 20 * 3600 * 1000);
  }
  assert.match(admin.title, /^Dave Heylen: gisteren nog 1 call zonder uitkomst$/);
  assert.match(closer.linkUrl, /v2preview=opvolging&v2tab=Vandaag/);
});

test('al gemeld vandaag → geen nieuwe melding, en geen naam- of rolvraag', async () => {
  const { db, log } = nepDb({ notifications: { data: [{ id: 'n1' }], error: null } });
  let gebeld = 0;
  const r = await meldGisterenOpen({ db, notify: async () => { gebeld += 1; return { count: 1 }; },
    userId: DAVE, gisteren: '2026-10-02', aantal: 3 });
  assert.equal(r.verstuurd, 0);
  assert.equal(gebeld, 0);
  assert.deepEqual(log.map((q) => q.tabel), ['notifications']);
  const niets = await meldGisterenOpen({ db, notify: async () => { gebeld += 1; }, userId: DAVE, gisteren: '2026-10-02', aantal: 0 });
  assert.equal(niets.verstuurd, 0);
  assert.equal(gebeld, 0);
});

test('de meldingsleutel is een vaste uuid per closer en dag', () => {
  const a = meldingSleutel(DAVE, '2026-10-02');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, meldingSleutel(DAVE, '2026-10-02'));
  assert.notEqual(a, meldingSleutel(DAVE, '2026-10-03'));
  assert.notEqual(a, meldingSleutel('ander', '2026-10-02'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE BANNERBESLISSING
// ═══════════════════════════════════════════════════════════════════════════

// ── Een kleine nep-DOM ──────────────────────────────────────────────────────
// Bewust geen jsdom: dat is een devDependency die niet overal geïnstalleerd is,
// en deze scripts gebruiken maar een handvol DOM-dingen. Wat ze gebruiken staat
// hieronder; gebruiken ze iets anders, dan faalt de test luid.
class NepEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null; this.attrs = {}; this.id = '';
    this.className = ''; this.style = { cssText: '' }; this._html = ''; this._subs = {}; this._luisteraars = {};
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  insertBefore(el, ref) {
    if (el.parentNode) el.parentNode.removeChild(el);
    const i = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, el);
    el.parentNode = this;
    return el;
  }
  appendChild(el) { return this.insertBefore(el, null); }
  removeChild(el) { const i = this.children.indexOf(el); if (i >= 0) this.children.splice(i, 1); el.parentNode = null; return el; }
  get firstChild() { return this.children[0] || null; }
  set innerHTML(h) { this._html = String(h); this._subs = {}; this.children = []; }
  get innerHTML() { return this._html; }
  get textContent() {
    return this._html.replace(/<[^>]*>/g, '').replace(/&rarr;/g, '→').replace(/&times;/g, '×')
      .replace(/&#\d+;/g, '').replace(/&amp;/g, '&');
  }
  get offsetHeight() { return 0; }
  querySelector(sel) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    if (m) {
      if (!this._html.includes(m[1])) return null;
      return this._subs[m[1]] || (this._subs[m[1]] = new NepEl('span'));
    }
    if (sel === '.app') return zoek(this, (e) => e.className === 'app');
    throw new Error('nep-DOM kent selector niet: ' + sel);
  }
  addEventListener(t, f) { (this._luisteraars[t] ||= []).push(f); }
  click() { for (const f of this._luisteraars.click || []) f({ preventDefault() {} }); }
}
function zoek(el, pred) {
  for (const k of el.children) { if (pred(k)) return k; const d = zoek(k, pred); if (d) return d; }
  return null;
}

function laadDom() {
  const body = new NepEl('body');
  const app = new NepEl('div'); app.className = 'app'; body.appendChild(app);
  const luisteraars = {};
  const opslag = new Map();
  const document = {
    body, visibilityState: 'visible',
    createElement: (t) => new NepEl(t),
    getElementById: (id) => zoek(body, (e) => e.id === id),
    querySelector: (sel) => body.querySelector(sel),
    addEventListener() {},
  };
  const timers = [];
  const ctx = {
    document, console, JSON, Promise,
    localStorage: {
      getItem: (k) => (opslag.has(k) ? opslag.get(k) : null),
      setItem: (k, v) => { opslag.set(k, String(v)); },
    },
    addEventListener: (t, f) => { (luisteraars[t] ||= []).push(f); },
    dispatchEvent: (ev) => { for (const f of luisteraars[ev.type] || []) f(ev); return true; },
    // De poll draait niet vanzelf in een test; het uur-wekkertje ook niet.
    setInterval: (f) => { timers.push(f); return timers.length; },
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
  };
  ctx.window = ctx;
  createContext(ctx);
  runInContext(lees('modules/klanten-v2/banner-stapel.js'), ctx, { filename: 'banner-stapel.js' });
  runInContext(lees('modules/klanten-v2/closer-topbar.js'), ctx, { filename: 'closer-topbar.js' });
  ctx.close = () => {};
  return ctx;
}
const W = laadDom();
const { bannerStaat, wegklik, EEN_UUR_MS } = W.KVCloserTopbar;
const NU = Date.parse('2026-10-03T12:00:00Z');
const data = (o) => ({ dag: '2026-10-03', gisteren: '2026-10-02', open: 0, te_beoordelen: 0,
  vastgelegd: 0, gisteren_open: 0, ...o });

test('niets open → geen balk', () => {
  assert.equal(bannerStaat(null, NU, null).zichtbaar, false);
  assert.equal(bannerStaat(data({ te_beoordelen: 3, vastgelegd: 3 }), NU, null).zichtbaar, false);
  assert.equal(bannerStaat(data({ gepland_nog: 4 }), NU, null).zichtbaar, false);
});

test('open → "Maak je dagrapportage in orde — X/Y beoordeeld"', () => {
  const s = bannerStaat(data({ open: 2, te_beoordelen: 5, vastgelegd: 3 }), NU, null);
  assert.equal(s.zichtbaar, true);
  assert.equal(s.variant, 'normaal');
  assert.equal(s.tekst, 'Maak je dagrapportage in orde — 3/5 beoordeeld');
  assert.equal(s.sluitbaar, true);
});

test('gisteren open → de dringende variant, ook als vandaag alles af is', () => {
  const s = bannerStaat(data({ gisteren_open: 2 }), NU, null);
  assert.equal(s.variant, 'urgent');
  assert.equal(s.tekst, 'Gisteren nog 2 calls zonder uitkomst — vul ze nu in');
  const beide = bannerStaat(data({ gisteren_open: 1, open: 1, te_beoordelen: 2, vastgelegd: 1 }), NU, null);
  assert.equal(beide.variant, 'urgent');
  assert.equal(beide.tekst, 'Gisteren nog 1 call zonder uitkomst — vul ze nu in · vandaag 1/2 beoordeeld');
});

test('wegklikken verbergt een uur, daarna staat hij er weer', () => {
  const d = data({ open: 1, te_beoordelen: 1 });
  const s = bannerStaat(d, NU, null);
  const w = wegklik(s, NU);
  assert.equal(w.tot, NU + EEN_UUR_MS);
  assert.equal(bannerStaat(d, NU + 59 * MIN, w).zichtbaar, false);
  assert.equal(bannerStaat(d, NU + 60 * MIN, w).zichtbaar, true);
});

test('een wegklik geldt niet voor de dringende variant of een nieuwe dag', () => {
  const normaal = bannerStaat(data({ open: 1, te_beoordelen: 1 }), NU, null);
  const w = wegklik(normaal, NU);
  assert.equal(bannerStaat(data({ open: 1, te_beoordelen: 1, gisteren_open: 1 }), NU + MIN, w).zichtbaar, true);
  assert.equal(bannerStaat(data({ dag: '2026-10-04', open: 1, te_beoordelen: 1 }), NU + MIN, w).zichtbaar, true);
  // Ook de dringende is maar een uur weg te klikken.
  const urgent = bannerStaat(data({ gisteren_open: 1 }), NU, null);
  const wu = wegklik(urgent, NU);
  assert.equal(bannerStaat(data({ gisteren_open: 1 }), NU + 30 * MIN, wu).zichtbaar, false);
  assert.equal(bannerStaat(data({ gisteren_open: 1 }), NU + 61 * MIN, wu).zichtbaar, true);
});

test('een opgeslagen wegklik van langer dan een uur telt niet', () => {
  const d = data({ open: 1, te_beoordelen: 1 });
  const s = bannerStaat(d, NU, null);
  assert.equal(bannerStaat(d, NU, { sleutel: s.sleutel, tot: NU + 5 * EEN_UUR_MS }).zichtbaar, true);
  assert.equal(bannerStaat(d, NU, { sleutel: s.sleutel, tot: 'morgen' }).zichtbaar, true);
});

test('in de pagina: balk erin, × verbergt en bewaart, alles af → weg', async () => {
  const w = laadDom();
  w.KVBannerStapel.meet = (el) => el.children.length * 40;
  const antwoorden = [
    data({ open: 1, te_beoordelen: 2, vastgelegd: 1, heeft_afspraken: true }),
    data({ open: 0, te_beoordelen: 2, vastgelegd: 2, heeft_afspraken: true }),
  ];
  let n = 0;
  w.KVCloserTopbar.start({ userId: 'u1', haal: async () => ({ ok: true, status: 200, json: async () => antwoorden[Math.min(n++, 1)] }) });
  await new Promise((r) => setTimeout(r, 10));
  const bar = w.document.getElementById('kv-closer-topbar');
  assert.ok(bar, 'balk staat er');
  assert.match(bar.textContent, /1\/2 beoordeeld/);
  assert.equal(w.document.querySelector('.app').style.marginTop, '40px');

  bar.querySelector('[data-kv-closer-sluit]').click();
  assert.equal(w.document.getElementById('kv-closer-topbar'), null);
  const bewaard = JSON.parse(w.localStorage.getItem('kv_closer_topbar_verborgen:u1'));
  assert.equal(bewaard.sleutel, 'normaal|2026-10-03');
  assert.equal(w.document.querySelector('.app').style.marginTop, '');

  // Na een vastgelegde uitkomst: opnieuw tellen; alles af → blijft weg.
  w.dispatchEvent({ type: w.KVCloserTopbar.EVENT });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(n, 2, 'het event liet opnieuw tellen');
  assert.equal(w.document.getElementById('kv-closer-topbar'), null);
  w.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE BANNERSTAPEL
// ═══════════════════════════════════════════════════════════════════════════

test('shellStijl: geen hoogte = terug naar de css', () => {
  const { shellStijl } = W.KVBannerStapel;
  assert.deepEqual({ ...shellStijl(0) }, { marginTop: '', height: '' });
  assert.deepEqual({ ...shellStijl(42) }, { marginTop: '42px', height: 'calc(100vh - 42px)' });
  assert.deepEqual({ ...shellStijl(-3) }, { marginTop: '', height: '' });
});

test('invoegIndex: laag bovenaan, gelijk achteraan', () => {
  const { invoegIndex } = W.KVBannerStapel;
  assert.equal(invoegIndex([], 10), 0);
  assert.equal(invoegIndex(['0'], 10), 1);
  assert.equal(invoegIndex(['10'], 0), 0);
  assert.equal(invoegIndex(['0', '10'], 10), 2);
});

test('beide balken tegelijk: juiste volgorde, één marge voor allebei', () => {
  const w = laadDom();
  const st = w.KVBannerStapel;
  st.meet = (el) => el.children.length * 40;     // jsdom meet geen hoogtes
  const topbar = w.document.createElement('div'); topbar.id = 'kv-closer-topbar';
  const imp = w.document.createElement('div'); imp.id = 'kv-impersonation-banner';
  st.plaats(topbar, 10);
  st.plaats(imp, 0);                               // later geplaatst, toch bovenaan
  const houder = w.document.getElementById(st.HOUDER_ID);
  assert.deepEqual([...houder.children].map((c) => c.id), ['kv-impersonation-banner', 'kv-closer-topbar']);
  const app = w.document.querySelector('.app');
  assert.equal(app.style.marginTop, '80px');
  assert.equal(app.style.height, 'calc(100vh - 80px)');
  st.haalWeg('kv-closer-topbar');
  assert.equal(app.style.marginTop, '40px');
  st.haalWeg(imp);
  assert.equal(app.style.marginTop, '');
  assert.equal(app.style.height, '');
  w.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE BEDRADING
// ═══════════════════════════════════════════════════════════════════════════

test('index.html laadt stapel en topbar vóór klanten-v2.js', () => {
  const html = lees('modules/klanten-v2/index.html');
  const stapel = html.indexOf('banner-stapel.js?v=');
  const topbar = html.indexOf('closer-topbar.js?v=');
  const shell = html.indexOf('klanten-v2.js?v=');
  assert.ok(stapel > 0 && topbar > stapel && shell > topbar);
});

test('de impersonatiebanner zet zelf geen marge meer, de stapel doet het', () => {
  const bron = lees('modules/klanten-v2/klanten-v2.js');
  const i = bron.indexOf('function initImpersonationBanner');
  const j = bron.indexOf('async function stopImpersonationV2');
  const blok = bron.slice(i, j);
  assert.match(blok, /KVBannerStapel\.plaats\(bar, 0\)/);
  assert.doesNotMatch(blok, /ResizeObserver/);
  assert.match(bron, /RBAC\.can\('calls\.closer'\)/);
});

test('opvolging seint na een vastgelegde uitkomst', () => {
  const bron = lees('modules/klanten-v2/views/opvolging-v2.js');
  assert.match(bron, /new CustomEvent\('kv:call-uitkomst-vastgelegd'/);
  assert.equal(W.KVCloserTopbar.EVENT, 'kv:call-uitkomst-vastgelegd');
});

test('het recht staat in het register en de migratie geeft het aan sales', () => {
  assert.match(lees('modules/shared/rbac/registry.js'), /key:'calls\.closer'/);
  const sql = lees('docs/sql-migrations/2026-10-01-calls-closer-recht.sql');
  assert.match(sql, /SELECT 'sales', 'calls\.closer', true\s+WHERE NOT EXISTS/);
  assert.doesNotMatch(sql, /ALTER TABLE|CREATE TABLE|DROP /i);
});
