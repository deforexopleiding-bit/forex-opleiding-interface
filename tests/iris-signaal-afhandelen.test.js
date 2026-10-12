// tests/iris-signaal-afhandelen.test.js
//
// Taak 6, deel 4 — een mentorsignaal afvinken op de dossierkaart.
//
// ── DE REGEL DIE HIER BEWAAKT WORDT ─────────────────────────────────────────
// Er gaat NIETS terug naar het LMS. `hlms_signaal` wordt niet gelezen en niet
// geschreven; de mentor sluit zijn signaal daar zelf af. Wat deze knop zet, is
// ONZE stand: "wij hebben ernaar gekeken". Twee systemen die ieder hun eigen
// stand bijhouden is hier de bedoeling.
//
// Dat is ook waarom het terug kan. Eén klik die een signaal van de kaart haalt
// en daarna niet meer terug kan, is een knop waar je bang voor wordt — en een
// knop waar je bang voor bent, wordt niet gebruikt. `afgehandeld: false` zet
// verwerkt_op weer op NULL, en dát is de voorwaarde om de knop zonder
// bevestigingsvraag te durven aanbieden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EP    = readFileSync(new URL('../api/iris-signaal-afhandelen.js', import.meta.url), 'utf8');
const IRIS  = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
const DOSS  = readFileSync(new URL('../api/_lib/iris/dossier.js', import.meta.url), 'utf8');

const codeVan = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');

const C_EP = codeVan(EP);
const C_IRIS = codeVan(IRIS);

/* ── niets terug naar het LMS ─────────────────────────────────────────────── */

test('het endpoint raakt het LMS met geen enkele regel aan', () => {
  for (const verboden of ['hlms_', 'getDfoLmsClient', 'dfo-lms']) {
    assert.ok(!C_EP.includes(verboden), `het endpoint raakt ${verboden} aan`);
  }
});

test('het endpoint schrijft in precies twee tabellen, en iris_signalen is de enige mutatie', () => {
  const tabellen = [...C_EP.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tabellen)].sort(), ['iris_log', 'iris_signalen']);
  // en de enige update is die op verwerkt_op
  const updates = [...C_EP.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1].trim());
  assert.equal(updates.length, 1);
  assert.match(updates[0], /^verwerkt_op:/);
});

/* ── het kan terug ────────────────────────────────────────────────────────── */

test('afgehandeld: false zet verwerkt_op weer op NULL', () => {
  assert.match(C_EP, /afgehandeld \? new Date\(\)\.toISOString\(\) : null/);
});

test('alles behalve een uitdrukkelijke false is afvinken', () => {
  // Een ontbrekend veld betekent "afgehandeld" — dat is waar de knop voor is.
  // Maar `false` als tekst uit een jsonb-body mag geen heropening worden.
  assert.match(C_EP, /req\.body\?\.afgehandeld !== false/);
});

/* ── poorten ──────────────────────────────────────────────────────────────── */

test('alleen POST, en alleen met het recht iris.belrij', () => {
  assert.match(C_EP, /req\.method !== 'POST'/);
  assert.match(C_EP, /requirePermission\(req, 'iris\.belrij'\)/);
  assert.match(C_EP, /Niet aangemeld/);
});

test('een signaal_id dat geen uuid is komt er niet in', () => {
  assert.match(C_EP, /UUID_RE\.test\(id\)/);
  assert.match(C_EP, /signaal_id moet een geldige uuid zijn/);
});

test('een signaal dat niet bestaat geeft 404 en geen stille 200', () => {
  assert.match(C_EP, /if \(!data\) return res\.status\(404\)/);
  assert.match(C_EP, /maybeSingle\(\)/);
});

/* ── privacy in het logboek ───────────────────────────────────────────────── */

