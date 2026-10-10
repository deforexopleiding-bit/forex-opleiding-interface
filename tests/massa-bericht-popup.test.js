// tests/massa-bericht-popup.test.js
//
// De massa-popup (modules/klanten-v2/views/_massa-bericht.js) in jsdom:
//   1. openen → selectie geladen met de beginfilters; alles wat voldoet staat aan;
//   2. vinkje uit → teller omlaag; "Niets" → volgende-knop uit;
//   3. stap 2: knop pas aan met naam + soort + onderwerp + tekst;
//   4. controle → POST preview met PRECIES de aangevinkte lead_ids;
//   5. bevestigen → POST start met bevestig_aantal = het getoonde aantal;
//   6. pure helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRON = readFileSync(join(ROOT, 'modules/klanten-v2/views/_massa-bericht.js'), 'utf8');
const wacht = () => new Promise((ok) => setTimeout(ok, 0));

function opzet() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const verzoeken = [];
  const items = [
    { id: 'a', naam: 'Anna', email: 'a@x.nl', status: 'nieuw', kennismaking: 'geen', categorie: 'lead_aanmelding', geldig_email: true, toestemming: true },
    { id: 'b', naam: 'Bas', email: 'b@x.nl', status: 'nieuw', kennismaking: 'gehad', categorie: 'klant', geldig_email: true, toestemming: true, laatst_massa_op: '2026-10-01T10:00:00Z' },
    { id: 'c', naam: 'Cor', email: 'c@x.nl', status: 'nieuw', kennismaking: 'geen', categorie: 'events', geldig_email: true, toestemming: true },
  ];
  w.KV = {
    toast: () => {},
    authedFetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      verzoeken.push({ url, body });
      let j = {};
      if (url === '/api/massa-selectie') j = { items, totaal: items.length, opties: { bron: ['7-daagse-v2'], soort: ['instagram'], traject: ['7-daagse'] }, campagnes: [] };
      else if (url === '/api/lead-mail-sjablonen') j = { sjablonen: [{ id: 's1', naam: 'Welkom', onderwerp: 'Hoi {{voornaam}}', html: '<p>Sjabloon</p>' }] };
      else if (url === '/api/massa-campagne' && body.actie === 'preview') j = { ok: true, aantal_geselecteerd: body.lead_ids.length, aantal_verzenden: body.lead_ids.length, aantal_overgeslagen: 0, redenen: {}, portie: body.portie, voorbeeld: { aan: 'a@x.nl', onderwerp: 'Hoi Anna', html: '<p>x</p>' } };
      else if (url === '/api/massa-campagne' && body.actie === 'start') j = { ok: true, campagne_id: 'camp-1', aantal_verzenden: body.bevestig_aantal };
      else if (url.startsWith('/api/massa-campagne?id=')) j = { campagne: { id: 'camp-1', naam: 'Okt', soort: 'tips', onderwerp: 'Hoi', portie: 100, status: 'wachtrij', aantal: 2, aantal_verstuurd: 0, aantal_mislukt: 0, aantal_overgeslagen: 0, in_wachtrij: 2 }, mislukt: [] };
      return { ok: true, status: 200, json: async () => j };
    },
  };
  w.document.execCommand = () => true;
  w.eval(BRON);
  return { w, verzoeken };
}
const $ = (w, sel) => w.document.querySelector(sel);
const klik = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

