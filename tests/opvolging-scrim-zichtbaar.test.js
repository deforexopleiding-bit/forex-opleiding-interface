// tests/opvolging-scrim-zichtbaar.test.js
//
// Elke scrim in de Opvolging-module moet de klasse `on` dragen.
//
// WAAROM DIT BESTAAT
// Het design system zet in modules/shared/design-system/app-shell.css:
//
//     .scrim   { … opacity:0; pointer-events:none; transition:opacity .22s }
//     .scrim.on{ opacity:1; pointer-events:auto }
//
// De module heeft zijn eigen `.opv .scrim` met position, background, z-index en
// wat maatvoering. Die selector is specifieker (0,2,0 tegen 0,1,0) en wint dus
// — maar alléén voor de eigenschappen die hij noemt. `opacity` en
// `pointer-events` staan er niet in, en voor die twee valt de cascade terug op
// de globale regel. Netto: opacity 0, pointer-events none.
//
// Het gevolg is het vervelendste soort fout. Er gaat niets stuk, er komt geen
// melding, de HTML wordt correct opgebouwd en staat gewoon in de DOM — je ziet
// alleen niets. In DevTools lijkt alles in orde. Zo is het WhatsApp-paneel
// onzichtbaar live gegaan, en bij navraag bleek dezelfde fout al vanaf fase 1 in
// de gedeelde scrim-helper te zitten, waar élk venster van deze module doorheen
// gaat: Wat nu?, een dag kiezen, archiveren, opnieuw inplannen, de historiek en
// het afronden van een call.
//
// Vandaar deze test in plaats van een opmerking in de code: een klasse die
// nergens iets lijkt te doen, wordt bij de eerstvolgende opruiming weggehaald.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW  = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const SHELL = join(ROOT, 'modules/shared/design-system/app-shell.css');

/** Elke `class="scrim…"` in het bestand, met het regelnummer erbij. */
function scrimsUitBron() {
  const regels = readFileSync(VIEW, 'utf8').split('\n');
  const uit = [];
  regels.forEach((regel, i) => {
    for (const m of regel.matchAll(/class="(scrim[^"]*)"/g)) {
      uit.push({ regel: i + 1, klassen: m[1] });
    }
  });
  return uit;
}

test('elke scrim in de module draagt de klasse on', () => {
  const scrims = scrimsUitBron();
  // Ondergrens, zodat deze test niet stil groen blijft als de markup ooit
  // verdwijnt of hernoemd wordt: er horen er twee te zijn — de gedeelde
  // scrim-helper en het WhatsApp-koppelpaneel.
  assert.ok(scrims.length >= 2,
    `verwacht minstens twee scrims in opvolging-v2.js, gevonden: ${scrims.length}`);

  const zonder = scrims.filter((s) => !/\bon\b/.test(s.klassen));
  assert.deepEqual(zonder, [],
    '\n\nDeze scrims missen de klasse `on` en zijn daardoor onzichtbaar:\n' +
    zonder.map((s) => `  opvolging-v2.js:${s.regel} → class="${s.klassen}"`).join('\n') +
    '\n\nHet design system zet .scrim op opacity:0 en pointer-events:none; alleen\n' +
    '.scrim.on is zichtbaar. De module-eigen `.opv .scrim` noemt die twee\n' +
    'eigenschappen niet, dus de globale regel wint daarvoor. Het venster wordt\n' +
    'wel opgebouwd, maar je ziet het niet.\n');
});

test('de module-eigen regel dekt opacity en pointer-events niet zelf af', () => {
  // Als iemand ooit `opacity:1;pointer-events:auto` in `.opv .scrim` zet, is de
  // klasse `on` niet meer nodig en mag de test hierboven weg. Zolang dat niet
  // gebeurd is, blijft die klasse het enige dat de vensters zichtbaar maakt —
  // en dan moet niemand hem als overbodig aanzien.
  const src = readFileSync(VIEW, 'utf8');
  const m = src.match(/\.opv \.scrim\{([^}]*)\}/);
  assert.ok(m, '.opv .scrim-regel niet gevonden — is het stijlblok verplaatst?');
  const regel = m[1];
  assert.ok(!/opacity/.test(regel) && !/pointer-events/.test(regel),
    'de module dekt opacity/pointer-events nu zelf af; werk deze test bij, ' +
    'want dan is de klasse `on` niet langer wat de vensters zichtbaar maakt');
});

test('de klasse waar we op leunen bestaat nog in het design system', () => {
  // Verdwijnt .scrim.on uit app-shell.css, dan is onze `on` betekenisloos
  // geworden en staat er weer een onzichtbaar venster klaar. Deze test is de
  // aankondiging daarvan, niet een verbod op wijzigen.
  const css = readFileSync(SHELL, 'utf8');
  assert.match(css, /\.scrim\.on\s*\{/,
    '.scrim.on staat niet meer in app-shell.css — controleer of de vensters in ' +
    'de Opvolging-module nog zichtbaar zijn en pas ze zo nodig aan');
});
