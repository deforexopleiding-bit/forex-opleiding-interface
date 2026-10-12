// tests/iris-belrij-escalatie-concept.test.js
//
// Taak 6, deel 3 (schrijfkant) — van "drie keer niet opgenomen" naar een
// concept in de Post.
//
// Het mandaat (welke poorten, in welke volgorde) staat in
// iris-belrij-escalatie.test.js. Hier gaat het over wat er daarna gebeurt: WELK
// gesprek, WELK kanaal, WELKE tekst, en wat er in de databank belandt.
//
// ── WAAR DE RISICO'S ZITTEN ─────────────────────────────────────────────────
// Dit is een derde weg naar de klant, naast de Post en de gesprekken-module.
// Drie dingen mogen dus NIET kunnen, en op alle drie staat hier een toets:
//   1. een bericht naar de verkeerde persoon, doordat er op een gesprek gegokt
//      wordt als een contact er meerdere heeft;
//   2. een bedrag, factuurnummer of datum in de tekst die niemand nagekeken
//      heeft -- vandaar vaste tekst en geen LLM-aanroep;
//   3. een bericht bij een opzegging of klacht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEKST, VENSTER_MS, kiesGesprek, vensterOpen, bouwConcepten, metStand,
} from '../api/_lib/iris/belrij-escalatie-concept.js';
import { ESCALATIE_TEMPLATE } from '../api/_lib/iris/templates.js';
import { NOOIT_ZELF, leesBelrijEscalatie, BELRIJ_BRONNEN } from '../api/_lib/iris/instellingen.js';
import { keurWaardeGoed, TOEGESTANE_SLEUTELS } from '../api/iris-instellingen.js';
import { eersteNaam } from '../api/_lib/iris/belrij-escalatie-ronde.js';

const RONDE = readFileSync(new URL('../api/_lib/iris/belrij-escalatie-ronde.js', import.meta.url), 'utf8');
const CRON  = readFileSync(new URL('../api/cron-iris-werk.js', import.meta.url), 'utf8');
const IRIS  = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
const CONCEPT = readFileSync(new URL('../api/_lib/iris/belrij-escalatie-concept.js', import.meta.url), 'utf8');

const codeVan = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');

const C_RONDE = codeVan(RONDE);
const C_CRON  = codeVan(CRON);
const C_IRIS  = codeVan(IRIS);
const C_CONCEPT = codeVan(CONCEPT);

const NU = new Date('2026-10-12T12:00:00Z');
const wa = (extra = {}) => ({ id: 'g-wa', kanaal: 'whatsapp', categorie: 'wanbetaling_reactie', laatste_inbound: null, ...extra });
const mail = (extra = {}) => ({ id: 'g-mail', kanaal: 'email', categorie: 'wanbetaling_reactie', ...extra });
const goedgekeurd = [{ name: ESCALATIE_TEMPLATE, status: 'APPROVED', category: 'UTILITY', language: 'nl' }];

/* ── 1. nooit gokken op wie iemand is ─────────────────────────────────────── */

test('één gesprek: dat is het', () => {
  assert.equal(kiesGesprek([wa()]).gesprek.id, 'g-wa');
  assert.equal(kiesGesprek([mail()]).gesprek.id, 'g-mail');
});

test('één WhatsApp en één mail: WhatsApp, want daar tikt het venster', () => {
  const uit = kiesGesprek([mail(), wa()]);
  assert.equal(uit.gesprek.id, 'g-wa');
  assert.equal(uit.reden, null);
});

test('twee gesprekken op hetzelfde kanaal: GEEN keuze, met een leesbare reden', () => {
  const uit = kiesGesprek([wa({ id: 'a' }), wa({ id: 'b' })]);
  assert.equal(uit.gesprek, null);
  assert.match(uit.reden, /2 WhatsApp-gesprekken/);

  const m = kiesGesprek([mail({ id: 'a' }), mail({ id: 'b' })]);
  assert.equal(m.gesprek, null);
  assert.match(m.reden, /2 mailgesprekken/);
});

test('geen gesprek: geen concept, want gesprek_id is NOT NULL', () => {
  assert.equal(kiesGesprek([]).gesprek, null);
  assert.equal(kiesGesprek(null).gesprek, null);
  assert.deepEqual(bouwConcepten({ gesprek: null }).rijen, []);
});

