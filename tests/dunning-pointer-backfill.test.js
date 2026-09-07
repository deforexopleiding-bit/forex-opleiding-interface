// tests/dunning-pointer-backfill.test.js
//
// Tests voor de planner van scripts/dunning-pointer-backfill.js. De planner is
// puur: hij krijgt een snapshot en bepaalt welke run-pointer waarheen moet.
// Het schrijven zelf (apply) zit erbuiten en wordt hier niet aangeraakt.
//
// Gedekt:
//   • de pointer landt op de sport die bij de ECHTE days_overdue hoort
//   • gepauzeerde runs doen mee (anders cascaderen ze zodra de pauze wegvalt)
//   • idempotent: een tweede ronde verzet niets meer
//   • needs_attention, niet-vervallen en run-zonder-factuur worden overgeslagen
//   • de synthetische voorbeeld-fixture in de repo blijft kloppen

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planBackfill } from '../scripts/dunning-pointer-backfill.js';

const LADDER = { aanmaning_dag7: 1, aanmaning_dag14: 7, aanmaning_dag17: 14, aanmaning_dag21: 21, aanmaning_dag37: 30 };

const TEMPLATES = {
  t7:  { id: 't7',  name: 'WA dag 7',  meta_template_name: 'aanmaning_dag7'  },
  t14: { id: 't14', name: 'WA dag 14', meta_template_name: 'aanmaning_dag14' },
  t17: { id: 't17', name: 'WA dag 17', meta_template_name: 'aanmaning_dag17' },
  t21: { id: 't21', name: 'WA dag 21', meta_template_name: 'aanmaning_dag21' },
  t37: { id: 't37', name: 'WA dag 37', meta_template_name: 'aanmaning_dag37' },
};

const STEPS = [
  { id: 's1', workflow_id: 'wf1', step_order: 1, step_type: 'whatsapp', config: { template_id: 't7'  } },
  { id: 's2', workflow_id: 'wf1', step_order: 2, step_type: 'wait',     config: { days: 6 } },
  { id: 's3', workflow_id: 'wf1', step_order: 3, step_type: 'whatsapp', config: { template_id: 't14' } },
  { id: 's4', workflow_id: 'wf1', step_order: 4, step_type: 'wait',     config: { days: 7 } },
  { id: 's5', workflow_id: 'wf1', step_order: 5, step_type: 'whatsapp', config: { template_id: 't17' } },
  { id: 's6', workflow_id: 'wf1', step_order: 6, step_type: 'wait',     config: { days: 7 } },
  { id: 's7', workflow_id: 'wf1', step_order: 7, step_type: 'whatsapp', config: { template_id: 't21' } },
  { id: 's8', workflow_id: 'wf1', step_order: 8, step_type: 'wait',     config: { days: 9 } },
  { id: 's9', workflow_id: 'wf1', step_order: 9, step_type: 'whatsapp', config: { template_id: 't37' } },
];

const TODAY = '2026-09-07';
function dueMinus(dagen) {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - dagen * 86400000).toISOString().slice(0, 10);
}
function snap(runs, customers) {
  return { today: TODAY, ladder: LADDER, steps: STEPS, templates: TEMPLATES, runs, customers };
}
function run(id, { status = 'active', step = 's1', ...rest } = {}) {
  return { id: `run-${id}`, workflow_id: 'wf1', customer_id: id, status, current_step_id: step, needs_attention: false, ...rest };
}
function cust(id, dagen) {
  return { [id]: { id, name: `Klant ${id}`, oldest_due: dueMinus(dagen) } };
}

// ── De juiste sport ───────────────────────────────────────────────────────
test('pointer landt op de sport die bij de echte days_overdue hoort', () => {
  const gevallen = [
    [1,  's1', 'aanmaning_dag7'],
    [6,  's1', 'aanmaning_dag7'],
    [7,  's3', 'aanmaning_dag14'],
    [14, 's5', 'aanmaning_dag17'],
    [21, 's7', 'aanmaning_dag21'],
    [30, 's9', 'aanmaning_dag37'],
    [95, 's9', 'aanmaning_dag37'],
  ];
  for (const [dagen, verwachteStap, verwachteTpl] of gevallen) {
    const { moves } = planBackfill(snap([run('k')], cust('k', dagen)));
    if (verwachteStap === 's1') {
      assert.equal(moves.length, 0, `${dagen} dagen: pointer staat al op de juiste sport`);
      continue;
    }
    assert.equal(moves.length, 1, `${dagen} dagen te laat`);
    assert.equal(moves[0].to_step_id, verwachteStap);
    assert.equal(moves[0].to_template, verwachteTpl);
    assert.equal(moves[0].days_overdue, dagen);
  }
});

