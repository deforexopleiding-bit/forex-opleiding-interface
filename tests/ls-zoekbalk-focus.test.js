// tests/ls-zoekbalk-focus.test.js
//
// Leadsonderhoud → Contacten / Gesprekken / Templates: het zoekveld houdt
// focus en cursor tijdens het typen (2026-10-11).
//
// OORZAAK. Het zoekveld stond als HTML-string in de view met
//   oninput="…DFO.render();this.focus()"
// DFO.render() vervangt #content via innerHTML, dus 'this' was na de render
// een losgekoppeld element: focus() deed niets en de cursor was na elke toets
// weg. Templates had niet eens die poging; Gesprekken herstelde pas in een rAF.
//
// FIX. De gedeelde stableSearch uit _shared-v2.js (net als de Leads-lijst): het
// <input> blijft hetzelfde DOM-element over renders heen, en het filteren loopt
// gedebounced. Deze test draait de echte views in jsdom en typt erin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const wacht = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function laad() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // Timers bijhouden: de view pollt (Gesprekken) en tryFetch zet een 8s-timeout.
  const timers = [];
  const st = w.setTimeout.bind(w), si = w.setInterval.bind(w);
  w.setTimeout = (...a) => { const h = st(...a); timers.push(h); return h; };
  w.setInterval = (...a) => { const h = si(...a); timers.push(h); return h; };
  // Opruimen zonder w.close(): nog lopende promises (fetch-stubs) mogen daarna
  // nog renderen; een gesloten jsdom-venster gooit dan op document.location.
  w.__sluit = () => { w.DFO.render = () => {}; timers.forEach((h) => { w.clearTimeout(h); w.clearInterval(h); }); };
  const content = w.document.getElementById('content');
  const urls = [];
  const S = { filters: {} };
  const staat = { view: 'leadsonderhoud/Contacten' };
  w.DFO = {
    VIEWS: {}, S,
    key: () => 'leadsonderhoud',
    F: (k, d) => (S.filters['leadsonderhoud::' + k] !== undefined ? S.filters['leadsonderhoud::' + k] : d),
    setF: (k, v) => { S.filters['leadsonderhoud::' + k] = v; w.DFO.render(); },
    I: new Proxy({}, { get: () => '' }), svg: () => '',
    render: () => { content.innerHTML = w.DFO.VIEWS[staat.view](); },
  };
  w.KV = {
    toast() {},
    authedFetch: async () => ({ ok: true, json: async () => ({ access: {} }) }), // zoals productie: anders blijft de access-batch hertekenen
    authedJson: async (url) => {
      urls.push(url);
      if (url.startsWith('/api/leads-list')) return { items: [{ id: 'l1', naam: 'Anna Test', email: 'anna@x.nl' }], total: 1, has_more: false };
      if (url.startsWith('/api/leadsonderhoud-gesprekken')) return { items: [] };
      return { items: [], categories: [] };
    },
  };
  w.console.debug = () => {};
  w.console.warn = () => {};
  w.eval(lees('modules/klanten-v2/views/_shared-v2.js'));
  w.eval(lees('modules/klanten-v2/views/leadsonderhoud-v2.js'));
  return { w, content, urls, S, staat };
}

/** Typ zoals een mens: focus, waarde + cursor, input-event. */
function typ(w, input, tekst) {
  input.focus();
  input.value = tekst;
  input.setSelectionRange(tekst.length, tekst.length);
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
}

