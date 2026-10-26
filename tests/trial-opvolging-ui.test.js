// tests/trial-opvolging-ui.test.js
//
// Leadsonderhoud › Templates › Trial-opvolging (modules/klanten-v2/views/
// trial-opvolging-v2.js) in jsdom: laadt de instellingen, toont de schakelaar
// en elke stap met zijn mail- en WhatsApp-status, en bewaart via
// /api/leadsonderhoud-sjabloon-opslaan met traject 'the-lab'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../modules/klanten-v2/views/trial-opvolging-v2.js', import.meta.url), 'utf8');
const ANTWOORD = {
  ok: true, live: false, noodstop: false, wa_lijn_ok: true, variabelen: ['voornaam', 'loginlink'],
  stappen: [
    { stap: 'welkom', label: 'Dag 0 · welkom', wanneer: 'meteen', whatsapp_stap: true, mail: null, whatsapp: { voorgesteld_template: 'trial_welkom', eigen: null, goedgekeurd: null } },
    { stap: 'niet-ingelogd-48u', label: '+48u niet ingelogd', wanneer: '48u', whatsapp_stap: true,
      mail: { standaard: { onderwerp: 'Je toegang loopt maar 7 dagen', html: '<p>x</p>' }, eigen: null },
      whatsapp: { voorgesteld_template: 'trial_niet_ingelogd_48u', eigen: { id: 'w1', meta_template: 'trial_niet_ingelogd_48u', actief: true, variabele_volgorde: ['voornaam', 'loginlink'] }, goedgekeurd: false } },
  ],
};

async function opzet() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  w.KV = { authedJson: async (url, init) => { calls.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return url.startsWith('/api/lab-opvolging-instellingen') ? ANTWOORD : { ok: true }; }, toast: () => {} };
  w.DFO = { render: () => {} };
  w.confirm = () => { throw new Error('native confirm() gebruikt'); };
  w.eval(SRC);
  w.DFOTrialOpvolging.render();
  await new Promise((r) => setTimeout(r, 20));
  return { w, calls };
}

test('rendert schakelaar en stappen met de status van mail en WhatsApp', async () => {
  const { w } = await opzet();
  const html = w.DFOTrialOpvolging.render();
  assert.match(html, /UIT \(droogloop\)/);
  assert.match(html, /\+48u niet ingelogd/);
  assert.match(html, /Mail · standaardtekst/);
  assert.match(html, /wacht op Meta \(wordt overgeslagen\)/);
  assert.match(html, /nog geen template gekoppeld/);
  assert.match(html, /Je toegang loopt maar 7 dagen/);
});

test('mail bewerken en bewaren: traject the-lab, soort = stap, kanaal mail', async () => {
  const { w, calls } = await opzet();
  w.__trialOpvBewerk('niet-ingelogd-48u', 'mail');
  assert.match(w.DFOTrialOpvolging.render(), /Mail · niet-ingelogd-48u/);
  w.__trialOpvVeld('onderwerp', 'Nieuw onderwerp');
  await w.__trialOpvBewaar(true);
  const b = calls.find((c) => c.url === '/api/leadsonderhoud-sjabloon-opslaan').body;
  assert.equal(b.traject_slug, 'the-lab');
  assert.equal(b.soort, 'niet-ingelogd-48u');
  assert.equal(b.kanaal, 'mail');
  assert.equal(b.onderwerp, 'Nieuw onderwerp');
  assert.ok(b.tekst);
});

test('schakelaar zet live via POST', async () => {
  const { w, calls } = await opzet();
  w.__trialOpvLive(true);
  assert.equal(calls.filter((c) => c.body && 'live' in c.body).length, 0, 'eerst bevestigen, nog niets opgeslagen');
  assert.match(w.DFOTrialOpvolging.render(), /data-trial-opv-bevestig-ok/);
  w.__trialOpvBevestigAnnuleer();
  assert.doesNotMatch(w.DFOTrialOpvolging.render(), /data-trial-opv-bevestig-ok/);
  w.__trialOpvLive(true);
  await w.__trialOpvBevestigOk();
  assert.deepEqual(calls.at(-1), { url: '/api/lab-opvolging-instellingen', body: { live: true } });
  await w.__trialOpvLive(false);
  assert.deepEqual(calls.at(-1), { url: '/api/lab-opvolging-instellingen', body: { live: false } }, 'uitzetten zonder bevestiging');
  assert.doesNotMatch(SRC, /window\.confirm\(/, 'geen native confirm()');
});

test('zonder recht om te schakelen: geen knop, wel de stand', async () => {
  ANTWOORD.mag_schakelen = false;
  try {
    const { w } = await opzet();
    const html = w.DFOTrialOpvolging.render();
    assert.doesNotMatch(html, /__trialOpvLive/);
    assert.match(html, /Aan\/uit: Dave of Maxim/);
  } finally { delete ANTWOORD.mag_schakelen; }
});
