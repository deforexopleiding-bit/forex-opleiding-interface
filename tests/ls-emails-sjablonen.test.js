// tests/ls-emails-sjablonen.test.js
//
// Leadsonderhoud → E-mails: e-mailsjablonen beheren vanaf de pagina (2026-10-11).
//
// De mailbouwer, "Stuur bericht" (1-op-1) en Massabericht werken met
// lead_mail_sjablonen (/api/lead-mail-sjablonen). Die stonden niet op de
// E-mails-pagina. Nu wel: als bewerkbare rij ("DB · lead-mails") met Bewerk ✎
// in de mailbouwer, plus een knop "+ Nieuw e-mailsjabloon". Zelfde bouwer en
// zelfde opslag als de popup — geen tweede implementatie.
// email_templates (compose-sjablonen van de E-mail-module) houden Bewerk ↗ naar
// Instellingen; onderhoud_sjablonen / code blijven read-only (alleen Preview).
//
// Draait de echte view + de echte mailbouwer in jsdom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const wacht = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const B = await import(pathToFileURL(join(ROOT, 'modules/shared/mail-blokken.js')).href);
const H = await import(pathToFileURL(join(ROOT, 'modules/shared/mail-huisstijl.js')).href);
const kloon = (x) => JSON.parse(JSON.stringify(x));

const OVERZICHT = {
  ok: true,
  categorie_labels: { 'funnels-toegang': 'Funnels & toegang', overig: 'Overig' },
  categories: {
    email_templates: [{ id: 'et1', naam: 'TEST hertest', categorie: 'overig', bron: 'email_templates', bewerkbaar: true, actief: true, mailbox: 'compose (per verzending)', preview_html: '<p>x</p>' }],
    onderhoud_sjablonen: [{ id: 'os1', naam: 'toelating · 7-daagse', categorie: 'funnels-toegang', bron: 'onderhoud_sjablonen', bewerkbaar: false, actief: true, mailbox: 'Strato (dfo-website)', preview_html: '<p>toelating</p>' }],
    code: [{ id: 'afspraak_24u', naam: 'Afspraak 24u', categorie: 'overig', bron: 'code', bewerkbaar: false, actief: true, mailbox: 'events@', preview_html: '<p>24u</p>' }],
  },
};

