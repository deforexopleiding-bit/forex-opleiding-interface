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
  DEFAULT_LADDER,
  MAX_LADDER_DAYS,
  todayIsoInTz,
  daysOverdueSigned,
  daysOverdueClamped,
  parseGraceDays,
  isOverdue,
  parseLadder,
  resolveStepTierDays,
  resolveWorkflowStartDays,
  ladderLabel,
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

// ── ladder-parsing ────────────────────────────────────────────────────────
test('parseLadder: default-ladder als er niets is ingesteld', () => {
  assert.deepEqual(parseLadder(null), { ...DEFAULT_LADDER });
  assert.deepEqual(parseLadder({}), { ...DEFAULT_LADDER });
  assert.deepEqual(parseLadder('onzin'), { ...DEFAULT_LADDER });
});

test('parseLadder: de vijf drempels zijn instelbaar, niet hardcoded', () => {
  const lad = parseLadder({ rungs: {
    aanmaning_dag7: 2, aanmaning_dag14: 9, aanmaning_dag17: 16,
    aanmaning_dag21: 23, aanmaning_dag37: 40,
  } });
  assert.deepEqual(lad, {
    aanmaning_dag7: 2, aanmaning_dag14: 9, aanmaning_dag17: 16,
    aanmaning_dag21: 23, aanmaning_dag37: 40,
  });
});

test('parseLadder: plat object (zonder rungs-wrapper) werkt ook', () => {
  assert.equal(parseLadder({ aanmaning_dag7: 3 }).aanmaning_dag7, 3);
});

test('parseLadder: ontbrekende sporten vallen terug op de default', () => {
  const lad = parseLadder({ rungs: { aanmaning_dag14: 9 } });
  assert.equal(lad.aanmaning_dag14, 9);
  assert.equal(lad.aanmaning_dag7,  DEFAULT_LADDER.aanmaning_dag7);
  assert.equal(lad.aanmaning_dag37, DEFAULT_LADDER.aanmaning_dag37);
});

test('parseLadder: ongeldige waarden worden genegeerd, eigen templates mogen erbij', () => {
  const lad = parseLadder({ rungs: {
    aanmaning_dag7: -1,             // negatief → default
    aanmaning_dag14: 'x',           // niet-numeriek → default
    aanmaning_dag17: MAX_LADDER_DAYS + 1, // te groot → default
    eigen_template: 45,             // eigen naam mag
  } });
  assert.equal(lad.aanmaning_dag7,  DEFAULT_LADDER.aanmaning_dag7);
  assert.equal(lad.aanmaning_dag14, DEFAULT_LADDER.aanmaning_dag14);
  assert.equal(lad.aanmaning_dag17, DEFAULT_LADDER.aanmaning_dag17);
  assert.equal(lad.eigen_template, 45);
});

test('DEFAULT_LADDER: de afgesproken mapping (naam ≠ moment)', () => {
  assert.deepEqual({ ...DEFAULT_LADDER }, {
    aanmaning_dag7 : 1,
    aanmaning_dag14: 7,
    aanmaning_dag17: 14,
    aanmaning_dag21: 21,
    aanmaning_dag37: 30,
  });
});

// ── resolveStepTierDays ───────────────────────────────────────────────────
test('resolveStepTierDays: de LADDER bepaalt de drempel, niet het getal in de naam', () => {
  const step = { step_type: 'whatsapp', config: {} };
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag7' },  DEFAULT_LADDER), 1);
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag14' }, DEFAULT_LADDER), 7);
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag17' }, DEFAULT_LADDER), 14);
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag21' }, DEFAULT_LADDER), 21);
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag37' }, DEFAULT_LADDER), 30);
});

test('resolveStepTierDays: expliciete config.min_days_overdue wint van de ladder', () => {
  const step = { step_type: 'whatsapp', config: { min_days_overdue: 30 } };
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag7' }, DEFAULT_LADDER), 30);
});

test('resolveStepTierDays: expliciete 0 betekent bewust geen ladder-eis', () => {
  const step = { step_type: 'whatsapp', config: { min_days_overdue: 0 } };
  assert.equal(resolveStepTierDays(step, { meta_template_name: 'aanmaning_dag14' }, DEFAULT_LADDER), 0);
});

test('resolveStepTierDays: valt terug op template.name als meta-naam ontbreekt', () => {
  assert.equal(resolveStepTierDays({ config: {} }, { name: 'aanmaning_dag21' }, DEFAULT_LADDER), 21);
});

test('resolveStepTierDays: template buiten de ladder → null (geen ladder-eis)', () => {
  assert.equal(resolveStepTierDays({ config: {} }, { meta_template_name: 'welkomstbericht' }, DEFAULT_LADDER), null);
  assert.equal(resolveStepTierDays({ config: {} }, null, DEFAULT_LADDER), null);
  assert.equal(resolveStepTierDays(null, null, DEFAULT_LADDER), null);
});

