// tests/gesprekken-draad-bladzijden.test.js
//
// De bedrading van G8-paginering: het endpoint en het scherm.
//
// Twee gaten, allebei stil. Het endpoint haalde ÁLLE berichten van een gesprek
// op om er daarna alles behalve de laatste 200 weg te gooien — dat groeit mee
// met de geschiedenis, dus precies bij de klant met wie je het meest gepraat
// hebt loopt het als eerste tegen de tijdslimiet. En het scherm zei er niets
// over, dus je las een gesprek dat halverwege begon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ENDPOINT = readFileSync(new URL('../api/inbox-thread-unified.js', import.meta.url), 'utf8');
const SCHERM   = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');

// ── het endpoint ────────────────────────────────────────────────────────────

test('geen enkele opvraging haalt nog de hele geschiedenis op', () => {
  // Dit is de kern. Een opvraging zonder limiet op een gesprekstabel is werk
  // dat meegroeit met de klant.
  assert.doesNotMatch(ENDPOINT, /ascending:\s*true/,
    'oplopend ophalen betekent: vanaf het begin, dus alles');
});

test('alle vijf de bronnen halen nieuwste-eerst op, met een limiet', () => {
  // Vijf: WhatsApp, plus mail en eigen antwoorden langs het klant-pad én
  // langs het contact-pad (G6). Mist er één, dan is dát de bron die het
  // endpoint straks omver trekt.
  const omlaag = (ENDPOINT.match(/ascending:\s*false/g) || []).length;
  const limieten = (ENDPOINT.match(/\.limit\(perBron\)/g) || []).length;
  assert.equal(omlaag, 5, 'elke bron hoort nieuwste-eerst te zijn');
  assert.equal(limieten, 5, 'elke bron hoort een limiet te hebben');
});

test('de grens is kleiner-of-gelijk, nooit kleiner-dan', () => {
  // Bij mail is de tijdstempel op de seconde nauwkeurig. Met kleiner-dan
  // verdwijnt een bericht dat op dezelfde seconde als de bladzijdegrens staat,
  // en dat merk je nooit.
  assert.equal((ENDPOINT.match(/\.lte\(/g) || []).length, 5);
  assert.doesNotMatch(ENDPOINT, /\.lt\(/);
});

test('de grens gaat door leesGrens, zodat onzin niet "dan maar alles" wordt', () => {
  assert.match(ENDPOINT, /leesGrens\(q\.voor\)/);
});

test('het endpoint vertelt of er nog meer is', () => {
  // Zonder dit kan het scherm het verschil niet zien tussen "dit is het hele
  // gesprek" en "dit is het staartje".
  assert.match(ENDPOINT, /heeft_meer:/);
  assert.match(ENDPOINT, /oudste_at:/);
});

// ── het scherm ──────────────────────────────────────────────────────────────

test('het scherm bewaart wat het endpoint over de bladzijde zegt', () => {
  assert.match(SCHERM, /bag\.heeftMeer\s*=\s*!!j\?\.heeft_meer/);
  assert.match(SCHERM, /bag\.oudsteAt\s*=\s*j\?\.oudste_at/);
});

test('de knop zit achter de vlag', () => {
  const i = SCHERM.indexOf('function _inboxOuderKnopHtml');
  assert.ok(i > 0, 'de knop-functie hoort te bestaan');
  const body = SCHERM.slice(i, i + 400);
  assert.match(body, /const gv = _gv2\(\);/);
  assert.match(body, /if \(!gv\) return '';/);
});

test('de knop verschijnt alleen als er echt meer is', () => {
  // Een knop die niets oplevert is erger dan geen knop: je klikt, er gebeurt
  // niets, en je gaat twijfelen aan de rest van het scherm.
  const i = SCHERM.indexOf('function _inboxOuderKnopHtml');
  const body = SCHERM.slice(i, i + 600);
  assert.match(body, /!bag\.heeftMeer \|\| bag\.ouderEind/);
});

test('bij oudere berichten springt de draad NIET naar onder', () => {
  // Er komt inhoud BOVEN je te staan. De gewone repaint springt omlaag zodra
  // er berichten bij zijn — dat klopt bij een nieuw bericht en is precies
  // verkeerd hier.
  const i = SCHERM.indexOf('function _repaintInboxThreadBehoudPositie');
  assert.ok(i > 0, 'er hoort een eigen repaint te zijn voor aanwas bovenaan');
  const body = SCHERM.slice(i, i + 800);
  assert.match(body, /scrollTop\s*=\s*topVoor \+ \(el\.scrollHeight - hoogteVoor\)/,
    'de schuifbalk hoort mee te schuiven met de gegroeide hoogte');
  assert.match(body, /threadItemCountByConv/,
    'zonder de telling bij te werken springt de vólgende repaint alsnog omlaag');
});

test('een bladzijde zonder iets nieuws zet de knop uit', () => {
  // De grens is kleiner-of-gelijk, dus het grensbericht komt zelf mee terug.
  // Staat een hele bladzijde op dezelfde tijdstempel, dan komen we niet
  // verder — dan hoort de knop weg, niet eindeloos hetzelfde op te halen.
  const i = SCHERM.indexOf('window.__wbxInboxOuder');
  assert.ok(i > 0);
  const body = SCHERM.slice(i, i + 2000);
  assert.match(body, /nieuweDraadItems\(bag\.items, binnen\)/);
  assert.match(body, /bag\.ouderEind = true/);
});

test('twee keer tegelijk klikken haalt niet twee keer op', () => {
  const i = SCHERM.indexOf('window.__wbxInboxOuder');
  const body = SCHERM.slice(i, i + 700);
  assert.match(body, /bag\.ouderOp/);
});

test('een mislukte ophaling laat de draad staan die je al had', () => {
  const i = SCHERM.indexOf('window.__wbxInboxOuder');
  const body = SCHERM.slice(i, i + 2000);
  assert.match(body, /finally\s*\{/, 'de bezig-vlag moet hoe dan ook terug');
});
