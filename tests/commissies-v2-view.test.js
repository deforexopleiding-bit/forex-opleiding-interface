// tests/commissies-v2-view.test.js
//
// Rooktest voor Mentoren → Commissies (modules/klanten-v2/views/commissies-v2.js):
// de view registreert zich, laadt /api/commissie-overzicht, tekent KPI's en de
// drie weergaven zonder fouten, en het toewijzingsvenster heeft geen
// klik-op-de-achtergrond-sluiter. Plus: 'Commissies' is de eerste tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const FIXTURE = {
  ok: true, periode: 'alles', migratie_ok: true, fouten: [],
  mentoren: [{ user_id: 'u-a', naam: 'Anna' }, { user_id: 'u-b', naam: 'Bart' }],
  kpis: { geboekt: 210, vrijgegeven: 135, open: 75, deze_maand_verwacht: 15, volgende_maand_verwacht: 9, risico: 30, risico_aantal: 1, aantal_sales: 2 },
  per_mentor: [
    { user_id: 'u-a', naam: 'Anna', closes: 2, geboekt: 120, vrijgegeven: 45, open: 75, verwacht_volgende_maand: 9, risico: 30 },
    { user_id: 'u-b', naam: 'Bart', closes: 1, geboekt: 90, vrijgegeven: 90, open: 0, verwacht_volgende_maand: 0, risico: 0 },
  ],
  per_event: [
    { key: 'ev1', event_id: 'ev1', titel: 'Event <Gent>', is_handmatig: false, datum: '2025-01-10', omzet: 6000, sales: 1, pot: 180, vrijgegeven: 135,
      verdeling: [{ user_id: 'u-a', naam: 'Anna', bedrag: 90 }, { user_id: 'u-b', naam: 'Bart', bedrag: 90 }], sale_keys: ['ev:ev1:k1'] },
    { key: 'handmatig:verlenging', event_id: null, titel: 'Handmatig toegewezen · Verlenging', is_handmatig: true, datum: null, omzet: 1000, sales: 1, pot: 30, vrijgegeven: 0,
      verdeling: [{ user_id: 'u-a', naam: 'Anna', bedrag: 30 }], sale_keys: ['attr:x1'] },
  ],
  sales: [
    { key: 'ev:ev1:k1', bron: 'event', bron_label: 'Event <Gent>', event_id: 'ev1', event_title: 'Event <Gent>', datum: '2025-01-10', klant: 'Jan Peeters',
      dealwaarde: 6000, pct: 3, term_count: 2, betaalde_termijnen: 1, schema_onbekend: false, achterstallig: false, wanbetaler: false, geannuleerd: false,
      share: 180, vrijgegeven: 135, open: 45, status: 'deels', risico: false, risico_redenen: [],
      mentoren: [{ user_id: 'u-a', naam: 'Anna', aandeel: 90, vrijgegeven: 45 }, { user_id: 'u-b', naam: 'Bart', aandeel: 90, vrijgegeven: 90 }],
      termijnen: [{ index: 1, due_date: '2025-02-01', status: 'betaald', aandeel: 90 }, { index: 2, due_date: '2027-01-01', status: 'open', aandeel: 90 }],
      volgende_termijn: { due_date: '2027-01-01', aandeel: 90, status: 'open' } },
    { key: 'attr:x1', bron: 'handmatig', reden: 'verlenging', bron_label: 'Verlenging', attribution_id: 'x1', datum: '2026-10-01', klant: 'Jan Peeters',
      dealwaarde: 1000, pct: 3, term_count: 4, betaalde_termijnen: 0, achterstallig: true, achterstand_bedrag: 250, geannuleerd: false,
      share: 30, vrijgegeven: 0, open: 30, status: 'achterstallig', risico: true, risico_redenen: ['vervallen facturen'],
      mentoren: [{ user_id: 'u-a', naam: 'Anna', aandeel: 30, vrijgegeven: 0 }], termijnen: [], volgende_termijn: null },
  ],
  projectie: [{ month: new Date().toISOString().slice(0, 7), per_mentor: { 'u-a': { betaald: 0, verwacht: 10 }, 'u-b': { betaald: 5, verwacht: 0 } } }],
  risicos: [],
};

