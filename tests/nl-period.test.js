// tests/nl-period.test.js
//
// Unit-tests voor api/_lib/nl-period.js.
//
// Kritieke scenarios:
//   * NL vs UTC dag-boundaries (deals na middernacht NL)
//   * ISO week ma-zo (niet rolling)
//   * DST: zomertijd (aug = UTC+2) vs wintertijd (feb = UTC+1)
//   * Maand-overgang eind december → jaar+1
//   * Cabdi-scenario: deal 1 aug 11:23 UTC (13:23 NL) valt in aug-maand

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nlDayStart, nlDayEndExclusive,
  nlWeekStart, nlWeekEndExclusive,
  nlMonthStart, nlMonthEndExclusive,
  nlYearStart, nlYearEndExclusive,
  nlDateString,
  periodRange,
} from '../api/_lib/nl-period.js';

// Helper: bouw een UTC-Date direct uit ISO-string.
const utc = (iso) => new Date(iso);

// ── nlDayStart / nlDayEndExclusive ────────────────────────────────

test('nlDayStart: 4 aug 2026 (zomertijd = UTC+2) → 3 aug 22:00 UTC', () => {
  const now = utc('2026-08-04T15:00:00.000Z'); // 17:00 NL
  const start = nlDayStart(now);
  assert.equal(start.toISOString(), '2026-08-03T22:00:00.000Z');
});

test('nlDayStart: 4 feb 2026 (wintertijd = UTC+1) → 3 feb 23:00 UTC', () => {
  const now = utc('2026-02-04T15:00:00.000Z'); // 16:00 NL
  const start = nlDayStart(now);
  assert.equal(start.toISOString(), '2026-02-03T23:00:00.000Z');
});

test('nlDayEndExclusive: dag+1 correcte overloop naar volgende maand', () => {
  const now = utc('2026-08-31T15:00:00.000Z'); // 31 aug 17:00 NL
  const end = nlDayEndExclusive(now);
  assert.equal(end.toISOString(), '2026-08-31T22:00:00.000Z'); // 1 sep 00:00 NL
});

test('nlDayStart: 4 aug 22:30 UTC (5 aug 00:30 NL) → dag = 5 aug NL', () => {
  const now = utc('2026-08-04T22:30:00.000Z'); // = 00:30 NL op 5 aug
  const start = nlDayStart(now);
  // NL-dag is nu 5 aug; NL 00:00 = 4 aug 22:00 UTC
  assert.equal(start.toISOString(), '2026-08-04T22:00:00.000Z');
});

// ── nlWeekStart: ISO ma-zo ────────────────────────────────────────

test('nlWeekStart: di 4 aug 2026 → ma 3 aug 00:00 NL', () => {
  const now = utc('2026-08-04T10:00:00.000Z'); // di 12:00 NL
  const start = nlWeekStart(now);
  // 3 aug 00:00 NL = 2 aug 22:00 UTC (zomertijd)
  assert.equal(start.toISOString(), '2026-08-02T22:00:00.000Z');
});

test('nlWeekStart: zo 9 aug 2026 → ma 3 aug 00:00 NL (zondag hoort bij dezelfde week)', () => {
  const now = utc('2026-08-09T10:00:00.000Z'); // zo 12:00 NL
  const start = nlWeekStart(now);
  assert.equal(start.toISOString(), '2026-08-02T22:00:00.000Z');
});

test('nlWeekStart: ma 3 aug 2026 zelf → ma 3 aug 00:00 NL', () => {
  const now = utc('2026-08-03T10:00:00.000Z'); // ma 12:00 NL
  const start = nlWeekStart(now);
  assert.equal(start.toISOString(), '2026-08-02T22:00:00.000Z');
});

test('nlWeekEndExclusive: 7 dagen na start', () => {
  const now = utc('2026-08-04T10:00:00.000Z');
  const start = nlWeekStart(now);
  const end = nlWeekEndExclusive(now);
  assert.equal(end.getTime() - start.getTime(), 7 * 24 * 3600 * 1000);
});

test('CABDI-scenario: deal getekend 1 aug 11:23 UTC (13:23 NL) valt in aug-maand', () => {
  const now = utc('2026-08-04T15:00:00.000Z'); // vandaag = 4 aug
  const monthStart = nlMonthStart(now);
  const monthEnd = nlMonthEndExclusive(now);
  const cabdi = utc('2026-08-01T11:23:00.000Z'); // deal-tekenmoment
  assert.ok(cabdi >= monthStart && cabdi < monthEnd,
    `Cabdi's deal moet in aug vallen. start=${monthStart.toISOString()} end=${monthEnd.toISOString()} cabdi=${cabdi.toISOString()}`);
});

// ── nlMonthStart / nlMonthEndExclusive ────────────────────────────

