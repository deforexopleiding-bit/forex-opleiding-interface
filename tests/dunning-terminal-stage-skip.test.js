// tests/dunning-terminal-stage-skip.test.js
//
// Bewijst dat de FIX 4 engine-detectie-guard (shouldSkipDueToTerminalStage):
//   1) klanten met een terminal-stage (opgelost/afschrijven) OVERSLAAT zolang
//      alle open facturen dateren van vóór of op stage_changed_at,
//   2) WEL DOORLAAT als er een factuur bij zit met issue_date NA
//      stage_changed_at — dat is de kritieke edge waardoor we mensen niet
//      permanent uitsluiten wanneer ze een nieuwe deal krijgen,
//   3) niet-terminale stages ONVERANDERD laat (bestaand gedrag).
//
// Pure unit-tests — geen DB, geen HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipDueToTerminalStage } from '../api/_lib/dunning-pipeline.js';

// ── Basis: niet-terminale stages blijven ongemoeid ───────────────────

test('niet-terminale stage (nieuw / aangemaand / regeling …) → NOOIT skippen', () => {
  for (const slug of ['nieuw', 'aangemaand', 'in_gesprek', 'regeling', 'brief_verstuurd', 'incasso']) {
    assert.equal(
      shouldSkipDueToTerminalStage({
        stageSlug: slug,
        stageChangedAt: '2026-01-01T00:00:00Z',
        openInvoices: [{ issue_date: '2025-01-01' }],
      }),
      false,
      `stage "${slug}" mag niet skippen`,
    );
  }
});

test('undefined / null / lege stage → niet skippen (defensief)', () => {
  assert.equal(shouldSkipDueToTerminalStage({ stageSlug: null, stageChangedAt: '2026-01-01', openInvoices: [] }), false);
  assert.equal(shouldSkipDueToTerminalStage({ stageSlug: undefined, stageChangedAt: '2026-01-01', openInvoices: [] }), false);
  assert.equal(shouldSkipDueToTerminalStage({ stageSlug: '', stageChangedAt: '2026-01-01', openInvoices: [] }), false);
});

// ── Terminale stages: happy path — allemaal skippen ──────────────────

test('opgelost + oudere facturen → skip', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [
      { issue_date: '2026-05-15' },
      { issue_date: '2026-04-10' },
    ],
  });
  assert.equal(r, true);
});

test('afschrijven + oudere facturen → skip', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'afschrijven',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [{ issue_date: '2026-05-15' }],
  });
  assert.equal(r, true);
});

test('opgelost + factuur EXACT op stage_changed_at (zelfde dag) → skip', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [{ issue_date: '2026-06-01' }],
  });
  assert.equal(r, true, 'zelfde dag telt niet als "nieuwe" factuur');
});

test('opgelost + geen open facturen → skip (klant is af)', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [],
  });
  assert.equal(r, true);
});

// ── DE KRITIEKE EDGE: nieuwe factuur na afsluiting ───────────────────

test('KRITIEK: opgelost + nieuwe factuur (issue_date NA stage_changed_at) → NIET skippen', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [
      { issue_date: '2026-05-15' },   // oud
      { issue_date: '2026-07-10' },   // NIEUW — na afsluiting
    ],
  });
  assert.equal(r, false, 'nieuwe deal moet weer in de flow komen');
});

test('KRITIEK: afschrijven + nieuwe factuur → NIET skippen', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'afschrijven',
    stageChangedAt: '2026-01-01T00:00:00Z',
    openInvoices: [{ issue_date: '2026-07-15' }],
  });
  assert.equal(r, false);
});

test('KRITIEK: opgelost + EXACT één dag na stage_changed_at → NIET skippen', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T23:59:59Z',
    openInvoices: [{ issue_date: '2026-06-02' }],
  });
  assert.equal(r, false, 'dag+1 telt al als nieuwe factuur');
});

// ── Defensieve edges: onvolledige data ───────────────────────────────

test('opgelost zonder stage_changed_at → skip (conservatief)', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: null,
    openInvoices: [{ issue_date: '2026-07-15' }],
  });
  assert.equal(r, true, 'geen datum → we weten het niet, dus behoud terminal-status');
});

test('opgelost + facturen zonder issue_date → skip (conservatief)', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [{ issue_date: null }, { issue_date: '' }, {}],
  });
  assert.equal(r, true);
});

test('opgelost + mix: sommige facturen zonder issue_date, één met nieuwe datum → NIET skippen', () => {
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00Z',
    openInvoices: [
      { issue_date: null },
      { issue_date: '2026-07-01' },   // nieuw
      { issue_date: '2026-05-01' },   // oud
    ],
  });
  assert.equal(r, false, 'nieuwe factuur wint over ontbrekende datums');
});

// ── Case-sensitivity / timezone-drift ────────────────────────────────

test('stage_changed_at met milliseconden + verschillende timezone offsets → vergelijkt op datum-string', () => {
  // Beide dates zijn 2026-06-01 lokaal én UTC (12:00 midden op de dag).
  const r = shouldSkipDueToTerminalStage({
    stageSlug: 'opgelost',
    stageChangedAt: '2026-06-01T12:00:00.123456+02:00',
    openInvoices: [{ issue_date: '2026-06-01T00:00:00.000Z' }],
  });
  assert.equal(r, true, 'zelfde datum = skip, ongeacht time-of-day of tz');
});

test('openInvoices is null / undefined → skip (conservatief)', () => {
  assert.equal(
    shouldSkipDueToTerminalStage({ stageSlug: 'opgelost', stageChangedAt: '2026-06-01', openInvoices: null }),
    true,
  );
  assert.equal(
    shouldSkipDueToTerminalStage({ stageSlug: 'opgelost', stageChangedAt: '2026-06-01', openInvoices: undefined }),
    true,
  );
});
