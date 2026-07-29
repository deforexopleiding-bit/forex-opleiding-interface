// tests/dunning-pipeline-skip-stages.test.js
//
// Acties-tab v1 — bewijst dat de engine-guard shouldSkipDueToTerminalStage
// (nu bredere semantiek dan de naam suggereert — dekt ook dispuut/bewind)
// EXACT de juiste stages skipt en de rest ONVERANDERD doorlaat.
//
// Dit is DE kritieke test-matrix voor deze PR:
//   * Skip-stages: opgelost, afschrijven, dispuut, bewind.
//   * Niet-skip stages: nieuw, aangemaand, in_gesprek, regeling,
//     brief_verstuurd, incasso.
//   * "Nieuwe factuur ná parkering" edge geldt voor alle 4 skip-stages
//     (geen permanente uitsluiting bij dispuut/bewind, net als bij terminal).
//
// Pure tests. Geen DB, geen HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_TERMINAL_STAGES,
  PIPELINE_SKIP_STAGES,
  shouldSkipDueToTerminalStage,
  shouldSkipDueToPipelineStage,
} from '../api/_lib/dunning-pipeline.js';

// ── Set-samenstelling ──────────────────────────────────────────────

test('PIPELINE_TERMINAL_STAGES: exact {opgelost, afschrijven}', () => {
  assert.equal(PIPELINE_TERMINAL_STAGES.size, 2);
  assert.ok(PIPELINE_TERMINAL_STAGES.has('opgelost'));
  assert.ok(PIPELINE_TERMINAL_STAGES.has('afschrijven'));
});

test('PIPELINE_SKIP_STAGES: exact {opgelost, afschrijven, dispuut, bewind}', () => {
  assert.equal(PIPELINE_SKIP_STAGES.size, 4);
  for (const s of ['opgelost', 'afschrijven', 'dispuut', 'bewind']) {
    assert.ok(PIPELINE_SKIP_STAGES.has(s), `mist stage "${s}"`);
  }
});

test('shouldSkipDueToPipelineStage is alias van shouldSkipDueToTerminalStage', () => {
  assert.equal(shouldSkipDueToPipelineStage, shouldSkipDueToTerminalStage);
});

// ── NIET-SKIP STAGES: engine moet NORMAAL oppakken (regressie-check) ──

test('regressie: nieuw + oude factuur → NIET skippen (engine pakt op)', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'nieuw',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2025-01-01' }],
    }),
    false,
  );
});

test('regressie: aangemaand → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'aangemaand',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-01' }],
    }),
    false,
  );
});

test('regressie: in_gesprek → NIET skippen (klant is in gesprek, engine pakt volgende stap op zodra pauze op is)', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'in_gesprek',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-01' }],
    }),
    false,
  );
});

test('regressie: regeling → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'regeling',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-01' }],
    }),
    false,
  );
});

test('regressie: brief_verstuurd → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'brief_verstuurd',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-01' }],
    }),
    false,
  );
});

test('regressie: incasso → NIET skippen (engine loopt door)', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'incasso',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-01' }],
    }),
    false,
  );
});

// ── SKIP STAGES: engine moet OVERSLAAN ────────────────────────────────

test('opgelost + oude facturen → skip', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'opgelost',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-15' }],
    }),
    true,
  );
});

test('afschrijven + oude facturen → skip', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'afschrijven',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-15' }],
    }),
    true,
  );
});

test('NIEUW: dispuut + oude facturen → skip', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'dispuut',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-15' }],
    }),
    true,
  );
});

test('NIEUW: bewind + oude facturen → skip', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'bewind',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-05-15' }],
    }),
    true,
  );
});

// ── KRITIEKE EDGE (verificatie-check 2 uit Jeffrey's brief) ──────────
// Klant in dispuut/bewind + NIEUWE factuur (na stage-parkering) → NIET
// permanent uitsluiten. Dit is dé check die stille lekken voorkomt.

test('KRITIEK: dispuut + NIEUWE factuur na stage_changed_at → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'dispuut',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [
        { issue_date: '2026-05-15' }, // oud
        { issue_date: '2026-07-10' }, // NIEUW — na stage-parkering
      ],
    }),
    false,
    'nieuwe deal moet weer in de flow komen, ook al staat klant in dispuut',
  );
});

test('KRITIEK: bewind + NIEUWE factuur na stage_changed_at → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'bewind',
      stageChangedAt: '2026-01-01T00:00:00Z',
      openInvoices: [{ issue_date: '2026-07-15' }],
    }),
    false,
    'nieuwe deal na bewind moet niet permanent uitgesloten worden',
  );
});

test('KRITIEK: dispuut + factuur EXACT dag+1 na stage_changed_at → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'dispuut',
      stageChangedAt: '2026-06-01T23:59:59Z',
      openInvoices: [{ issue_date: '2026-06-02' }],
    }),
    false,
    'dag+1 telt al als nieuwe factuur — geen off-by-one uitsluiting',
  );
});

test('regressie kritieke edge blijft werken voor terminal (opgelost): nieuwe factuur → NIET skippen', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'opgelost',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: '2026-07-10' }],
    }),
    false,
  );
});

// ── Conservatieve defaults ────────────────────────────────────────────

test('dispuut zonder stage_changed_at → skip (conservatief)', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'dispuut',
      stageChangedAt: null,
      openInvoices: [{ issue_date: '2026-07-15' }],
    }),
    true,
  );
});

test('bewind + facturen zonder issue_date → skip (conservatief)', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({
      stageSlug: 'bewind',
      stageChangedAt: '2026-06-01T12:00:00Z',
      openInvoices: [{ issue_date: null }, {}, { issue_date: '' }],
    }),
    true,
  );
});

// ── Onbekende / null stages ───────────────────────────────────────────

test('onbekende stage-slug → NIET skippen (defensief; engine bepaalt zelf)', () => {
  for (const slug of ['unknown_future_stage', '', null, undefined]) {
    assert.equal(
      shouldSkipDueToTerminalStage({
        stageSlug: slug,
        stageChangedAt: '2026-06-01T12:00:00Z',
        openInvoices: [{ issue_date: '2025-01-01' }],
      }),
      false,
      `stage ${JSON.stringify(slug)} mag niet skippen (whitelist-benadering)`,
    );
  }
});
