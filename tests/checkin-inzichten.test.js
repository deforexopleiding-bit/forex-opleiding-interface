// tests/checkin-inzichten.test.js — tab Inzichten van de studentencheck-in.
//
// Bedoeld gedrag (opdracht checkin-uitbreiding, 29 okt 2026):
//   · alleen verstuurde inzendingen tellen, testinzendingen enkel met test=1;
//   · KPI's (ingevuld/respons, gem. NPS, % feedbackpanel ja);
//   · zekerheid per trechterstap met de zwakste uitgelicht;
//   · gebruik per onderdeel vaak/soms/nooit + top "waarom niet";
//   · open antwoorden met naam/traject/mentor;
//   · filters traject/mentor/fase/trade-stand; onder 5 = "te weinig";
//   · CSV één rij per inzending (zelfde filter); machine-route voor het LMS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inzichten, filterUit, filterRijen, MIN_BETROUWBAAR } from '../api/_lib/checkin-inzichten.js';
import { stuurInzichten } from '../api/checkin-beheer.js';
import { maakHandler as machineHandler } from '../api/lms-checkin-inzichten.js';

const antw = (over = {}) => ({
  fase: 'demo', trade_stand: 'demo', nps: 8, feedbackpanel: 'ja',
  zekerheid: { h4_impuls: 4, fib_71: 4, bevestiging_15m: 2, risk: 5, discipline: 3 },
  gebruik: { live_sessies: 'vaak', discord: 'nooit' },
  gebruik_waarom_niet: { discord: 'wist_niet' },
  grootste_knelpunt: 'geduld_discipline',
  vooruithelpen: ['feedback_eigen_trades', 'live_meetraden'],
  live_moment: 'weekavond',
  ...over,
});
let n = 0;
const rij = (over = {}, a = {}) => {
  n += 1;
  return {
    id: 't' + n, naam: 'Student ' + n, product: 'membership', mentor_id: null, mentor: null,
    status: 'verstuurd', is_test: false, verstuurd_op: `2026-11-0${(n % 9) + 1}T10:00:00Z`, ruw: antw(a), ...over,
  };
};

test('filterUit: onbekende waarden vallen weg', () => {
  assert.deepEqual(filterUit({ traject: 'x', fase: 'demo', trade_stand: 'hack', mentor: ' m1 ', test: '1' }),
    { traject: '', mentor: 'm1', fase: 'demo', trade_stand: '', test: true });
  assert.deepEqual(filterUit(), { traject: '', mentor: '', fase: '', trade_stand: '', test: false });
});

test('filterRijen: verstuurd, test enkel op vraag, traject/mentor/fase/trade-stand', () => {
  const rijen = [
    rij(), rij({ status: 'bezig' }), rij({ is_test: true }),
    rij({ product: 'mentorship', mentor_id: 'm1', mentor: 'Seppe' }, { fase: 'funded', trade_stand: 'funded' }),
  ];
  assert.equal(filterRijen(rijen, {}).length, 2);
  assert.equal(filterRijen(rijen, { test: true }).length, 3);
  assert.deepEqual(filterRijen(rijen, { traject: '1op1' }).map((r) => r.mentor), ['Seppe']);
  assert.equal(filterRijen(rijen, { mentor: 'm1' }).length, 1);
  assert.equal(filterRijen(rijen, { mentor: 'geen' }).length, 1);
  assert.equal(filterRijen(rijen, { fase: 'funded' }).length, 1);
  assert.equal(filterRijen(rijen, { trade_stand: 'demo' }).length, 1);
});

test('inzichten: KPI\'s, zwakste stap, gebruik, top en open antwoorden', () => {
  const rijen = [
    rij({}, { nps: 10, een_ding_veranderen: 'Meer live' }),
    rij({}, { nps: 9 }),
    rij({}, { nps: 6, feedbackpanel: 'nee' }),
    rij({ product: 'mentorship', mentor_id: 'm1', mentor: 'Seppe' }, { nps: 3, mentor_score: 4, verbeter: 'oud antwoord' }),
    rij({}, { nps: 8, gebruik: { live_sessies: 'soms', discord: 'nooit' }, gebruik_waarom_niet: { discord: 'niet_nuttig' } }),
    rij({ status: 'niet_gestart' }),
    rij({ is_test: true }, { een_ding_veranderen: 'test' }),
  ];
  const z = inzichten(rijen, {});
  assert.equal(z.genoeg, true);
  assert.equal(z.kpi.ingevuld, 5);
  assert.equal(z.kpi.toegewezen, 6);
  assert.equal(z.kpi.respons_pct, 83.3);
  assert.equal(z.kpi.nps_gemiddeld, 7.2);
  assert.equal(z.kpi.nps_score, 0); // 2 promotors − 2 criticasters
  assert.equal(z.kpi.feedbackpanel_ja_pct, 80);
  assert.equal(z.kpi.mentor_score_gemiddeld, 4);
  assert.equal(z.zwakste, 'bevestiging_15m');
  const bev = z.zekerheid.find((s) => s.stap === 'bevestiging_15m');
  assert.equal(bev.gemiddelde, 2);
  assert.equal(bev.laag_pct, 100);
  assert.deepEqual(bev.verdeling.map((v) => v.aantal), [0, 5, 0, 0, 0]);
  const discord = z.gebruik.find((g) => g.onderdeel === 'discord');
  assert.deepEqual([discord.vaak, discord.soms, discord.nooit], [0, 0, 5]);
  assert.deepEqual(discord.waarom_niet.map((w) => [w.waarde, w.aantal]), [['wist_niet', 4], ['niet_nuttig', 1]]);
  assert.ok(!z.gebruik.some((g) => g.onderdeel === 'een_op_een'), 'zonder 1-op-1-antwoorden geen 1-op-1-balk');
  assert.equal(z.top.knelpunten[0].waarde, 'geduld_discipline');
  assert.deepEqual(z.top.vooruithelpen.map((b) => b.waarde).sort(), ['feedback_eigen_trades', 'live_meetraden']);
  const fp = z.vragen.find((v) => v.sleutel === 'feedbackpanel');
  assert.equal(fp.beantwoord, 5);
  assert.equal(z.open.length, 2);
  assert.deepEqual(z.open.map((o) => [o.tekst, o.oud, o.traject]).sort(), [['Meer live', false, 'membership'], ['oud antwoord', true, '1op1']]);
  assert.ok(!z.open.some((o) => o.tekst === 'test'), 'testinzending blijft buiten');
  assert.deepEqual(z.keuzes.mentoren, [['m1', 'Seppe']]);
});

