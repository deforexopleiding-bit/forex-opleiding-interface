// tests/dunning-auto-brief-gate.test.js
//
// Pure unit-tests voor shouldAutoGenerateBrief(step, stepResult): de gate die
// bepaalt of de dunning-engine de WIK-brief auto-genereert. Vuurt ALLEEN op een
// succesvol verzonden WhatsApp op een stap met config.auto_generate_brief=true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoGenerateBrief } from '../api/_lib/dunning-engine.js';

const OK_WA = { status: 'ok', log_event: 'whatsapp_sent' };
const stepWA = (extra = {}) => ({ step_type: 'whatsapp', config: { auto_generate_brief: true }, ...extra });

// ── Happy path ──────────────────────────────────────────────────────────────

test('whatsapp_sent + vlag=true → true', () => {
  assert.equal(shouldAutoGenerateBrief(stepWA(), OK_WA), true);
});

// ── Kanaal-gate: nooit op de e-mailstap ─────────────────────────────────────

test('e-mailstap met vlag=true → false (dubbel-gate op step_type)', () => {
  const emailStep = { step_type: 'email', config: { auto_generate_brief: true } };
  assert.equal(shouldAutoGenerateBrief(emailStep, { status: 'ok', log_event: 'email_sent' }), false);
});

test('whatsapp met vlag=true maar log_event=email_sent → false', () => {
  assert.equal(shouldAutoGenerateBrief(stepWA(), { status: 'ok', log_event: 'email_sent' }), false);
});

// ── Vlag-gate: alleen expliciet aangewezen stappen ──────────────────────────

test('whatsapp zonder vlag → false', () => {
  assert.equal(shouldAutoGenerateBrief({ step_type: 'whatsapp', config: {} }, OK_WA), false);
});

test('whatsapp met vlag=false → false', () => {
  assert.equal(shouldAutoGenerateBrief({ step_type: 'whatsapp', config: { auto_generate_brief: false } }, OK_WA), false);
});

test('vlag truthy maar niet strikt true (1/"true") → false', () => {
  assert.equal(shouldAutoGenerateBrief({ step_type: 'whatsapp', config: { auto_generate_brief: 1 } }, OK_WA), false);
  assert.equal(shouldAutoGenerateBrief({ step_type: 'whatsapp', config: { auto_generate_brief: 'true' } }, OK_WA), false);
});

// ── Send-succes-gate: alleen bij daadwerkelijke verzending ──────────────────

test('gefaalde send (status=failed) → false', () => {
  assert.equal(shouldAutoGenerateBrief(stepWA(), { status: 'failed', log_event: 'whatsapp_send_failed' }), false);
});

test('overgeslagen send (whatsapp_skipped_*) → false', () => {
  assert.equal(shouldAutoGenerateBrief(stepWA(), { status: 'ok', log_event: 'whatsapp_skipped_no_phone' }), false);
});

// ── Defensief: rommelige input ──────────────────────────────────────────────

test('ontbrekende step / stepResult → false (geen throw)', () => {
  assert.equal(shouldAutoGenerateBrief(null, OK_WA), false);
  assert.equal(shouldAutoGenerateBrief(stepWA(), null), false);
  assert.equal(shouldAutoGenerateBrief(undefined, undefined), false);
  assert.equal(shouldAutoGenerateBrief({ step_type: 'whatsapp' }, OK_WA), false); // config undefined
});
