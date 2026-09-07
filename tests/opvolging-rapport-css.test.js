// tests/opvolging-rapport-css.test.js
//
// ELKE KLASSE DIE GETEKEND WORDT, MOET OOK EEN REGEL HEBBEN.
//
// Het rapportscherm was visueel stuk en niemand zag het: elke cijfertegel
// rendeerde als losse regels onder elkaar in een lege witte doos. De oorzaak
// gaf geen enkele foutmelding, want ontbrekende CSS bestaat niet — het valt
// gewoon terug op display:block.
//
// Drie dingen tegelijk:
//   · .opv .kpi bestond al in deze module, maar als ENKELVOUDIGE kaart met
//     kinderen .k/.v/.s. Het rapport gebruikte hem als rij van vier.
//   · .cell had nergens een regel. app-shell.css heeft alleen .cell-main en
//     .cell-sub, en die matchen niet.
//   · .n en .l bestonden wel, maar in een andere context (.sh .n, .wkd .l).
//
// Dit is de derde keer deze week dat iets bestond maar niet deed wat het
// beweerde — nu in CSS in plaats van in code. Deze test vangt die vorm: hij
// leest de klassen die de view tekent en controleert dat er een .opv-regel
// voor is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');

/** De CSS die deze module zelf inspuit. */
function moduleCss() {
  const i = VIEW.indexOf('el.textContent = `');
  const j = VIEW.indexOf('\n`;', i);
  assert.ok(i > 0 && j > i, 'de stijl-blok van de module hoort te bestaan');
  return VIEW.slice(i, j);
}

/**
 * Alle klassenamen die een stuk view tekent.
 *
 * Ook de klassen die via een ternary aan het attribuut geplakt worden, zoals
 * `class="opvr-regel' + (x ? '' : ' opvr-grijs') + '"`. Juist daar verstopt zo'n
 * bug zich, want die naam staat buiten het aanhalingsteken.
 *
 * Alleen BINNEN een class-attribuut kijken. Een eerdere versie pakte elke
 * ternary in het bestand en hield 'binnengekomen' en 'verstuurd' voor klassen —
 * dat is gewone tekst.
 */
function klassenIn(blok) {
  const uit = new Set();
  for (const m of blok.matchAll(/class="((?:[^"]|"\s*\+)*?)"[>\s]/g)) {
    // Binnen zo'n stuk wisselen letterlijke tekst en JS-uitdrukking elkaar af,
    // gescheiden door een enkel aanhalingsteken. Alleen de EVEN stukken zijn
    // echte tekst; de oneven zijn code. Zonder dat onderscheid komen
    // variabelenamen als `merk` en `k` als klasse binnen.
    const stukken = m[1].split("'");
    for (let i = 0; i < stukken.length; i += 2) {
      // Het EERSTE stuk staat altijd letterlijk in het attribuut. Een later
      // even stuk telt alleen mee als het met witruimte begint — zo wordt een
      // klasse aangeplakt (`' p'`, `' opvr-grijs'`). Zonder die eis glipt een
      // vergelijkingsstring uit de expressie mee: bij
      // `_ui.rapportPeriode === 'eigen' ? ' p' : ''` schuift 'eigen' precies op
      // een even plek en werd het voor een klassenaam aangezien.
      if (i > 0 && !/^\s/.test(stukken[i])) continue;
      for (const t of stukken[i].matchAll(/(?:^|\s)([a-z][a-z0-9-]*)(?=\s|$)/g)) uit.add(t[1]);
    }
  }
  // Een klasse die via een variabele wordt samengesteld ontsnapt daaraan. Voor
  // onze eigen namespace vangen we die alsnog: een ternary waarvan beide takken
  // met opvr- beginnen is ondubbelzinnig een klassenaam en geen tekst.
  for (const m of blok.matchAll(/'(opvr-[a-z0-9-]+)'\s*:\s*'(opvr-[a-z0-9-]+)'/g)) {
    uit.add(m[1]); uit.add(m[2]);
  }
  return uit;
}

/**
 * Heeft deze klasse ergens in de module-CSS een selector die hem raakt?
 *
 * Op SELECTOR-BLOKKEN parsen, niet op regels. Een eerdere versie deed
 * `regel.split('{')[0]` en miste daardoor elke regel die achter een andere op
 * dezelfde tekstregel staat — en zo staan .t-red, .t-green en .t-grey er nu
 * juist. De test zei toen dat bestaande klassen geen regel hadden.
 */
function heeftRegel(css, klasse) {
  const patroon = new RegExp('\\.' + klasse.replace(/-/g, '\\-') + '(?![a-z0-9_-])');
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const sel = m[1];
    if (!sel.includes('.opv')) continue;
    if (patroon.test(sel)) return true;
  }
  return false;
}

// Klassen die het rapport bewust deelt met de rest van de module. Die hebben
// hun regel elders in hetzelfde blok en horen NIET geprefixt te worden.
const GEDEELD = new Set(['opv', 'card', 'ronde', 'zacht', 'warn', 'empty', 'tag',
  't-green', 't-grey', 't-red', 't-amber', 't-blue', 't-purple', 'obtn', 'p', 'info']);

function rapportBlok() {
  const i = VIEW.indexOf('  // R · HET DAGRAPPORT');
  const j = VIEW.indexOf('  window.__opvVensterHelpers', i);
  assert.ok(i > 0 && j > i, 'het rapport-blok hoort te bestaan');
  return VIEW.slice(i, j);
}

