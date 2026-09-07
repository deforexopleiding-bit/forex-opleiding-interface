// tests/dunning-workflow-tijdlijn.test.js
//
// Tests voor de rekenkern van scripts/dunning-workflow-tijdlijn.js: op welke
// dag na de vervaldatum landt elke stap, vóór deze branch en erna?
//
// De hier gebruikte stappen 0 t/m 4 zijn de FEITELIJKE kop van de
// productie-workflow "Aanmaningen" (9805c900-1c74-4326-9d15-a1e49f754eb0):
// whatsapp aanmaning_dag7 + e-mail "Aanmaning dag 7 (E-mail)", wait 7 dagen,
// whatsapp aanmaning_dag14 + e-mail "Aanmaning dag 14 (E-mail)". De
// wachtdagen ná stap 4 verschillen per ronde; die worden hier als parameter
// gevarieerd zodat de conclusie niet van één aanname afhangt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopStappen, bouwTijdlijn } from '../scripts/dunning-workflow-tijdlijn.js';
import { DEFAULT_LADDER } from '../api/_lib/dunning-overdue-guard.js';

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

function tijdlijn(waitNaRonde2, triggerConditions = { min_days_since_invoice_date: 7 }) {
  return bouwTijdlijn({
    steps: stappen(waitNaRonde2), templates: TPL,
    triggerConditions, ladder: DEFAULT_LADDER, caps: { whatsapp: 1, email: 1 },
  });
}
const dagVan = (t, order, kolom) => t.rijen.find((r) => r.step_order === order)[kolom];

// ── Startdag ──────────────────────────────────────────────────────────────
test('startdag: van dag 0 (de vervaldag zelf) naar dag 1', () => {
  // VOOR: min_days_since_invoice_date gezet → minDays viel terug op -1 en de
  // geclampte teller maakte daar dag 0 van. Dat is precies waarom er op de
  // vervaldag zelf al aanmaningen uitgingen.
  const t = tijdlijn(3);
  assert.equal(t.start_voor, 0);
  assert.equal(t.start_na, 1, 'na: de laagste ladder-sport (aanmaning_dag7 = dag 1)');
});

test('startdag: een workflow met een expliciete min_days_overdue houdt die', () => {
  const t = tijdlijn(3, { min_days_overdue: 5 });
  assert.equal(t.start_voor, 5);
  assert.equal(t.start_na, 5);
});

// ── Ronde 1 en 2: het koppel blijft bij elkaar ────────────────────────────
test('ronde 1: WhatsApp en e-mail landen op dezelfde dag, en schuiven samen op', () => {
  const t = tijdlijn(3);
  assert.equal(dagVan(t, 0, 'dag_voor'), 0);
  assert.equal(dagVan(t, 1, 'dag_voor'), 0);
  assert.equal(dagVan(t, 0, 'dag_na'), 1);
  assert.equal(dagVan(t, 1, 'dag_na'), 1, 'de e-mail blijft bij de WhatsApp — geen dag ertussen');
});

test('ronde 2: landt op dag 7, voor én na — de ladder valt samen met de wait', () => {
  const t = tijdlijn(3);
  for (const stap of [3, 4]) {
    assert.equal(dagVan(t, stap, 'dag_voor'), 7);
    assert.equal(dagVan(t, stap, 'dag_na'), 7);
    assert.equal(dagVan(t, stap, 'verschil'), 0);
  }
});

// ── De taak-stappen: de kern van de vraag ─────────────────────────────────
test('taak na een KORTE wait schuift NAAR ACHTEREN, naar de ladderdag', () => {
  // wait 3 → voorheen dag 7+3 = 10. Nu mikt de wait op de ladderdag van de
  // eerstvolgende send (aanmaning_dag17 = dag 14).
  const t = tijdlijn(3);
  assert.equal(dagVan(t, 6, 'dag_voor'), 10);
  assert.equal(dagVan(t, 6, 'dag_na'), 14);
  assert.equal(dagVan(t, 6, 'verschil'), 4);
});

test('taak na een wait die precies op de ladderdag uitkomt verschuift niet', () => {
  const t = tijdlijn(7);   // 7 + 7 = 14 = de sport van aanmaning_dag17
  assert.equal(dagVan(t, 6, 'dag_voor'), 14);
  assert.equal(dagVan(t, 6, 'dag_na'), 14);
  assert.equal(dagVan(t, 6, 'verschil'), 0);
});

test('taak na een LANGE wait schuift juist NAAR VOREN', () => {
  // wait 10 → voorheen dag 17, nu de ladderdag 14. De verschuiving is dus niet
  // altijd naar achteren; het hangt af van de wachtdagen.
  const t = tijdlijn(10);
  assert.equal(dagVan(t, 6, 'dag_voor'), 17);
  assert.equal(dagVan(t, 6, 'dag_na'), 14);
  assert.equal(dagVan(t, 6, 'verschil'), -3);
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
