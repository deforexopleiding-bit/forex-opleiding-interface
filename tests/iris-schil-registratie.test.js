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

/* ── 3. Vrijgegeven: zichtbaar voor drie rollen, voor de rest niet ────── */
//
// Deze bak stond tot 16 oktober op de KOP: hij eiste dat Iris in geen enkele
// zijbalk stond. Dat was juist zolang de module sliep. Nu is hij vrijgegeven
// voor super_admin, manager en sales (Dave), en is de eis dus niet "voor
// niemand" maar "voor precies die drie". Dat is de helft die stil kan
// verschuiven: een rolset uitbreiden kost één woord en levert geen foutmelding
// op bij degene die het niet had mogen zien.

const MAG = ['super_admin', 'manager', 'sales'];
const MAG_NIET = ['mentor', 'marketing', 'appointmentsetter'];

test('iris staat in de zijbalk voor super_admin, manager en sales', () => {
  const DFO = laadSchil('');
  for (const rol of MAG) {
    DFO.setRoles([rol]);
    const zichtbaar = DFO.visMods().filter((m) => m.nav !== false).map((m) => m.id);
    assert.ok(zichtbaar.includes('iris'), `iris staat NIET in de zijbalk van ${rol}`);
  }
});

test('en voor geen enkele andere rol', () => {
  const DFO = laadSchil('');
  for (const rol of MAG_NIET) {
    DFO.setRoles([rol]);
    assert.ok(!DFO.visMods().map((m) => m.id).includes('iris'),
      `iris is zichtbaar voor ${rol} — die rol hoort Iris niet te zien`);
  }
  // Een administratie-user houdt na pickShellRoles() een LEGE rolset over
  // (administratie zit niet in SHELL_ROLES). Zo iemand ziet alleen modules met
  // een permKey waar hij het recht voor heeft — en Iris heeft er geen.
  DFO.setRoles([]);
  assert.ok(!DFO.visMods().map((m) => m.id).includes('iris'));
});

test('zonder ?v2preview opent iris nu gewoon', () => {
  // Precies het omgekeerde van de oude toets. Dit is waarom de PR bestaat.
  const DFO = laadSchil('');
  DFO.setRoles(['sales']);
  DFO.goMod('iris');
  assert.equal(DFO.S.mod, 'iris');
  assert.equal(DFO.curMod().id, 'iris');
});

test('maar een mentor komt er nog steeds niet in', () => {
  const DFO = laadSchil('');
  DFO.setRoles(['mentor']);
  DFO.goMod('iris');
  assert.notEqual(DFO.curMod().id, 'iris');
});

test('iris heeft roles en GEEN permKey — dat laatste is een keuze', () => {
  // permKey zou alleen zichtbaarheid TOEVOEGEN (visMods is additief), en
  // `iris.view` staat voor administratie op true. Een permKey erbij zou Iris
  // dus breder zetten dan afgesproken, zonder dat dat ergens te zien is.
  const DFO = laadSchil('');
  const iris = DFO.MODS.find((m) => m.id === 'iris');
  assert.deepEqual([...iris.roles].sort(), [...MAG].sort());
  assert.equal(iris.permKey, undefined,
    'permKey gezet → ook administratie ziet Iris in de zijbalk');
  assert.equal(iris.preview, undefined,
    'de preview-vlag hoort weg nu de rollen kloppen — anders tovert ?v2preview= het item in elke zijbalk');
});

test('geen enkele module heeft de preview-vlag nog', () => {
  // De vlag bestaat nog als mechanisme (voor een volgende slapende module),
  // maar er hoort er nu geen gebruik van te maken. Staat 'ie ergens, dan is die
  // module met een URL-parameter in een zijbalk te krijgen waar hij niet hoort.
  const DFO = laadSchil('');
  assert.deepEqual(DFO.MODS.filter((m) => m.preview).map((m) => m.id), []);
});

test('iris staat onder Klanten & communicatie, direct naast Wanbetalers', () => {
  const DFO = laadSchil('');
  const iris = DFO.MODS.find((m) => m.id === 'iris');
  assert.equal(iris.g, 'Klanten & communicatie');
  const ids = DFO.MODS.filter((m) => m.g === 'Klanten & communicatie').map((m) => m.id);
  assert.equal(ids[ids.indexOf('iris') - 1], 'wanbetalers',
    'iris hoort direct na wanbetalers te staan — daar wordt hij gezocht');
});

test("'iris' staat in V2_ACTIVE_ALLOWLIST, anders is de weergave dormant", () => {
  // KV_V2_ADD gooit een registratie weg die niet in de allowlist staat. Zonder
  // deze regel verschijnt het menu-item wél (MODS) en blijft het scherm leeg.
  const bron = lees('modules/klanten-v2/klanten-v2.js');
  const regel = bron.slice(bron.indexOf('const V2_ACTIVE_ALLOWLIST'));
  assert.match(regel.slice(0, regel.indexOf(');')), /'iris'/);
});

test('de links die we zelf maken houden ?v2preview=iris — die is dragend', () => {
  // Niet overbodig geworden: klanten-v2.js leest de boot-module uit
  // `?v2preview=`, en pas als die ontbreekt uit de hash. `#iris/dossier/<id>`
  // is als geheel geen module-id, dus zonder de parameter landt zo'n link op
  // het Dashboard. Weghalen vraagt eerst een hash-parser die het eerste
  // segment pakt.
  assert.match(lees('api/_lib/iris/opvolging.js'), /v2preview=iris/);
  assert.match(lees('api/_lib/iris/belrij-bronnen.js'), /v2preview=iris#iris\//);
  const kv = lees('modules/klanten-v2/klanten-v2.js');
  assert.match(kv, /get\('v2preview'\)/);
});

test('sales heeft iris.view, dus het menu-item is voor Dave geen doodlopende weg', () => {
  // Het item zichtbaar maken zonder het recht erachter geeft een scherm vol
  // 403's. De rechten staan in de migratie van 21 september; deze toets houdt
  // de zijbalk en die migratie aan elkaar.
  const sql = lees('docs/sql-migrations/2026-09-21-iris-fase1-rechten.sql');
  for (const rol of ['manager', 'sales']) {
    const re = new RegExp(`'${rol}', 'iris\\.view', true`);
    assert.match(sql, re, `${rol} krijgt iris.view niet in de rechten-migratie`);
  }
  // En de keerzijde: de rollen die het item niet zien, hebben het recht ook niet.
  for (const rol of ['mentor', 'marketing', 'appointmentsetter']) {
    const re = new RegExp(`'${rol}', 'iris\\.view', false`);
    assert.match(sql, re, `${rol} staat niet expliciet op false in de rechten-migratie`);
  }
});

/* ── 4. De browser moet de nieuwe bestanden ook echt ophalen ──────────── */

test('index.html laadt iris.js en draagt een v-nummer op beide bestanden', () => {
  const html = lees(INDEX);
  assert.match(html, /\.\.\/iris\/iris\.js\?v=\d+/);
  assert.match(html, /app-shell\.js\?v=[^"']+/);
});
