// tests/dunning-overdue-guard.test.js
//
// Unit-tests voor api/_lib/dunning-overdue-guard.js — de harde vervaldatum-
// poort van de aanmaan-motor. Regressie-basis voor de bug van 06-09-2026:
// facturen die nog NIET vervallen waren kregen automatisch een aanmaning
// omdat days_overdue op 0 geclampt werd.
//
// Focus:
//   • Kalenderdag in Europe/Amsterdam (niet UTC) — DST-grens inbegrepen
//   • ONGECLAMPTE dagen-teller (negatief = nog niet vervallen)
//   • isOverdue: niets op of vóór de vervaldag, ook niet met grace
//   • Gratieperiode-parsing (default 0, clamp 0..90)
//   • Tier-afleiding: aanmaning_dagNN ↔ echte days_overdue

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMSTERDAM_TZ,
  DEFAULT_GRACE_DAYS,
  MAX_GRACE_DAYS,
  todayIsoInTz,
  daysOverdueSigned,
  daysOverdueClamped,
  parseGraceDays,
  isOverdue,
  tierFromName,
  resolveStepTierDays,
  earliestSendIso,
} from '../api/_lib/dunning-overdue-guard.js';

// ── todayIsoInTz ──────────────────────────────────────────────────────────
test('todayIsoInTz: zomertijd — 00:30 UTC is in NL al de volgende dag', () => {
  // 2026-09-06T23:30Z = 2026-09-07 01:30 CEST.
  assert.equal(todayIsoInTz(new Date('2026-09-06T23:30:00Z'), AMSTERDAM_TZ), '2026-09-07');
});

test('todayIsoInTz: wintertijd — 23:30 UTC is in NL al de volgende dag', () => {
  // 2026-01-10T23:30Z = 2026-01-11 00:30 CET.
  assert.equal(todayIsoInTz(new Date('2026-01-10T23:30:00Z'), AMSTERDAM_TZ), '2026-01-11');
});

test('todayIsoInTz: midden op de dag verandert er niets', () => {
  assert.equal(todayIsoInTz(new Date('2026-09-07T10:00:00Z'), AMSTERDAM_TZ), '2026-09-07');
});

// ── daysOverdueSigned ─────────────────────────────────────────────────────
test('daysOverdueSigned: toekomstige vervaldatum geeft een NEGATIEF getal', () => {
  // Het concrete bug-geval: factuur 2026/1780, vervaldatum 08-09, gemeten 06-09.
  assert.equal(daysOverdueSigned('2026-09-08', '2026-09-06'), -2);
});

test('daysOverdueSigned: vervalt vandaag = 0, gisteren = 1', () => {
  assert.equal(daysOverdueSigned('2026-09-07', '2026-09-07'), 0);
  assert.equal(daysOverdueSigned('2026-09-06', '2026-09-07'), 1);
});

test('daysOverdueSigned: timestamp-input wordt op de datum afgekapt', () => {
  assert.equal(daysOverdueSigned('2026-09-01T23:00:00+02:00', '2026-09-07'), 6);
});

test('daysOverdueSigned: ontbrekende/onparseerbare datum geeft null', () => {
  assert.equal(daysOverdueSigned(null, '2026-09-07'), null);
  assert.equal(daysOverdueSigned('', '2026-09-07'), null);
  assert.equal(daysOverdueSigned('geen-datum', '2026-09-07'), null);
});

test('daysOverdueSigned: DST-overgang telt hele kalenderdagen', () => {
  // 25 okt 2026 = einde zomertijd (dag van 25 uur). Toch 7 kalenderdagen.
  assert.equal(daysOverdueSigned('2026-10-22', '2026-10-29'), 7);
});

test('daysOverdueClamped: negatief wordt 0 (oude UI-semantiek)', () => {
  assert.equal(daysOverdueClamped('2026-09-08', '2026-09-06'), 0);
  assert.equal(daysOverdueClamped('2026-09-06', '2026-09-07'), 1);
});

// ── isOverdue — DE poort ──────────────────────────────────────────────────
test('isOverdue: niets gaat uit vóór de vervaldag', () => {
  assert.equal(isOverdue('2026-09-08', '2026-09-06'), false);
  assert.equal(isOverdue('2026-09-08', '2026-09-07'), false);
});