test('inzichten: onder 5 inzendingen → te weinig, leeg = geen zwakste', () => {
  const z = inzichten([rij(), rij()], {});
  assert.equal(MIN_BETROUWBAAR, 5);
  assert.equal(z.genoeg, false);
  assert.equal(z.kpi.ingevuld, 2);
  const leeg = inzichten([], {});
  assert.equal(leeg.genoeg, false);
  assert.equal(leeg.zwakste, null);
  assert.equal(leeg.kpi.respons_pct, null);
  assert.equal(leeg.open.length, 0);
});

function nepRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

const OV = () => ({
  campagne: { slug: 'checkin-2026-11', naam: 'Check-in', status: 'live', live_op: '2026-11-01' },
  campagnes: [], meldingen: [],
  rijen: [rij({}, { een_ding_veranderen: 'Kortere video\'s, "graag"' }), rij({ product: 'mentorship', mentor_id: 'm1', mentor: 'Seppe' }, { fase: 'funded' }), rij({ status: 'bezig' })],
});

test('stuurInzichten: JSON en CSV met dezelfde filter (één rij per inzending)', () => {
  const r = nepRes();
  stuurInzichten(r, OV(), { traject: 'membership' });
  assert.equal(r.body.campagne.slug, 'checkin-2026-11');
  assert.equal(r.body.inzichten.kpi.ingevuld, 1);
  assert.equal(r.body.inzichten.genoeg, false);

  const c = nepRes();
  stuurInzichten(c, OV(), { csv: '1' });
  assert.match(c.headers['content-type'], /text\/csv/);
  assert.match(c.headers['content-disposition'], /checkin-inzichten-checkin-2026-11\.csv/);
  const regels = String(c.body).replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(regels.length, 3, 'kop + 2 verstuurde inzendingen');
  assert.match(regels[0], /Zekerheid per stap \(1-5\) – Fibonacci/, 'de objectdelen zijn kolommen');
  const f = nepRes();
  stuurInzichten(f, OV(), { csv: '1', fase: 'funded' });
  assert.equal(String(f.body).trim().split(/\r?\n/).length, 2);
});

test('machine-route: geheim verplicht, GET, zelfde inhoud verpakt', async () => {
  const oud = { p: process.env.DFO_LMS_PUSH_SECRET, a: process.env.DFO_LMS_AGENDA_SECRET };
  delete process.env.DFO_LMS_PUSH_SECRET; delete process.env.DFO_LMS_AGENDA_SECRET;
  try {
    const h = machineHandler({ lms: () => ({}), crm: {}, laad: async () => OV() });
    const roep = async (headers, method = 'GET', query = {}) => { const res = nepRes(); await h({ method, headers, query }, res); return res; };
    assert.equal((await roep({ 'x-dfo-secret': 'x' })).statusCode, 503);
    process.env.DFO_LMS_PUSH_SECRET = 'geheim-geheim';
    assert.equal((await roep({ 'x-dfo-secret': 'fout' })).statusCode, 403);
    assert.equal((await roep({})).statusCode, 403);
    assert.equal((await roep({ 'x-dfo-secret': 'geheim-geheim' }, 'POST')).statusCode, 405);
    const ok = await roep({ 'x-dfo-secret': 'geheim-geheim' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.inzichten.kpi.ingevuld, 2);
    assert.equal(ok.body.data.inzichten.open[0].naam.startsWith('Student'), true);
    const csv = await roep({ 'x-dfo-secret': 'geheim-geheim' }, 'GET', { csv: '1' });
    assert.match(csv.headers['content-type'], /text\/csv/);
  } finally {
    if (oud.p === undefined) delete process.env.DFO_LMS_PUSH_SECRET; else process.env.DFO_LMS_PUSH_SECRET = oud.p;
    if (oud.a === undefined) delete process.env.DFO_LMS_AGENDA_SECRET; else process.env.DFO_LMS_AGENDA_SECRET = oud.a;
  }
});

test('CRM-tab: view, tab in de shell en script geladen', async () => {
  const { readFileSync } = await import('node:fs');
  const shell = readFileSync(new URL('../modules/shared/design-system/app-shell.js', import.meta.url), 'utf8');
  assert.match(shell, /'Overzicht', 'Inzichten', 'Payouts', 'Per mentor', 'Mails'/);
  const idx = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
  assert.match(idx, /views\/checkin-inzichten-v2\.js/);
  const view = readFileSync(new URL('../modules/klanten-v2/views/checkin-inzichten-v2.js', import.meta.url), 'utf8');
  assert.match(view, /Te weinig antwoorden voor een betrouwbaar beeld/);
  assert.match(view, /checkin\/Inzichten/);
});