function laad({ sjablonenFout = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const timers = [];
  const st = w.setTimeout.bind(w), si = w.setInterval.bind(w);
  w.setTimeout = (...a) => { const h = st(...a); timers.push(h); return h; };
  w.setInterval = (...a) => { const h = si(...a); timers.push(h); return h; };
  const content = w.document.getElementById('content');
  const opslag = [{ id: 'sj-oud', naam: 'Oud los sjabloon', onderwerp: 'Hoi', html: '<p>Hallo {{voornaam}}</p>', blokken: null }];
  const verzoeken = [];
  const S = { filters: {} };
  w.DFO = {
    VIEWS: {}, S,
    key: () => 'leadsonderhoud',
    F: (k, d) => (S.filters['leadsonderhoud::' + k] !== undefined ? S.filters['leadsonderhoud::' + k] : d),
    setF() {}, goMod: (m) => { w.__goMod = m; },
    I: new Proxy({}, { get: () => '' }), svg: () => '',
    render: () => { content.innerHTML = w.DFO.VIEWS['leadsonderhoud/E-mails'](); },
  };
  w.MailBlokken = B; w.MailHuisstijl = H;
  w.document.execCommand = () => true;
  w.KV = {
    toast() {},
    authedJson: async (url) => {
      verzoeken.push({ url, method: 'GET' });
      if (url === '/api/email-overzicht') return kloon(OVERZICHT);
      if (url === '/api/lead-mail-sjablonen') {
        if (sjablonenFout) { const e = new Error('409'); e.status = 409; e.body = { code: sjablonenFout }; throw e; }
        return { sjablonen: kloon(opslag) };
      }
      return {};
    },
    // De mailbouwer bewaart via authedFetch POST /api/lead-mail-sjablonen.
    authedFetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      verzoeken.push({ url, method: (init && init.method) || 'GET', body });
      if (url === '/api/lead-mail-sjablonen' && init && init.method === 'POST') {
        const html = B.compileerBlokken(B.normaliseerBlokken(body.blokken).blokken);
        const bestaand = body.id && opslag.find((s) => s.id === body.id);
        const rij = { id: body.id || 'sj-nieuw', naam: body.naam, onderwerp: body.onderwerp, html, blokken: body.blokken };
        if (bestaand) Object.assign(bestaand, rij); else opslag.push(rij);
        return { ok: true, status: 200, json: async () => ({ ok: true, sjabloon: { id: rij.id } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  w.console.debug = () => {}; w.console.warn = () => {}; w.console.error = () => {};
  w.eval(lees('modules/klanten-v2/views/_shared-v2.js'));
  w.eval(lees('modules/klanten-v2/views/leadsonderhoud-v2.js'));
  w.eval(lees('modules/klanten-v2/views/_mail-bouwer.js'));
  const sluit = () => { w.DFO.render = () => {}; timers.forEach((h) => { w.clearTimeout(h); w.clearInterval(h); }); };
  return { w, content, opslag, verzoeken, sluit };
}

const rijVan = (content, naam) => [...content.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(naam));
const klik = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
// Inline onclick-attributen draaien niet in jsdom (runScripts 'outside-only'):
// controleer de bedrading en roep de handler zelf aan.
const onclick = (el) => el.getAttribute('onclick') || '';

test('E-mails: lead-mailsjablonen staan erbij en zijn bewerkbaar; systeemmails blijven read-only', async () => {
  const { w, content, verzoeken, sluit } = laad();
  w.DFO.render();
  await wacht(30);
  assert.ok(verzoeken.some((v) => v.url === '/api/lead-mail-sjablonen' && v.method === 'GET'), 'zelfde GET als de popup');
  const lead = rijVan(content, 'Oud los sjabloon');
  assert.ok(lead, 'lead-mailsjabloon in de lijst');
  assert.match(lead.textContent, /DB · lead-mails/);
  assert.match(lead.textContent, /✓ ja/);
  assert.ok([...lead.querySelectorAll('button')].some((b) => /Bewerk ✎/.test(b.textContent)));
  assert.ok([...lead.querySelectorAll('button')].some((b) => b.textContent === 'Preview'));
  // email_templates: ongewijzigd (Bewerk ↗ naar Instellingen).
  const et = rijVan(content, 'TEST hertest');
  assert.ok([...et.querySelectorAll('button')].some((b) => /Bewerk ↗/.test(b.textContent)));
  // Read-only: alleen Preview, geen Bewerk.
  for (const naam of ['toelating · 7-daagse', 'Afspraak 24u']) {
    const r = rijVan(content, naam);
    const knoppen = [...r.querySelectorAll('button')].map((b) => b.textContent.trim());
    assert.deepEqual(knoppen, ['Preview'], naam + ' blijft alleen-preview');
    assert.match(r.textContent, /nee \(read-only\)/);
  }
  // Categorie-chip Lead-mails filtert op de lead-mailsjablonen.
  const chip = [...content.querySelectorAll('button.chip')].find((b) => /Lead-mails/.test(b.textContent));
  assert.ok(chip); assert.match(chip.textContent, /\(1\)/);
  assert.ok(onclick(chip).includes("_lsSetEmailFilter('lead-mails')"));
  w._lsSetEmailFilter('lead-mails');
  assert.equal(content.querySelectorAll('tbody tr').length, 1);
  // Preview van een lead-mail = de echte huisstijl-shell.
  const pv = [...rijVan(content, 'Oud los sjabloon').querySelectorAll('button')].find((b) => b.textContent === 'Preview');
  assert.ok(onclick(pv).includes("_lsEmailPreview('lead_mail_sjablonen','sj-oud')"));
  w._lsEmailPreview('lead_mail_sjablonen', 'sj-oud');
  assert.match(content.querySelector('iframe').getAttribute('srcdoc'), /lead-mailshell[\s\S]*Hallo \{\{voornaam\}\}/);
  sluit();
});

test('E-mails: "+ Nieuw e-mailsjabloon" → mailbouwer → opslaan → in de lijst → Bewerk opent het met de blokken intact', async () => {
  const { w, content, opslag, verzoeken, sluit } = laad();
  w.DFO.render();
  await wacht(30);
  const nieuw = [...content.querySelectorAll('button')].find((b) => /Nieuw e-mailsjabloon/.test(b.textContent));
  assert.ok(nieuw);
  assert.ok(onclick(nieuw).includes('_lsLeadSjNieuw()'));
  w._lsLeadSjNieuw();
  const $ = (s) => w.document.querySelector(s);
  assert.ok($('#mailBouwerRoot'), 'mailbouwer open');
  const zet = (s, v) => { const el = $(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  for (const soort of ['kop', 'tekst', 'knop']) klik(w, $(`[data-mbw-voeg="${soort}"]`));
  klik(w, $('[data-mbw-kaart="0"]'));
  zet('[data-mbw-veld="tekst"]', 'Welkom terug');
  zet('[data-mbw-meta="naam"]', 'Heropenen oktober');
  zet('[data-mbw-meta="onderwerp"]', 'Hoi {{voornaam}}, nog interesse?');
  klik(w, $('[data-mbw-opslaan]'));
  await wacht(30);
  const post = verzoeken.find((v) => v.url === '/api/lead-mail-sjablonen' && v.method === 'POST');
  assert.ok(post, 'opgeslagen via dezelfde POST als de popup');
  assert.deepEqual(post.body.blokken.map((b) => b.soort), ['kop', 'tekst', 'knop']);
  assert.equal($('#mailBouwerRoot'), null, 'bouwer dicht na opslaan');
  // Lijst ververst: nieuw sjabloon staat erin, bewerkbaar.
  const rij = rijVan(content, 'Heropenen oktober');
  assert.ok(rij, 'nieuw sjabloon in de lijst');
  assert.match(rij.textContent, /DB · lead-mails/);
  // Bewerk ✎ → bouwer met precies dezelfde blokken.
  const bew = [...rij.querySelectorAll('button')].find((b) => /Bewerk ✎/.test(b.textContent));
  assert.ok(onclick(bew).includes("_lsLeadSjBewerk('sj-nieuw')"));
  w._lsLeadSjBewerk('sj-nieuw');
  assert.ok($('#mailBouwerRoot'));
  const staat = w.MailBouwer._intern.staat();
  assert.equal(staat.id, 'sj-nieuw');
  assert.deepEqual(kloon(staat.blokken), kloon(opslag.find((s) => s.id === 'sj-nieuw').blokken));
  assert.equal(staat.blokken[0].tekst, 'Welkom terug');
  // Bijwerken gaat naar hetzelfde id (geen dubbel sjabloon).
  zet('[data-mbw-meta="naam"]', 'Heropenen oktober v2');
  klik(w, $('[data-mbw-opslaan]'));
  await wacht(30);
  assert.equal(verzoeken.filter((v) => v.method === 'POST').pop().body.id, 'sj-nieuw');
  assert.equal(opslag.length, 2);
  assert.ok(rijVan(content, 'Heropenen oktober v2'));
  sluit();
});

test('E-mails: tabel ontbreekt → melding, de rest van het overzicht blijft staan', async () => {
  const { w, content, sluit } = laad({ sjablonenFout: 'MIGRATIE_NODIG' });
  w.DFO.render();
  await wacht(30);
  assert.match(content.textContent, /sjablonen-tabel bestaat nog niet/);
  assert.ok(rijVan(content, 'TEST hertest'));
  assert.ok(rijVan(content, 'Afspraak 24u'));
  sluit();
});

test('Stuur bericht: lead zonder nummer opent op E-mail en laadt de sjablonen meteen (geen tabklik nodig)', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const verzoeken = [];
  w.document.execCommand = () => true;
  w.MailBlokken = B; w.MailHuisstijl = H;
  w.KV = {
    toast() {},
    authedFetch: async (url) => {
      verzoeken.push(url);
      const j = url.startsWith('/api/lead-bericht')
        ? { lead: { id: 'l1', naam: 'Jef Testo', email: 'jef@x.nl', geldig_email: true, geldig_telefoon: false }, variabelen: { voornaam: 'Jef' }, templates: [] }
        : url === '/api/lead-mail-sjablonen' ? { sjablonen: [{ id: 'sj1', naam: 'Heropenen oktober', onderwerp: 'Hoi', html: '<p>x</p>', blokken: null }] } : {};
      return { ok: true, status: 200, json: async () => j };
    },
  };
  w.console.error = () => {};
  w.eval(lees('modules/klanten-v2/views/_stuur-bericht.js'));
  w.StuurBericht.open('l1', 'Jef Testo');
  await wacht(20);
  assert.ok(verzoeken.includes('/api/lead-mail-sjablonen'), 'sjablonen opgehaald zonder tabklik');
  const opties = [...w.document.querySelectorAll('[data-sb-box] select option')].map((o) => o.textContent.trim());
  assert.ok(opties.includes('Heropenen oktober'), 'sjabloon te kiezen in de 1-op-1-popup');
  w.StuurBericht.sluit();
});

test('bedrading: één opslagweg — popup, massa en E-mails-pagina delen /api/lead-mail-sjablonen + MailBouwer', () => {
  const ls = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(ls, /authedJson\('\/api\/lead-mail-sjablonen'\)/);
  assert.match(ls, /window\.MailBouwer\.open\(\{ sjabloon: sjabloon \|\| \{\}, onOpgeslagen: \(\) => fetchEmails\(true\) \}\)/);
  assert.match(lees('modules/klanten-v2/views/_stuur-bericht.js'), /api\('\/api\/lead-mail-sjablonen'\)/);
  assert.match(lees('modules/klanten-v2/views/_massa-bericht.js'), /api\('\/api\/lead-mail-sjablonen'\)/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/leadsonderhoud-v2\.js\?v=73"/);
});