// ── Gepauzeerde runs ──────────────────────────────────────────────────────
test('gepauzeerde runs doen mee — anders cascaderen ze zodra de pauze wegvalt', () => {
  const runs = [
    run('gesprek',     { status: 'paused', paused_by_conversation_id: 'c1' }),
    run('arrangement', { status: 'paused', paused_by_arrangement_id: 'a1' }),
    run('handmatig',   { status: 'paused', paused_manual_reason: 'reply_email' }),
  ];
  const customers = { ...cust('gesprek', 60), ...cust('arrangement', 60), ...cust('handmatig', 60) };
  const { moves } = planBackfill(snap(runs, customers));
  assert.equal(moves.length, 3);
  assert.ok(moves.every((m) => m.run_status === 'paused'));
  assert.deepEqual(moves.map((m) => m.paused_reason).sort(), ['arrangement', 'gesprek', 'reply_email']);
  // De status zelf verandert niet: de planner levert alleen een pointer-doel.
  // Alleen de gesprekspauze krijgt een sport lager (toon-beslissing).
  const perReden = Object.fromEntries(moves.map((m) => [m.paused_reason, m.to_step_id]));
  assert.equal(perReden.arrangement, 's9');
  assert.equal(perReden.reply_email, 's9');
  assert.equal(perReden.gesprek,     's7', 'gesprekspauze: één sport lager');
});

// ── TOON-BESLISSING: gesprekspauze één sport lager ────────────────────────
test('TOON: gespreksgepauzeerde run met 60 dagen te laat landt op aanmaning_dag21', () => {
  const { moves } = planBackfill(snap(
    [run('g', { status: 'paused', paused_by_conversation_id: 'conv-1' })],
    cust('g', 60),
  ));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to_template, 'aanmaning_dag21');
  assert.equal(moves[0].to_step_id, 's7');
  assert.equal(moves[0].tone_downgrade, true);
  assert.equal(moves[0].conversation_paused, true);
  assert.equal(moves[0].highest_reached_template, 'aanmaning_dag37');
  assert.match(moves[0].downgrade_reason, /lopend gesprek/);
});

test('TOON: actieve run met dezelfde 60 dagen achterstand landt op aanmaning_dag37', () => {
  const { moves } = planBackfill(snap([run('a')], cust('a', 60)));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to_template, 'aanmaning_dag37');
  assert.equal(moves[0].to_step_id, 's9');
  assert.equal(moves[0].tone_downgrade, false);
  assert.equal(moves[0].conversation_paused, false);
});

test('TOON: één bereikte sport blijft staan — nooit lager dan de laagste', () => {
  // 3 dagen te laat → alleen aanmaning_dag7 (sport dag 1) bereikt. Er is geen
  // lagere sport, dus de pointer blijft op s1 en de move valt weg tegen de
  // idempotentiecheck.
  const { moves, skipped } = planBackfill(snap(
    [run('g', { status: 'paused', paused_by_conversation_id: 'conv-1' })],
    cust('g', 3),
  ));
  assert.equal(moves.length, 0);
  assert.match(skipped[0].reason, /pointer staat al goed/);
});

test('TOON: verlaging gaat nooit terug naar een stap die de pointer al voorbij is', () => {
  // Pointer staat al op s9 (aanmaning_dag37); de verlaging zou s7 opleveren,
  // maar terugzetten mag niet — de idempotentiecheck houdt 'm tegen.
  const { moves, skipped } = planBackfill(snap(
    [run('g', { status: 'paused', paused_by_conversation_id: 'conv-1', step: 's9' })],
    cust('g', 60),
  ));
  assert.equal(moves.length, 0);
  assert.match(skipped[0].reason, /toon-verlaging|al goed/);
});

test('TOON: verlaging slaat de e-mailstap over — alleen ladder-sporten tellen', () => {
  // Een workflow met whatsapp + e-mail per ronde. De e-mails staan niet op de
  // ladder, dus "één sport lager" dan aanmaning_dag37 is aanmaning_dag21 en
  // niet de e-mail van dag 21.
  const stepsMetMail = [
    { id: 'm0', workflow_id: 'wf1', step_order: 0, step_type: 'whatsapp', config: { template_id: 't7'  } },
    { id: 'm1', workflow_id: 'wf1', step_order: 1, step_type: 'whatsapp', config: { template_id: 't21' } },
    { id: 'm2', workflow_id: 'wf1', step_order: 2, step_type: 'email',    config: { template_id: 'e21' } },
    { id: 'm3', workflow_id: 'wf1', step_order: 3, step_type: 'whatsapp', config: { template_id: 't37' } },
    { id: 'm4', workflow_id: 'wf1', step_order: 4, step_type: 'email',    config: { template_id: 'e37' } },
  ];
  const s = {
    today: TODAY, ladder: LADDER, steps: stepsMetMail,
    templates: { ...TEMPLATES, e21: { id: 'e21', name: 'Aanmaning dag 21 (E-mail)' }, e37: { id: 'e37', name: 'Aanmaning dag 37 (E-mail)' } },
    runs: [{ id: 'run-g', workflow_id: 'wf1', customer_id: 'g', status: 'paused', current_step_id: 'm0', needs_attention: false, paused_by_conversation_id: 'c1' }],
    customers: cust('g', 60),
  };
  const { moves } = planBackfill(s);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to_template, 'aanmaning_dag21');
  assert.equal(moves[0].to_step_id, 'm1', 'de whatsapp van ronde 21, niet de e-mail');
});

