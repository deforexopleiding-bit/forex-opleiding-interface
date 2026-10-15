// Strategie-scan fase 4 (2026-10-15): dashboard.
//   1. berekenScanDashboard: periode (NL-tijd), week/maand-reeks incl. lege
//      periodes, concepten niet meegeteld, verdelingen in vaste volgorde,
//      conversie (handmatig voorrang) + dealwaarde (elke deal één keer);
//   2. api: ?dashboard=1 met periode-validatie;
//   3. bedrading: tab Dashboard, view, cache-busters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { berekenScanDashboard, kiesGroep, weekStart, nlDag } from '../api/_lib/scan-dashboard.js';
import { maakHandler } from '../api/scans-overzicht.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const klant = (bron, deal) => ({ status: 'klant', bron, klant: true, auto: deal ? { deal_id: deal[0], bedrag: deal[1], traject: 'Mentorschap > 12 maanden' } : null });
const geen = { status: null, bron: null, klant: false, auto: null };
const scan = (aangemaakt, extra = {}) => ({ status: 'verstuurd', aangemaakt, readiness_score: 70, categorie: 'Zeer geschikt', aanbevolen_traject: '12 maanden 1-op-1', aanbevolen_aanpak: 'Daytrading', klant: geen, ...extra });

const SCANS = [
  scan('2026-10-05T10:00:00Z', { klant: klant('automatisch', ['d1', 4995]) }),
  scan('2026-10-06T21:30:00Z', { readiness_score: 80, aanbevolen_traject: '24 maanden 1-op-1', klant: klant('handmatig', null) }),
  scan('2026-10-13T10:00:00Z', { status: 'afgerond', categorie: 'Geschikt met de juiste begeleiding', aanbevolen_aanpak: 'Swingtrading', readiness_score: 60 }),
  scan('2026-10-14T10:00:00Z', { categorie: 'Nu nog niet', aanbevolen_traject: 'Eerst de basis op orde', aanbevolen_aanpak: null, readiness_score: 50, klant: { status: 'geen_klant', bron: 'handmatig', klant: false, auto: null } }),
  scan('2026-10-14T12:00:00Z', { status: 'concept' }),
  scan('2026-10-15T09:00:00Z', { klant: klant('automatisch', ['d1', 4995]) }), // zelfde deal als de eerste
];

test('dashboard: totalen — concepten tellen niet mee, conversie (handmatig voorrang), dealwaarde elke deal één keer', () => {
  const d = berekenScanDashboard(SCANS, { van: '2026-10-01', tot: '2026-10-15', nu: new Date('2026-10-15T12:00:00Z') });
  const t = d.totaal;
  assert.equal(t.scans, 5); assert.equal(t.concepten, 1);
  assert.equal(t.verstuurd, 4); assert.equal(t.verstuurd_pct, 80);
  assert.equal(t.klanten, 3); assert.equal(t.conversie, 60);
  assert.equal(t.klanten_automatisch, 2); assert.equal(t.klanten_handmatig, 1); assert.equal(t.klanten_zonder_deal, 1);
  assert.equal(t.dealwaarde, 4995); assert.equal(t.deals, 1); assert.equal(t.gem_dealwaarde, 4995);
  assert.equal(t.gem_readiness, 66);
});

test('dashboard: reeks per week (maandag, NL-tijd), lege weken erbij; maand bij lange periodes', () => {
  const d = berekenScanDashboard(SCANS, { van: '2026-09-28', tot: '2026-10-25', nu: new Date('2026-10-25T12:00:00Z') });
  assert.equal(d.periode.groep, 'week');
  assert.deepEqual(d.reeks.map((r) => [r.start, r.scans, r.klanten]), [
    ['2026-09-28', 0, 0], ['2026-10-05', 2, 2], ['2026-10-12', 3, 1], ['2026-10-19', 0, 0],
  ]);
  assert.equal(d.reeks[1].label, '5 okt');
  const m = berekenScanDashboard(SCANS, { van: '2026-01-01', tot: '2026-12-31' });
  assert.equal(m.periode.groep, 'maand'); assert.equal(m.reeks.length, 12); assert.equal(m.reeks[9].label, 'okt 26'); assert.equal(m.reeks[9].scans, 5);
  assert.equal(kiesGroep('2026-01-01', '2026-03-31'), 'week'); assert.equal(kiesGroep(null, null), 'maand');
  assert.equal(weekStart('2026-10-18'), '2026-10-12', 'zondag hoort bij de week van maandag ervoor');
  assert.equal(nlDag('2026-10-06T22:30:00Z'), '2026-10-07', 'na middernacht NL = volgende dag');
});

