// tests/support-widget-weg-terug.test.js
//
// DE WIDGET GOOIT ALLEEN WEG WAT ECHT WEG IS.
//
// widget/support.js draait in de browser, zonder build en zonder exports. We
// laden het hier in een node:vm-context met een kleine nep-DOM: net genoeg
// om te zien welk scherm er staat, wat er in localStorage zit en welke
// calls er naar de API gaan. Wat vastligt:
//
//   * Alleen een 401 met SESSIE_ONGELDIG ruimt een sessie op. Een 503, een
//     netwerkfout of een kale 401 laten 'm staan, bij het laden én bij het
//     pollen. Een sessie leeft dertig dagen; die verdwijnt niet door een
//     hikje.
//   * Na een geslaagde code staat de bezoeker in de chat, ook als de eerste
//     poll mislukt. Geen codescherm zonder kenmerk waar niets meer werkt.
//   * De uitweg uit het codescherm haalt het gesprek terug dat al in deze
//     browser stond, in plaats van het te wissen.
//   * Wijst de link naar het gesprek dat hier al open staat, dan gaat er geen
//     code en geen rotatie uit.
//   * Het kenmerk is uit de adresbalk voordat de eerste call de deur uit gaat.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRON = readFileSync(join(ROOT, 'widget/support.js'), 'utf8');
const OPSLAG = 'dfo-support-sessie';
const KENMERK = 'SUP-Z3HB8F';

const tick = () => new Promise((r) => setImmediate(r));
async function wacht(n = 8) { for (let i = 0; i < n; i++) await tick(); }

/**
 * Laad de widget met een route-tabel voor de API.
 * `routes[pad]` is een functie (verzoek) → { status, body } | 'netwerk' (fetch
 * gooit), of een array daarvan die per aanroep wordt afgelopen.
 */
function laad({ routes = {}, opslag = null, search = '' } = {}) {
  const log = { calls: [], volgorde: [] };
  const store = new Map();
  if (opslag) store.set(OPSLAG, JSON.stringify(opslag));

  const loc = { search, pathname: '/cursus', hash: '', href: 'https://www.deforexopleiding.nl/cursus' + search };
  const history = {
    replaceState: (_s, _t, url) => {
      log.volgorde.push('replaceState');
      const [pad, rest] = url.split('?');
      loc.pathname = pad; loc.search = rest ? '?' + rest : '';
    },
  };

  let intervalFn = null;

  function element() {
    const handlers = {};
    return {
      style: {},
      value: '',
      className: '',
      _html: '',
      set innerHTML(h) { this._html = h; },
      get innerHTML() { return this._html; },
      setAttribute() {},
      appendChild() {},
      remove() { log.verwijderd = true; },
      focus() {},
      addEventListener(t, f) { handlers[t] = f; },
      _handlers: handlers,
    };
  }

  const wrapRef = { el: null };
  const invoer = {};
  const root = {
    appendChild(el) { if (el.className === 'wrap' || !wrapRef.el) wrapRef.el = el; },
    querySelectorAll() {
      const html = wrapRef.el ? wrapRef.el.innerHTML : '';
      const knoppen = [];
      const re = /data-a="([^"]+)"(?:\s+data-v="([^"]*)")?/g;
      let m;
      while ((m = re.exec(html))) {
        const el = element();
        const a = m[1]; const v = m[2] || null;
        el.getAttribute = (n) => (n === 'data-a' ? a : v);
        knoppen.push(el);
      }
      log.knoppen = knoppen;
      return knoppen;
    },
    querySelector(sel) {
      const html = wrapRef.el ? wrapRef.el.innerHTML : '';
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        if (!html.includes('id="' + id + '"')) return null;
        const el = element();
        el.value = invoer[id] || '';
        return el;
      }
      if (sel === '.body') return { scrollTop: 0, scrollHeight: 0 };
      return null;
    },
  };

  const document = {
    readyState: 'complete',
    hidden: false,
    currentScript: { src: 'https://crm.deforexopleiding.nl/widget/support.js' },
    getElementsByTagName: () => [],
    body: { appendChild() {} },
    addEventListener() {},
    createElement() {
      const el = element();
      el.attachShadow = () => root;
      return el;
    },
  };

  const rondes = {};
  async function fetch(url, opts = {}) {
    const pad = url.replace('https://crm.deforexopleiding.nl/api/', '');
    const naam = pad.split('?')[0];
    log.volgorde.push('fetch:' + naam);
    log.calls.push({ pad, naam, token: opts.headers?.['X-Support-Token'] || null, body: opts.body ? JSON.parse(opts.body) : null });
    let route = routes[naam];
    if (Array.isArray(route)) {
      const i = rondes[naam] = (rondes[naam] ?? -1) + 1;
      route = route[Math.min(i, route.length - 1)];
    }
    const uit = typeof route === 'function' ? route({ pad, opts }) : route;
    if (!uit || uit === 'netwerk') throw new TypeError('Failed to fetch');
    return {
      ok: uit.status >= 200 && uit.status < 300,
      status: uit.status,
      text: async () => JSON.stringify(uit.body ?? null),
    };
  }

  const window = {};
  const ctx = {
    window, document, location: loc, history, fetch, URL, URLSearchParams,
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setInterval: (f) => { intervalFn = f; return 1; },
    clearInterval: () => { intervalFn = null; },
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(BRON, ctx);

  return {
    log,
    loc,
    invoer,
    html: () => (wrapRef.el ? wrapRef.el.innerHTML : ''),
    opslag: () => (store.has(OPSLAG) ? JSON.parse(store.get(OPSLAG)) : null),
    async klik(actie) {
      const el = (log.knoppen || []).find((k) => k.getAttribute('data-a') === actie);
      assert.ok(el, 'knop ' + actie + ' staat niet op het scherm');
      el._handlers.click({ preventDefault() {} });
      await wacht();
    },
    async pollRonde() {
      assert.ok(intervalFn, 'er loopt geen poll');
      intervalFn();
      await wacht();
    },
    pollLoopt: () => !!intervalFn,
  };
}