// ── Idempotentie ──────────────────────────────────────────────────────────
test('idempotent: na de eerste ronde valt er niets meer te verzetten', () => {
  const s1 = snap([run('k')], cust('k', 60));
  const eerste = planBackfill(s1);
  assert.equal(eerste.moves.length, 1);

  // Tweede ronde met de pointer waar de eerste ronde 'm zou zetten.
  const s2 = snap([run('k', { step: eerste.moves[0].to_step_id })], cust('k', 60));
  const tweede = planBackfill(s2);
  assert.equal(tweede.moves.length, 0);
  assert.equal(tweede.skipped[0].reason, 'pointer staat al goed of verder');
});

test('een pointer die al VERDER staat wordt nooit teruggezet', () => {
  // Klant 8 dagen te laat (sport dag 7 → stap 3), pointer staat al op stap 7.
  const { moves, skipped } = planBackfill(snap([run('k', { step: 's7' })], cust('k', 8)));
  assert.equal(moves.length, 0);
  assert.equal(skipped[0].reason, 'pointer staat al goed of verder');
});

// ── Overslaan ─────────────────────────────────────────────────────────────
test('overslaan: needs_attention, nog niet vervallen, en geen openstaande factuur', () => {
  const attentie = planBackfill(snap([run('a', { needs_attention: true })], cust('a', 60)));
  assert.equal(attentie.moves.length, 0);
  assert.match(attentie.skipped[0].reason, /needs_attention/);

  const nietVervallen = planBackfill(snap([run('b')], cust('b', -5)));
  assert.equal(nietVervallen.moves.length, 0);
  assert.match(nietVervallen.skipped[0].reason, /nog niet vervallen/);

  const opDeVervaldag = planBackfill(snap([run('c')], cust('c', 0)));
  assert.equal(opDeVervaldag.moves.length, 0, 'op de vervaldag zelf verzetten we niets');

  const geenFactuur = planBackfill(snap([run('d')], {}));
  assert.equal(geenFactuur.moves.length, 0);
  assert.match(geenFactuur.skipped[0].reason, /geen openstaande factuur/);
});

test('overslaan: workflow zonder stappen', () => {
  const s = { ...snap([run('k')], cust('k', 60)), steps: [] };
  const { moves, skipped } = planBackfill(s);
  assert.equal(moves.length, 0);
  assert.match(skipped[0].reason, /workflow zonder stappen/);
});

// ── De meegeleverde voorbeeld-fixture ─────────────────────────────────────
test('voorbeeld-fixture: dekt de gemeten verdeling en levert een stabiel plan', () => {
  const fixture = JSON.parse(readFileSync('scripts/fixtures/dunning-backfill-voorbeeld.json', 'utf8'));
  // 21 gemeten actieve runs + 2 randgevallen (pointer al goed, needs_attention).
  assert.equal(fixture.runs.filter((r) => r.status === 'active').length, 23);
  assert.equal(fixture.runs.filter((r) => r.status === 'paused').length, 68);

  const { moves, skipped } = planBackfill(fixture);
  assert.equal(moves.length, 69);
  assert.equal(moves.filter((m) => m.run_status === 'active').length, 20);
  // 44 gespreksgepauzeerde zware gevallen gaan één sport lager naar dag21;
  // de 19 lichte gespreksgepauzeerde runs vallen tegen de idempotentiecheck.
  assert.equal(moves.filter((m) => m.conversation_paused).length, 44);
  assert.equal(moves.filter((m) => m.tone_downgrade).length, 44);
  assert.ok(moves.filter((m) => m.conversation_paused).every((m) => m.to_template === 'aanmaning_dag21'));
  assert.equal(moves.filter((m) => !m.conversation_paused && m.to_template === 'aanmaning_dag37').length, 21);
  assert.equal(skipped.length, 22);
  assert.equal(skipped.filter((s) => /toon-verlaging/.test(s.reason)).length, 19);

  // Tweede ronde op het resultaat: niets meer te doen.
  const na = {
    ...fixture,
    runs: fixture.runs.map((r) => {
      const m = moves.find((x) => x.run_id === r.id);
      return m ? { ...r, current_step_id: m.to_step_id } : r;
    }),
  };
  assert.equal(planBackfill(na).moves.length, 0, 'idempotent op de volledige fixture');
});
