// tests/dunning-office-hours.test.js
//
// Unit-tests voor api/_lib/dunning-office-hours.js — de kantooruren-guard
// die send-stappen in de dunning-engine gate. Focus op:
//   • Correcte DST-conversie (CET winter / CEST zomer)
//   • Weekend-days
//   • Ongeldige config → fail-open naar default
//   • Cross-midnight-configs (bewust NIET ondersteund)
//   • SEND vs non-SEND step classification

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEND_STEP_TYPES,
  isSendStep,
  DEFAULT_OFFICE_HOURS,
  parseHHMM,
  parseOfficeHoursConfig,
  getLocalDayHourMinute,
  isWithinOfficeHours,
  officeHoursLabel,
} from '../api/_lib/dunning-office-hours.js';

// ── isSendStep ────────────────────────────────────────────────────────────
test('isSendStep: email + whatsapp zijn send-steps', () => {
  assert.equal(isSendStep('email'), true);
  assert.equal(isSendStep('whatsapp'), true);
  assert.equal(isSendStep('EMAIL'), true);      // case-insensitive
  assert.equal(isSendStep('WhatsApp'), true);
});

test('isSendStep: wait/task/stop/resume_dunning zijn GEEN send-steps', () => {
  assert.equal(isSendStep('wait'), false);
  assert.equal(isSendStep('task'), false);
  assert.equal(isSendStep('stop'), false);
  assert.equal(isSendStep('resume_dunning'), false);
  assert.equal(isSendStep(''), false);
  assert.equal(isSendStep(null), false);
  assert.equal(isSendStep(undefined), false);
});

test('SEND_STEP_TYPES bevat exact email + whatsapp', () => {
  assert.deepEqual([...SEND_STEP_TYPES].sort(), ['email', 'whatsapp']);
});

// ── parseHHMM ─────────────────────────────────────────────────────────────
test('parseHHMM: geldig HH:MM', () => {
  assert.deepEqual(parseHHMM('08:00'),  { hour: 8,  minute: 0  });
  assert.deepEqual(parseHHMM('20:00'),  { hour: 20, minute: 0  });
  assert.deepEqual(parseHHMM('23:59'),  { hour: 23, minute: 59 });
  assert.deepEqual(parseHHMM('00:00'),  { hour: 0,  minute: 0  });
  assert.deepEqual(parseHHMM('9:15'),   { hour: 9,  minute: 15 });  // single-digit hour
});

test('parseHHMM: ongeldig → null', () => {
  assert.equal(parseHHMM(''), null);
  assert.equal(parseHHMM(null), null);
  assert.equal(parseHHMM('abc'), null);
  assert.equal(parseHHMM('24:00'), null);      // hour 24 buiten range
  assert.equal(parseHHMM('12:60'), null);      // minute 60 buiten range
  assert.equal(parseHHMM('8'), null);          // geen dubbelepunt
  assert.equal(parseHHMM('8:5'), null);        // minute niet 2-digit
  assert.equal(parseHHMM(800), null);          // niet-string
});

// ── parseOfficeHoursConfig ────────────────────────────────────────────────
test('parseOfficeHoursConfig: null/undefined → default', () => {
  assert.deepEqual(parseOfficeHoursConfig(null), DEFAULT_OFFICE_HOURS);
  assert.deepEqual(parseOfficeHoursConfig(undefined), DEFAULT_OFFICE_HOURS);
  assert.deepEqual(parseOfficeHoursConfig({}), DEFAULT_OFFICE_HOURS);
});

test('parseOfficeHoursConfig: alle velden overschreven', () => {
  const cfg = parseOfficeHoursConfig({
    tz: 'Europe/London',
    start: '09:00',
    end: '17:30',
    days: [1, 2, 3, 4, 5],
  });
  assert.equal(cfg.tz, 'Europe/London');
  assert.equal(cfg.start, '09:00');
  assert.equal(cfg.end, '17:30');
  assert.deepEqual(cfg.days, [1, 2, 3, 4, 5]);
});

