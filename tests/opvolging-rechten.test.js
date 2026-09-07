// tests/opvolging-rechten.test.js
//
// M — zeven rechtenschakelaars die niets deden.
//
// In modules/shared/rbac/registry.js stonden opvolging.dag.view,
// opvolging.dashboard.view, opvolging.archief.view, opvolging.taak.afronden,
// opvolging.taak.archiveren, opvolging.agenda.boeken en
// opvolging.whatsapp.sturen. In de database stonden er netjes 40 rijen voor,
// per rol ingevuld. Maar de sleutels kwamen alleen in dat register voor en
// werden nergens gecontroleerd: alle veertien opvolging-endpoints keken
// uitsluitend naar opvolging.module.access.
//
// Zet een beheerder dus 'WhatsApp sturen' uit voor sales, dan veranderde er
// niets. Een rechtenscherm dat rapporteert dat het iets tegenhoudt terwijl het
// niets doet is erger dan geen scherm, want niemand controleert het nog een
// tweede keer.
//
// Deze test is de bewaking daarop: elke sleutel in het register moet ergens
// gecontroleerd worden, en elke controle moet op de juiste plek staan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Alleen de code: een sleutel die in een comment staat is niet aangesloten. */
const code = (p) => lees(p).split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');

const REGISTRY  = 'modules/shared/rbac/registry.js';
const APP_SHELL = 'modules/shared/design-system/app-shell.js';

/** De opvolging-sleutels zoals ze in het rechtenscherm staan. */
function sleutelsUitRegistry() {
  const b = lees(REGISTRY);
  return (b.match(/key:'(opvolging\.[a-z_.]+)'/g) || []).map((x) => x.slice(5, -1));
}

// ═══════════════════════════════════════════════════════════════════════════
// GEEN SLEUTEL DIE NERGENS OVER GAAT
// ═══════════════════════════════════════════════════════════════════════════

