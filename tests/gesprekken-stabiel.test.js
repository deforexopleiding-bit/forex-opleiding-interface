// tests/gesprekken-stabiel.test.js
//
// Bewaakt de fix van 29 okt: een gesprek openen (of een poll, een badge, de
// ongedaan-teller) mag het scherm niet meer volledig vervangen.
//
// Gemeten vóór de fix: bij één klik ging de hele lijst eruit en erin
// (scrollTop 382 → 0) en werd de volledige shell twee keer vervangen (bij de
// klik en ~1,4 s later via de parkeerstand). Zie de toelichting bij
// _herteken() in wanbetalers-v2.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('../modules/shared/design-system/app-shell.js', import.meta.url), 'utf8');

function blok(bron, begin, eind = '\n  };') {
  const i = bron.indexOf(begin);
  assert.ok(i >= 0, 'niet gevonden: ' + begin);
  return bron.slice(i, bron.indexOf(eind, i) + eind.length);
}

test('openen van een gesprek gebruikt de gerichte hertekening, geen volle render', () => {
  const b = blok(SCHERM, 'window.__wbxInboxSelect = (convId, opts) =>');
  assert.match(b, /_herteken\(\);/);
  assert.doesNotMatch(b, /window\.DFO\??\.render/);
  assert.doesNotMatch(SCHERM, /_wbxSafeRender/, 'de oude volle-render-met-scrollredding is weg');
});

test('_herteken valt alleen buiten het gesprekkenscherm terug op de volle render', () => {
  const b = blok(SCHERM, 'function _herteken()', '\n  }');
  assert.match(b, /if \(_wbxInboxGemonteerd\(\)\)/);
  assert.match(b, /_hertekenInbox\(\); return;/);
  assert.match(b, /window\.DFO\?\.render\?\.\(\)/);
  const g = blok(SCHERM, 'function _wbxInboxGemonteerd()', '\n  }');
  assert.match(g, /S\.mod === 'wanbetalers' && S\.tab === 'Gesprekken'/);
});

test('de parkeerstand tekent alleen de schrijfbalk opnieuw', () => {
  const b = blok(SCHERM, 'async function _fetchParkeerStand', '\n  }');
  assert.match(b, /_repaintInboxCompose\(\)/);
  assert.doesNotMatch(b, /window\.DFO\??\.render/);
});

test('lijst en draad worden per rij vergeleken, niet in één keer vervangen', () => {
  const lijst = blok(SCHERM, 'function _repaintInboxList()', '\n  }');
  assert.match(lijst, /_wbxMorph\(el, _inboxConvsListHtml\(\)\)/);
  assert.doesNotMatch(lijst, /innerHTML/);
  assert.match(SCHERM, /data-wbx-sleutel="\$\{esc\(cid\)\}" onclick="__wbxInboxSelect/);
  const draad = blok(SCHERM, 'function _repaintInboxThread(convId)', '\n  }');
  assert.match(draad, /_wbxMorph\(el, _inboxThreadHtml\(convId\)\)/);
});

test('de schrijfbalk bewaart focus en cursor bij hertekenen', () => {
  const b = blok(SCHERM, 'function _repaintInboxCompose()', '\n  }');
  assert.match(b, /_wbxFocusVast\(el\)/);
  assert.match(b, /_wbxFocusTerug\(el, focus\)/);
  assert.match(b, /ta\.value === String\(c\.text \|\| ''\)/, 'zet de code er tekst in, dan moet er wél geschreven worden');
});

test('de ongedaan-teller tikt alleen de teller bij, niet het scherm', () => {
  const i = SCHERM.indexOf('u.tikker = setInterval(');
  const b = SCHERM.slice(i, SCHERM.indexOf('}, 1000);', i));
  assert.match(b, /getElementById\('wbxUitstelSec'\)/);
  assert.match(b, /sec\.textContent = tekst/);
});

test('het zoekveld valt buiten de hertekende filterrijen', () => {
  assert.match(SCHERM, /<input id="wbxInboxSearch"[^\n]*\/>\n\s*<div id="wbxInboxFilters">\$\{_inboxFiltersHtml\(\)\}<\/div>/);
});

test('de shell schrijft nav, kruimel en tabs alleen bij verschil', () => {
  const nav = blok(SHELL, 'function renderNav()', '\n  }');
  assert.match(nav, /if \(el\.__dfoHtml === html\) return;/);
  assert.match(SHELL, /zetHtmlAlsAnders\(crumb,/);
  assert.match(SHELL, /zetHtmlAlsAnders\(tb,/);
});
