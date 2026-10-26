// tests/trial-overzicht-ui.test.js
//
// Leadsonderhoud › The Lab (modules/klanten-v2/views/the-lab-v2.js) in jsdom:
// het overzicht van alle trial-leads (KPI's per product, chips), de bellijst
// (tel:-link, resultaat noteren) en de Ads-tab die enkel The Lab vraagt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../modules/klanten-v2/views/the-lab-v2.js', import.meta.url), 'utf8');
const RIJ = {
  email: 'lien@x.be', lead_id: '11111111-1111-4111-8111-111111111111', aanmelding_id: 'a1', naam: 'Lien Peeters', telefoon: '+32470000000',
  product: 'minicursus', product_label: 'Minicursus', bron: 'kennismakingscursus-v9', aangemeld: '2026-10-26T10:00:00Z', dagen_over: 5,
  chips: [{ code: 'ingelogd', label: 'Ingelogd' }, { code: 'video', label: "Video's · 2" }], video_titels: ['Market Structure', 'Fibonacci'],
  lab: { gestart: false, afgerond: false }, laatste_bericht: null, laatste_belpoging: null, bel_groep: 'warm',
};
const DATA = {
  ok: true, hooks: ['H03'], belpogingen_ok: true, meldingen: [],
  kpi: [
    { sleutel: 'minicursus', label: 'Minicursus', leads: 4, ingelogd: 2, video: 2, lab_gestart: 1, lab_afgewerkt: 0, geboekt: 1, klant: 0 },
    { sleutel: '7-daagse', label: '7-daagse', leads: 0, ingelogd: 0, video: 0, lab_gestart: 0, lab_afgewerkt: 0, geboekt: 0, klant: 0 },
    { sleutel: 'totaal', label: 'Totaal', leads: 4, ingelogd: 2, video: 2, lab_gestart: 1, lab_afgewerkt: 0, geboekt: 1, klant: 0 },
  ],
  leads: [RIJ], bellijst: [RIJ],
};

async function opzet() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const antwoord = (url) => (url.startsWith('/api/trial-overzicht') ? DATA : url.startsWith('/api/lab-lead-index') ? { leads: {}, emails: {} } : { ok: true, rijen: [], leads: [] });
  w.KV = {
    authedFetch: async (url) => { calls.push({ url }); return { ok: true, json: async () => antwoord(url) }; },
    authedJson: async (url, init) => { calls.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return { ok: true }; },
    toast: () => {},
  };
  w.DFO = { render: () => {} };
  w.alert = (m) => { throw new Error('alert: ' + m); };
  w.eval(SRC);
  const view = w.DFO.VIEWS['leadsonderhoud/The Lab'];
  view();
  await new Promise((r) => setTimeout(r, 20));
  return { w, view, calls };
}

test('overzicht: KPI per product met % t.o.v. leads, lijst met belofte en chips', async () => {
  const { view, calls } = await opzet();
  const html = view();
  assert.ok(calls.some((c) => /\/api\/trial-overzicht\?van=\d{4}-\d\d-\d\d&tot=\d{4}-\d\d-\d\d&product=alle/.test(c.url)));
  assert.match(html, /data-trial-kpi/);
  assert.match(html, /Minicursus/);
  assert.match(html, /50%/);
  assert.match(html, /Video&#39;s · 2|Video's · 2/);
  assert.match(html, /kennismakingscursus-v9/);
});

test('bellijst: tel-link en een belpoging noteren', async () => {
  const { w, view, calls } = await opzet();
  w.__trialOvZet('tab', 'bellijst');
  const html = view();
  assert.match(html, /href="tel:\+32470000000"/);
  assert.match(html, /Warm, geen sessie/);
  w.__trialBelVeld('lien@x.be', 'resultaat', 'terugbellen');
  w.__trialBelVeld('lien@x.be', 'notitie', 'na 18u');
  await w.__trialBelNoteer('lien@x.be');
  const post = calls.find((c) => c.url === '/api/trial-belpoging');
  assert.deepEqual(post.body, { email: 'lien@x.be', lead_id: RIJ.lead_id, aanmelding_id: 'a1', resultaat: 'terugbellen', notitie: 'na 18u' });
});

test('ads-tab vraagt enkel The Lab op', async () => {
  const { w, view, calls } = await opzet();
  w.__trialOvZet('tab', 'ads');
  view();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.some((c) => /\/api\/lab-statistieken\?.*&product=the-lab/.test(c.url)));
});
