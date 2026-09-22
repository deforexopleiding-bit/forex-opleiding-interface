// tests/iris-schil-registratie.test.js
//
// DE WEERGAVE DIE ER WEL WAS EN TOCH NIET VERSCHEEN.
//
// Iris werd netjes geregistreerd als schil-weergave:
//
//   window.DFO.VIEWS['iris/'] = irisView;
//
// en die regel draaide ook. Toch toonde crm.deforexopleiding.nl/modules/
// klanten-v2/?v2preview=iris#iris het Dashboard. Geen foutmelding, geen lege
// pagina, geen waarschuwing in de console — gewoon de verkeerde module.
//
// De oorzaak is dat een schil-weergave TWEE registraties nodig heeft, en dat
// het ontbreken van de tweede nergens een geluid maakt:
//
//   1. VIEWS['<id>/']  — wat er getekend wordt.
//   2. een regel in MODS in app-shell.js — DAT de module bestaat.
//
// Zonder die tweede regel:
//   · goMod('iris')  doet `const m = MODS.find(...); if (!m) return;` — stil.
//   · curMod()       vindt niets en valt terug op visMods()[0] = Dashboard.
//   · klanten-v2.js  keurt de boot-module af via _modIsValid() en houdt
//                    'dashboard' aan, ook als de hash #iris is.
//
// Drie plekken die alle drie fail-soft zijn. Precies daarom is dit een test
// en geen commentaarregel: de volgende module die vergeten wordt, valt hier
// om in plaats van op het scherm van Maxim.
//
// De tweede helft van dit bestand bewaakt de andere kant: Iris hoort NIET in
// de zijbalk te staan tot hij vrijgegeven wordt. De `preview: true`-vlag mag
// een module bereikbaar maken met ?v2preview=, niet zichtbaar zonder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const APP_SHELL = 'modules/shared/design-system/app-shell.js';
const ICONS     = 'modules/shared/design-system/icons.js';
const INDEX     = 'modules/klanten-v2/index.html';

/**
 * Draai icons.js + app-shell.js in een nagebootst venster en geef window.DFO
 * terug. Geen jsdom: de schil raakt het document uitsluitend binnen functies
 * en controleert overal of het element bestaat, dus een document dat altijd
 * `null` teruggeeft is genoeg om nav-logica te draaien zonder te tekenen.
 */
function laadSchil(search = '') {
  const maakEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, display: '' },
    innerHTML: '', textContent: '', value: '', scrollTop: 0,
    setAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {}, focus() {}, select() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => maakEl(), querySelectorAll: () => [],
  });
  const doc = {
    getElementById: () => maakEl(),
    querySelector: () => maakEl(),
    querySelectorAll: () => [],
    createElement: () => maakEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: maakEl(),
    body: maakEl(),
  };
  const win = {
    location: { search, hash: '' },
    innerWidth: 1400,
    addEventListener: () => {},
    open: () => {},
  };
  win.document = doc;
  const draai = (bestand) => {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'module', 'requestAnimationFrame', lees(bestand))(
      win, doc, undefined, (fn) => fn(),
    );
  };
  draai(ICONS);
  draai(APP_SHELL);
  return win.DFO;
}

/* ── 1. De regel die ontbrak ──────────────────────────────────────────── */

test('iris staat in MODS — zonder die regel keert goMod stil terug', () => {
  const DFO = laadSchil('');
  const iris = DFO.MODS.find((m) => m.id === 'iris');
  assert.ok(iris, 'MODS mist een entry met id "iris" — dan toont de schil Dashboard');
  assert.equal(iris.naam, 'Iris');
});