test('popup: selectie → bericht → controle → wachtrij', async () => {
  const { w, verzoeken } = opzet();
  w.MassaBericht.open({ filter: { traject: '7-daagse' }, leadIds: [] });
  await wacht(); await wacht();
  const eerste = verzoeken.find((v) => v.url === '/api/massa-selectie');
  assert.deepEqual(JSON.parse(JSON.stringify(eerste.body.filter)), { traject: ['7-daagse'], email: 'ja', toestemming: 'ja', afgemeld: 'verbergen' }, 'beginfilter + veilige standaard');
  const vinkjes = [...w.document.querySelectorAll('[data-mb-vink]')];
  assert.equal(vinkjes.length, 3);
  assert.ok(vinkjes.every((v) => v.checked), 'alles wat voldoet staat standaard aan');
  assert.equal($(w, '[data-mb-aantal]').textContent, '3');

  // Eén vinkje uit.
  klik(w, vinkjes[1]); // een echte klik zet het vinkje uit
  assert.equal($(w, '[data-mb-aantal]').textContent, '2');
  // "Niets" → volgende uit; "Selecteer alles" → weer 3.
  klik(w, $(w, '[data-mb-actie="niets"]'));
  assert.ok($(w, '[data-mb-actie="naar-bericht"]').disabled);
  klik(w, $(w, '[data-mb-actie="alles"]'));
  assert.equal($(w, '[data-mb-aantal]').textContent, '3');
  const bVink = w.document.querySelector('[data-mb-vink="b"]');
  klik(w, bVink);

  // Stap 2.
  klik(w, $(w, '[data-mb-actie="naar-bericht"]'));
  await wacht(); await wacht();
  assert.ok($(w, '[data-mb-actie="naar-controle"]').disabled, 'zonder naam/onderwerp/tekst kan het niet');
  const zet = (sel, waarde, type = 'input') => { const el = $(w, sel); el.value = waarde; el.dispatchEvent(new w.Event(type, { bubbles: true })); };
  zet('[data-mb-b="naam"]', 'Oktober tips');
  zet('[data-mb-b="soort"]', 'tips', 'change');
  zet('[data-mb-b="sjabloon"]', 's1', 'change');
  assert.equal($(w, '[data-mb-b="onderwerp"]').value, 'Hoi {{voornaam}}', 'sjabloon geladen');
  assert.equal($(w, '[data-mb-editor]').innerHTML, '<p>Sjabloon</p>');
  assert.equal($(w, '[data-mb-actie="naar-controle"]').disabled, false);

  // Stap 3: controle met precies de aangevinkte leads.
  klik(w, $(w, '[data-mb-actie="naar-controle"]'));
  await wacht(); await wacht();
  const preview = verzoeken.find((v) => v.body && v.body.actie === 'preview');
  assert.deepEqual(preview.body.lead_ids, ['a', 'c']);
  assert.equal(preview.body.naam, 'Oktober tips');
  assert.equal(preview.body.soort, 'tips');
  assert.equal(preview.body.html, '<p>Sjabloon</p>');
  assert.equal(preview.body.sjabloon_id, 's1');
  assert.equal(preview.body.portie, 100);
  const start = $(w, '[data-mb-actie="start"]');
  assert.match(start.textContent, /2 mails in de wachtrij/);

  // Stap 4: bevestigen.
  klik(w, start);
  await wacht(); await wacht(); await wacht();
  const st = verzoeken.find((v) => v.body && v.body.actie === 'start');
  assert.equal(st.body.bevestig_aantal, 2);
  assert.deepEqual(st.body.lead_ids, ['a', 'c']);
  assert.ok(verzoeken.some((v) => v.url === '/api/massa-campagne?id=camp-1'), 'voortgang geladen');
  assert.ok($(w, '[data-mb-actie="verwerk"]'), 'knop "nu een portie"');
  w.MassaBericht.sluit();
  assert.equal(w.document.getElementById('massaBerichtRoot'), null);
});

test('popup: eigen selectie (vinkjes uit de lijst) gaat als lead_ids mee', async () => {
  const { w, verzoeken } = opzet();
  w.MassaBericht.open({ filter: {}, leadIds: ['a', 'c'] });
  await wacht(); await wacht();
  assert.deepEqual(verzoeken[0].body.filter.lead_ids, ['a', 'c']);
  assert.match(w.document.body.textContent, /Alleen je eigen selectie \(2 leads\)/);
});

test('popup-helpers: berichtFout + filterVoorApi', () => {
  const { w } = opzet();
  const H = w.MassaBericht._intern;
  const b = { naam: 'X', soort: 'tips', onderwerp: 'Hoi', portie: 100 };
  assert.equal(H.berichtFout(b, '<p>tekst</p>'), '');
  assert.match(H.berichtFout({ ...b, naam: ' ' }, '<p>t</p>'), /naam/);
  assert.match(H.berichtFout({ ...b, soort: '' }, '<p>t</p>'), /soort/);
  assert.match(H.berichtFout(b, '<p> </p>'), /leeg/);
  assert.match(H.berichtFout(b, '<p>{{korting}}</p>'), /Onbekende variabele/);
  assert.match(H.berichtFout({ ...b, portie: 0 }, '<p>t</p>'), /Portie/);
  assert.deepEqual(JSON.parse(JSON.stringify(H.filterVoorApi({ q: 'an', status: 'nieuw', massa_modus: 'dagen', massa_dagen: '7', lead_ids: [] }))), { q: 'an', status: ['nieuw'], massa: { modus: 'dagen', dagen: 7, campagne_id: '' } });
});
