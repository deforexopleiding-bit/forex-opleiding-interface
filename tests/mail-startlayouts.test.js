// tests/mail-startlayouts.test.js
//
// Startlayouts voor de mailbouwer (2026-10-11): welkom, webinar, aanbod,
// nieuwsbrief. Elk layout is meteen opslaan-/verstuurbaar (geen fouten,
// alleen bekende variabelen), compileert e-mailveilig, en de bouwer biedt ze
// aan bij een nieuw sjabloon en zet ze om naar bewerkbare blokken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const B = await import(pathToFileURL(join(ROOT, 'modules/shared/mail-blokken.js')).href);
const H = await import(pathToFileURL(join(ROOT, 'modules/shared/mail-huisstijl.js')).href);

function laad() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.MailBlokken = B; w.MailHuisstijl = H;
  w.KV = { toast: () => {}, authedFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sjabloon: { id: 'n' } }) }) };
  w.document.execCommand = () => true;
  w.eval(lees('modules/klanten-v2/views/_mail-startlayouts.js'));
  return w;
}

test('vier startlayouts: geldig, alleen bekende variabelen, e-mailveilig', () => {
  const w = laad();
  const l = w.MailStartlayouts;
  assert.deepEqual(JSON.parse(JSON.stringify(l.map((x) => x.sleutel))), ['welkom', 'webinar', 'aanbod', 'nieuwsbrief']);
  for (const x of l) {
    const blokken = JSON.parse(JSON.stringify(x.blokken()));
    const n = B.normaliseerBlokken(blokken);
    assert.deepEqual(n.fouten, [], x.sleutel + ' heeft geen fouten');
    const html = B.compileerBlokken(blokken);
    assert.doesNotMatch(html, /display:\s*(flex|grid)|<style/i, x.sleutel);
    const vars = [...(x.onderwerp + JSON.stringify(blokken)).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(vars.every((v) => B.MAIL_VARIABELEN.includes(v)), x.sleutel + ': alleen bekende variabelen');
    assert.ok(x.naam && x.omschrijving && x.onderwerp);
  }
  assert.ok(l.find((x) => x.sleutel === 'nieuwsbrief').blokken().some((b) => b.soort === 'kolommen' && b.links.afbeelding));
  assert.notEqual(l[0].blokken()[0], l[0].blokken()[0], 'elke keer verse blokken (geen gedeelde objecten)');
});

test('bouwer: nieuw sjabloon toont de startlayouts; kiezen vult blokken, naam en onderwerp', () => {
  const w = laad();
  w.eval(lees('modules/klanten-v2/views/_mail-bouwer.js'));
  w.MailBouwer.open({ sjabloon: {} });
  const $ = (s) => w.document.querySelector(s);
  assert.ok($('[data-mbw-layouts]'), 'bij een nieuw sjabloon direct de keuze');
  $('[data-mbw-layout="webinar"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const st = w.MailBouwer._intern.staat();
  assert.equal($('[data-mbw-layouts]'), null);
  assert.equal(st.naam, 'Webinar-uitnodiging');
  assert.match(st.onderwerp, /gratis webinar/);
  assert.deepEqual(JSON.parse(JSON.stringify(st.blokken.map((b) => b.soort))), ['kop', 'tekst', 'lijn', 'kolommen', 'knop', 'tekst']);
  assert.equal(new Set(st.blokken.map((b) => b.id)).size, st.blokken.length, 'unieke ids');
  // Via "Startlayout…" ook later te kiezen.
  $('[data-mbw-actie="layouts"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok($('[data-mbw-layout="nieuwsbrief"]'));
  w.MailBouwer.sluit();
  w.MailBouwer.open({ sjabloon: { id: 'x', naam: 'Bestaand', onderwerp: 'X', blokken: [B.maakBlok('kop')] } });
  assert.equal($('[data-mbw-layouts]'), null, 'een bestaand sjabloon opent zonder keuze');
});

test('bedrading: script na de bouwer in index.html', () => {
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /<script src="views\/_mail-startlayouts\.js\?v=\d+"><\/script>/);
  assert.ok(html.indexOf('views/_mail-bouwer.js') < html.indexOf('views/_mail-startlayouts.js'));
});
