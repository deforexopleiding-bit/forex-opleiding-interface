// tests/dunning-workflow-tijdlijn.test.js
//
// Tests voor de rekenkern van scripts/dunning-workflow-tijdlijn.js: op welke
// dag na de vervaldatum landt elke stap, vóór deze branch en erna?
//
// De eerste testgroep gebruikt de VOLLEDIGE productie-configuratie van
// workflow "Aanmaningen" (9805c900-1c74-4326-9d15-a1e49f754eb0), uitgelezen
// uit productie: 22 stappen, trigger_conditions { min_days_overdue: 1 }.
// De tweede groep varieert één wachtstap synthetisch, om te laten zien dat de
// verschuiving drie kanten op kan (later / gelijk / eerder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopStappen, bouwTijdlijn } from '../scripts/dunning-workflow-tijdlijn.js';
import { DEFAULT_LADDER } from '../api/_lib/dunning-overdue-guard.js';

// ── De echte productie-workflow ───────────────────────────────────────────
const AANMANINGEN_TPL = {
  w7:  { name: 'Aanmaning WA dag 7',        meta_template_name: 'aanmaning_dag7'  },
  e7:  { name: 'Aanmaning dag 7 (E-mail)',  meta_template_name: null },
  w14: { name: 'Aanmaning WA dag 14',       meta_template_name: 'aanmaning_dag14' },
  e14: { name: 'Aanmaning dag 14 (E-mail)', meta_template_name: null },
  w17: { name: 'Aanmaning WA dag 17',       meta_template_name: 'aanmaning_dag17' },
  e17: { name: 'Aanmaning dag 17 (E-mail)', meta_template_name: null },
  w21: { name: 'Aanmaning WA dag 21',       meta_template_name: 'aanmaning_dag21' },
  e21: { name: 'Aanmaning dag 21 (E-mail)', meta_template_name: null },
  w37: { name: 'Aanmaning WA dag 37',       meta_template_name: 'aanmaning_dag37' },
  e37: { name: 'Aanmaning dag 37 (E-mail)', meta_template_name: null },
};

const AANMANINGEN_STEPS = [
  { step_order: 0,  step_type: 'whatsapp', config: { template_id: 'w7'  } },
  { step_order: 1,  step_type: 'email',    config: { template_id: 'e7'  } },
  { step_order: 2,  step_type: 'wait',     config: { days: 7 } },
  { step_order: 3,  step_type: 'whatsapp', config: { template_id: 'w14' } },
  { step_order: 4,  step_type: 'email',    config: { template_id: 'e14' } },
  { step_order: 5,  step_type: 'wait',     config: { days: 1 } },
  { step_order: 6,  step_type: 'task',     config: { title: 'belmoment' } },
  { step_order: 7,  step_type: 'wait',     config: { days: 2 } },
  { step_order: 8,  step_type: 'whatsapp', config: { template_id: 'w17' } },
  { step_order: 9,  step_type: 'email',    config: { template_id: 'e17' } },
  { step_order: 10, step_type: 'task',     config: { title: 'belmoment' } },
  { step_order: 11, step_type: 'wait',     config: { days: 4 } },
  { step_order: 12, step_type: 'whatsapp', config: { template_id: 'w21' } },
  { step_order: 13, step_type: 'email',    config: { template_id: 'e21' } },
  { step_order: 14, step_type: 'task',     config: { title: 'belmoment' } },
  { step_order: 15, step_type: 'task',     config: { title: 'taak' } },
  { step_order: 16, step_type: 'wait',     config: { days: 15 } },
  { step_order: 17, step_type: 'task',     config: { title: 'belmoment' } },
  { step_order: 18, step_type: 'wait',     config: { days: 1 } },
  { step_order: 19, step_type: 'whatsapp', config: { template_id: 'w37' } },
  { step_order: 20, step_type: 'email',    config: { template_id: 'e37' } },
  { step_order: 21, step_type: 'stop',     config: {} },
];

function aanmaningenTijdlijn() {
  return bouwTijdlijn({
    steps: AANMANINGEN_STEPS, templates: AANMANINGEN_TPL,
    triggerConditions: { min_days_overdue: 1 },
    ladder: DEFAULT_LADDER, caps: { whatsapp: 1, email: 1 },
  });
}

test('PRODUCTIE "Aanmaningen": startdag blijft dag 1 — min_days_overdue is expliciet 1', () => {
  const t = aanmaningenTijdlijn();
  assert.equal(t.start_voor, 1);
  assert.equal(t.start_na, 1);
});

test('PRODUCTIE "Aanmaningen": de volledige tijdlijn, voor en na', () => {
  const t = aanmaningenTijdlijn();
  const perStap = Object.fromEntries(t.rijen.map((r) => [r.step_order, [r.dag_voor, r.dag_na]]));
  assert.deepEqual(perStap, {
    0:  [1, 1],    1:  [1, 1],    2:  [1, 1],       // ronde 1 + wait
    3:  [8, 7],    4:  [8, 7],    5:  [8, 7],       // ronde 2 gaat een dag NAAR VOREN
    6:  [9, 14],                                    // eerste bel-taak: +5
    7:  [9, 14],
    8:  [11, 15],  9:  [11, 15],  10: [11, 15],     // ronde 3 + taak: +4
    11: [11, 15],
    12: [15, 21],  13: [15, 21],  14: [15, 21], 15: [15, 21],   // ronde 4 + 2 taken: +6
    16: [15, 21],
    17: [30, 30],  18: [30, 30],                    // staart komt weer samen
    19: [31, 31],  20: [31, 31],  21: [31, 31],
  });
});

