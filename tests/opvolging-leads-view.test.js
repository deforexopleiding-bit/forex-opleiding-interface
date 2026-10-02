// tests/opvolging-leads-view.test.js
//
// De tab 'Leads bellen': registratie, wiring, escaping en de tweelingen met de
// server (afrond-drempel).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as POT from '../api/_lib/opvolging-leads-pot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const VIEW = lees('modules/klanten-v2/views/opvolging-leads-v2.js');

function laad() {
  const taken = [];
  const window = {
    DFO: { VIEWS: {}, render() {}, goTab() {} },
    KV: { authedJson: async () => ({}) },
    __opvGedeeld: {
      render() {}, stijl() {}, straks: (fn) => taken.push(fn), opvToast() {},
      waLamp: () => '<lamp>', modalHtml: () => '', waPaneelHtml: () => '', gesprekPaneelHtml: () => '', doorstuurPaneelHtml: () => '',
      openModal() {},
    },
  };
  window.window = window;
  const ctx = createContext({
    window, document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console, queueMicrotask: (fn) => taken.push(fn), Date, Math, Number, String, JSON, Intl, Set, Map, Array, Object,
    encodeURIComponent, alert() {},
  });
  runInContext(VIEW, ctx, { filename: 'opvolging-leads-v2.js' });
  return { window, taken };
}

const rij = (o = {}) => ({
  lead_id: 'l1', naam: 'Jan', telefoon: '+32470', product_label: 'Minicursus · v2', score: 62,
  label: { code: 'heet', tekst: '🔥 Heet' }, chips: [{ tekst: 'ingelogd', soort: 'goed' }],
  opener: 'Vraag hoe de cursus loopt.', aangemeld_dagen: 3, kaart: null, ...o,
});

test('registreert opvolging/Leads bellen en de haken voor opvolging-v2', () => {
  const { window } = laad();
  assert.equal(typeof window.DFO.VIEWS['opvolging/Leads bellen'], 'function');
  assert.equal(typeof window.__opvLeadsZoek, 'function');
  assert.equal(typeof window.__opvLeadsVerander, 'function');
  assert.equal(typeof window.__opvLeadsKnop, 'function');
});

test('de pot Nieuw toont rijen, de tellers en wat er niet getoond wordt', () => {
  const { window } = laad();
  const st = window.__opvLeadsState;
  const data = {
    aantallen: { terugbellen: 0, verlopen: 0, bezig: 0, nieuw: 1, wacht: 0, later: 0, ingepland: 0, afgerond: 0 },
    badge: 1, dag: { gebeld: 2, gesproken: 1, whatsapps: 0, doorgestuurd: 1, ingepland: 0, afgerond: 0 },
    week: { doorgestuurd: 4, ingepland: 1, pct: 25 }, meldingen: [],
    niet_getoond: [{ code: 'komende_call', aantal: 8, tekst: 'heeft een geplande call' }],
    items: [rij()],
  };
  st.telling.data = data;
  st.potten.nieuw = { laden: false, fout: null, data };
  for (const r of data.items) st.rijen.set('l:' + r.lead_id, r);
  const html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /Trage momenten\?/);
  assert.match(html, /lb-pot on[^>]*>Nieuw<span class="n">1</);
  assert.match(html, /8 niet getoond omdat heeft een geplande call/);
  assert.match(html, /25 %/);
  assert.match(html, /Jan/);
  assert.match(html, /Heet &middot; 62/);
  assert.match(html, /window\.__opvLb\.bel\('l:l1'\)/);
});

test('escaping: een naam met HTML wordt nooit HTML', () => {
  const { window } = laad();
  const st = window.__opvLeadsState;
  const r = rij({ naam: '<img src=x onerror=alert(1)>', opener: '"><script>', chips: [{ tekst: "<b>'x'</b>" }] });
  const data = { aantallen: { nieuw: 1 }, items: [r], niet_getoond: [] };
  st.telling.data = data; st.potten.nieuw = { data }; st.rijen.set('l:l1', r);
  const html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /"><script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('zoekTaak-haak: een leadkaart in taakvorm (lijst leads)', () => {
  const { window } = laad();
  const r = rij({ kaart: { taak_id: 't1', status: 'open', telefoon: '+32471', bel_totaal: 2, bel_dagen: 1, wa_totaal: 1, pogingen: [] } });
  window.__opvLeadsState.rijen.set('t:t1', r);
  const t = window.__opvLeadsZoek('t1');
  assert.equal(t.id, 't1');
  assert.equal(t.lijst, 'leads');
  assert.equal(t.telefoon, '+32471');
  assert.equal(window.__opvLeadsZoek('onbekend'), null);
});

