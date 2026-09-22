// tests/iris-templates.test.js
//
// De keuze van een goedgekeurde template buiten het venster van 24 uur.
//
// De regel waar dit bestand omheen draait: filteren op STATUS, niet op naam.
// Namen veranderen, APPROVED niet. Een template die bij Meta op PAUSED staat
// en die we toch sturen, levert een geweigerd bericht op en op den duur een
// slechtere beoordeling van het nummer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOORKEUR,
  ESCALATIE_TEMPLATE,
  BRUIKBARE_STATUS,
  bruikbaar,
  kiesTemplate,
  terugvalpad,
  controleerVariabelen,
} from '../api/_lib/iris/templates.js';
import { CATEGORIEEN } from '../api/_lib/iris/instellingen.js';

const T = (naam, extra = {}) => ({
  name: naam, language: 'nl', status: 'APPROVED', category: 'UTILITY',
  body_text: 'Beste klant, …', ...extra,
});

// ── wat bruikbaar is ────────────────────────────────────────────────────────

test('alleen goedgekeurde templates zijn bruikbaar', () => {
  const lijst = [
    T('a'), T('b', { status: 'PENDING' }), T('c', { status: 'REJECTED' }),
    T('d', { status: 'PAUSED' }), T('e', { status: 'LOCAL' }),
  ];
  assert.deepEqual(bruikbaar(lijst).map((t) => t.name), ['a']);
});

test('PAUSED wordt uitdrukkelijk geweigerd — dat is de stille valkuil', () => {
  // Een gepauzeerde template ziet er in de lijst hetzelfde uit als een
  // goedgekeurde. Versturen geeft een geweigerd bericht.
  assert.equal(bruikbaar([T('x', { status: 'PAUSED' })]).length, 0);
});

test('MARKETING valt af, ook als hij goedgekeurd is', () => {
  // Een betalingsherinnering onder marketing versturen is een overtreding van
  // Meta's eigen indeling, en het is een categorie waar klanten zich voor
  // kunnen afmelden — dan mist een aanmaning zijn doel.
  assert.equal(bruikbaar([T('x', { category: 'MARKETING' })]).length, 0);
  assert.equal(bruikbaar([T('x', { category: 'marketing' })]).length, 0);
});

test('UTILITY en AUTHENTICATION mogen wel', () => {
  assert.equal(bruikbaar([T('a'), T('b', { category: 'AUTHENTICATION' })]).length, 2);
});

test('een template zonder naam is geen template', () => {
  assert.equal(bruikbaar([{ status: 'APPROVED' }, null, undefined]).length, 0);
});

test('rommel als lijst geeft een lege lijst', () => {
  assert.deepEqual(bruikbaar(null), []);
  assert.deepEqual(bruikbaar('x'), []);
});

// ── kiezen ──────────────────────────────────────────────────────────────────

test('de voorkeurstemplate wordt gekozen als hij bestaat', () => {
  const r = kiesTemplate([T('aanmaning_dag7'), T('iets_anders')], 'wanbetaling_reactie');
  assert.equal(r.template.name, 'aanmaning_dag7');
});

test('de volgorde van voorkeur wordt gevolgd', () => {
  const r = kiesTemplate([T('aanmaning_dag7'), T('factuur_vraag')], 'facturatie');
  assert.equal(r.template.name, 'factuur_vraag', 'de eerste voorkeur wint');
});

test('valt de eerste voorkeur weg, dan komt de tweede', () => {
  const r = kiesTemplate([T('aanmaning_dag7')], 'facturatie');
  assert.equal(r.template.name, 'aanmaning_dag7');
});

test('een voorkeurstemplate die NIET goedgekeurd is, telt niet mee', () => {
  const r = kiesTemplate([T('factuur_vraag', { status: 'PAUSED' }), T('aanmaning_dag7')], 'facturatie');
  assert.equal(r.template.name, 'aanmaning_dag7');
});

test('bestaat er geen enkele voorkeurstemplate, dan geen keuze maar wel alternatieven', () => {
  const r = kiesTemplate([T('iets_heel_anders')], 'facturatie');
  assert.equal(r.template, null);
  assert.match(r.reden, /bestaan niet of zijn niet goedgekeurd/);
  assert.equal(r.alternatieven.length, 1, 'de alternatieven worden wél getoond zodat een mens kan kiezen');
});

test('voor een opzegging of klacht gaat er NOOIT automatisch een template weg', () => {
  const r = kiesTemplate([T('aanmaning_dag7'), T('opvolging_geen_reactie2')], 'opzeg_klacht_juridisch');
  assert.equal(r.template, null);
  assert.match(r.reden, /nooit automatisch/);
});

test('spam en bounces krijgen ook geen template', () => {
  assert.equal(kiesTemplate([T('aanmaning_dag7')], 'spam').template, null);
  assert.equal(kiesTemplate([T('aanmaning_dag7')], 'bounce_systeem').template, null);
});

test('een onbekende categorie wordt geweigerd', () => {
  const r = kiesTemplate([T('a')], 'verzonnen');
  assert.equal(r.template, null);
  assert.match(r.reden, /onbekende categorie/);
});

