// tests/inbox-overzicht-bronnen.test.js
//
// De bronnenlijst van het Inbox-overzicht, en waarom hij niet op drie plekken
// mag staan.
//
// Aanleiding is G10 uit docs/iris/02-gesprekken-audit.md: `onboarding@` werd al
// elke vijf minuten opgehaald en is in de E-mail-module gewoon te openen, maar
// ontbrak in inbox-v2.js. Wie het Inbox-overzicht gebruikt als het
// bakje-waar-alles-in-komt, zag die postbus dus nooit.
//
// Die bron erbij zetten is één regel. Het risico zit in de regels eromheen: de
// bronnenlijst stond in vijf verschillende opsommingen (registry, groepen,
// endpoints, _VALID_SRCS, de staat) plus twee plekken die de e-mailbronnen bij
// naam noemden. Drie ervan vergeten valt niet op — de bron verschijnt gewoon,
// telt alleen verkeerd of laat zich niet via een deep-link openen.
//
// Deze test loopt de opsommingen tegen elkaar na, zodat de volgende bron die
// erbij komt niet half aangesloten kan raken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/inbox-v2.js'), 'utf8');

/** De id's uit de IB_SRC-registry, in volgorde. */
function bronIds() {
  const blok = bron.slice(bron.indexOf('const IB_SRC = ['), bron.indexOf('const IB_GRP'));
  return [...blok.matchAll(/^\s*\['([a-z_]+)',/gm)].map((m) => m[1]);
}

/** De id's die in SRC_ENDPOINTS een adres hebben. */
function endpointIds() {
  const blok = bron.slice(bron.indexOf('const SRC_ENDPOINTS = {'));
  const eind = blok.indexOf('\n  };');
  return [...blok.slice(0, eind).matchAll(/^\s*([a-z_]+):\s*\{/gm)].map((m) => m[1]);
}

/** De id's die in een groep van de zijbalk staan. */
function groepIds() {
  const blok = bron.slice(bron.indexOf('const IB_GRP = ['), bron.indexOf('const SRC_ENDPOINTS'));
  return [...blok.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((x) => x !== '');
}

test('onboarding@ staat in de bronnenlijst', () => {
  assert.ok(bronIds().includes('m_onb'), 'G10: de postbus ontbreekt nog steeds');
});

test('onboarding@ wijst naar de juiste postbus', () => {
  assert.match(bron, /m_onb:\s*\{ url: '\/api\/email-inbox-list\?mailbox=onboarding/);
  assert.match(bron, /m_onb:.*mailbox: 'onboarding'/);
});

test('elke bron heeft een endpoint', () => {
  const zonder = bronIds().filter((id) => !endpointIds().includes(id));
  assert.deepEqual(zonder, [], 'bron zonder adres — die telt altijd "—"');
});

test('elke bron staat in een groep', () => {
  const groepen = groepIds();
  const wees = bronIds().filter((id) => !groepen.includes(id));
  assert.deepEqual(wees, [], 'bron die in geen enkele groep staat is onzichtbaar in de zijbalk');
});

test('de lijst met geldige bronnen wordt afgeleid, niet overgetypt', () => {
  // Een tweede handmatige opsomming raakt uit de pas met de eerste, en dan
  // werkt de deep-link-hint naar die bron stil niet meer.
  assert.match(bron, /_VALID_SRCS = IB_SRC\.map\(/);
});

test('de staat krijgt zijn sleutels uit de registry', () => {
  assert.match(bron, /sources: Object\.fromEntries\(IB_SRC\.map\(/);
});

test('de e-mailtakken herkennen hun bron aan het soort, niet aan een naam', () => {
  // `v === 'm_adm' || v === 'm_info'` was de opsomming die bij een derde
  // postbus stilletjes fout gaat: die bron telt dan items in plaats van het
  // echte totaal, zonder dat er iets stuk lijkt.
  // Alleen de code: de toelichting hierboven mag de oude vorm wél noemen, dus
  // eerst de blok- en regelcommentaren eruit.
  const code = bron.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/v === 'm_adm'/.test(code), 'de oude opsomming staat er nog');
  assert.match(bron, /function _isEmailSrc\(v\)/);
  // Twee aanroepen (srcCount + srcCountDisplay), los van de definitie zelf.
  const gebruik = (code.match(/if \(_isEmailSrc\(v\)\)/g) || []).length;
  assert.equal(gebruik, 2, 'beide teltakken horen via _isEmailSrc te lopen');
});
