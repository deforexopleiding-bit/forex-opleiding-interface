// tests/setter-calls-view.test.js
//
// HET SCHERM 'Mijn calls', UITGEVOERD.
//
// Draait de echte modules/shared/call-uitkomst-categorie.js en
// modules/klanten-v2/views/setter-payout-v2.js in een node:vm met een nep-
// window, laat de view zijn data ophalen bij een nep-/api/setter-calls en
// kijkt wat er op het scherm komt. Bewaakt:
//   - de tab bestaat in de schil en de view is geregistreerd;
//   - de tellers en chips tonen de labels van de MAPPING (ook als de server
//     iets anders meestuurt), alleen categorieën met aantal > 0;
//   - 'nog niet vastgelegd door de closer', het sale-bedrag en 'geen deal
//     gevonden' staan erop; de calls van vóór de startdatum zitten ingeklapt;
//   - een beheerder die een andere setter kiest laadt diens calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const MAPPING = readFileSync(new URL('../modules/shared/call-uitkomst-categorie.js', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('../modules/klanten-v2/views/setter-payout-v2.js', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('../modules/shared/design-system/app-shell.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
const DASH = readFileSync(new URL('../modules/klanten-v2/views/dashboard-v2.js', import.meta.url), 'utf8');

const DATA = {
  setter_user_id: 'romy',
  startdatum: '2026-10-02',
  telling: {
    totaal: 3,
    per_categorie: [
      // Server-label bewust anders: de view moet de mapping volgen.
      { key: 'sale', label: 'SERVERLABEL', kleur: '#000000', aantal: 1 },
      { key: 'no_show', label: 'No show', kleur: '#dc2626', aantal: 0 },
      { key: 'nog_niet_vastgelegd', label: 'Nog niet vastgelegd', kleur: '#e11d48', aantal: 1 },
      { key: 'gepland', label: 'Gepland', kleur: '#0ea5e9', aantal: 1 },
    ],
  },
  komend: [
    { id: 'k1', lead_name: 'Alpha <b>Test</b>', datum_nl: '2026-10-07', tijd_nl: '15:00',
      categorie: { key: 'gepland', label: 'Gepland', kleur: '#0ea5e9' }, toelichting: null, sale: null },
  ],
  gedaan: [
    { id: 'g1', lead_name: 'Sal Koper', datum_nl: '2026-10-03', tijd_nl: '10:00',
      categorie: { key: 'sale', label: 'Sale', kleur: '#16a34a' }, toelichting: null,
      sale: { gekoppeld: true, deal_id: 'd1', bedrag: 7200, offerte_status: 'accepted', offerte_status_label: 'geaccepteerd', in_afwachting: false } },
    { id: 'g2', lead_name: 'Zonder Deal', datum_nl: '2026-10-03', tijd_nl: '09:00',
      categorie: { key: 'sale', label: 'Sale', kleur: '#16a34a' }, toelichting: null, sale: { gekoppeld: false } },
    { id: 'g3', lead_name: 'Nog Open', datum_nl: '2026-10-02', tijd_nl: '12:00',
      categorie: { key: 'nog_niet_vastgelegd', label: 'Nog niet vastgelegd', kleur: '#e11d48' },
      toelichting: 'Uitkomst nog niet vastgelegd door de closer', sale: null },
  ],
  eerder: [
    { id: 'e1', lead_name: 'Oude Call', datum_nl: '2026-09-20', tijd_nl: '12:00', status: 'scheduled',
      categorie: null, toelichting: 'Geen uitkomst vastgelegd (van vóór de start van de call-rapportage)', sale: null },
  ],
};

function maakScherm({ admin = false } = {}) {
  const fetches = [];
  let renders = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    queueMicrotask: (f) => queueMicrotask(f),
    setTimeout, clearTimeout,
  };
  ctx.window = ctx;
  ctx.KV_V2 = { helpers: {} };
  ctx.KV = {
    authedFetch: async (url) => {
      fetches.push(url);
      const body = url.startsWith('/api/setter-calls') ? DATA
        : url.startsWith('/api/profiles-list') ? { members: [{ id: 'ander-id', full_name: 'Andere Setter' }] }
          : {};
      return { ok: true, status: 200, json: async () => body };
    },
  };
  ctx.DFO = { VIEWS: {}, render: () => { renders += 1; } };
  ctx.RBAC = {
    ensurePermissionsLoaded: async () => {},
    canSync: (k) => admin && k === 'setter.ledger.admin',
  };
  createContext(ctx);
  runInContext(MAPPING, ctx, { filename: 'call-uitkomst-categorie.js' });
  runInContext(VIEW, ctx, { filename: 'setter-payout-v2.js' });
  return { ctx, fetches, renders: () => renders };
}

const wacht = () => new Promise((r) => setTimeout(r, 0));