test('elke geregistreerde schil-weergave heeft een MODS-entry', () => {
  // De algemene vorm van de fout hierboven. Loopt over alle scripts die een
  // weergave registreren en eist voor elk gebruikt module-id een MODS-regel.
  const DFO = laadSchil('');
  const bekend = new Set(DFO.MODS.map((m) => m.id));

  const bestanden = [];
  const loop = (map) => {
    for (const naam of readdirSync(join(ROOT, map))) {
      if (naam === 'node_modules' || naam.startsWith('.')) continue;
      const pad = join(map, naam);
      if (statSync(join(ROOT, pad)).isDirectory()) loop(pad);
      else if (naam.endsWith('.js')) bestanden.push(pad);
    }
  };
  loop('modules');

  const ontbreekt = [];
  for (const pad of bestanden) {
    const inhoud = lees(pad);
    for (const treffer of inhoud.matchAll(/VIEWS\[['"]([a-z0-9-]+)\//g)) {
      const id = treffer[1];
      if (!bekend.has(id)) ontbreekt.push(`${relative('.', pad)} → VIEWS['${id}/…']`);
    }
  }
  assert.deepEqual(
    ontbreekt, [],
    'weergave geregistreerd voor een module die niet in MODS staat:\n  ' + ontbreekt.join('\n  '),
  );
});

/* ── 2. Bereikbaar mét ?v2preview=iris ────────────────────────────────── */

test('met ?v2preview=iris opent de module en blijft curMod op iris staan', () => {
  const DFO = laadSchil('?v2preview=iris');
  DFO.setRoles(['manager']);
  DFO.goMod('iris');
  assert.equal(DFO.S.mod, 'iris');
  assert.equal(DFO.curMod().id, 'iris', 'curMod valt terug op de eerste zichtbare module');
});

test('setRoles gooit de preview-module er naderhand niet uit', () => {
  // klanten-v2.js roept setRoles() aan zodra de echte rollen binnen zijn.
  // Staat iris dan niet in visMods(), dan zet setRoles S.mod terug op de
  // eerste zichtbare module en is de preview weg.
  const DFO = laadSchil('?v2preview=iris');
  DFO.goMod('iris');
  DFO.setRoles(['manager', 'super_admin']);
  assert.equal(DFO.S.mod, 'iris');
});

test('een komma-lijst werkt ook — ?v2preview=wanbetalers,iris', () => {
  const DFO = laadSchil('?v2preview=wanbetalers,iris');
  DFO.setRoles(['manager']);
  DFO.goMod('iris');
  assert.equal(DFO.curMod().id, 'iris');
});

/* ── 3. Onzichtbaar zónder ?v2preview ─────────────────────────────────── */

test('zonder ?v2preview staat iris in geen enkele zijbalk', () => {
  const DFO = laadSchil('');
  for (const rol of ['super_admin', 'manager', 'sales', 'mentor', 'marketing', 'appointmentsetter']) {
    DFO.setRoles([rol]);
    const zichtbaar = DFO.visMods().map((m) => m.id);
    assert.ok(!zichtbaar.includes('iris'), `iris is zichtbaar voor rol ${rol} — hij hoort nog slapend te zijn`);
  }
});

test('zonder ?v2preview levert goMod(iris) geen iris-scherm op', () => {
  // Het gedrag van vóór deze wijziging, en het gedrag dat we willen houden
  // zolang de module niet is vrijgegeven: de MODS-entry alleen is niet genoeg.
  const DFO = laadSchil('');
  DFO.setRoles(['manager']);
  DFO.goMod('iris');
  assert.notEqual(DFO.curMod().id, 'iris');
});

test('iris heeft geen roles en geen permKey — vrijgeven is een bewuste stap', () => {
  const DFO = laadSchil('');
  const iris = DFO.MODS.find((m) => m.id === 'iris');
  assert.deepEqual(iris.roles, [], 'roles gevuld → iris verschijnt in de zijbalk');
  assert.equal(iris.permKey, undefined, 'permKey gezet → iris verschijnt bij iedereen met dat recht');
  assert.equal(iris.preview, true);
});

test('de preview-vlag verandert niets voor de bestaande modules', () => {
  // Alleen een MOD met `preview: true` hoort het nieuwe pad te lopen. Staat de
  // vlag ergens anders, dan is een module onbedoeld met een URL-parameter uit
  // de zijbalk te toveren.
  const DFO = laadSchil('');
  const metVlag = DFO.MODS.filter((m) => m.preview).map((m) => m.id);
  assert.deepEqual(metVlag, ['iris']);
});

test('?v2preview van een gewone module verruimt niets', () => {
  // wanbetalers is SAM-only. Een mentor die 'em opvraagt met de parameter
  // hoort 'em nog steeds niet te zien: de parameter opent alleen slapende
  // modules, hij is geen rechten-omweg.
  const DFO = laadSchil('?v2preview=wanbetalers');
  DFO.setRoles(['mentor']);
  assert.ok(!DFO.visMods().map((m) => m.id).includes('wanbetalers'));
});

/* ── 4. De browser moet de nieuwe bestanden ook echt ophalen ──────────── */

test('index.html laadt iris.js en draagt een v-nummer op beide bestanden', () => {
  const html = lees(INDEX);
  assert.match(html, /\.\.\/iris\/iris\.js\?v=\d+/);
  assert.match(html, /app-shell\.js\?v=[^"']+/);
});