test('elke klasse die het rapport tekent heeft een regel in de module-CSS', () => {
  const css = moduleCss();
  const zonder = [...klassenIn(rapportBlok())].filter((k) => !heeftRegel(css, k));
  assert.deepEqual(zonder, [],
    'deze klassen worden getekend maar hebben geen enkele regel — dan valt alles terug op display:block:\n  ' +
    zonder.join(', '));
});

test('de rapport-eigen klassen dragen allemaal het opvr-voorvoegsel', () => {
  // Namen als cell, n en l botsen vroeg of laat met iets anders, en dat merk je
  // pas als het scherm er verkeerd uitziet.
  const fout = [...klassenIn(rapportBlok())]
    .filter((k) => !GEDEELD.has(k) && !k.startsWith('opvr-'));
  assert.deepEqual(fout, [],
    'rapport-eigen klassen horen met opvr- te beginnen: ' + fout.join(', '));
});

test('het rapport gebruikt .kpi niet meer — die is in deze module iets anders', () => {
  const blok = rapportBlok();
  // Let op het koppelteken: 'opvr-kpi' mag hier niet op aanslaan.
  assert.doesNotMatch(blok, /class="[^"]*(?<![a-z-])kpi(?![a-z-])/,
    '.opv .kpi is de enkelvoudige kaart met .k/.v/.s, geen rij van vier');
  assert.doesNotMatch(blok, /class="[^"]*(?<![a-z-])cell(?![a-z-])/);
});

test('de cijferrij is echt een grid en geen stapel blokken', () => {
  const css = moduleCss();
  const regel = css.split('\n').find((r) => r.startsWith('.opv .opvr-kpi{'));
  assert.ok(regel, '.opv .opvr-kpi hoort te bestaan');
  assert.match(regel, /display:grid/);
  assert.match(regel, /minmax\(0,1fr\)/, 'anders breekt de rij af bij een lange waarde');
});

test('de tegel-onderdelen hebben allemaal hun eigen regel', () => {
  const css = moduleCss();
  for (const k of ['opvr-cel', 'opvr-getal', 'opvr-label']) {
    assert.ok(heeftRegel(css, k), k + ' mist een regel');
  }
});

test('geen enkele rapport-klasse botst met een naam uit app-shell.css', () => {
  // De gedeelde stylesheet wordt door elke module geladen. Een naam die daar al
  // bestaat krijgt regels die niets met ons te maken hebben.
  const shell = readFileSync(join(ROOT, 'modules/shared/design-system/app-shell.css'), 'utf8');
  const shellKlassen = new Set(
    [...shell.matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]),
  );
  const eigen = [...klassenIn(rapportBlok())].filter((k) => !GEDEELD.has(k));
  const botsend = eigen.filter((k) => shellKlassen.has(k));
  assert.deepEqual(botsend, [], 'deze namen bestaan al in app-shell.css: ' + botsend.join(', '));
});

// ═══════════════════════════════════════════════════════════════════════════
// DE WOORDEN MOETEN HETZELFDE BETEKENEN ALS IN DE CODE
// ═══════════════════════════════════════════════════════════════════════════
// Onder Volume stond "Gemeten gesprekstijd 2 min 13 sec over alle 9
// gesprekken". Dat waren geen negen gesprekken maar negen POGINGEN, waarvan er
// vijf een gesprek werden. Als het rapport Dave beoordeelt en de woorden
// kloppen niet, discussieert hij terecht over de meting in plaats van over zijn
// werk.
//
//   poging  — Dave heeft gebeld. Telt altijd.
//   gesprek — de verbinding kwam tot stand én duurde lang genoeg.
//   contact — de verbinding kwam tot stand. Ook een korte.

test('de gespreksduur wordt niet over "gesprekken" uitgedrukt maar over pogingen', () => {
  const blok = rapportBlok();
  const i = blok.indexOf('Gemeten gesprekstijd');
  assert.ok(i > 0, 'de regel over gesprekstijd hoort te bestaan');
  const zin = blok.slice(i, i + 700);
  // v.bel.uit is het aantal POGINGEN. Dat getal 'gesprekken' noemen is de
  // leugen die hier stond.
  assert.doesNotMatch(zin, /v\.bel\.uit \+ ' gesprekken/);
  assert.match(zin, /v\.bel\.uit \+ ' belpogingen/);
});

test('geen enkele tegel noemt een pogingen-getal een gesprek', () => {
  const blok = rapportBlok();
  for (const m of blok.matchAll(/rapCel\(([^,]+), '([^']+)'\)/g)) {
    const [, waarde, label] = m;
    if (/gesprek/i.test(label)) {
      assert.match(waarde, /gesproken/,
        `het label "${label}" hangt aan ${waarde} — dat is geen gesprekken-teller`);
    }
    if (/poging/i.test(label)) {
      assert.doesNotMatch(waarde, /gesproken/,
        `het label "${label}" hangt aan ${waarde} — dat telt gesprekken, geen pogingen`);
    }
  }
});

test('"aangeraakt" en "actie" zijn vervangen door het woord dat de code gebruikt', () => {
  // Die twee woorden stonden voor 'kreeg minstens één poging', maar dat las
  // niemand eruit. isMoeite heet moeite; naar buiten heet dat een poging.
  const blok = rapportBlok();
  assert.doesNotMatch(blok, /'leads aangeraakt'/);
  assert.doesNotMatch(blok, /'kregen actie'/);
  assert.doesNotMatch(blok, /'Alle aangeraakte leads'/);
});