const CONFIG = { status: 200, body: { aan: true, titel: 'Hulp nodig?' } };
const GESPREK = { kenmerk: KENMERK, status: 'wacht_op_ons', geverifieerd: false };
const THREAD = {
  status: 200,
  body: { gesprek: GESPREK, berichten: [{ id: 'b1', afzender: 'medewerker', tekst: 'Hallo Paulien', created_at: '2026-09-23T10:00:00Z' }], live: false },
};
const BEWAARD = { token: 'bewaard-token-'.padEnd(43, 'b'), tijd: Date.now() };
const ONGELDIG = { status: 401, body: { error: 'Onbekende sessie', code: 'SESSIE_ONGELDIG' } };

describe('herstel na laden', () => {
  for (const [naam, antwoord] of [
    ['503', { status: 503, body: { error: 'Even niet bereikbaar' } }],
    ['netwerkfout', 'netwerk'],
    ['kale 401 zonder code', { status: 401, body: { error: 'Unauthorized' } }],
  ]) {
    test(`${naam}: sessie blijft, en de volgende poll haalt de thread op`, async () => {
      const w = laad({ opslag: BEWAARD, routes: { 'support-widget-config': CONFIG, 'support-poll': [antwoord, THREAD] } });
      await wacht();
      assert.deepEqual(w.opslag(), BEWAARD, 'bewaarde sessie is weggegooid');

      await w.pollRonde();
      const laatste = w.log.calls.filter((c) => c.naam === 'support-poll').pop();
      assert.match(laatste.pad, /volledig=1/, 'eerste poll na een storing moet de hele thread halen');
      assert.equal(laatste.token, BEWAARD.token);
      await w.klik('open');
      assert.match(w.html(), /Hallo Paulien/);
    });
  }

  test('401 met SESSIE_ONGELDIG: sessie weg', async () => {
    const w = laad({ opslag: BEWAARD, routes: { 'support-widget-config': CONFIG, 'support-poll': ONGELDIG } });
    await wacht();
    assert.equal(w.opslag(), null);
    assert.equal(w.pollLoopt(), false);
  });
});