test('de ronde laat een rij staan in plaats van te gokken welk gesprek het is', () => {
  assert.match(C_RONDE, /if \(!gesprek\) \{[\s\S]{0,200}?poort = 'geen_gesprek'/);
});

/* ── 2. geen verzonnen feiten ─────────────────────────────────────────────── */

test('in de teksten staat geen bedrag, geen factuurnummer en geen datum', () => {
  for (const tekst of [TEKST.whatsapp_in_venster('Jeffrey'), TEKST.mail_tekst('Jeffrey'), TEKST.mail_onderwerp]) {
    assert.ok(!/€|\beuro\b|\bfactuur\s*nummer|\b\d{1,2}[-/]\d{1,2}\b/i.test(tekst), `verzonnen feit in: ${tekst}`);
    assert.ok(!/\[invullen\]/.test(tekst), 'een gat in een tekst die zo de deur uit kan');
    assert.ok(!/undefined|null|NaN/.test(tekst));
  }
});

test('zonder naam valt de aanhef weg, en wordt het geen "Hoi undefined"', () => {
  for (const leeg of [null, undefined, '']) {
    assert.match(TEKST.whatsapp_in_venster(leeg), /^Hoi, we hebben je/);
    assert.match(TEKST.mail_tekst(leeg), /^Hoi,\n/);
  }
  assert.match(TEKST.whatsapp_in_venster('Dave'), /^Hoi Dave, /);
});

test('er wordt geen model aangeroepen voor deze tekst', () => {
  // Een "we proberen je te bereiken"-bericht is elke keer hetzelfde bericht.
  for (const verboden of ['anthropic', 'Anthropic', 'schrijfConcept', 'ANTHROPIC']) {
    assert.ok(!C_CONCEPT.includes(verboden), `de conceptbouwer roept ${verboden} aan`);
    assert.ok(!C_RONDE.includes(verboden), `de ronde roept ${verboden} aan`);
  }
});

test('alleen de voornaam in de aanhef, en nooit een mailadres', () => {
  assert.equal(eersteNaam('Jeffrey Biemold'), 'Jeffrey');
  assert.equal(eersteNaam('  Dave  '), 'Dave');
  assert.equal(eersteNaam('iemand@ergens.nl'), null, 'een mailadres als aanhef');
  assert.equal(eersteNaam(''), null);
  assert.equal(eersteNaam(null), null);
  assert.equal(eersteNaam('x'.repeat(50)), null, 'een onzinnig lange "naam"');
});

/* ── 3. nooit bij een klacht of opzegging ─────────────────────────────────── */

test('een opzegging of klacht levert geen enkel concept op', () => {
  for (const cat of NOOIT_ZELF) {
    const uit = bouwConcepten({ gesprek: wa({ categorie: cat }), email: 'a@b.nl', nu: NU });
    assert.deepEqual(uit.rijen, [], `${cat} kreeg toch een concept`);
    assert.match(uit.overgeslagen[0], /opzegging of klacht/);
  }
});

/* ── het venster en de template ───────────────────────────────────────────── */

test('binnen het venster: vrije tekst, geen template', () => {
  const uit = bouwConcepten({ gesprek: wa({ laatste_inbound: new Date(NU.getTime() - 3600_000).toISOString() }), nu: NU });
  assert.equal(uit.rijen.length, 1);
  assert.equal(uit.rijen[0].kanaal, 'whatsapp');
  assert.equal(uit.rijen[0].template_naam, null);
  assert.ok(uit.rijen[0].tekst);
});

test('buiten het venster: de goedgekeurde escalatie-template', () => {
  const uit = bouwConcepten({
    gesprek: wa({ laatste_inbound: new Date(NU.getTime() - 2 * VENSTER_MS).toISOString() }),
    naam: 'Dave', templates: goedgekeurd, nu: NU,
  });
  assert.equal(uit.rijen[0].template_naam, ESCALATIE_TEMPLATE);
  assert.equal(uit.rijen[0].tekst, null);
  assert.deepEqual(uit.rijen[0].template_vars, { 1: 'Dave' });
});

test('buiten het venster zonder goedgekeurde template: GEEN WhatsApp', () => {
  // Een bericht forceren in een template die er niet over gaat is erger dan
  // een dag wachten. Zelfde regel als in templates.js.
  const dicht = wa({ laatste_inbound: new Date(NU.getTime() - 2 * VENSTER_MS).toISOString() });
  for (const niet of [[], [{ name: ESCALATIE_TEMPLATE, status: 'PAUSED' }], [{ name: ESCALATIE_TEMPLATE, status: 'APPROVED', category: 'MARKETING' }]]) {
    const uit = bouwConcepten({ gesprek: dicht, templates: niet, nu: NU });
    assert.ok(!uit.rijen.some((r) => r.kanaal === 'whatsapp'), `template ${JSON.stringify(niet)} werd toch gebruikt`);
    assert.ok(uit.overgeslagen.some((o) => /venster is dicht/.test(o)));
  }
});

test('zonder inkomend bericht staat het venster DICHT', () => {
  // Niet open-bij-twijfel: dan gaat er vrije tekst weg waar Meta een template eist.
  assert.equal(vensterOpen(wa()), false);
  assert.equal(vensterOpen(wa({ laatste_inbound: 'gisteren' })), false);
  assert.equal(vensterOpen(wa({ laatste_inbound: new Date(NU.getTime() + 3600_000).toISOString() }), NU), false);
});

test('de grens van het venster ligt op 24 uur', () => {
  const net = new Date(NU.getTime() - VENSTER_MS + 60_000).toISOString();
  const over = new Date(NU.getTime() - VENSTER_MS - 60_000).toISOString();
  assert.equal(vensterOpen(wa({ laatste_inbound: net }), NU), true);
  assert.equal(vensterOpen(wa({ laatste_inbound: over }), NU), false);
});

test('de mail gaat erbij als er een adres is, ook binnen het venster', () => {
  const uit = bouwConcepten({
    gesprek: wa({ laatste_inbound: new Date(NU.getTime() - 3600_000).toISOString() }),
    email: 'a@b.nl', nu: NU,
  });
  assert.deepEqual(uit.rijen.map((r) => r.kanaal), ['whatsapp', 'email']);
  assert.equal(uit.rijen[1].onderwerp, TEKST.mail_onderwerp);
});

test('een mailgesprek zonder adres levert niets op, met uitleg', () => {
  const uit = bouwConcepten({ gesprek: mail(), nu: NU });
  assert.deepEqual(uit.rijen, []);
  assert.match(uit.overgeslagen[0], /zonder adres/);
});

/* ── wat er in de databank belandt ────────────────────────────────────────── */

test("stand 'concept' blijft op klaar staan en wacht op een mens", () => {
  const r = metStand({ gesprek_id: 'g', kanaal: 'email' }, { doen: 'concept', nu: NU });
  assert.equal(r.status, 'klaar');
  assert.equal(r.verstuur_na, null);
});

test("stand 'zelf' gaat als goedgekeurd met een verstuur_na — langs de BESTAANDE cron", () => {
  // Geen tweede verzendweg betekent geen tweede plek waar de
  // claim-voor-versturen van G2 vergeten kan worden.
  const r = metStand({ gesprek_id: 'g', kanaal: 'email' }, { doen: 'zelf', ongedaanSeconden: 30, nu: NU });
  assert.equal(r.status, 'goedgekeurd');
  assert.equal(new Date(r.verstuur_na).getTime() - NU.getTime(), 30_000);
});

test('een onzinnige ongedaan-tijd wordt niet nul seconden', () => {
  for (const ruw of [0, -5, null, 'x', undefined]) {
    const r = metStand({ gesprek_id: 'g' }, { doen: 'zelf', ongedaanSeconden: ruw, nu: NU });
    const sec = (new Date(r.verstuur_na).getTime() - NU.getTime()) / 1000;
    assert.ok(sec >= 5, `${ruw} gaf ${sec} seconden`);
  }
});

test('de ronde verstuurt zelf niets', () => {
  for (const verboden of ['verstuurConcept', 'metaPostMessage', 'leverAfBijMeta', 'sendMail']) {
    assert.ok(!C_RONDE.includes(verboden), `de ronde raakt ${verboden} aan`);
  }
});

/* ── de poorten die de databank nodig hebben ──────────────────────────────── */

test('een tweede concept naast een eerste dat nog klaarstaat kan niet', () => {
  assert.match(C_RONDE, /\.in\('status', \['klaar', 'goedgekeurd'\]\)/);
});

test('de afspraak-poort kijkt naar beide bronnen en is fail-CLOSED', () => {
  // Wie een regeling heeft en zich eraan houdt, hoort geen "we proberen je te
  // bereiken" te krijgen. Bij twijfel dus NIET sturen.
  assert.match(C_RONDE, /from\('iris_beloftes'\)/);
  assert.match(C_RONDE, /from\('payment_arrangements'\)/);
  assert.match(C_RONDE, /\.eq\('status', 'ACTIEF'\)/);
  const treffers = [...C_RONDE.matchAll(/catch \(e\) \{[\s\S]{0,200}?return true;/g)];
  assert.equal(treffers.length, 2, 'niet beide opvragingen vallen fail-closed terug');
});

test('één rij die omvalt blokkeert de ronde niet', () => {
  assert.match(C_RONDE, /for \(const rij of \(data \|\| \[\]\)\)[\s\S]{0,300}?try \{/);
  assert.match(C_RONDE, /if \(rapport\.fouten\.length < 3\)/);
});

test('per kanaal een eigen try/catch: valt de WhatsApp om, dan blijft de mail', () => {
  assert.match(C_RONDE, /for \(const basis of gebouwd\.rijen\)[\s\S]{0,120}?try \{/);
});

test('de ronde telt per poort, zodat een stille nul-ronde te verklaren is', () => {
  assert.match(C_RONDE, /per_poort\[sleutel\] = \(rapport\.per_poort\[sleutel\] \|\| 0\) \+ 1/);
});

/* ── de instelling ────────────────────────────────────────────────────────── */

test('rommel leest als concept, nooit als zelf', () => {
  const uit = leesBelrijEscalatie({ wanbetaler: 'ZELF STUREN', hand: 'ja' }, { aan: true });
  assert.equal(uit.wanbetaler, 'concept');
  assert.equal(uit.hand, 'concept');
});

test('een bron zonder instelling staat op concept, niet op uit', () => {
  const uit = leesBelrijEscalatie({}, { aan: true });
  for (const b of BELRIJ_BRONNEN) assert.equal(uit[b], 'concept');
});

test('de hoofdschakelaar overrulet zelf naar concept — het werk blijft zichtbaar', () => {
  assert.equal(leesBelrijEscalatie({ wanbetaler: 'zelf' }, { aan: true }).wanbetaler, 'zelf');
  assert.equal(leesBelrijEscalatie({ wanbetaler: 'zelf' }, { aan: false }).wanbetaler, 'concept');
  // 'uit' blijft wel uit: dat is een uitdrukkelijke keuze.
  assert.equal(leesBelrijEscalatie({ wanbetaler: 'uit' }, { aan: false }).wanbetaler, 'uit');
});

test('schrijven: een onbekende stand of bron is een FOUT met uitleg', () => {
  assert.ok(TOEGESTANE_SLEUTELS.has('belrij_escalatie'));
  const stand = keurWaardeGoed('belrij_escalatie', { wanbetaler: 'autonoom' });
  assert.equal(stand.ok, false);
  assert.match(stand.fout, /is geen stand/);
  const bron = keurWaardeGoed('belrij_escalatie', { wanbetalers: 'uit' });
  assert.equal(bron.ok, false);
  assert.match(bron.fout, /onbekende bron/);
});

test('schrijven: een geldige kaart komt genormaliseerd terug', () => {
  const uit = keurWaardeGoed('belrij_escalatie', { wanbetaler: ' UIT ', hand: 'Concept' });
  assert.equal(uit.ok, true);
  assert.deepEqual(uit.waarde, { wanbetaler: 'uit', hand: 'concept' });
});

/* ── de ronde hangt in de cron ────────────────────────────────────────────── */

test('de cron roept de escalatie aan, fail-soft en binnen de tijd', () => {
  assert.match(C_CRON, /import \{ escalatieRonde \}/);
  assert.match(C_CRON, /await escalatieRonde\(supabaseAdmin, \{ opTijd \}\)/);
  assert.match(C_CRON, /catch \(e\) \{[\s\S]{0,80}?meldFout\('escalatie', e\)/);
});

test('de escalatie staat NA het vullen van de belrij', () => {
  // Een concept dat deze ronde klaarstaat, mag pas volgende ronde vertrekken.
  assert.ok(C_CRON.indexOf('vulBelrij(supabaseAdmin') < C_CRON.indexOf('escalatieRonde(supabaseAdmin'));
});

/* ── het scherm ───────────────────────────────────────────────────────────── */

test("'zelf sturen' staat in het scherm, met de gevolgen erbij", () => {
  // Een stand die niet in het scherm staat, moet via SQL gezet worden — en dan
  // staat er iets aan dat niemand kan zien.
  assert.match(IRIS, /function belrijEscalatieBlok\(inst\)/);
  assert.match(IRIS, /zelf sturen/);
  assert.match(IRIS, /tussen\s*\n?\s*8 en 20 uur/);
  assert.match(IRIS, /één bericht per persoon per drie dagen/);
  assert.match(IRIS, /nooit\s*\n?\s*tijdens een lopende betaalafspraak/);
});

test('het scherm zegt het als de hoofdschakelaar uit staat', () => {
  assert.match(IRIS, /De hoofdschakelaar staat uit/);
});

test('de hele kaart gaat als één waarde terug', () => {
  const fn = C_IRIS.slice(C_IRIS.indexOf('window.__irisBelrijEscalatieZet'), C_IRIS.indexOf('function belrijEigenaarBlok'));
  assert.match(fn, /sleutel: 'belrij_escalatie', waarde: nieuw/);
});

test('het blok staat in Instellingen', () => {
  assert.match(IRIS, /\$\{belrijEscalatieBlok\(inst\)\}/);
});

test('het scherm heeft een nieuw nummer', () => {
  const m = INDEX.match(/\.\.\/iris\/iris\.js\?v=(\d+)/);
  assert.ok(m, 'iris.js wordt zonder ?v= geladen');
  assert.ok(Number(m[1]) >= 27, `?v=${m[1]} is lager dan de 27 van deze PR`);
});