test('parseOfficeHoursConfig: ongeldige tz → default tz', () => {
  const cfg = parseOfficeHoursConfig({ tz: 'Not/AValid_Zone', start: '09:00', end: '17:00' });
  assert.equal(cfg.tz, DEFAULT_OFFICE_HOURS.tz);
  assert.equal(cfg.start, '09:00');
  assert.equal(cfg.end, '17:00');
});

test('parseOfficeHoursConfig: ongeldige start/end → default start/end', () => {
  const cfg = parseOfficeHoursConfig({ start: 'abc', end: '25:00' });
  assert.equal(cfg.start, DEFAULT_OFFICE_HOURS.start);
  assert.equal(cfg.end, DEFAULT_OFFICE_HOURS.end);
});

test('parseOfficeHoursConfig: days dedupliceert + sorteert', () => {
  const cfg = parseOfficeHoursConfig({ days: [5, 1, 3, 1, 5, 0] });
  assert.deepEqual(cfg.days, [0, 1, 3, 5]);
});

test('parseOfficeHoursConfig: days met ongeldige items filtert die eruit', () => {
  const cfg = parseOfficeHoursConfig({ days: [1, 'abc', 7, -1, 2, null, 3.5, 3] });
  // Alleen 1, 2, 3 blijven over (7 en -1 out of range, 3.5 niet integer).
  assert.deepEqual(cfg.days, [1, 2, 3]);
});

test('parseOfficeHoursConfig: alle days ongeldig → default days', () => {
  const cfg = parseOfficeHoursConfig({ days: [-1, 7, 'abc'] });
  assert.deepEqual(cfg.days, DEFAULT_OFFICE_HOURS.days);
});

test('parseOfficeHoursConfig: days niet-array → default days', () => {
  const cfg = parseOfficeHoursConfig({ days: 'weekdays' });
  assert.deepEqual(cfg.days, DEFAULT_OFFICE_HOURS.days);
});

// ── getLocalDayHourMinute ─────────────────────────────────────────────────
test('getLocalDayHourMinute: Amsterdam zomertijd (CEST = UTC+2)', () => {
  // 2026-08-05 12:00 UTC = 14:00 Amsterdam (CEST). Woensdag = day 3.
  const d = new Date(Date.UTC(2026, 7, 5, 12, 0, 0));
  const local = getLocalDayHourMinute(d, 'Europe/Amsterdam');
  assert.equal(local.day, 3);      // wo
  assert.equal(local.hour, 14);
  assert.equal(local.minute, 0);
});

test('getLocalDayHourMinute: Amsterdam wintertijd (CET = UTC+1)', () => {
  // 2026-01-15 12:00 UTC = 13:00 Amsterdam (CET). Donderdag = day 4.
  const d = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  const local = getLocalDayHourMinute(d, 'Europe/Amsterdam');
  assert.equal(local.day, 4);      // do
  assert.equal(local.hour, 13);
  assert.equal(local.minute, 0);
});

test('getLocalDayHourMinute: DST-transitie (laatste zondag maart)', () => {
  // 2026-03-29 00:30 UTC = 01:30 CET (winter) → 30 min later klok springt naar 03:00.
  // 2026-03-29 03:00 UTC = 05:00 CEST (zomer, +2).
  const d = new Date(Date.UTC(2026, 2, 29, 3, 0, 0));
  const local = getLocalDayHourMinute(d, 'Europe/Amsterdam');
  assert.equal(local.day, 0);      // zo
  assert.equal(local.hour, 5);     // CEST +2
});

test('getLocalDayHourMinute: ongeldige tz → null', () => {
  const d = new Date();
  const local = getLocalDayHourMinute(d, 'Not/A_Zone');
  assert.equal(local, null);
});

// ── isWithinOfficeHours ───────────────────────────────────────────────────
test('isWithinOfficeHours: 14:00 NL zomertijd binnen 08-20 → true', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 12, 0, 0)); // 14:00 Amsterdam
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), true);
});

test('isWithinOfficeHours: 03:00 NL zomertijd buiten 08-20 → false', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 1, 0, 0));  // 03:00 Amsterdam
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), false);
});

test('isWithinOfficeHours: exact 08:00 = start → true (inclusief)', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 6, 0, 0));  // 08:00 Amsterdam
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), true);
});