test('PRODUCTIE "Aanmaningen": alleen het midden rekt op, de staart niet', () => {
  const t = aanmaningenTijdlijn();
  const verschil = (o) => t.rijen.find((r) => r.step_order === o).verschil;
  assert.equal(verschil(0),   0, 'ronde 1 ongewijzigd');
  assert.equal(verschil(3),  -1, 'ronde 2 een dag naar voren');
  assert.equal(verschil(6),  +5, 'eerste bel-taak');
  assert.equal(verschil(8),  +4, 'ronde 3');
  assert.equal(verschil(10), +4, 'taak bij ronde 3');
  assert.equal(verschil(12), +6, 'ronde 4');
  assert.equal(verschil(14), +6, 'taken bij ronde 4');
  assert.equal(verschil(17),  0, 'taak stap 17 blijft op dag 30');
  assert.equal(verschil(19),  0, 'ronde 5 blijft op dag 31');
});

test('PRODUCTIE "Aanmaningen": de wait op stap 7 kan niet op dezelfde dag uitkomen', () => {
  // Stap 6 landt op dag 14 (de sport van aanmaning_dag17). De wait op stap 7
  // mikt op diezelfde sport, dus de klem schuift 'm naar dag 15 — daarom
  // vertrekt ronde 3 op 15 en niet op 14.
  const t = aanmaningenTijdlijn();
  assert.equal(t.rijen.find((r) => r.step_order === 6).dag_na, 14);
  assert.equal(t.rijen.find((r) => r.step_order === 8).dag_na, 15);
});

// ── Synthetische variant: de drie richtingen van de verschuiving ──────────
const TPL = {
  w7:  { name: 'Aanmaning WA dag 7',        meta_template_name: 'aanmaning_dag7'  },
  e7:  { name: 'Aanmaning dag 7 (E-mail)',  meta_template_name: null },
  w14: { name: 'Aanmaning WA dag 14',       meta_template_name: 'aanmaning_dag14' },
  e14: { name: 'Aanmaning dag 14 (E-mail)', meta_template_name: null },
  w17: { name: 'Aanmaning WA dag 17',       meta_template_name: 'aanmaning_dag17' },
};

// De feitelijke kop van de workflow, met een instelbare wachtstap na ronde 2
// en daarachter een bel-taak plus ronde 3.
function stappen(waitNaRonde2) {
  return [
    { step_order: 0, step_type: 'whatsapp', config: { template_id: 'w7'  } },
    { step_order: 1, step_type: 'email',    config: { template_id: 'e7'  } },
    { step_order: 2, step_type: 'wait',     config: { days: 7 } },
    { step_order: 3, step_type: 'whatsapp', config: { template_id: 'w14' } },
    { step_order: 4, step_type: 'email',    config: { template_id: 'e14' } },
    { step_order: 5, step_type: 'wait',     config: { days: waitNaRonde2 } },
    { step_order: 6, step_type: 'task',     config: { title: 'Belmoment Dave' } },
    { step_order: 7, step_type: 'whatsapp', config: { template_id: 'w17' } },
  ];
}

function tijdlijn(waitNaRonde2, triggerConditions = { min_days_overdue: 1 }) {
  return bouwTijdlijn({
    steps: stappen(waitNaRonde2), templates: TPL,
    triggerConditions, ladder: DEFAULT_LADDER, caps: { whatsapp: 1, email: 1 },
  });
}
const dagVan = (t, order, kolom) => t.rijen.find((r) => r.step_order === order)[kolom];

// ── Startdag ──────────────────────────────────────────────────────────────
test('startdag: een expliciete min_days_overdue blijft in beide kolommen gelden', () => {
  const t = tijdlijn(3);
  assert.equal(t.start_voor, 1);
  assert.equal(t.start_na, 1);
});

test('startdag: zonder min_days_overdue van de oude default 14 naar de laagste ladder-sport', () => {
  // Deze terugval gold voor workflows ZONDER expliciete min_days_overdue.
  const t = tijdlijn(3, {});
  assert.equal(t.start_voor, 14, 'oude default');
  assert.equal(t.start_na, 1, 'na: de laagste ladder-sport (aanmaning_dag7 = dag 1)');
});

test('startdag: de -1-terugval bij een factuurdatum-trigger gaf dag 0', () => {
  // Dit was het gat in detectAndStartRuns: min_days_since_invoice_date liet
  // minDays op -1 vallen, en de op 0 geclampte teller maakte daar dag 0 van.
  // De actieve workflow "Aanmaningen" viel hier NIET onder — die heeft een
  // expliciete min_days_overdue van 1.
  const t = tijdlijn(3, { min_days_since_invoice_date: 7 });
  assert.equal(t.start_voor, 0);
  assert.equal(t.start_na, 1);
});

