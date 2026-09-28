// tests/iris-opdracht-snelknoppen.test.js
//
// Wat kan ik Iris eigenlijk vragen? (O-3)
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Het invoerveld had één voorbeeld in de placeholder en verder niets. Wat Iris
// kan stond wél uitgeschreven -- in de systeemtekst van _lib/iris/opdracht.js
// -- maar die lijst gaat naar het taalmodel en niet naar de mens die ervoor
// zit. Het model wéét wat het kan; jij moest het raden.
//
// Nog scherper: van de tien staptypes zijn er VIJF die bij uitvoering meteen
// een fout gooien. Vraag je iets dat daarop uitkomt, dan kreeg je een plan,
// drukte je op Uitvoeren, en hoorde je pas dán dat de stap niet bestaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STAPTYPES,
  WERKENDE_STAPTYPES,
  NIET_VIA_OPDRACHT,
  GEREEDSCHAP_SCHEMA,
  SYSTEEM_TEKST,
  keurPlan,
} from '../api/_lib/iris/opdracht.js';
import { SNELKNOPPEN, NIET_HIER_TEKST } from '../api/_lib/iris/opdracht-tekst.js';

const ACTIE = readFileSync(new URL('../api/iris-actie.js', import.meta.url), 'utf8');

// ── de lijst gelijk houden aan de werkelijkheid ──────────────────────────────

test('elk staptype in NIET_VIA_OPDRACHT gooit ook echt een fout in voerUit', () => {
  // Dit is de test die de twee bestanden aan elkaar knoopt. Zonder deze test is
  // NIET_VIA_OPDRACHT een lijst die iemand ooit heeft opgeschreven; mét deze
  // test is het een bewering over de code die ernaast staat.
  const i = ACTIE.indexOf('async function voerUit');
  const blok = ACTIE.slice(i);
  for (const t of NIET_VIA_OPDRACHT) {
    const j = blok.indexOf(`case '${t}':`);
    assert.ok(j > 0, `${t} heeft geen case in voerUit`);
    // De eerstvolgende regel na de case-groep moet een throw zijn. We kijken
    // tot de volgende case of het einde van het blok.
    const rest = blok.slice(j);
    const tot = rest.indexOf('\n\n');
    assert.match(rest.slice(0, tot > 0 ? tot : 300), /throw new Error/, `${t} lijkt wél uitvoerbaar`);
  }
});

test('elk WERKEND staptype heeft een case die GEEN directe fout gooit', () => {
  // De andere kant op: wordt er iets ingebouwd en blijft het in
  // NIET_VIA_OPDRACHT staan, dan is de lijst te streng en stelt Iris iets niet
  // voor dat allang kan.
  const i = ACTIE.indexOf('async function voerUit');
  const blok = ACTIE.slice(i);
  for (const t of WERKENDE_STAPTYPES) {
    const j = blok.indexOf(`case '${t}': {`);
    assert.ok(j > 0, `${t} heeft geen uitvoerbare case in voerUit`);
  }
});

test('de twee lijsten samen zijn alle staptypes, zonder overlap', () => {
  assert.equal(WERKENDE_STAPTYPES.length + NIET_VIA_OPDRACHT.length, STAPTYPES.length);
  for (const t of WERKENDE_STAPTYPES) assert.ok(!NIET_VIA_OPDRACHT.includes(t));
  for (const t of NIET_VIA_OPDRACHT) assert.ok(STAPTYPES.includes(t), `${t} bestaat niet`);
});

// ── wat het model nog mag voorstellen ────────────────────────────────────────

test('het model krijgt alleen de werkende stappen als keuze', () => {
  // Staat een niet-uitvoerbaar type nog in de enum, dan mag het model hem
  // voorstellen -- en dan loopt het plan bij Uitvoeren alsnog stuk.
  const enumLijst = GEREEDSCHAP_SCHEMA.properties.stappen.items.properties.type.enum;
  assert.deepEqual([...enumLijst].sort(), [...WERKENDE_STAPTYPES].sort());
  for (const t of NIET_VIA_OPDRACHT) {
    assert.ok(!enumLijst.includes(t), `${t} staat nog in de enum`);
  }
});

test('de systeemtekst noemt de niet-werkende stappen niet als beschikbaar', () => {
  const i = SYSTEEM_TEKST.indexOf('Beschikbare stappen:');
  assert.ok(i > 0);
  const tot = SYSTEEM_TEKST.indexOf('Wat je NIET kunt', i);
  const blok = SYSTEEM_TEKST.slice(i, tot);
  for (const t of NIET_VIA_OPDRACHT) {
    assert.ok(!blok.includes(t), `${t} staat nog bij de beschikbare stappen`);
  }
  for (const t of WERKENDE_STAPTYPES) {
    assert.ok(blok.includes(t), `${t} ontbreekt bij de beschikbare stappen`);
  }
});

test('de systeemtekst zegt wat er dan WEL moet bij een bericht', () => {
  // Alleen weglaten is niet genoeg: dan verzint het model iets anders. Er moet
  // staan wat het in plaats daarvan moet doen.
  assert.match(SYSTEEM_TEKST, /via de Post/);
  assert.match(SYSTEEM_TEKST, /begrepen/);
});

