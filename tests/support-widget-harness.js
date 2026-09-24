// tests/support-widget-harness.js
//
// Laadt widget/support.js in een echte DOM (jsdom). Gedeeld door de
// widgettests; zelf geen testbestand (de glob pakt alleen *.test.js).

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRON = readFileSync(join(ROOT, 'widget/support.js'), 'utf8');
export const OPSLAG = 'dfo-support-sessie';

const tick = () => new Promise((r) => setImmediate(r));
export async function wacht(n = 8) { for (let i = 0; i < n; i++) await tick(); }

export /**
 * Laad de widget in een echte DOM (jsdom) met een route-tabel voor de API.
 * `routes[pad]` is een functie (verzoek) → { status, body } | 'netwerk' (fetch
 * gooit), of een array daarvan die per aanroep wordt afgelopen.
 *
 * Timers zijn nep: setInterval (de poll) draait alleen via pollRonde(), en
 * setTimeout (teaser, supportkaart) wordt vastgehouden en niet uitgevoerd.
 */
function laad({ routes = {}, opslag = null, search = '' } = {}) {
  const log = { calls: [], volgorde: [] };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.deforexopleiding.nl/cursus' + search,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (opslag) window.localStorage.setItem(OPSLAG, JSON.stringify(opslag));

  const echteReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState = (a, b, url) => { log.volgorde.push('replaceState'); echteReplace(a, b, url); };

  let intervalFn = null;
  window.setInterval = (f) => { intervalFn = f; return 1; };
  window.clearInterval = () => { intervalFn = null; };
  window.setTimeout = () => 0;
  window.clearTimeout = () => {};

  const rondes = {};
  window.fetch = async (url, opts = {}) => {
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
  };

  // currentScript bestaat niet bij eval; de widget zoekt dan zijn eigen
  // <script>-tag. Die zetten we er dus neer.
  const tag = window.document.createElement('script');
  tag.src = 'https://crm.deforexopleiding.nl/widget/support.js';
  window.document.body.appendChild(tag);
  window.eval(BRON);

  const sr = () => window.document.querySelector('[data-dfo-support]')?.shadowRoot || null;

  return {
    log,
    window,
    loc: window.location,
    sr,
    invoer(id, waarde) {
      const el = sr().querySelector('#' + id);
      assert.ok(el, 'veld ' + id + ' staat niet op het scherm');
      el.value = waarde;
    },
    // Wat er zichtbaar is: verborgen delen tellen niet mee.
    html: () => {
      const r = sr();
      if (!r) return '';
      const kloon = r.querySelector('.wrap').cloneNode(true);
      kloon.querySelectorAll('[hidden]').forEach((n) => n.remove());
      const p = kloon.querySelector('.paneel');
      if (p && !p.classList.contains('open')) p.remove();
      return kloon.innerHTML;
    },
    inChat: () => {
      const p = sr()?.querySelector('.paneel');
      return !!(p && p.classList.contains('open') && p.classList.contains('chat'));
    },
    opslag: () => { const v = window.localStorage.getItem(OPSLAG); return v ? JSON.parse(v) : null; },
    async klik(actie) {
      const el = [...(sr()?.querySelectorAll('[data-a="' + actie + '"]') || [])].find((n) => !n.closest('[hidden]'));
      assert.ok(el, 'knop ' + actie + ' staat niet op het scherm');
      el.click();
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