test('isWithinOfficeHours: exact 20:00 = end → false (exclusief)', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 18, 0, 0)); // 20:00 Amsterdam
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), false);
});

test('isWithinOfficeHours: 19:59 NL binnen venster → true', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 17, 59, 0)); // 19:59 Amsterdam
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), true);
});

test('isWithinOfficeHours: winter 09:00 UTC = 10:00 NL, binnen 08-20 → true', () => {
  const d = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), true);
});

test('isWithinOfficeHours: zaterdag met default 7d → true', () => {
  // 2026-08-08 = zaterdag, 14:00 UTC = 16:00 Amsterdam
  const d = new Date(Date.UTC(2026, 7, 8, 14, 0, 0));
  assert.equal(isWithinOfficeHours(d, DEFAULT_OFFICE_HOURS), true);
});

test('isWithinOfficeHours: zondag met werkdagen-only [1-5] → false', () => {
  // 2026-08-09 = zondag, 14:00 UTC = 16:00 Amsterdam
  const d = new Date(Date.UTC(2026, 7, 9, 14, 0, 0));
  const cfg = { ...DEFAULT_OFFICE_HOURS, days: [1, 2, 3, 4, 5] };
  assert.equal(isWithinOfficeHours(d, cfg), false);
});

test('isWithinOfficeHours: cross-midnight config (22:00-06:00) → altijd false', () => {
  // Bewust niet ondersteund — voorkomt per-ongeluk nacht-sends door misconfig.
  const cfg = { ...DEFAULT_OFFICE_HOURS, start: '22:00', end: '06:00' };
  const dLate = new Date(Date.UTC(2026, 7, 5, 21, 0, 0)); // 23:00 Amsterdam
  const dEarly = new Date(Date.UTC(2026, 7, 5, 3, 0, 0)); // 05:00 Amsterdam
  assert.equal(isWithinOfficeHours(dLate, cfg), false);
  assert.equal(isWithinOfficeHours(dEarly, cfg), false);
});

test('isWithinOfficeHours: ongeldige config → default 08-20 wordt gebruikt', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 12, 0, 0)); // 14:00 Amsterdam
  assert.equal(isWithinOfficeHours(d, { start: 'abc', end: 'xyz' }), true);
});

test('isWithinOfficeHours: null config → default gebruikt', () => {
  const d = new Date(Date.UTC(2026, 7, 5, 12, 0, 0));
  assert.equal(isWithinOfficeHours(d, null), true);
});

test('isWithinOfficeHours: custom venster 09:00-17:00 binnen NL → correct', () => {
  const cfg = { ...DEFAULT_OFFICE_HOURS, start: '09:00', end: '17:00' };
  const dOK   = new Date(Date.UTC(2026, 7, 5, 7, 30, 0));  // 09:30 Amsterdam
  const dLate = new Date(Date.UTC(2026, 7, 5, 15, 30, 0)); // 17:30 Amsterdam
  const dEarly= new Date(Date.UTC(2026, 7, 5, 6, 30, 0));  // 08:30 Amsterdam
  assert.equal(isWithinOfficeHours(dOK, cfg), true);
  assert.equal(isWithinOfficeHours(dLate, cfg), false);
  assert.equal(isWithinOfficeHours(dEarly, cfg), false);
});

// ── officeHoursLabel ──────────────────────────────────────────────────────
test('officeHoursLabel: default toont 7d', () => {
  assert.equal(officeHoursLabel(DEFAULT_OFFICE_HOURS), '08:00-20:00 Europe/Amsterdam (7d)');
});

test('officeHoursLabel: werkdagen-only toont ma,di,wo,do,vr', () => {
  const cfg = { ...DEFAULT_OFFICE_HOURS, days: [1, 2, 3, 4, 5] };
  assert.equal(officeHoursLabel(cfg), '08:00-20:00 Europe/Amsterdam (ma,di,wo,do,vr)');
});

test('officeHoursLabel: custom tz + venster', () => {
  const cfg = { tz: 'Europe/London', start: '09:00', end: '17:00', days: [1, 3, 5] };
  assert.equal(officeHoursLabel(cfg), '09:00-17:00 Europe/London (ma,wo,vr)');
});
