// Strategie-scan: logo + beelden op /scan (2026-10-15).
//   - logo bovenaan, per thema (navy op licht, wit op donker), geen CRM-navigatie;
//   - maximaal 2 beelden in de flow (intro + "Jouw volgende stap"), als echte
//     bestanden in /img/scan/ met srcset (geen base64), thema-bewust gedimd;
//   - bestanden bestaan, juiste maten, klein genoeg;
//   - cache-buster opgehoogd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const pad = (p) => new URL('../' + p, import.meta.url);

function maat(p) {
  const b = readFileSync(pad(p));
  if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
}

test('logo bovenaan /scan: navy op licht, wit op donker, zonder CRM-navigatie', () => {
  const html = lees('modules/scan/index.html');
  assert.match(html, /<img class="logo logo-licht" src="\/img\/scan\/logo-navy\.png" width="400" height="226" alt="De Forex Opleiding">/);
  assert.match(html, /<img class="logo logo-donker" src="\/img\/scan\/logo-wit\.png" width="400" height="226" alt="De Forex Opleiding">/);
  assert.doesNotMatch(html, /<span class="em">F<\/span>/, 'oude F-embleem weg');
  assert.doesNotMatch(html, /sidebar|crm-guard|app-shell/);
  const css = lees('modules/scan/scan.css');
  assert.match(css, /:root\[data-theme="light"\] \.brand \.logo-donker\{display:none\}/);
  assert.match(css, /:root:not\(\[data-theme="light"\]\) \.brand \.logo-licht\{display:none\}/);
  assert.match(css, /\.brand \.logo\{height:46px;width:auto;/);
  assert.match(css, /@media \(max-width:560px\)\{[^\n]*\.brand \.logo\{height:40px\}/, 'kleiner op mobiel, naast de thema-knop');
  // Zijmarge van de balk blijft staan (geen padding-shorthand op .bb).
  assert.match(css, /\.bb\{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;padding-bottom:12px\}/);
});

test('maximaal 2 beelden in de flow, via srcset uit /img/scan (geen base64), thema-bewust gedimd', () => {
  const html = lees('modules/scan/index.html');
  const figuren = html.match(/<figure class="beeld[^"]*">/g) || [];
  assert.equal(figuren.length, 2);
  assert.match(html, /<figure class="beeld introbeeld">\s*<img src="\/img\/scan\/scan-intro-les-1400\.jpg" srcset="\/img\/scan\/scan-intro-les-800\.jpg 800w, \/img\/scan\/scan-intro-les-1400\.jpg 1400w"[^>]*width="1400" height="788"/);
  // De oude "AI in Actie"-seminarfoto is weg (bestanden + verwijzingen).
  assert.doesNotMatch(html, /scan-intro-(800|1400)\.jpg/);
  assert.ok(!existsSync(pad('img/scan/scan-intro-800.jpg')) && !existsSync(pad('img/scan/scan-intro-1400.jpg')), 'oude AI-foto verwijderd');
  assert.match(html, /<figure class="beeld sellbeeld">\s*<img src="\/img\/scan\/scan-trading-1200\.jpg" srcset="\/img\/scan\/scan-trading-700\.jpg 700w, \/img\/scan\/scan-trading-1200\.jpg 1200w"[\s\S]*?loading="lazy"/);
  assert.ok(html.indexOf('introbeeld') < html.indexOf('class="meta"'), 'intro-beeld onder de introtekst');
  assert.ok(html.indexOf('sellbeeld') > html.indexOf('id="sellCard"'), 'tweede beeld in "Jouw volgende stap" (valt mee weg bij "Nu nog niet")');
  assert.doesNotMatch(html, /data:image/);
  const css = lees('modules/scan/scan.css');
  assert.match(css, /:root:not\(\[data-theme="light"\]\) \.beeld img\{filter:brightness\(\.74\) saturate\(\.88\)\}/);
  assert.match(lees('modules/scan/index.html'), /scan\.css\?v=4/);
});

test('bestanden: bestaan, juiste maten (zoals in de HTML), geoptimaliseerd', () => {
  const verwacht = {
    'img/scan/logo-navy.png': [400, 226], 'img/scan/logo-wit.png': [400, 226],
    'img/scan/scan-intro-les-800.jpg': [800, 450], 'img/scan/scan-intro-les-1400.jpg': [1400, 788],
    'img/scan/scan-trading-700.jpg': [700, 700], 'img/scan/scan-trading-1200.jpg': [1200, 1200],
  };
  for (const [p, [w, h]] of Object.entries(verwacht)) {
    assert.ok(existsSync(pad(p)), p);
    assert.deepEqual(maat(p), [w, h], p);
    assert.ok(statSync(pad(p)).size < 200_000, p + ' < 200 kB');
  }
});