test('dashboard: verdelingen in vaste volgorde (ook 0), "nu nog niet" zonder aanpak apart', () => {
  const d = berekenScanDashboard(SCANS, { van: '2026-10-01', tot: '2026-10-31' });
  assert.deepEqual(d.verdeling.categorie.map((r) => [r.naam, r.aantal]), [['Zeer geschikt', 3], ['Geschikt met de juiste begeleiding', 1], ['Nu nog niet', 1]]);
  assert.deepEqual(d.verdeling.traject.map((r) => [r.naam, r.aantal]), [['12 maanden 1-op-1', 3], ['24 maanden 1-op-1', 1], ['Zelfstudietraject', 0], ['Eerst de basis op orde', 1]]);
  assert.deepEqual(d.verdeling.aanpak.map((r) => [r.naam, r.aantal, r.pct]), [['Daytrading', 3, 60], ['Swingtrading', 1, 20], ['Geen (nu nog niet)', 1, 20]]);
  const c = d.conversie.categorie;
  assert.deepEqual(c[0], { naam: 'Zeer geschikt', scans: 3, klanten: 3, conversie: 100, dealwaarde: 4995 });
  assert.deepEqual(c[2], { naam: 'Nu nog niet', scans: 1, klanten: 0, conversie: 0, dealwaarde: 0 });
  assert.deepEqual(d.conversie.traject.find((r) => r.naam === 'Zelfstudietraject'), { naam: 'Zelfstudietraject', scans: 0, klanten: 0, conversie: 0, dealwaarde: 0 });
});

test('dashboard: lege set → nullen, geen fout', () => {
  const d = berekenScanDashboard([], { van: '2026-10-01', tot: '2026-10-07' });
  assert.equal(d.totaal.scans, 0); assert.equal(d.totaal.conversie, 0); assert.equal(d.totaal.gem_readiness, null);
  assert.equal(d.reeks.length, 2);
});

test('api: ?dashboard=1 geeft de cijfers; ongeldige periode → 400', async () => {
  const U = (n) => 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const tabellen = {
    scans: [{ id: U(1), lead_id: null, status: 'verstuurd', deelnemer_naam: 'A', deelnemer_email: null, readiness_score: 70, categorie: 'Zeer geschikt', aanbevolen_aanpak: 'Daytrading', aanbevolen_traject: '12 maanden 1-op-1', aangemaakt: '2026-10-10T10:00:00Z', klant_status_handmatig: 'klant' }],
    profiles: [], leads: [], customers: [], deals: [], traject_variants: [], trajects: [],
  };
  const from = (t) => {
    const k = { select: () => k, eq: () => k, is: () => k, in: () => k, order: () => k, limit: () => k,
      then: (res) => Promise.resolve({ data: tabellen[t] || [], error: null }).then(res) };
    return k;
  };
  const h = maakHandler({ db: { from }, userVan: async () => ({ id: 'u' }), magHet: async () => true, nu: () => new Date('2026-10-15T12:00:00Z') });
  const roep = async (query) => { const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await h({ method: 'GET', headers: {}, query }, res); return res; };
  const r = await roep({ dashboard: '1', van: '2026-10-01', tot: '2026-10-15' });
  assert.equal(r.code, 200);
  assert.equal(r.body.totaal.scans, 1); assert.equal(r.body.totaal.klanten, 1); assert.equal(r.body.totaal.klanten_handmatig, 1);
  assert.equal(r.body.periode.groep, 'week');
  assert.equal((await roep({ dashboard: '1', van: '1-10-2026' })).code, 400);
  assert.equal((await roep({ dashboard: '1', van: '2026-10-15', tot: '2026-10-01' })).code, 400);
});

test('bedrading: tab Dashboard in de module, view geregistreerd, cache-busters, legenda + tabelweergave', () => {
  assert.match(lees('modules/shared/design-system/app-shell.js'), /id: 'scans',[^\n]*permKey: 'scan\.use', tabs: \['Overzicht', 'Dashboard'\]/);
  const view = lees('modules/klanten-v2/views/scans-v2.js');
  assert.match(view, /window\.DFO\.VIEWS\['scans\/Dashboard'\] = dashboardView;/);
  assert.match(view, /\/api\/scans-overzicht\?' \+ qs/);
  assert.match(view, /class="scd-legend"><span><i style="background:var\(--emerald\)"><\/i>Klant geworden<\/span>/);
  assert.match(view, /<title>\$\{esc\(titel\)\}<\/title>/, 'tooltip per kolom');
  assert.match(view, /Cijfers per \$\{d\.periode\.groep\}/, 'tabelweergave onder de grafiek');
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /app-shell\.js\?v=1e4/); assert.match(html, /views\/scans-v2\.js\?v=2/);
});