test('zonder enige goedgekeurde template is dat de reden', () => {
  const r = kiesTemplate([T('a', { status: 'PENDING' })], 'facturatie');
  assert.equal(r.template, null);
  assert.match(r.reden, /geen enkele goedgekeurde template/);
});

// ── taal ────────────────────────────────────────────────────────────────────

test('nl_BE en nl_NL tellen als nl', () => {
  // Een template weigeren omdat er _BE achter staat, zou betekenen dat we
  // naar Vlaanderen niets kunnen sturen.
  assert.equal(kiesTemplate([T('aanmaning_dag7', { language: 'nl_BE' })], 'wanbetaling_reactie').template?.name, 'aanmaning_dag7');
  assert.equal(kiesTemplate([T('aanmaning_dag7', { language: 'nl_NL' })], 'wanbetaling_reactie').template?.name, 'aanmaning_dag7');
});

test('een Engelse template wordt niet gekozen voor een Nederlands gesprek', () => {
  const r = kiesTemplate([T('aanmaning_dag7', { language: 'en_US' })], 'wanbetaling_reactie');
  assert.equal(r.template, null);
});

// ── de terugval ─────────────────────────────────────────────────────────────

test('met een mailadres gaat het via mail', () => {
  const r = terugvalpad({ heeftEmail: true, categorie: 'facturatie' });
  assert.equal(r.pad, 'mail');
});

test('zonder mailadres wordt er gewacht, en NIET een andere template geforceerd', () => {
  // Een bericht persen in een template die er niet over gaat, is erger dan een
  // dag wachten: de klant leest dan iets wat niet bij zijn vraag past en
  // concludeert dat er niemand meekijkt.
  const r = terugvalpad({ heeftEmail: false, categorie: 'lms_support' });
  assert.equal(r.pad, 'wachten');
  assert.match(r.uitleg, /template-wensen\.md/);
});

// ── de variabelen ───────────────────────────────────────────────────────────

test('een template zonder variabelen heeft er geen nodig', () => {
  const r = controleerVariabelen(T('a', { body_text: 'Hallo, we hebben je bericht ontvangen.' }), []);
  assert.equal(r.ok, true);
  assert.equal(r.nodig, 0);
});

test('genummerde plaatshouders worden geteld', () => {
  const t = T('a', { body_text: 'Beste {{1}}, je factuur {{2}} staat open.' });
  assert.equal(controleerVariabelen(t, ['Jan', 'F-001']).ok, true);
  assert.equal(controleerVariabelen(t, ['Jan']).ok, false);
});

test('een tekort aan waarden wordt UITGELEGD, niet alleen gemeld', () => {
  // Meta geeft hierop een 400 die er in de logs uitziet als een vaag probleem
  // met de componenten. Dan is een leesbare reden het halve werk.
  const t = T('a', { body_text: 'Beste {{1}}, je factuur {{2}} van {{3}} staat open.' });
  const r = controleerVariabelen(t, ['Jan']);
  assert.equal(r.ok, false);
  assert.match(r.reden, /3 waarde/);
  assert.match(r.reden, /is er 1/);
});

test('het hoogste nummer telt, niet het aantal plaatshouders', () => {
  // {{1}} en {{3}} zonder {{2}} betekent dat Meta er drie verwacht.
  const t = T('a', { body_text: 'Beste {{1}}, zie {{3}}.' });
  assert.equal(controleerVariabelen(t, ['a', 'b']).ok, false);
  assert.equal(controleerVariabelen(t, ['a', 'b', 'c']).ok, true);
});

test('benoemde plaatshouders worden ook herkend', () => {
  const t = T('a', { body_text: 'Beste {{klant.naam}}, je factuur {{factuur.nummer}} staat open.' });
  assert.equal(controleerVariabelen(t, ['Jan']).ok, false);
  assert.equal(controleerVariabelen(t, ['Jan', 'F-001']).ok, true);
});

test('meer waarden dan nodig is geen probleem', () => {
  const t = T('a', { body_text: 'Beste {{1}}.' });
  assert.equal(controleerVariabelen(t, ['Jan', 'extra']).ok, true);
});

test('een object met waarden telt ook', () => {
  const t = T('a', { body_text: 'Beste {{1}}, zie {{2}}.' });
  assert.equal(controleerVariabelen(t, { a: 1, b: 2 }).ok, true);
  assert.equal(controleerVariabelen(t, { a: 1 }).ok, false);
});

// ── samenhang ───────────────────────────────────────────────────────────────

test('elke categorie staat in de voorkeurslijst — er valt er geen door de mazen', () => {
  for (const c of CATEGORIEEN) {
    assert.ok(Array.isArray(VOORKEUR[c]), `${c} ontbreekt in de voorkeurslijst`);
  }
});

test('de escalatietemplate is er een die we kennen', () => {
  assert.equal(ESCALATIE_TEMPLATE, 'opvolging_geen_reactie2');
  assert.ok(Object.values(VOORKEUR).some((l) => l.includes(ESCALATIE_TEMPLATE)));
});

test('alleen APPROVED telt als bruikbaar', () => {
  assert.equal(BRUIKBARE_STATUS, 'APPROVED');
});