test('de afrond-drempel in het scherm is een tweeling van de server', () => {
  const getal = (naam) => Number((VIEW.match(new RegExp('const ' + naam + ' = (\\d+);')) || [])[1]);
  assert.equal(getal('AFROND_MIN_NOTITIE'), POT.AFROND_MIN_NOTITIE);
  assert.equal(getal('AFROND_MIN_BEL'), POT.AFROND_MIN_BEL);
  assert.equal(getal('AFROND_MIN_BEL_DAGEN'), POT.AFROND_MIN_BEL_DAGEN);
  assert.equal(getal('AFROND_MIN_WA'), POT.AFROND_MIN_WA);
  for (const c of Object.keys(POT.AFROND_CATEGORIEEN)) assert.ok(VIEW.includes("'" + c + "'"), c);
  for (const c of POT.AFROND_ZONDER_DREMPEL) assert.ok(VIEW.includes("'" + c + "'"));
  for (const p of POT.POTTEN) assert.ok(VIEW.includes("code: '" + p + "'"), p);
});

test('vensters van deze tab sluiten alleen via het kruisje', () => {
  const venster = VIEW.slice(VIEW.indexOf('function venster('), VIEW.indexOf('function venster(') + 500);
  assert.match(venster, /class="scrim on"/);
  assert.doesNotMatch(venster, /onmouseup|onclick="window\.__opvLb\.sluit\(\)"[^>]*class="scrim/);
  const door = lees('modules/klanten-v2/views/opvolging-v2.js');
  const paneel = door.slice(door.indexOf('function doorstuurPaneelHtml'), door.indexOf('function doorStijl'));
  assert.match(paneel, /<div class="scrim on"><div class="modal">/);
  assert.doesNotMatch(paneel, /onmouseup/);
});

test('wiring: tab, recht, registry, scriptvolgorde', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /'opvolging\/Leads bellen': 'opvolging\.leads\.view'/);
  assert.match(lees('modules/shared/rbac/registry.js'), /key:'opvolging\.leads\.view'/);
  const html = lees('modules/klanten-v2/index.html');
  const iOpv = html.indexOf('views/opvolging-v2.js?v=');
  const iLb = html.indexOf('views/opvolging-leads-v2.js?v=');
  assert.ok(iOpv > 0 && iLb > iOpv, 'leads-tab na opvolging-v2.js');
  const opv = lees('modules/klanten-v2/views/opvolging-v2.js');
  assert.match(opv, /window\.DFO\.VIEWS\['opvolging\/Leads bellen'\] = scherm;/, 'ook in de fallback-registratie');
  assert.match(opv, /window\.__opvLeadsKnop\(\)/, 'knop rechtsboven in Vandaag');
  assert.match(opv, /'Agenda doorsturen'/);
  assert.doesNotMatch(opv, /'Agenda doorgestuurd', 'Hij plant zelf in/);
});

test('lijst opladen: venster met voorvertoning, bevestigen pas na een geldige voorvertoning', () => {
  const { window } = laad();
  window.__opvLb.import();
  const st = window.__opvLeadsState;
  st.telling.data = { aantallen: {} };
  let html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /Lijst opladen/);
  assert.doesNotMatch(html, /Bevestigen:/);
  st.modal.vv = {
    aantallen: { geldig: 2, dubbel: 1, ongeldig: 0 }, per_dag: 10, samenvatting: '2 vandaag',
    rijen: [{ regel: 2, naam: '<x>', telefoon: '+32471', status: 'geldig', due: '2026-10-02' }],
  };
  html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /Bevestigen: 2 kaarten maken/);
  assert.match(html, /&lt;x&gt;/);
});