test('isOverdue: niets gaat uit OP de vervaldag', () => {
  assert.equal(isOverdue('2026-09-08', '2026-09-08'), false);
});

test('isOverdue: de dag NA de vervaldag mag wel (grace 0 = default)', () => {
  assert.equal(isOverdue('2026-09-08', '2026-09-09'), true);
  assert.equal(isOverdue('2026-09-08', '2026-09-09', DEFAULT_GRACE_DAYS), true);
});

test('isOverdue: gratieperiode schuift de poort mee op', () => {
  // grace 3 → pas vanaf 4 dagen na de vervaldag.
  assert.equal(isOverdue('2026-09-08', '2026-09-11', 3), false);
  assert.equal(isOverdue('2026-09-08', '2026-09-12', 3), true);
});

test('isOverdue: zonder vervaldatum fail-closed (geen send)', () => {
  assert.equal(isOverdue(null, '2026-09-07'), false);
  assert.equal(isOverdue('kapot', '2026-09-07'), false);
});

test('isOverdue: tweede bug-geval (vervaldatum 17-09, aanmaning 16-08)', () => {
  assert.equal(isOverdue('2026-09-17', '2026-08-16'), false);
});

// ── parseGraceDays ────────────────────────────────────────────────────────
test('parseGraceDays: default 0 bij onzin, clamp op 0..90', () => {
  assert.equal(parseGraceDays(undefined), 0);
  assert.equal(parseGraceDays(null), 0);
  assert.equal(parseGraceDays('geen getal'), 0);
  assert.equal(parseGraceDays(-5), 0);
  assert.equal(parseGraceDays(3), 3);
  assert.equal(parseGraceDays('7'), 7);
  assert.equal(parseGraceDays(2.9), 2);
  assert.equal(parseGraceDays(999), MAX_GRACE_DAYS);
});

// ── tier-afleiding ────────────────────────────────────────────────────────
test('tierFromName: leest het dag-nummer uit de templatenaam', () => {
  assert.equal(tierFromName('aanmaning_dag7'), 7);
  assert.equal(tierFromName('aanmaning_dag14'), 14);
  assert.equal(tierFromName('aanmaning_dag37'), 37);
  assert.equal(tierFromName('Aanmaning dag 21'), 21);
  assert.equal(tierFromName('aanmaning-dag-17'), 17);
});

test('tierFromName: geen dag-nummer → null', () => {
  assert.equal(tierFromName('welkomstbericht'), null);
  assert.equal(tierFromName(null), null);
  assert.equal(tierFromName(42), null);
});

test('resolveStepTierDays: expliciete config.min_days_overdue wint', () => {
  const step = { config: { min_days_overdue: 30, title: 'Aanmaning dag 7' } };
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag14' }), 30);
});

test('resolveStepTierDays: expliciete 0 betekent bewust geen tier-eis', () => {
  const step = { config: { min_days_overdue: 0 } };
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag14' }), 0);
});

test('resolveStepTierDays: valt terug op meta-template, dan naam, dan titel', () => {
  assert.equal(
    resolveStepTierDays({ config: {} }, { meta_template_name: 'aanmaning_dag14', name: 'iets' }),
    14,
  );
  assert.equal(resolveStepTierDays({ config: {} }, { name: 'Aanmaning dag 17' }), 17);
  assert.equal(resolveStepTierDays({ config: { title: 'Aanmaning dag 21' } }, null), 21);
});

test('resolveStepTierDays: niets af te leiden → null (geen tier-eis)', () => {
  assert.equal(resolveStepTierDays({ config: { title: 'Belmoment' } }, { name: 'Belscript' }), null);
  assert.equal(resolveStepTierDays(null, null), null);
});

// ── earliestSendIso ───────────────────────────────────────────────────────
test('earliestSendIso: de dag waarop de tier bereikt wordt', () => {
  assert.equal(earliestSendIso('2026-09-08', 14), '2026-09-22T00:00:00.000Z');
  // grace 0 → poort open vanaf 1 dag na de vervaldag.
  assert.equal(earliestSendIso('2026-09-08', 1), '2026-09-09T00:00:00.000Z');
});

test('earliestSendIso: onbruikbare input → null', () => {
  assert.equal(earliestSendIso(null, 14), null);
  assert.equal(earliestSendIso('2026-09-08', 'x'), null);
});
