// tests/iris-polish-h5-h10.test.js
//
// Vijf kleine dingen uit de walkthrough. Klein in code, niet klein in gebruik:
// een afgekapte uitleg, een knop onder de vouw en een logboek van honderd keer
// hetzelfde woord zijn allemaal manieren waarop een scherm je iets níét
// vertelt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const IRIS = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const WBX = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../docs/sql-migrations/2026-09-21-iris-fase1-datamodel.sql', import.meta.url), 'utf8');

// ── H5 — de stand in gewone taal ────────────────────────────────────────────

test('H5: de gesprekskop toont een label, niet de databankwaarde', () => {
  // Er stond "wacht_op_ons", met liggend streepje, terwijl de filterpil
  // eronder "Wacht op ons" zei. Twee namen voor hetzelfde ding op één scherm
  // is hoe je gaat twijfelen of het wel hetzelfde ding is.
  assert.match(IRIS, /const STAND_LABELS = \{/);
  assert.match(IRIS, /\$\{esc\(STAND_LABELS\[g\.status\] \|\| g\.status \|\| ''\)\}/);
  assert.doesNotMatch(IRIS, /\$\{esc\(g\.status \|\| ''\)\}/, 'de ruwe waarde hoort er niet meer te staan');
});

test('H5: alle vijf standen uit de CHECK hebben een label', () => {
  // Ontbreekt er één, dan valt die terug op de databankwaarde en is het gat
  // terug voor precies dat geval — en dat merk je pas als een gesprek in die
  // stand staat.
  const check = SQL.match(/CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(check, 'de CHECK op iris_gesprekken.status hoort vindbaar te zijn');
  const standen = check[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(standen, ['nieuw', 'wacht_op_ons', 'wacht_op_klant', 'belofte_loopt', 'geregeld']);
  const blok = IRIS.slice(IRIS.indexOf('const STAND_LABELS = {'), IRIS.indexOf('const CATEGORIE_LABELS'));
  for (const stand of standen) {
    assert.match(blok, new RegExp(`\\b${stand}:`), `${stand} hoort een label te hebben`);
  }
});

// ── H6 — de schrijfbalk onder de vouw ───────────────────────────────────────

test('H6: de draad kan krimpen, dus de schrijfbalk blijft in beeld', () => {
  // In een flex-kolom is de standaard min-height:auto, en dan WEIGERT een vak
  // met flex:1 kleiner te worden dan zijn inhoud. De draad groeide door en
  // duwde de schrijfbalk onder de vouw; bij 801 px hoog was die niet meer te
  // zien. De regel staat al in de CSS van .iris-post, maar die geldt alleen
  // voor directe kinderen — dit vak zit een laag dieper.
  assert.match(IRIS, /<div style="flex:1;min-height:0;overflow-y:auto;padding:12px 14px">\$\{draad\}<\/div>/);
  assert.doesNotMatch(IRIS, /<div style="flex:1;overflow-y:auto;padding:12px 14px">\$\{draad\}/);
  // En in de gesprekken-module net zo: zelfde constructie, zelfde val.
  assert.match(WBX, /id="wbxInboxThreadScroll" style="flex:1;min-height:0;overflow-y:auto/);
});

// ── H7 — de afgekapte placeholder ───────────────────────────────────────────

test('H7: de placeholder past in het veld', () => {
  // "Zoek op naam of e-mailadres…" werd "Zoek op naam of e-n". Een afgekapte
  // uitleg legt niets uit.
  assert.match(IRIS, /placeholder="Zoek op naam of e-mail"/);
  assert.match(IRIS, /title="Zoek op naam of e-mailadres"/, 'de volledige tekst blijft in de title');
  assert.doesNotMatch(IRIS, /placeholder="Zoek op naam of e-mailadres…"/);
});

// ── H8 — het logboek zei honderd keer hetzelfde ─────────────────────────────

test('H8: een logregel zegt wat die ronde deed', () => {
  // Honderd keer het woord "werkronde" is geen logboek, dat is een hartslag —
  // en een hartslag die honderd regels kost, verbergt de drie regels waar je
  // naar zocht. De gegevens stonden al in `details`; het scherm keek er niet
  // naar.
  assert.match(IRIS, /function logRegelTekst\(r\)/);
  assert.match(IRIS, /\$\{esc\(wat\)\}/);
  assert.doesNotMatch(IRIS, /\$\{esc\(r\.wat \|\| '—'\)\}/, 'de kale wat-waarde hoort er niet meer te staan');
});

test('H8: nullen worden weggelaten, en enkelvoud is enkelvoud', async () => {
  // Een regel die "0 mails opgenomen, 0 gesprekken ingedeeld" zegt, is net zo
  // leeg als "werkronde" — alleen langer.
  //
  // De functie zit in een IIFE, dus hij wordt hier nagespeeld op precies de
  // tekst uit het bestand. Verandert die, dan verandert deze toets mee; dat is
  // de bedoeling, want de uitkomst is wat er op het scherm komt.
  const i = IRIS.indexOf('function logRegelTekst(r)');
  const eind = IRIS.indexOf('\n  }', IRIS.indexOf("return wat + ' · '", i));
  const bron = IRIS.slice(i, eind + 4);
  // eslint-disable-next-line no-new-func
  const logRegelTekst = new Function(`${bron}; return logRegelTekst;`)();

  assert.equal(
    logRegelTekst({ wat: 'werkronde', details: { opgenomen_mail: 3, opgenomen_wa: 0, ingedeeld: 1 } }),
    'werkronde · 3 mails opgenomen, 1 gesprek ingedeeld',
  );
  assert.equal(
    logRegelTekst({ wat: 'werkronde', details: { opgenomen_mail: 1 } }),
    'werkronde · 1 mail opgenomen',
  );
  // Alles nul: dan is "niets te doen" de informatie, en niet een rij nullen.
  assert.equal(
    logRegelTekst({ wat: 'werkronde', details: { opgenomen_wa: 0, fouten: [] } }),
    'werkronde · niets te doen',
  );
  // Geen details: dan valt hij terug op wat er staat.
  assert.equal(logRegelTekst({ wat: 'concept geschreven' }), 'concept geschreven');
  assert.equal(logRegelTekst({ wat: 'x', details: 'rommel' }), 'x');
  assert.equal(logRegelTekst({}), '—');
});

test('H8: het endpoint geeft details al mee — er hoeft niets bij', () => {
  const LOG = readFileSync(new URL('../api/iris-log.js', import.meta.url), 'utf8');
  assert.match(LOG, /\.select\('id, wanneer, wie, wat, contact_id, gesprek_id, kanaal, resultaat, fout, details'\)/);
});

// ── H10 — de draad sprong terug bij een kanaalwissel ────────────────────────

test('H10: een kanaalwissel hertekent alleen de schrijfbalk', () => {
  // De volle DFO.render() vervangt #wbxInboxThreadScroll, en een nieuwe node
  // begint op scrollTop 0 — dus sprong de draad terug naar 9 september. Een
  // kanaalwissel verandert alleen de schrijfbalk.
  const i = WBX.indexOf('window.__wbxInboxToggleChannel = (ch) =>');
  const blok = WBX.slice(i, WBX.indexOf('\n  };', i));
  assert.match(blok, /_repaintInboxCompose\(\)/);
  assert.match(WBX, /function _repaintInboxCompose\(\)/);
  assert.match(WBX, /<div id="wbxInboxCompose" style="min-width:0">/, 'de schrijfbalk heeft een eigen node nodig');
  // En een terugval, want niets doen is erger dan te veel hertekenen.
  assert.match(blok, /if \(!_repaintInboxCompose\(\)\) \{/);
  assert.match(blok, /window\.DFO\?\.render\?\.\(\)/);
});

// ── en de nummers ───────────────────────────────────────────────────────────

test('beide gewijzigde schermen hebben een nieuw nummer', () => {
  // Zonder bump laadt de browser de oude kopie en is de reparatie er voor
  // niemand. Het GETAL pinnen is wel een val: dan valt deze toets om op
  // precies de bump die hij zelf eist, zodra er een volgende PR langskomt.
  // Dus: een bump, niet een getal.
  assert.match(INDEX, /\.\.\/iris\/iris\.js\?v=(2[4-9]|[3-9]\d)/);
  assert.match(INDEX, /views\/wanbetalers-v2\.js\?v=(6[7-9]|[7-9]\d)/);
});

// ── H11 — kandidaat, geen bewezen fix ───────────────────────────────────────

test('H11-kandidaat: de schrijfbalk mag krimpen', () => {
  // Derde keer dezelfde val in dit bestand: in een flexkolom is de standaard
  // min-*:auto, en dan WEIGERT een vak kleiner te worden dan zijn inhoud.
  //
  // Bij een dicht 24-uursvenster rendert de schrijfbalk een <select> met de
  // templatelijst, en de breedte van een <select> wordt bepaald door zijn
  // langste optietekst ("<naam> · UTILITY"). De middenkolom mág krimpen
  // (min-width:0), zijn inhoud niet — dus loopt die over en wordt het
  // rechterpaneel uit beeld geduwd.
  //
  // Dit is een KANDIDAAT. Het ⋮-paneel is position:absolute en kan de
  // kolommen niet verzetten, en de buitenste rij heeft geen flex-wrap met
  // minima 260+0+260 — dus wrappen kan hij niet. Deze regel haalt de enige
  // oorzaak weg die ik uit de bron kan aanwijzen; gebeurt het daarna nog,
  // dan weten we dat het de select niet was.
  assert.match(WBX, /id="wbxInboxCompose" style="min-width:0"/);
  // En de middenkolom zelf had hem al — anders zou krimpen daar al stoppen.
  assert.match(WBX, /<div style="flex:1;display:flex;flex-direction:column;min-width:0">/);
});

// ── H9-nasleep: een vlag die uit staat, zegt dat ────────────────────────────

test('Instellingen zegt of gesprekken-v2 aan of uit staat', () => {
  // H9 kostte een halve zoektocht: de microfoon uit G1 was er in productie
  // niet, het script was geladen, de functie bestond — en niemand kon zien
  // dat GESPREKKEN_V2 de oorzaak was, want de knop verdwijnt gewoon als die
  // vlag uit staat.
  //
  // Een feature die uit staat zonder dat iets dat zegt, is de stilste storing
  // die er is. Daarom staat het nu op het scherm waar je opzoekt hoe het
  // ingesteld staat, naast de andere hoofdschakelaar.
  const ENDPOINT = readFileSync(new URL('../api/iris-instellingen.js', import.meta.url), 'utf8');
  assert.match(ENDPOINT, /import \{ gesprekkenV2Aan \} from '\.\/_lib\/gesprekken-vlag\.js';/);
  assert.match(ENDPOINT, /gesprekken_v2: gesprekkenV2Aan\(\),/);

  assert.match(IRIS, /Gesprekken-v2 staat aan/);
  assert.match(IRIS, /Gesprekken-v2 staat uit/);
  // En het zegt WAAR de schakelaar staat plus wat je mist — anders weet je nog
  // niet wat je eraan kunt doen.
  assert.match(IRIS, /GESPREKKEN_V2 staat uit in Vercel/);
  assert.match(IRIS, /geen microfoon/);
  // De regel staat ook echt in de tab, niet alleen gedefinieerd.
  assert.match(IRIS, /\$\{hoofd\}\s*\n\s*\$\{gv2\}/);
});

test('de vlag wordt op één plek gelezen, ook hier', () => {
  // gesprekken-vlag.js is met opzet de enige plek die GESPREKKEN_V2 leest.
  // Dit endpoint mag daar geen tweede lezing naast zetten.
  const ENDPOINT = readFileSync(new URL('../api/iris-instellingen.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ENDPOINT, /process\.env\.GESPREKKEN_V2/);
});