test('de logregel bevat GEEN toelichting van de mentor', () => {
  // Dat is tekst over een student. Het logboek bewaart geen berichtteksten.
  const log = C_EP.slice(C_EP.indexOf("from('iris_log')"), C_EP.indexOf('return res.status(200)'));
  assert.ok(!/toelichting/.test(log), 'de toelichting van de mentor staat in het logboek');
  assert.match(log, /signaal_id: data\.id/);
  assert.match(log, /type: data\.type/);
});

test('een mislukte logregel laat de actie zelf staan', () => {
  // Het signaal is afgevinkt; dat terugdraaien omdat het logboek hikte, zou
  // de gebruiker een fout geven voor iets dat gelukt is.
  assert.match(C_EP, /if \(logFout\) console\.warn/);
});

/* ── het scherm ───────────────────────────────────────────────────────────── */

test('elk signaal krijgt een knop, met de juiste richting', () => {
  assert.match(C_IRIS, /__irisSignaalAf\('\$\{esc\(s\.id\)\}', \$\{klaar \? 'false' : 'true'\}\)/);
  assert.match(IRIS, /klaar \? 'Heropen' : 'Afgehandeld'/);
});

test('de knop zegt in zijn titel dat het LMS niet wordt aangepast', () => {
  assert.match(IRIS, /Het LMS wordt niet aangepast/);
});

test('een afgehandeld signaal verdwijnt NIET van de kaart', () => {
  // Verbergen betekent dat je niet kunt zien dat iemand er net op geklikt
  // heeft, en dan klikt de volgende nog een keer.
  assert.match(C_IRIS, /opacity:\$\{klaar \? '\.55' : '1'\}/);
  assert.match(IRIS, /afgehandeld \$\{esc\(tijdKort\(s\.verwerkt_op\)\)\} — alleen hier, niet in het LMS/);
});

test('open signalen staan boven de afgehandelde', () => {
  assert.match(C_IRIS, /const ax = x\.verwerkt_op \? 1 : 0, ay = y\.verwerkt_op \? 1 : 0;/);
});

test('de rij wordt bijgewerkt met wat de SERVER teruggaf, niet met een eigen gok', () => {
  assert.match(C_IRIS, /lijst\[i\] = \{ \.\.\.lijst\[i\], \.\.\.j\.signaal \}/);
});

test('twee klikken tegelijk op dezelfde kaart kan niet', () => {
  assert.match(C_IRIS, /if \(!signaalId \|\| S\.signaalBezig\) return;/);
  assert.match(C_IRIS, /signaalBezig: null,/);
});

test('de belrij wordt opnieuw opgehaald: een afgehandeld signaal levert geen reden meer', () => {
  const fn = C_IRIS.slice(C_IRIS.indexOf('window.__irisSignaalAf'), C_IRIS.indexOf('async function haalInstellingen'));
  assert.match(fn, /S\.belrij\.opgehaald = false/);
});

test('een fout komt op het scherm en wordt niet stil weggeslikt', () => {
  const fn = C_IRIS.slice(C_IRIS.indexOf('window.__irisSignaalAf'), C_IRIS.indexOf('async function haalInstellingen'));
  assert.match(fn, /toast\(e\?\.message \|\| 'Signaal niet bijgewerkt', 'error'\)/);
});

/* ── de kaart heeft de velden die hij nodig heeft ─────────────────────────── */

test('het dossier geeft id en verwerkt_op mee, anders kan de knop niets', () => {
  assert.match(DOSS, /from\('iris_signalen'\)[\s\S]{0,200}?\.select\('id, type, mentor_naam, toelichting, gevraagde_actie, signaal_op, verwerkt_op'\)/);
});

test('het scherm heeft een nieuw nummer', () => {
  const m = INDEX.match(/\.\.\/iris\/iris\.js\?v=(\d+)/);
  assert.ok(m, 'iris.js wordt zonder ?v= geladen');
  assert.ok(Number(m[1]) >= 26, `?v=${m[1]} is lager dan de 26 van deze PR`);
});