test('keurPlan gooit een niet-uitvoerbare stap weg en zegt dat erbij', () => {
  const r = keurPlan({
    titel: 'Bericht sturen',
    begrepen: 'Kevin een bericht sturen.',
    stappen: [
      { type: 'wa_versturen', omschrijving: 'Kevin appen' },
      { type: 'taak_aanmaken', omschrijving: 'Taak voor Dave' },
    ],
    raakt_groep: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan.stappen.length, 1, 'alleen de uitvoerbare stap blijft');
  assert.equal(r.plan.stappen[0].type, 'taak_aanmaken');
  // Stil weggooien zou erger zijn: dan is het plan korter dan Iris bedoelde en
  // niemand weet waarom. Het komt in geweigerde_stappen en dus in het verloop.
  assert.deepEqual(r.plan.geweigerde_stappen, ['wa_versturen']);
});

// ── de knoppen ───────────────────────────────────────────────────────────────

test('elke snelknop leunt op iets dat ook echt kan', () => {
  for (const k of SNELKNOPPEN) {
    assert.ok(WERKENDE_STAPTYPES.includes(k.staptype), `${k.staptype} kan niet uitgevoerd worden`);
  }
});

test('elk werkend staptype heeft een snelknop', () => {
  // De forcerende kant: wordt lms_uitnodiging ooit ingebouwd, dan valt hij uit
  // NIET_VIA_OPDRACHT, wordt hij een werkend type, en faalt deze test tot er
  // een knop bij staat. Zonder dat zou de knoppenrij stilletjes achterlopen op
  // wat Iris inmiddels kan.
  const gedekt = new Set(SNELKNOPPEN.map((k) => k.staptype));
  for (const t of WERKENDE_STAPTYPES) assert.ok(gedekt.has(t), `${t} heeft geen snelknop`);
});

test('de knopteksten zijn HALVE zinnen', () => {
  // Een hele zin nodigt uit om te versturen wat er staat. Een halve dwingt je
  // de naam en de reden zelf in te vullen -- en die mag Iris nooit verzinnen.
  for (const k of SNELKNOPPEN) {
    assert.ok(k.tekst.length > 5, `${k.staptype} heeft geen tekst`);
    assert.match(k.tekst, /[ :]$/, `"${k.tekst}" leest als een afgemaakte zin`);
    assert.doesNotMatch(k.tekst, /\.$/, `"${k.tekst}" eindigt op een punt`);
  }
});

test('geen knoptekst bevat een verzonnen naam, bedrag of datum', () => {
  // Iris mag niets verzinnen, en een voorbeeldzin met "Sarah" erin nodigt uit
  // om die naam te laten staan.
  for (const k of SNELKNOPPEN) {
    assert.doesNotMatch(k.tekst, /\d/, `"${k.tekst}" bevat een getal`);
    assert.doesNotMatch(k.tekst, /€/, `"${k.tekst}" bevat een bedrag`);
  }
});

test('elke knop heeft een label dat niet als sleutel leest', () => {
  for (const k of SNELKNOPPEN) {
    assert.ok(k.label, `${k.staptype} heeft geen label`);
    assert.ok(!k.label.includes('_'), `${k.label} leest nog als een sleutel`);
    // Een knop moet op één regel passen naast vier andere. Langer dan dit en de
    // rij valt uit elkaar op een smal scherm.
    assert.ok(k.label.length <= 30, `${k.label} is te lang voor een knop`);
  }
});

test('er staat een regel onder die zegt wat hier NIET kan', () => {
  // Zonder die regel is de enige manier om erachter te komen: het vragen, een
  // plan krijgen, en bij Uitvoeren stuklopen.
  assert.match(NIET_HIER_TEKST, /Post/);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const ENDPOINT = readFileSync(new URL('../api/iris-opdracht.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');

test('de lijst stuurt de knoppen mee', () => {
  const i = ENDPOINT.indexOf('async function geefLijst');
  const blok = ENDPOINT.slice(i, ENDPOINT.indexOf('\n}', i));
  assert.match(blok, /snelknoppen: SNELKNOPPEN/);
  assert.match(blok, /niet_hier: NIET_HIER_TEKST/);
});

test('het scherm houdt geen eigen lijst bij', () => {
  // Een tweede lijst in de browser zou uit de pas lopen met wat er echt kan,
  // en dat is precies het probleem dat O-3 oplost.
  assert.match(SCHERM, /st\.snelknoppen = Array\.isArray\(j\.snelknoppen\)/);
  assert.doesNotMatch(SCHERM, /lms_toegang_verlengen'\s*,\s*label/);
});

test('de knop geeft een INDEX door, geen tekst in een attribuut', () => {
  // Een string in een HTML-attribuut betekent aanhalingstekens ontsnappen in
  // een taal die dat zelf ook doet -- zie de les over JSON.stringify in
  // attributen in CLAUDE.md.
  const i = SCHERM.indexOf('function snelknoppen()');
  assert.ok(i > 0);
  const blok = SCHERM.slice(i, i + 1200);
  assert.match(blok, /__irisOpdrachtVoorbeeld\(\$\{i\}\)/);
  assert.doesNotMatch(blok, /JSON\.stringify/);
});

test('een snelknop overschrijft nooit wat er al staat', () => {
  // Wie halverwege een zin op een knop drukt, is die zin anders kwijt.
  const i = SCHERM.indexOf('window.__irisOpdrachtVoorbeeld');
  const blok = SCHERM.slice(i, i + 1200);
  assert.match(blok, /if \(staat\.trim\(\)\)/);
  assert.match(blok, /return;/);
});

test('de cursor gaat na het vullen naar het einde van het veld', () => {
  // Zonder dit staat de tekst er wel, maar typt de volgende toetsaanslag
  // ergens anders -- het veld is door het hertekenen een nieuw element.
  const i = SCHERM.indexOf('window.__irisOpdrachtVoorbeeld');
  const blok = SCHERM.slice(i, i + 1400);
  assert.match(blok, /selectionStart = veld\.selectionEnd = veld\.value\.length/);
});