test('de schil heeft de tab "Mijn calls" in de Commissie-module, en de view is geregistreerd', () => {
  assert.match(SHELL, /id: 'setter-payout'.*tabs: \['Overzicht', 'Mijn calls', 'Rapporten'\]/);
  const { ctx } = maakScherm();
  assert.equal(typeof ctx.DFO.VIEWS['setter-payout/Mijn calls'], 'function');
  assert.equal(typeof ctx.DFO.VIEWS['setter-payout/Overzicht'], 'function');
  assert.equal(typeof ctx.DFO.VIEWS['setter-payout/Rapporten'], 'function');
});

test('de view laadt /api/setter-calls en toont tellers, lijsten, sale-bedrag en toelichting', async () => {
  const { ctx, fetches } = maakScherm();
  const view = ctx.DFO.VIEWS['setter-payout/Mijn calls'];
  assert.match(view(), /Laden/);
  await wacht(); await wacht();
  assert.deepEqual(fetches, ['/api/setter-calls']);
  const html = view();

  // Tellers: label + kleur uit de mapping, niet uit de server; nul-categorieën weg.
  const M = ctx.CallUitkomstCategorie;
  assert.ok(html.includes(`${M.categorieInfo('sale').label} <b>1</b>`));
  assert.ok(html.includes(M.categorieInfo('sale').kleur));
  assert.doesNotMatch(html, /SERVERLABEL/);
  assert.doesNotMatch(html, new RegExp(`${M.categorieInfo('no_show').label} <b>0</b>`));
  assert.match(html, /Calls vanaf 02-10-2026: <b[^>]*>3<\/b>/);

  // Lijsten.
  assert.match(html, /Komende calls <span[^>]*>\(1\)<\/span>/);
  assert.match(html, /Afgelopen calls <span[^>]*>\(3\)<\/span>/);
  assert.match(html, /07-10-2026 · 15:00/);
  assert.ok(html.includes('Alpha &lt;b&gt;Test&lt;/b&gt;'), 'leadnaam ge-escaped');
  assert.match(html, /€\s?7\.200,00/);
  assert.match(html, /bedrag onbekend \(geen deal gevonden\)/);
  assert.match(html, /Uitkomst nog niet vastgelegd door de closer/);

  // Eerdere calls: ingeklapt, met teller; uitgeklapt zonder blaam.
  assert.match(html, /Eerdere calls van vóór 02-10-2026 \(1\)/);
  assert.doesNotMatch(html, /Oude Call/);
  ctx.__spCToggleEerder();
  const open = view();
  assert.match(open, /Oude Call/);
  assert.match(open, /Deze calls tellen niet mee/);
  assert.match(open, /Geen uitkomst vastgelegd \(van vóór de start/);
});

test('de view bevat geen eigen lijst met categorie-labels', () => {
  const blok = VIEW.slice(VIEW.indexOf('// Tab Mijn calls'), VIEW.indexOf("window.DFO = window.DFO || { VIEW"));
  assert.ok(blok.length > 500);
  assert.doesNotMatch(blok, /'Opvolgen \/ bedenktijd'|'Geen interesse'|'No show'|'Nieuw moment ingepland'|gesprek_gehad/);
  assert.match(blok, /window\.CallUitkomstCategorie/);
});

test('beheerder kiest een andere setter → de calls van die setter worden geladen', async () => {
  const { ctx, fetches } = maakScherm({ admin: true });
  const view = ctx.DFO.VIEWS['setter-payout/Mijn calls'];
  view();
  await wacht(); await wacht();
  assert.ok(view().includes('Andere Setter'), 'setterkeuze zichtbaar voor beheerder');
  ctx.__spSelectSetter('ander-id');
  view();
  await wacht(); await wacht();
  assert.ok(fetches.includes('/api/setter-calls?setter_user_id=ander-id'));
});

test('een setter krijgt geen setterkeuze', async () => {
  const { ctx } = maakScherm({ admin: false });
  const view = ctx.DFO.VIEWS['setter-payout/Mijn calls'];
  view();
  await wacht(); await wacht();
  assert.doesNotMatch(view(), /Bekijk setter/);
});

test('versies opgehoogd en het dashboard verwijst naar de tab', () => {
  assert.match(INDEX, /views\/setter-payout-v2\.js\?v=10"/);
  assert.match(INDEX, /views\/dashboard-v2\.js\?v=35"/);
  assert.match(INDEX, /app-shell\.js\?v=1db"/);
  // De mapping staat vóór de view in index.html.
  assert.ok(INDEX.indexOf('call-uitkomst-categorie.js') < INDEX.indexOf('views/setter-payout-v2.js'));
  assert.match(DASH, /DFO\.goTab\(\\'Mijn calls\\'\)/);
});
