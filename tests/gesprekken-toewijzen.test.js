// tests/gesprekken-toewijzen.test.js
//
// Wie pakt dit op? (G4)
//
// Het gat: nergens stond van wie een gesprek was. Bij twee mensen op één
// postbus is dat geen randgeval maar de normale gang van zaken — twee mensen
// antwoorden, of niemand doet het omdat allebei aannemen dat de ander al bezig
// is.
//
// Het veld bestond al: iris_gesprekken.toegewezen_aan, met NULL als "Iris
// houdt het vast". Er was alleen niets dat het zette of toonde.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOEWIJSBARE_ROLLEN } from '../api/_lib/gesprekken-werkstand.js';

const EP = readFileSync(new URL('../api/inbox-gesprek-toewijzen.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');

// ── aan wie kun je toewijzen ────────────────────────────────────────────────

test('een viewer kan geen gesprek oppakken', () => {
  // Een viewer mag niet antwoorden. Een gesprek aan hem toewijzen betekent dat
  // het stil blijft liggen bij iemand die er niets mee kan — het ziet eruit
  // alsof het belegd is, en dat is erger dan onbelegd.
  assert.ok(!TOEWIJSBARE_ROLLEN.includes('viewer'));
});

test('iedereen die de inbox bedient staat erin', () => {
  for (const rol of ['super_admin', 'admin', 'manager', 'sales', 'administratie', 'mentor']) {
    assert.ok(TOEWIJSBARE_ROLLEN.includes(rol), rol + ' ontbreekt');
  }
});

test('alleen actieve mensen komen in de lijst', () => {
  assert.match(EP, /\.eq\('is_active', true\)/);
  assert.match(EP, /\.in\('role', TOEWIJSBARE_ROLLEN\)/);
});

// ── de rechten ──────────────────────────────────────────────────────────────

test('toewijzen vraagt hetzelfde recht als antwoorden', () => {
  // Wie mag antwoorden mag het ook claimen: precies dezelfde groep mensen, dus
  // geen nieuw recht en geen migratie.
  assert.match(EP, /requirePermission\(req, 'finance\.inbox\.send'\)/);
});

test('de lijst met mensen zit achter datzelfde recht, niet achter beheerrechten', () => {
  // Toewijzen doet iedereen die de inbox bedient, en die heeft geen
  // beheerrechten. Zat de lijst in een admin-endpoint, dan kon niemand kiezen.
  assert.doesNotMatch(EP, /verifyAdmin|ADMIN_ROLES/);
});

test('het hele endpoint staat achter de vlag', () => {
  assert.match(EP, /if \(!gesprekkenV2Aan\(\)\)/);
});

// ── wat het nooit doet ──────────────────────────────────────────────────────

test('zonder gespreksrij geen stil succes', () => {
  // "Opgeslagen!" gevolgd door een leeg vakje na de volgende verversing is
  // erger dan een foutmelding: dan denk je dat het belegd is.
  assert.match(EP, /GEEN_GESPREKSRIJ/);
  assert.match(EP, /status\(409\)/);
  assert.match(EP, /\.select\('id, toegewezen_aan'\)/,
    'zonder select weet je niet of er iets geraakt is');
});

test('toewijzen aan iemand die niet mag antwoorden wordt geweigerd op de SERVER', () => {
  // Niet erop vertrouwen dat het scherm alleen geldige mensen aanbiedt.
  assert.match(EP, /Die persoon is niet actief/);
  assert.match(EP, /kan geen gesprek oppakken/);
});

test('niemand is een geldige keuze, geen ontbrekende waarde', () => {
  // Terug naar Iris moet kunnen. Zou een lege waarde als "veld vergeten"
  // gelezen worden, dan kun je een toewijzing nooit meer weghalen.
  assert.match(EP, /naarNiemand/);
  assert.match(EP, /toegewezen_aan: profileId/);
});

test('een verzonnen id komt er niet door', () => {
  assert.match(EP, /profile_id moet een uuid zijn of null/);
  assert.match(EP, /UUID_RE\.test\(convId\)/);
});

// ── het scherm ──────────────────────────────────────────────────────────────

test('de keuze staat in de kop en de initialen in de lijst', () => {
  // In de lijst, want dat is waar je scant; alleen de initialen, want een hele
  // naam duwt de klantnaam uit beeld.
  assert.match(SCHERM, /function _inboxToewijzingHtml/);
  assert.match(SCHERM, /eigenaarBadge/);
  assert.match(SCHERM, /_initialen\(c\.toegewezen_naam\)/);
});

test('allebei achter de vlag', () => {
  const i = SCHERM.indexOf('function _inboxToewijzingHtml');
  assert.match(SCHERM.slice(i, i + 200), /const gv = _gv2\(\);[\s\S]{0,80}if \(!gv/);
  assert.match(SCHERM, /const eigenaarBadge = \(_gv2\(\) && c\.toegewezen_naam\)/);
});

test('een leeg keuzemenu wordt niet getoond', () => {
  // Misleidender dan geen menu: je klapt uit, ziet niets, en concludeert dat
  // er niemand is om aan toe te wijzen.
  const i = SCHERM.indexOf('function _inboxToewijzingHtml');
  assert.match(SCHERM.slice(i, i + 1400), /if \(!mensen\.length\)/);
});

test('een kapotte lijst wordt geen verkapte poll', () => {
  // 'geladen' blijft true ook bij een fout, anders probeert elke hertekening
  // het opnieuw en tikt een kapot endpoint aan bij elke render.
  const i = SCHERM.indexOf('async function _fetchInboxToewijsbaar');
  const body = SCHERM.slice(i, i + 900);
  assert.match(body, /_live\.inbox\.toewijzen\.geladen = true;/);
  assert.ok(body.indexOf('geladen = true') > body.indexOf('laadt = false'),
    'geladen hoort ook na een fout gezet te worden');
});

test('een mislukte toewijzing zegt WAT er aan de hand is', () => {
  const i = SCHERM.indexOf('window.__wbxInboxToewijzen = async');
  const body = SCHERM.slice(i, i + 1800);
  assert.match(body, /GEEN_GESPREKSRIJ/);
  assert.match(body, /_repaintInboxThreadHeader\(\)/);
});

test('na het toewijzen zeggen de kop en de lijst hetzelfde', () => {
  // De volgende poll zou dat ook doen, maar dan staat er tot 45 seconden lang
  // iets anders dan wat je net gekozen hebt.
  const i = SCHERM.indexOf('window.__wbxInboxToewijzen = async');
  const body = SCHERM.slice(i, i + 2200);
  assert.match(body, /rij\.toegewezen_naam = r\.json\?\.toegewezen_naam/);
  assert.match(body, /_repaintInboxList\(\)/);
});

// ── de initialen ────────────────────────────────────────────────────────────

test('initialen worden uit de naam gehaald, niet uit het id', () => {
  const src = SCHERM.slice(SCHERM.indexOf('function _initialen'), SCHERM.indexOf('function _initialen') + 400);
  const fn = new Function('return ' + src.slice(0, src.indexOf('\n  }') + 4))();
  assert.equal(fn('Dave Jansen'), 'DJ');
  assert.equal(fn('Maxim'), 'MA');
  assert.equal(fn('  Jan   de  Vries '), 'JV');
  assert.equal(fn(''), '?');
  assert.equal(fn(null), '?');
});