test('resolveStepTierDays: een aangepaste ladder wordt gevolgd', () => {
  const lad = parseLadder({ rungs: { aanmaning_dag7: 3 } });
  assert.equal(resolveStepTierDays({ config: {} }, { meta_template_name: 'aanmaning_dag7' }, lad), 3);
});

// ── resolveWorkflowStartDays ──────────────────────────────────────────────
test('resolveWorkflowStartDays: expliciete min_days_overdue wint', () => {
  assert.equal(resolveWorkflowStartDays({
    triggerConditions: { min_days_overdue: 10 }, stepTierDays: [1, 7, 14],
  }), 10);
});

test('resolveWorkflowStartDays: anders de LAAGSTE ladder-sport van de eigen stappen', () => {
  assert.equal(resolveWorkflowStartDays({ triggerConditions: {}, stepTierDays: [7, 1, 30] }), 1);
});

test('resolveWorkflowStartDays: zonder ladder-sporten de fallback (oude default 14)', () => {
  assert.equal(resolveWorkflowStartDays({ triggerConditions: {}, stepTierDays: [] }), 14);
  assert.equal(resolveWorkflowStartDays({ triggerConditions: {}, stepTierDays: [], fallbackDays: 1 }), 1);
});

test('resolveWorkflowStartDays: nooit lager dan 1 — niets op of vóór de vervaldag', () => {
  assert.equal(resolveWorkflowStartDays({ triggerConditions: { min_days_overdue: 0 } }), 1);
  assert.equal(resolveWorkflowStartDays({ triggerConditions: { min_days_overdue: -1 } }), 1);
  assert.equal(resolveWorkflowStartDays({ triggerConditions: {}, stepTierDays: [0] }), 1);
  assert.equal(resolveWorkflowStartDays({ triggerConditions: {}, stepTierDays: [], fallbackDays: 0 }), 1);
});

test('resolveWorkflowStartDays: min_days_since_invoice_date is GEEN selectiecriterium meer', () => {
  // Factuurdatum-trigger aanwezig, geen min_days_overdue → de ladder beslist,
  // niet de factuurdatum. Vroeger werd dit -1 ("altijd raak").
  assert.equal(resolveWorkflowStartDays({
    triggerConditions: { min_days_since_invoice_date: 7 },
    stepTierDays: [1, 7, 14, 21, 30],
  }), 1);
  assert.equal(resolveWorkflowStartDays({
    triggerConditions: { min_days_since_invoice_date: 7 },
    stepTierDays: [],
  }), 14);
});

// ── ladderLabel (UI + logs) ───────────────────────────────────────────────
test('ladderLabel: toont de echte drempel bij de goedgekeurde Meta-naam', () => {
  assert.equal(ladderLabel('aanmaning_dag7',  DEFAULT_LADDER), 'verstuurd op dag 1 na vervaldatum');
  assert.equal(ladderLabel('aanmaning_dag14', DEFAULT_LADDER), 'verstuurd op dag 7 na vervaldatum');
  assert.equal(ladderLabel('aanmaning_dag37', DEFAULT_LADDER), 'verstuurd op dag 30 na vervaldatum');
});

test('ladderLabel: template buiten de ladder → null', () => {
  assert.equal(ladderLabel('welkomstbericht', DEFAULT_LADDER), null);
  assert.equal(ladderLabel(null, DEFAULT_LADDER), null);
});

// ── REGRESSIE: de ladder in bedrijf ───────────────────────────────────────
//
// Spiegelt exact de twee guard-regels uit dunning-engine.js#advanceActiveRuns:
//   1. isOverdue(oldest_due_iso, todayIso, graceDays)          → harde poort
//   2. resolveStepTierDays(step, template, ladder) <= signed   → ladder-sport
// Zo tonen deze tests het gedrag van de motor, niet alleen dat van losse
// helpers.
const LADDER_STEPS = [
  { step_type: 'whatsapp', config: {}, template: { meta_template_name: 'aanmaning_dag7'  } },
  { step_type: 'whatsapp', config: {}, template: { meta_template_name: 'aanmaning_dag14' } },
  { step_type: 'whatsapp', config: {}, template: { meta_template_name: 'aanmaning_dag17' } },
  { step_type: 'whatsapp', config: {}, template: { meta_template_name: 'aanmaning_dag21' } },
  { step_type: 'whatsapp', config: {}, template: { meta_template_name: 'aanmaning_dag37' } },
];

/** Welke templates mag de motor versturen op `todayIso`? (grace default 0) */
function maySendOn(dueIso, todayIso, graceDays = DEFAULT_GRACE_DAYS, ladder = DEFAULT_LADDER) {
  if (!isOverdue(dueIso, todayIso, graceDays)) return [];
  const signed = daysOverdueSigned(dueIso, todayIso);
  return LADDER_STEPS
    .filter((st) => {
      const tier = resolveStepTierDays(st, st.template, ladder);
      return tier == null || (signed != null && signed >= tier);
    })
    .map((st) => st.template.meta_template_name);
}

