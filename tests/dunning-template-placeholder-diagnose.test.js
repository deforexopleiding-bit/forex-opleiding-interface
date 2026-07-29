// tests/dunning-template-placeholder-diagnose.test.js
//
// Bewijst het regex-gedrag rond Meta #132000:
// - buildMetaTemplateVariables telt N-delige dot-notation én HOOFDLETTER-legacy
// - diagnoseTemplatePlaceholders signaleert placeholders die de nauwe regex mist
//
// Kern-regressie-guard: 2-delige templates uit 2026-07-21-seed (aanmaning_dag*)
// MOETEN ongewijzigd blijven werken. 3-delige én lowercase-zonder-punt
// MOETEN nu correct gedetecteerd worden (voorheen stil overgeslagen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMetaTemplateVariables,
  diagnoseTemplatePlaceholders,
} from '../api/_lib/dunning-template-placeholders.js';

// ── Regressie-guard: 21-juli seed-templates blijven werken ─────────────────

test('aanmaning_dag7 body (5 vars) — matched=5, unmatched=0', () => {
  const body =
    'Hoi {{klant.voornaam}},\n' +
    'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR ' +
    '{{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' +
    'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 5);
  assert.equal(diag.n_missing, 0);
  assert.deepEqual(diag.matched, [
    'klant.voornaam', 'factuur.nummer', 'factuur.bedrag',
    'factuur.vervaldatum', 'factuur.betaal_link',
  ]);
});

test('aanmaning_dag14 body (4 vars) — matched=4, unmatched=0', () => {
  const body =
    'Hoi {{klant.voornaam}},\n' +
    'Factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat inmiddels ' +
    '{{factuur.dagen_overdue}} dagen open.';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 4);
  assert.equal(diag.n_missing, 0);
});

test('HOOFDLETTER-legacy blijft werken (backwards-compat)', () => {
  const body = 'Beste {{NAAM}}, betaal {{TOTAAL_BEDRAG}} vóór {{VERVALDATUM}}.';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 3);
  assert.equal(diag.n_missing, 0);
  assert.deepEqual(diag.matched, ['NAAM', 'TOTAAL_BEDRAG', 'VERVALDATUM']);
});

// ── Nieuw: 3-delige dot-notation (was stil overgeslagen vóór deze PR) ───

test('3-delige key {{klant.factuur.bedrag_open}} wordt NU wél gematcht', () => {
  const body = 'Hoi {{klant.voornaam}}, uw {{klant.factuur.bedrag_open}} is open.';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 2);
  assert.equal(diag.n_missing, 0, 'oude regex miste 3-delige — nu opgelost');
  assert.ok(diag.matched.includes('klant.factuur.bedrag_open'));
});

test('4+delige key wordt óók gematcht', () => {
  const body = '{{a.b.c.d}} → {{e.f}}';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 2);
});

// ── Fail-loud: placeholders die de nauwe regex NIET matcht ────────────

test('lowercase zonder punt ({{voornaam}}) belandt in unmatched', () => {
  const body = 'Hoi {{voornaam}}, uw {{factuur.nummer}} staat open.';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 1, 'alleen factuur.nummer matcht');
  assert.equal(diag.n_missing, 1);
  assert.deepEqual(diag.unmatched, ['voornaam']);
});

test('Mixed-case ({{Klant.voornaam}}) belandt in unmatched', () => {
  const body = '{{Klant.voornaam}} met {{factuur.nummer}}';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.n_missing, 1);
  assert.deepEqual(diag.unmatched, ['Klant.voornaam']);
});

test('Whitespace binnen placeholder ({{ voornaam }}) belandt in unmatched', () => {
  const body = 'Hoi {{ voornaam }} van {{ factuur.nummer }}';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.n_missing, 2);
});

test('Positionele placeholders ({{1}}) belandt in unmatched — Meta-native syntax die code niet ondersteunt', () => {
  const body = 'Hallo {{1}}, uw factuur {{2}} van {{3}}';
  const diag = diagnoseTemplatePlaceholders(body);
  assert.equal(diag.total_count, 0);
  assert.equal(diag.n_missing, 3);
  assert.deepEqual(diag.unmatched, ['1', '2', '3']);
});

// ── buildMetaTemplateVariables integratie ─────────────────────────────

test('build met 3-delige key: N-de key → N-de positie in output', () => {
  const body = '{{a.b}} {{c.d.e}} {{f.g}}';
  const vals = { 'a.b': 'X', 'c.d.e': 'Y', 'f.g': 'Z' };
  const out = buildMetaTemplateVariables(body, vals);
  assert.deepEqual(out, ['X', 'Y', 'Z']);
});

test('build met ontbrekende value → lege string (AANTAL blijft kloppend voor Meta)', () => {
  const body = '{{a.b}} {{c.d}}';
  const vals = { 'a.b': 'X' };
  const out = buildMetaTemplateVariables(body, vals);
  assert.deepEqual(out, ['X', '']);
  assert.equal(out.length, 2, 'Meta krijgt evenveel params als placeholders — geen #132000');
});

test('build dedupliceert: dezelfde key 2x = 1 param', () => {
  const body = '{{a.b}} en nog eens {{a.b}} en {{c.d}}';
  const out = buildMetaTemplateVariables(body, { 'a.b': 'X', 'c.d': 'Y' });
  assert.deepEqual(out, ['X', 'Y']);
});

test('build: lege body → lege output', () => {
  assert.deepEqual(buildMetaTemplateVariables('', {}), []);
  assert.deepEqual(buildMetaTemplateVariables(null, {}), []);
});

test('diagnose: lege body → alles nul, geen crash', () => {
  const d = diagnoseTemplatePlaceholders('');
  assert.deepEqual(d, { matched: [], unmatched: [], total_count: 0, raw_count: 0, n_missing: 0 });
});

test('diagnose: null body → alles nul, geen crash', () => {
  const d = diagnoseTemplatePlaceholders(null);
  assert.equal(d.total_count, 0);
});