test('Contacten: cursor blijft staan bij typen + renders; lijst filtert gedebounced op de server', async () => {
  const { w, content, urls, S } = laad();
  w.DFO.render();
  await wacht(20);
  const input = content.querySelector('.kv-search-input');
  assert.ok(input, 'zoekveld staat er');
  assert.equal(input.placeholder, 'Zoek op naam of e-mail…');
  assert.equal(content.querySelectorAll('input[oninput*="ls-q"]').length, 0, 'geen kaal input meer');

  typ(w, input, 'An');
  w.DFO.render(); // een tussentijdse render (fetch klaar / poll) mag niets breken
  assert.equal(w.document.activeElement, input, 'zelfde element houdt focus');
  assert.equal(input.selectionStart, 2);
  assert.equal(S.filters['leadsonderhoud::ls-q'], undefined, 'nog niet gefilterd binnen de debounce');

  typ(w, input, 'Ann');
  await wacht(320);
  assert.equal(S.filters['leadsonderhoud::ls-q'], 'Ann', 'na de debounce één keer gefilterd');
  await wacht(20);
  assert.ok(urls.some((u) => u.startsWith('/api/leads-list') && u.includes('q=Ann')), 'server-zoekopdracht met q');
  assert.ok(!urls.some((u) => u.includes('q=An&') || /q=An$/.test(u)), 'tussenstand "An" niet apart opgehaald');
  assert.equal(content.querySelector('.kv-search-input'), input, 'na de nieuwe lijst nog steeds hetzelfde input');
  assert.equal(w.document.activeElement, input);
  assert.equal(input.value, 'Ann');
  assert.equal(input.selectionStart, 3);
  w.__sluit();
});

test('Gesprekken: zoekveld blijft staan bij typen en bij een poll-render', async () => {
  const { w, content, staat } = laad();
  staat.view = 'leadsonderhoud/Gesprekken';
  w.DFO.render();
  await wacht(20);
  const input = content.querySelector('.kv-search-input');
  assert.ok(input);
  assert.equal(input.placeholder, 'Zoek op naam of telefoon…');
  typ(w, input, '06');
  w.DFO.render();
  assert.equal(w.document.activeElement, input);
  await wacht(200);
  assert.equal(content.querySelector('.kv-search-input'), input);
  assert.equal(w.document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  // Zetten van buitenaf (oude setter) houdt het veld in sync.
  w.__lsInbSetSearch('');
  assert.equal(input.value, '');
  w.__sluit();
});

test('Templates: zoekveld blijft staan bij typen', async () => {
  const { w, content, staat } = laad();
  staat.view = 'leadsonderhoud/Templates';
  w.DFO.render();
  await wacht(20);
  w.DFO.render();
  const input = content.querySelector('.kv-search-input');
  assert.ok(input);
  assert.equal(input.placeholder, 'Zoek in titel of tekst…');
  typ(w, input, 'welk');
  await wacht(200);
  assert.equal(content.querySelector('.kv-search-input'), input);
  assert.equal(w.document.activeElement, input);
  assert.equal(input.selectionStart, 4);
  w.__sluit();
});

test('Inbox (zelfde patroon): zoekveld blijft staan, placeholder volgt de bron', async () => {
  const { w, content, staat, S } = laad();
  w.eval(lees('modules/klanten-v2/views/inbox-v2.js'));
  staat.view = 'inbox/';
  w.DFO.render();
  await wacht(30);
  const input = content.querySelector('.kv-search-input');
  assert.ok(input);
  assert.match(input.placeholder, /^Zoek in /);
  typ(w, input, 'factuur');
  w.DFO.render();
  assert.equal(w.document.activeElement, input);
  await wacht(200);
  assert.equal(S.filters['leadsonderhoud::q'], 'factuur', 'gedebounced in de filter');
  assert.equal(content.querySelector('.kv-search-input'), input);
  assert.equal(w.document.activeElement, input);
  assert.equal(input.selectionStart, 7);
  const bron = content.querySelectorAll('.ib-src')[1];
  const naam = bron.textContent.trim();
  bron.click();
  await wacht(5);
  assert.equal(content.querySelector('.kv-search-input'), input, 'bronwissel: zelfde input');
  assert.ok(input.placeholder.length > 'Zoek in '.length && naam.includes(input.placeholder.replace(/^Zoek in /, '').replace('…', '')), 'placeholder volgt de bron');
  w.__sluit();
});

test('bedrading: cache-busters gebumpt, geen kale zoek-inputs meer', () => {
  assert.match(lees('modules/klanten-v2/index.html'), /views\/leadsonderhoud-v2\.js\?v=72"/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/inbox-v2\.js\?v=12"/);
  assert.doesNotMatch(lees('modules/klanten-v2/views/inbox-v2.js'), /oninput="[^"]*DFO\.render\(\);this\.focus/);
  const ls = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.doesNotMatch(ls, /oninput="[^"]*DFO\.render\(\);this\.focus/);
  assert.doesNotMatch(ls, /oninput="window\.__lsInbSetSearch|oninput="window\.__lsTplSetSearch/);
});