function laad() {
  const calls = [];
  const win = {
    DFO: {
      I: new Proxy({}, { get: () => '' }), svg: () => '<svg></svg>', S: { role: 'super_admin' },
      render: () => {}, VIEWS: {}, goTab: (t) => calls.push(['goTab', t]),
    },
    KV_V2: { helpers: {
      pill: (c, t) => `<span class="pill pill-${c}">${t}</span>`,
      kpis: (arr) => arr.map((k) => `<div class="kpi">${k.label}:${k.val}</div>`).join(''),
      stableSearch: (k) => `<div data-search-key="${k}"></div>`, getSearchValue: () => '', onSearch: () => {},
    } },
    KV: { authedJson: async (url) => { calls.push(['get', url]); if (url.startsWith('/api/commissie-overzicht')) return FIXTURE; return { mentors: [] }; } },
  };
  const doc = { getElementById: () => null, querySelector: () => null };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', lees('modules/klanten-v2/views/commissies-v2.js'))(win, doc, setTimeout, clearTimeout);
  return { win, calls, view: win.DFO.VIEWS['mentoren/Commissies'] };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('Commissies is de eerste tab van Mentoren en het script staat in index.html', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /id: 'mentoren',[^\n]*tabs: \['Commissies', 'Overzicht'/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/commissies-v2\.js\?v=\d+/);
});

test('view laadt het overzicht en tekent KPI\'s + grafiek + per-mentor', async () => {
  const { view, calls } = laad();
  assert.equal(typeof view, 'function');
  let html = view();
  assert.match(html, /Commissie valt pas vrij wanneer de klant de factuur effectief betaalt/);
  await tick();
  assert.ok(calls.some((c) => c[1] === '/api/commissie-overzicht?periode=alles'));
  html = view();
  assert.match(html, /Commissie geboekt/);
  assert.match(html, /Risico/);
  assert.match(html, /Anna/);
  assert.match(html, /Commissie per maand/);
});

test('per sale en per event tekenen zonder fouten, HTML wordt ge-escaped', async () => {
  const { view, win } = laad();
  view(); await tick();
  win.__commWeergave('sale');
  let html = view();
  assert.match(html, /Verlenging/);
  assert.match(html, /Achterstallig/);
  assert.ok(!html.includes('Event <Gent>'), 'eventnaam ge-escaped');
  win.__commToggleSale('attr:x1');
  html = view();
  assert.match(html, /Toewijzing annuleren/);
  win.__commWeergave('event');
  win.__commToggleEvent('ev1');
  html = view();
  assert.match(html, /Handmatig toegewezen · Verlenging/);
  assert.match(html, /Commissiepot/);
});

test('zijpaneel en toewijzingsvenster: sluiten alleen via kruisje/annuleren', async () => {
  const { view, win } = laad();
  view(); await tick();
  win.__commPaneel('u-a');
  let html = view();
  assert.match(html, /Volledige drilldown/);
  win.__commPaneel(null);
  await win.__commWizOpen();
  html = view();
  assert.match(html, /Sale toewijzen aan mentor/);
  // De achtergrond (position:fixed;inset:0) heeft geen onclick.
  const achtergrond = html.match(/<div style="position:fixed;inset:0[^"]*"([^>]*)>/);
  assert.ok(achtergrond);
  assert.ok(!/onclick/.test(achtergrond[1]));
  win.__commAnnuleerOpen('x1');
  html = view();
  assert.match(html, /Typ <code[^>]*>ANNULEER<\/code>/);
});

test('Mijn verdiensten: tab heet Sales, oude Events-route blijft werken', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /id: 'verdiensten',[^\n]*tabs: \['Overzicht', 'Coaching', 'Sales', 'Uitbetalingen'/);
  const v = lees('modules/klanten-v2/views/verdiensten-v2.js');
  assert.match(v, /VIEWS\['verdiensten\/Sales'\]\s*=\s*eventsView/);
  assert.match(v, /VIEWS\['verdiensten\/Events'\]\s*=\s*eventsView/);
  assert.match(v, /gedeeld met \$\{Number\(s\.mentor_count\) - 1\}/);
});
