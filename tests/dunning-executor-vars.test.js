// tests/dunning-executor-vars.test.js
//
// Regressietest voor buildMetaTemplateVariables() in
// api/_lib/dunning-step-executors.js. Pure functie — geen DB, geen HTTP.
// Focus: fix van #132000 ("Number of parameters does not match") die
// optrad zodra een dunning-template dot-notation gebruikte (klant.*).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetaTemplateVariables } from '../api/_lib/dunning-step-executors.js';

// ── Dot-notation (het bug-scenario dat Meta #132000 veroorzaakte) ─────────

test('dot-notation: 2 placeholders in body-volgorde → exact 2 params', () => {
  const body = 'Hoi {{klant.voornaam}}, je hebt {{klant.totaal_open}} openstaand.';
  const used = { 'klant.voornaam': 'Karl', 'klant.totaal_open': 'EUR 80,00' };
  const out = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out, ['Karl', 'EUR 80,00']);
});

test('dot-notation: klant.totaal_open EERST in body → is param 1', () => {
  // Bewijst dat de volgorde uit de BODY komt, niet uit een vaste key-lijst.
  const body = 'Openstaand: {{klant.totaal_open}} voor {{klant.voornaam}}.';
  const used = { 'klant.voornaam': 'Karl', 'klant.totaal_open': 'EUR 80,00' };
  const out = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out, ['EUR 80,00', 'Karl']);
});

// ── Legacy hoofdletter-templates (regressie-anker) ───────────────────────

test('legacy HOOFDLETTER: bestaande templates blijven werken', () => {
  const body = 'Hoi {{NAAM}}, u heeft {{TOTAAL_BEDRAG}} openstaand op {{FACTUUR_NR}}.';
  const used = { NAAM: 'Karl Test', TOTAAL_BEDRAG: 'EUR 100,00', FACTUUR_NR: '2026-0001' };
  const out = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out, ['Karl Test', 'EUR 100,00', '2026-0001']);
});

// ── Placeholder zonder waarde → lege string, aantal blijft kloppen ──────

test('placeholder zonder waarde in variables_used → lege string, aantal correct', () => {
  const body = 'Hoi {{klant.voornaam}}, factuur {{factuur.nummer}}.';
  const used = { 'klant.voornaam': 'Karl' }; // factuur.nummer ontbreekt
  const out = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out, ['Karl', '']);
  assert.equal(out.length, 2, 'aantal moet altijd 2 zijn — Meta accepteert geen gaten');
});

// ── Dubbele placeholder → dedupe naar 1 param, first-occurrence order ────

test('dubbele placeholder → dedupe naar 1 entry', () => {
  const body = '{{klant.voornaam}}, u heeft {{klant.totaal_open}}. Nogmaals {{klant.voornaam}}.';
  const used = { 'klant.voornaam': 'Karl', 'klant.totaal_open': 'EUR 80,00' };
  const out = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out, ['Karl', 'EUR 80,00']);
});

// ── Gemengd (hoofdletter + dot-notation) ─────────────────────────────────

test('gemengd: dot en hoofdletter door elkaar → volgorde van voorkomen', () => {
  const body = 'Hoi {{klant.voornaam}} ({{NAAM}}), {{klant.totaal_open}} = {{TOTAAL_BEDRAG}}';
  const used = {
    'klant.voornaam':    'Karl',
    NAAM:                'Karl Test',
    'klant.totaal_open': 'EUR 80,00',
    TOTAAL_BEDRAG:       'EUR 80,00',
  };
  const out = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out, ['Karl', 'Karl Test', 'EUR 80,00', 'EUR 80,00']);
});

// ── Edge cases ───────────────────────────────────────────────────────────

test('body zonder placeholders → []', () => {
  assert.deepEqual(buildMetaTemplateVariables('Hoi allemaal, hartelijk dank.', {}), []);
});

test('body null/undefined → []', () => {
  assert.deepEqual(buildMetaTemplateVariables(null, {}), []);
  assert.deepEqual(buildMetaTemplateVariables(undefined, {}), []);
});

test('variables_used null/undefined → alleen lege strings (aantal correct)', () => {
  const body = 'Hoi {{klant.voornaam}}, {{klant.totaal_open}}.';
  assert.deepEqual(buildMetaTemplateVariables(body, null), ['', '']);
  assert.deepEqual(buildMetaTemplateVariables(body, undefined), ['', '']);
});

test('value is null in variables_used → lege string (geen "null"-string)', () => {
  const body = 'Hoi {{klant.voornaam}}';
  const out  = buildMetaTemplateVariables(body, { 'klant.voornaam': null });
  assert.deepEqual(out, ['']);
});

test('value is number → gecast naar string', () => {
  const body = 'Aantal: {{klant.aantal_open}}';
  const out  = buildMetaTemplateVariables(body, { 'klant.aantal_open': 3 });
  assert.deepEqual(out, ['3']);
});

// ── Regex-precisie: onbekende brackets negeren ───────────────────────────

test('regex negeert non-matchende brackets', () => {
  // {{Not-A-Key}} matcht niet (bevat '-'), {{123}} matcht niet (positional).
  // {{onbekend.key}} matcht wel als 'ie lowercase dot-notation heeft — dan is
  // 't gewoon een placeholder zonder waarde in variables_used.
  const body = 'Iets {{NAAM}} en {{Not-A-Key}} en {{123}} en {{onbekend.key}}.';
  const out  = buildMetaTemplateVariables(body, { NAAM: 'Karl' });
  assert.deepEqual(out, ['Karl', '']);
});

// ── Multi-run: state van globale regex mag niet lekken ───────────────────

test('multi-run: geen state-lekkage tussen aanroepen', () => {
  const body = 'Hoi {{klant.voornaam}}';
  const used = { 'klant.voornaam': 'A' };
  const out1 = buildMetaTemplateVariables(body, used);
  const out2 = buildMetaTemplateVariables(body, used);
  const out3 = buildMetaTemplateVariables(body, used);
  assert.deepEqual(out1, ['A']);
  assert.deepEqual(out2, ['A']);
  assert.deepEqual(out3, ['A']);
});