test('REGRESSIE: op de vervaldag zelf vertrekt er NIETS', () => {
  assert.deepEqual(maySendOn('2026-09-08', '2026-09-08'), []);
  // ook niet als de klant al maanden een openstaande factuur heeft die
  // vandaag pas vervalt
  assert.equal(isOverdue('2026-09-08', '2026-09-08'), false);
  assert.equal(daysOverdueSigned('2026-09-08', '2026-09-08'), 0);
});

test('REGRESSIE: vóór de vervaldag vertrekt er niets (het bug-geval van 06-09)', () => {
  // Factuur 2026/1780: factuurdatum 01-09, vervaldatum 08-09, TeamLeader-status
  // "Niet betaald". Op 06-09 ging destijds aanmaning_dag14 uit.
  assert.deepEqual(maySendOn('2026-09-08', '2026-09-06'), []);
  assert.deepEqual(maySendOn('2026-09-08', '2026-09-07'), []);
});

test('REGRESSIE: het EERSTE bericht valt op dag 1 na de vervaldatum en is aanmaning_dag7', () => {
  const dag1 = maySendOn('2026-09-08', '2026-09-09');
  assert.deepEqual(dag1, ['aanmaning_dag7']);
  assert.equal(daysOverdueSigned('2026-09-08', '2026-09-09'), 1);
});

test('REGRESSIE: de hele ladder opent op de afgesproken dagen', () => {
  const due = '2026-09-08';
  // dag 6 — nog steeds alleen het duwtje
  assert.deepEqual(maySendOn(due, '2026-09-14'), ['aanmaning_dag7']);
  // dag 7 — aanmaning_dag14 komt erbij
  assert.deepEqual(maySendOn(due, '2026-09-15'), ['aanmaning_dag7', 'aanmaning_dag14']);
  // dag 14 — aanmaning_dag17
  assert.equal(maySendOn(due, '2026-09-22').includes('aanmaning_dag17'), true);
  assert.equal(maySendOn(due, '2026-09-21').includes('aanmaning_dag17'), false);
  // dag 21 — aanmaning_dag21
  assert.equal(maySendOn(due, '2026-09-29').includes('aanmaning_dag21'), true);
  assert.equal(maySendOn(due, '2026-09-28').includes('aanmaning_dag21'), false);
  // dag 30 — aanmaning_dag37
  assert.equal(maySendOn(due, '2026-10-08').includes('aanmaning_dag37'), true);
  assert.equal(maySendOn(due, '2026-10-07').includes('aanmaning_dag37'), false);
});

test('REGRESSIE: afwijkende betaaltermijn wordt op de EIGEN vervaldatum beoordeeld', () => {
  // Zelfde factuurdatum (01-09), drie verschillende termijnen. Nergens wordt
  // "factuurdatum + 7" gebruikt; alleen de vervaldatum telt.
  const factuurdatum = '2026-09-01';

  // 30-dagen-termijn → vervaldatum 01-10. Op 08-09 (dag 7 ná factuurdatum,
  // maar 23 dagen VÓÓR de vervaldatum) mag er niets uit.
  assert.deepEqual(maySendOn('2026-10-01', '2026-09-08'), []);
  assert.equal(daysOverdueSigned('2026-10-01', '2026-09-08'), -23);
  // Pas op 02-10 (dag 1 na de eigen vervaldatum) start het duwtje.
  assert.deepEqual(maySendOn('2026-10-01', '2026-10-02'), ['aanmaning_dag7']);

  // 60-dagen-termijn (bv. na een betalingsregeling) → vervaldatum 31-10.
  assert.deepEqual(maySendOn('2026-10-31', '2026-10-02'), []);
  assert.deepEqual(maySendOn('2026-10-31', '2026-11-01'), ['aanmaning_dag7']);

  // 0-dagen-termijn (direct betaalbaar) → vervaldatum = factuurdatum.
  assert.deepEqual(maySendOn(factuurdatum, factuurdatum), []);
  assert.deepEqual(maySendOn(factuurdatum, '2026-09-02'), ['aanmaning_dag7']);
});

test('REGRESSIE: de factuurdatum is nergens een anker — twee termijnen, één datum', () => {
  // Twee facturen met dezelfde factuurdatum maar een andere termijn krijgen
  // hun eerste bericht op verschillende dagen.
  const kortTermijn = maySendOn('2026-09-08', '2026-09-09');  // 7-daagse termijn
  const langTermijn = maySendOn('2026-10-01', '2026-09-09');  // 30-daagse termijn
  assert.deepEqual(kortTermijn, ['aanmaning_dag7']);
  assert.deepEqual(langTermijn, []);
});

test('REGRESSIE: een gratieperiode > 0 schuift de hele ladder op, 0 blijft de default', () => {
  assert.equal(DEFAULT_GRACE_DAYS, 0);
  assert.deepEqual(maySendOn('2026-09-08', '2026-09-09', 2), []);   // grace 2 → dag 1 en 2 stil
  assert.deepEqual(maySendOn('2026-09-08', '2026-09-11', 2), ['aanmaning_dag7']);
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