test('elke opvolging-sleutel in het register wordt ergens gecontroleerd', () => {
  // Dit is de eigenlijke bewaking. Komt er later een schakelaar bij die nergens
  // aan hangt, dan valt deze test om in plaats van dat een beheerder het pas
  // merkt als hij hem uitzet en er niets gebeurt.
  const sleutels = sleutelsUitRegistry();
  assert.ok(sleutels.length >= 8, 'de sleutels horen gevonden te worden: ' + sleutels.length);

  const bronnen = [
    APP_SHELL,
    'api/opvolging-taak-update.js', 'api/opvolging-aanmelding-actie.js',
    'api/opvolging-agenda.js', 'api/opvolging-whatsapp-send.js',
    'api/opvolging-taken.js', 'api/opvolging-dag.js',
  ].map(code).join('\n');

  for (const k of sleutels) {
    assert.ok(bronnen.includes("'" + k + "'"), 'sleutel wordt nergens gecontroleerd: ' + k);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VIER ACTIE-SLEUTELS, SERVER-SIDE
// ═══════════════════════════════════════════════════════════════════════════

test('WhatsApp sturen hangt aan het send-endpoint', () => {
  const b = code('api/opvolging-whatsapp-send.js');
  assert.match(b, /requirePermission\(req, 'opvolging\.whatsapp\.sturen'\)/);
  assert.match(b, /Geen rechten \(opvolging\.whatsapp\.sturen\)/);
});

test('de grove poort blijft ervóór staan', () => {
  // opvolging.module.access blijft de eerste vraag op elk endpoint; de fijne
  // sleutel komt erbovenop, niet in plaats daarvan.
  for (const p of ['api/opvolging-whatsapp-send.js', 'api/opvolging-taak-update.js',
                   'api/opvolging-aanmelding-actie.js', 'api/opvolging-agenda.js']) {
    const b = code(p);
    const grof = b.indexOf("'opvolging.module.access'");
    assert.ok(grof > 0, p + ': de grove poort hoort er te staan');
    const fijn = b.search(/'opvolging\.(taak|agenda|whatsapp)\./);
    assert.ok(fijn > grof, p + ': de fijne sleutel hoort ná de grove poort');
  }
});

test('taak afronden hangt aan de mutaties op een kaart', () => {
  const b = code('api/opvolging-taak-update.js');
  assert.match(b, /requirePermission\(req, 'opvolging\.taak\.afronden'\)/);
  // En vóór de eerste actie-tak, zodat geen enkele mutatie erlangs kan.
  assert.ok(b.indexOf("'opvolging.taak.afronden'") < b.indexOf("b.actie === 'later_vandaag'"));
});

test('archiveren heeft een eigen sleutel, bovenop afronden', () => {
  // Archiveren haalt een lead definitief uit de lijst; dat is een zwaardere
  // beslissing dan hem verzetten.
  const b = code('api/opvolging-taak-update.js');
  assert.match(b, /requirePermission\(req, 'opvolging\.taak\.archiveren'\)/);
  const arch = b.indexOf("'opvolging.taak.archiveren'");
  const tak  = b.indexOf("b.actie === 'archiveer'");
  assert.ok(tak > 0 && arch > tak, 'de check hoort binnen de archiveer-tak te staan');
});

test('het afronden van een aanmeldkaart valt onder dezelfde sleutel', () => {
  const b = code('api/opvolging-aanmelding-actie.js');
  assert.match(b, /requirePermission\(req, 'opvolging\.taak\.afronden'\)/);
});

test('agenda boeken hangt aan het boeken, niet aan het lezen', () => {
  // De vrije momenten bekijken is onschuldig; er een vastleggen is dat niet.
  const b = code('api/opvolging-agenda.js');
  assert.match(b, /requirePermission\(req, 'opvolging\.agenda\.boeken'\)/);
  const i = b.indexOf('async function boek(');
  const j = b.indexOf('async function lees(');
  const check = b.indexOf("'opvolging.agenda.boeken'");
  assert.ok(i > 0 && check > i, 'de check hoort in boek() te staan');
  if (j > 0 && j < i) {
    assert.ok(check > i, 'en niet in lees()');
  }
});

test('lezen blijft open voor wie de module mag', () => {
  const b = code('api/opvolging-agenda.js');
  const i = b.indexOf('async function lees(');
  const eind = b.indexOf('\n}', i);
  assert.ok(!b.slice(i, eind).includes('agenda.boeken'), 'lees() hoort niets extra te eisen');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE VIEW-SLEUTELS, OP DE TABBLADEN
// ═══════════════════════════════════════════════════════════════════════════

test('de drie tabs hangen aan hun eigen sleutel', () => {
  const b = code(APP_SHELL);
  assert.match(b, /'opvolging\/Vandaag'\s*:\s*'opvolging\.dag\.view'/);
  assert.match(b, /'opvolging\/Dashboard'\s*:\s*'opvolging\.dashboard\.view'/);
  assert.match(b, /'opvolging\/Afgerond'\s*:\s*'opvolging\.archief\.view'/);
});

test('roleTabs kijkt naar allebei: de rol én de sleutel', () => {
  const b = code(APP_SHELL);
  const i = b.indexOf('const roleTabs');
  const blok = b.slice(i, i + 500);
  assert.match(blok, /TAB_RESTRICT\[/, 'de rol-gate blijft');
  assert.match(blok, /TAB_PERM\[/, 'en de sleutel-gate komt erbij');
});

test('een tab zonder regel gedraagt zich precies zoals voorheen', () => {
  // Puur additief: dit bestand draagt elke module in de shell.
  const b = code(APP_SHELL);
  const i = b.indexOf('const tabPermOk');
  const blok = b.slice(i, i + 700);
  assert.match(blok, /if \(!sleutel\) return true/);
});

test('de tab-gate is fail-open bij een mislukte rechten-load', () => {
  // canSync() zegt bij een fout overal false — hetzelfde antwoord als 'niet
  // toegestaan'. Wie daarop iets verbergt, verbergt het ook bij een netwerkfout,
  // en dan opent de module met nul tabbladen.
  const b = code(APP_SHELL);
  const i = b.indexOf('const tabPermOk');
  const blok = b.slice(i, i + 700);
  assert.match(blok, /permissiesGeladen/);
  assert.match(blok, /!R\.permissiesGeladen\(\)\) return true/);
  assert.match(blok, /R\.canSync\(sleutel\) === true/, 'alleen een bewezen ja telt als ja');
});

test('RBAC kan zeggen of de rechten echt geladen zijn', () => {
  // Zonder die vlag zijn 'niet geladen' en 'niets toegestaan' dezelfde vorm.
  const b = code('modules/shared/permissions.js');
  assert.match(b, /function permissiesGeladen\(\)/);
  assert.match(b, /permissiesGeladen: permissiesGeladen/);
  // Elke faal-tak zet hem uit, elke gelukte tak aan.
  assert.ok((b.match(/_permsOk = false/g) || []).length >= 4, 'elke faal-tak');
  assert.ok((b.match(/_permsOk = true/g) || []).length >= 3, 'elke gelukte tak');
});

test('resetten zet de vlag ook terug', () => {
  const b = code('modules/shared/permissions.js');
  const i = b.indexOf('function resetPermissionsCache');
  assert.match(b.slice(i, i + 200), /_permsOk = false/);
});

// ═══════════════════════════════════════════════════════════════════════════
// WAT DEZE DRIE SLEUTELS WEL EN NIET ZIJN
// ═══════════════════════════════════════════════════════════════════════════

test('de drie view-sleutels staan als navigatie beschreven, niet als datapoort', () => {
  // Ze zijn bewust NIET server-side afgedwongen: de endpoints erachter worden
  // ook door de Kanban in Automatiseringen gebruikt, en die zou dan breken.
  // Dat hoort ergens te staan, anders leest 'Tab: Dashboard' als een garantie.
  const b = lees(APP_SHELL);
  const i = b.indexOf('const TAB_PERM');
  const uitleg = b.slice(Math.max(0, i - 1400), i);
  assert.match(uitleg, /navigatie, geen datapoort/);
  assert.match(uitleg, /Automatiseringen/);
});

test('de leesendpoints zijn NIET met de view-sleutels dichtgezet', () => {
  // Zou dat wel gebeuren, dan valt de Kanban om voor iedereen zonder die rij.
  for (const p of ['api/opvolging-taken.js', 'api/opvolging-dag.js']) {
    const b = code(p);
    for (const k of ['opvolging.dag.view', 'opvolging.dashboard.view', 'opvolging.archief.view']) {
      assert.ok(!b.includes(k), p + ' hoort ' + k + ' niet af te dwingen');
    }
  }
});

test('de kanban blijft dezelfde drie endpoints gebruiken', () => {
  const b = lees('modules/klanten-v2/views/automatiseringen-v2.js');
  assert.match(b, /\/api\/opvolging-dag/);
  assert.match(b, /\/api\/opvolging-taken\?include_ingepland=1/);
  assert.match(b, /\/api\/opvolging-taken\?view=archief/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BESTANDEN WORDEN OOK ECHT OPNIEUW GELADEN
// ═══════════════════════════════════════════════════════════════════════════

test('app-shell en permissions dragen een v-nummer', () => {
  // Zonder v-nummer draait de browser de oude versie en doet de hele PR niets.
  //
  // DEZE TEST PINDE EERST DE EXACTE NUMMERS VAST (permissions v=4, app-shell
  // v=1d7). Dat was fout van vorm: hij eiste dat die twee bestanden NOOIT meer
  // opgehoogd zouden worden, terwijl de regel juist is dat elke branch die ze
  // aanraakt ze WEL ophoogt. De eerstvolgende terechte bump maakte hem rood —
  // dat gebeurde bij het dagrapport (item R), dat app-shell.js aanraakt voor
  // het vierde tabblad. Twee controles die elkaar tegenspreken leren mensen om
  // er één te negeren, en dat is de gevaarlijkste van de twee uitkomsten.
  //
  // Of er ook echt opgehoogd IS, controleert tests/script-versies.test.js — en
  // die doet het goed: hij vergelijkt origin/main..HEAD en weet dus welke
  // bestanden deze branch heeft aangeraakt. Hier blijft staan wat hier hoort:
  // dat de twee scripts überhaupt met een v-nummer geladen worden en niet kaal.
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /permissions\.js\?v=[^"']+/);
  assert.match(html, /app-shell\.js\?v=[^"']+/);
});