describe('pollen in een lopend gesprek', () => {
  test('een kale 401 of 503 tijdens het pollen laat de sessie staan', async () => {
    const w = laad({
      opslag: BEWAARD,
      routes: { 'support-widget-config': CONFIG, 'support-poll': [THREAD, { status: 401, body: {} }, { status: 503, body: {} }] },
    });
    await wacht();
    await w.pollRonde();
    await w.pollRonde();
    assert.deepEqual(w.opslag(), BEWAARD);
    assert.equal(w.pollLoopt(), true);
  });

  test('SESSIE_ONGELDIG tijdens het pollen: opruimen met uitleg', async () => {
    const w = laad({ opslag: BEWAARD, routes: { 'support-widget-config': CONFIG, 'support-poll': [THREAD, ONGELDIG] } });
    await wacht();
    await w.klik('open');
    await w.pollRonde();
    assert.equal(w.opslag(), null);
    assert.match(w.html(), /ergens anders geopend/);
  });
});

describe('terugkomen via de link in een mail', () => {
  test('het kenmerk is uit de adresbalk vóór de eerste call', async () => {
    const w = laad({ search: '?dfo-support=' + KENMERK + '&utm_source=mail', routes: { 'support-widget-config': CONFIG } });
    await wacht();
    assert.equal(w.log.volgorde[0], 'replaceState');
    assert.equal(w.loc.search, '?utm_source=mail');
  });

  test('link naar het gesprek dat hier al open staat: geen code, geen rotatie', async () => {
    const w = laad({
      opslag: BEWAARD,
      search: '?dfo-support=' + KENMERK,
      routes: { 'support-widget-config': CONFIG, 'support-poll': THREAD },
    });
    await wacht();
    assert.ok(!w.log.calls.some((c) => c.naam.startsWith('support-hervat')), 'er ging toch een hervat-call uit');
    assert.match(w.html(), /paneel chat/);
    assert.match(w.html(), /Hallo Paulien/);
    assert.deepEqual(w.opslag(), BEWAARD);
  });

  test('link naar een ander gesprek: codescherm, en de uitweg brengt het bewaarde gesprek terug', async () => {
    const ANDER = { ...THREAD, body: { ...THREAD.body, gesprek: { ...GESPREK, kenmerk: 'SUP-AAAAAA' } } };
    const w = laad({
      opslag: BEWAARD,
      search: '?dfo-support=' + KENMERK,
      routes: { 'support-widget-config': CONFIG, 'support-poll': ANDER },
    });
    await wacht();
    assert.match(w.html(), /Stuur me de code/);
    assert.equal(w.pollLoopt(), false, 'het andere gesprek mag niet op de achtergrond door-pollen');

    await w.klik('hervat-terug');
    assert.deepEqual(w.opslag(), BEWAARD, 'de uitweg gooide het bewaarde gesprek weg');
    assert.match(w.html(), /paneel chat/);
  });

  test('geslaagde code met mislukte eerste poll: toch in de chat, nieuw token bewaard', async () => {
    const NIEUW = 'nieuw-token-'.padEnd(43, 'n');
    const w = laad({
      search: '?dfo-support=' + KENMERK,
      routes: {
        'support-widget-config': CONFIG,
        'support-hervat-start': { status: 200, body: { ok: true } },
        'support-hervat-check': { status: 200, body: { ok: true, token: NIEUW, gesprek: GESPREK } },
        'support-poll': [{ status: 503, body: {} }, THREAD],
      },
    });
    await wacht();
    await w.klik('hervat-code');
    w.invoer['f-hervat'] = '123456';
    await w.klik('hervat-open');

    assert.equal(w.opslag().token, NIEUW);
    assert.match(w.html(), /paneel chat/);
    assert.doesNotMatch(w.html(), /Stuur me de code/);

    await w.pollRonde();
    const laatste = w.log.calls.filter((c) => c.naam === 'support-poll').pop();
    assert.match(laatste.pad, /volledig=1/);
    assert.equal(laatste.token, NIEUW);
    assert.match(w.html(), /Hallo Paulien/);
  });
});