test('nlMonthStart: aug 2026 → 31 juli 22:00 UTC (1 aug 00:00 NL)', () => {
  const now = utc('2026-08-15T15:00:00.000Z');
  const start = nlMonthStart(now);
  assert.equal(start.toISOString(), '2026-07-31T22:00:00.000Z');
});

test('nlMonthEndExclusive: aug 2026 → 31 aug 22:00 UTC (1 sep 00:00 NL)', () => {
  const now = utc('2026-08-15T15:00:00.000Z');
  const end = nlMonthEndExclusive(now);
  assert.equal(end.toISOString(), '2026-08-31T22:00:00.000Z');
});

test('nlMonthEndExclusive: december → 1 jan volgend jaar (jaar-overloop)', () => {
  const now = utc('2026-12-15T15:00:00.000Z');
  const end = nlMonthEndExclusive(now);
  assert.equal(end.toISOString(), '2026-12-31T23:00:00.000Z'); // 1 jan 2027 00:00 NL = wintertijd = UTC 23:00 dec 31
});

test('nlMonthStart: feb 2026 (wintertijd) → 31 jan 23:00 UTC', () => {
  const now = utc('2026-02-15T15:00:00.000Z');
  const start = nlMonthStart(now);
  assert.equal(start.toISOString(), '2026-01-31T23:00:00.000Z');
});

// ── nlYearStart / nlYearEndExclusive ──────────────────────────────

test('nlYearStart: 2026 (wintertijd 1 jan) → 31 dec 2025 23:00 UTC', () => {
  const now = utc('2026-06-15T12:00:00.000Z');
  const start = nlYearStart(now);
  assert.equal(start.toISOString(), '2025-12-31T23:00:00.000Z');
});

test('nlYearEndExclusive: 2026 → 31 dec 2026 23:00 UTC (1 jan 2027 00:00 NL)', () => {
  const now = utc('2026-06-15T12:00:00.000Z');
  const end = nlYearEndExclusive(now);
  assert.equal(end.toISOString(), '2026-12-31T23:00:00.000Z');
});

// ── nlDateString ──────────────────────────────────────────────────

test('nlDateString: 3 aug 22:30 UTC → NL dag = 4 aug', () => {
  const d = utc('2026-08-03T22:30:00.000Z'); // 00:30 NL 4 aug
  assert.equal(nlDateString(d), '2026-08-04');
});

test('nlDateString: 4 aug 15:00 UTC → 4 aug', () => {
  const d = utc('2026-08-04T15:00:00.000Z');
  assert.equal(nlDateString(d), '2026-08-04');
});

// ── periodRange centraal ──────────────────────────────────────────

test('periodRange: dag levert start/endExclusive verschillend 24h (zomer)', () => {
  const now = utc('2026-08-04T15:00:00.000Z');
  const r = periodRange('dag', now);
  assert.equal(r.endExclusive.getTime() - r.start.getTime(), 24 * 3600 * 1000);
  assert.equal(r.label, '2026-08-04');
});

test('periodRange: week levert 7 dagen', () => {
  const now = utc('2026-08-04T15:00:00.000Z');
  const r = periodRange('week', now);
  assert.equal(r.endExclusive.getTime() - r.start.getTime(), 7 * 24 * 3600 * 1000);
  // Week begint op ma 3 aug
  assert.equal(r.label, '2026-08-03');
});

test('periodRange: maand aug 2026 = 31 dagen', () => {
  const now = utc('2026-08-04T15:00:00.000Z');
  const r = periodRange('maand', now);
  assert.equal(r.endExclusive.getTime() - r.start.getTime(), 31 * 24 * 3600 * 1000);
  assert.equal(r.label, '2026-08-01');
});

test('periodRange: onbekende period → throws', () => {
  assert.throws(() => periodRange('kwartaal'), /onbekende period/);
});

// ── DST-overgangen ────────────────────────────────────────────────

test('DST voorwaartse sprong: 29 maart 2026 (zo 02:00→03:00 lokaal)', () => {
  // Op zo 29 mrt 2026 wordt om 02:00 NL de klok 1 uur vooruit gezet naar 03:00.
  // Voor die dag nlDayStart is 28 mrt 23:00 UTC (nog wintertijd offset +1).
  const now = utc('2026-03-29T12:00:00.000Z');
  const start = nlDayStart(now);
  assert.equal(start.toISOString(), '2026-03-28T23:00:00.000Z');
});

test('DST achterwaartse sprong: 25 okt 2026 (zo 03:00→02:00 lokaal)', () => {
  // Op zo 25 okt 2026 wordt om 03:00 NL de klok 1 uur teruggezet naar 02:00.
  // Op 26 okt is 't wintertijd = UTC+1.
  const now = utc('2026-10-26T12:00:00.000Z');
  const start = nlDayStart(now);
  assert.equal(start.toISOString(), '2026-10-25T23:00:00.000Z');
});