test('startdag: een hogere expliciete min_days_overdue wordt gerespecteerd', () => {
  const t = tijdlijn(3, { min_days_overdue: 5 });
  assert.equal(t.start_voor, 5);
  assert.equal(t.start_na, 5);
});

// ── Ronde 1 en 2: het koppel blijft bij elkaar ────────────────────────────
test('ronde 1: WhatsApp en e-mail landen op dezelfde dag', () => {
  const t = tijdlijn(3);
  assert.equal(dagVan(t, 0, 'dag_voor'), 1);
  assert.equal(dagVan(t, 1, 'dag_voor'), 1);
  assert.equal(dagVan(t, 0, 'dag_na'), 1);
  assert.equal(dagVan(t, 1, 'dag_na'), 1, 'de e-mail blijft bij de WhatsApp — geen dag ertussen');
});

test('ronde 2: de wait van 7 dagen komt op dag 8 uit, de ladder op dag 7', () => {
  const t = tijdlijn(3);
  for (const stap of [3, 4]) {
    assert.equal(dagVan(t, stap, 'dag_voor'), 8);
    assert.equal(dagVan(t, stap, 'dag_na'), 7);
    assert.equal(dagVan(t, stap, 'verschil'), -1, 'een dag naar voren');
  }
});

// ── De taak-stappen: de kern van de vraag ─────────────────────────────────
test('taak na een KORTE wait schuift NAAR ACHTEREN, naar de ladderdag', () => {
  // Ronde 2 op dag 8, wait 3 → voorheen dag 11. Nu mikt de wait op de
  // ladderdag van de eerstvolgende send (aanmaning_dag17 = dag 14).
  const t = tijdlijn(3);
  assert.equal(dagVan(t, 6, 'dag_voor'), 11);
  assert.equal(dagVan(t, 6, 'dag_na'), 14);
  assert.equal(dagVan(t, 6, 'verschil'), 3);
});

test('taak na een wait die precies op de ladderdag uitkomt verschuift niet', () => {
  const t = tijdlijn(6);   // 8 + 6 = 14 = de sport van aanmaning_dag17
  assert.equal(dagVan(t, 6, 'dag_voor'), 14);
  assert.equal(dagVan(t, 6, 'dag_na'), 14);
  assert.equal(dagVan(t, 6, 'verschil'), 0);
});

test('taak na een LANGE wait schuift juist NAAR VOREN', () => {
  // wait 10 → voorheen dag 18, nu de ladderdag 14. De verschuiving is dus niet
  // altijd naar achteren; het hangt af van de wachtdagen.
  const t = tijdlijn(10);
  assert.equal(dagVan(t, 6, 'dag_voor'), 18);
  assert.equal(dagVan(t, 6, 'dag_na'), 14);
  assert.equal(dagVan(t, 6, 'verschil'), -4);
});

test('de taak landt altijd op de ladderdag van de eerstvolgende send-stap', () => {
  for (const w of [0, 1, 3, 5, 7, 10, 20]) {
    const t = tijdlijn(w);
    assert.equal(dagVan(t, 6, 'dag_na'), 14, `wait ${w}: taak op de sport van aanmaning_dag17`);
    assert.equal(dagVan(t, 7, 'dag_na'), 14, `wait ${w}: de send zelf ook`);
  }
});

// ── loopStappen los ───────────────────────────────────────────────────────
test('loopStappen: zonder ladder-gating en zonder klem is het puur optellen', () => {
  const rijen = loopStappen({
    steps: stappen(3), templates: TPL, ladder: DEFAULT_LADDER,
    startDay: 0, ladderGating: false, waitTargetsLadder: false, dailyCap: false,
  });
  assert.deepEqual(rijen.map((r) => r.dag), [0, 0, 0, 7, 7, 7, 10, 10]);
});

test('loopStappen: dagcap per kanaal — e-mail mee, tweede WhatsApp een dag later', () => {
  // WhatsApp + e-mail + nog een WhatsApp, zonder wait ertussen en zonder
  // ladder-sport. Het koppel gaat samen op dag 1; de tweede WhatsApp moet
  // wachten tot dag 2, en de run schuift daarmee als geheel mee.
  const drie = [
    { step_order: 0, step_type: 'whatsapp', config: { template_id: 'x' } },
    { step_order: 1, step_type: 'email',    config: { template_id: 'y' } },
    { step_order: 2, step_type: 'whatsapp', config: { template_id: 'x' } },
  ];
  const rijen = loopStappen({
    steps: drie, templates: { x: { name: 'los-wa' }, y: { name: 'los-mail' } },
    ladder: DEFAULT_LADDER, caps: { whatsapp: 1, email: 1 }, startDay: 1,
  });
  assert.equal(rijen[0].dag, 1, 'WhatsApp op dag 1');
  assert.equal(rijen[1].dag, 1, 'de e-mail heeft zijn eigen budget en gaat mee op dag 1');
  assert.equal(rijen[2].dag, 2, 'tweede WhatsApp pas de volgende dag');
});
