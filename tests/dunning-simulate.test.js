// tests/dunning-simulate.test.js
//
// Verificatie van de dry-run-simulator (api/_lib/dunning-simulate.js) op
// synthetische snapshots. Twee doelen:
//
//   1. Bewijzen dat de simulator de motor correct spiegelt (ladder-timing,
//      vervaldatum-poort, cooldown, één send per tick).
//   2. Het INHAALGOLF-risico kwantificeren: wat gebeurt er met een klant die
//      al lang te laat is terwijl zijn run-pointer nog op een vroege stap
//      staat — en wat doen de twee voorgestelde maatregelen ermee?
//
// Geen DB, geen netwerk: alles draait op de meegegeven snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateEngine, oldestDueIso, totalOpenEur } from '../api/_lib/dunning-simulate.js';
import { DEFAULT_LADDER } from '../api/_lib/dunning-overdue-guard.js';

// ── Bouwstenen ────────────────────────────────────────────────────────────

const TEMPLATES = {
  t7:  { id: 't7',  name: 'Aanmaning WA dag 7',  meta_template_name: 'aanmaning_dag7',  kind: 'whatsapp' },
  t14: { id: 't14', name: 'Aanmaning WA dag 14', meta_template_name: 'aanmaning_dag14', kind: 'whatsapp' },
  t17: { id: 't17', name: 'Aanmaning WA dag 17', meta_template_name: 'aanmaning_dag17', kind: 'whatsapp' },
  t21: { id: 't21', name: 'Aanmaning WA dag 21', meta_template_name: 'aanmaning_dag21', kind: 'whatsapp' },
  t37: { id: 't37', name: 'Aanmaning WA dag 37', meta_template_name: 'aanmaning_dag37', kind: 'whatsapp' },
};

// De vijf sporten met een wachtstap ertussen — de vorm van de productie-
// workflow "Aanmaningen".
const LADDER_STEPS = [
  { id: 's1', step_order: 1, step_type: 'whatsapp', config: { template_id: 't7'  } },
  { id: 's2', step_order: 2, step_type: 'wait',     config: { days: 6 } },
  { id: 's3', step_order: 3, step_type: 'whatsapp', config: { template_id: 't14' } },
  { id: 's4', step_order: 4, step_type: 'wait',     config: { days: 7 } },
  { id: 's5', step_order: 5, step_type: 'whatsapp', config: { template_id: 't17' } },
  { id: 's6', step_order: 6, step_type: 'wait',     config: { days: 7 } },
  { id: 's7', step_order: 7, step_type: 'whatsapp', config: { template_id: 't21' } },
  { id: 's8', step_order: 8, step_type: 'wait',     config: { days: 9 } },
  { id: 's9', step_order: 9, step_type: 'whatsapp', config: { template_id: 't37' } },
];

const WORKFLOW = {
  id: 'wf1', name: 'Aanmaningen', priority: 10,
  trigger_conditions: {}, steps: LADDER_STEPS,
};

function snapshot({ today = '2026-09-07', customers = [], runs = [], settings = {}, ...rest } = {}) {
  return {
    today,
    settings: {
      graceDays: 0, cooldownDays: 7, ladder: DEFAULT_LADDER,
      officeHours: { tz: 'Europe/Amsterdam', start: '08:00', end: '20:00', days: [0,1,2,3,4,5,6] },
      ...settings,
    },
    templates: TEMPLATES,
    workflows: [WORKFLOW],
    customers, runs,
    everRan: [], lastSendByCustomer: {}, blockedCustomers: [], breachedByCustomer: {},
    ...rest,
  };
}

function klant(id, dueDate, extra = {}) {
  return {
    id, name: `Klant ${id}`, is_company: false, stage_slug: 'nieuw',
    invoices: [{ id: `inv-${id}`, invoice_number: `2026/${id}`, due_date: dueDate, open_amount: 500 }],
    ...extra,
  };
}

// ── Basis-helpers ─────────────────────────────────────────────────────────
test('oldestDueIso / totalOpenEur: oudste vervaldatum en som open bedrag', () => {
  const invs = [
    { due_date: '2026-09-20', open_amount: 100 },
    { due_date: '2026-09-05', open_amount: 250.5 },
  ];
  assert.equal(oldestDueIso(invs), '2026-09-05');
  assert.equal(totalOpenEur(invs), 350.5);
  assert.equal(oldestDueIso([]), null);
});

// ── De poort en de ladder in de simulatie ─────────────────────────────────
test('simulatie: niet-vervallen klant krijgt niets, ook niet in 8 dagen vóór de vervaldag', () => {
  const snap = snapshot({ customers: [klant('A', '2026-09-20')] });  // vervalt over 13 dagen
  const r = simulateEngine(snap, { horizonDays: 8 });
  assert.equal(r.totals.messages, 0);
  assert.equal(r.totals.runs_started, 0);
});

test('simulatie: op de vervaldag zelf nog niets, dag erna het duwtje', () => {
  const snap = snapshot({ today: '2026-09-08', customers: [klant('A', '2026-09-08')] });
  const r = simulateEngine(snap, { horizonDays: 3 });
  assert.equal(r.days[0].total, 0, 'dag van vervallen: stil');
  assert.equal(r.days[1].total, 1, 'dag erna: 1 bericht');
  assert.deepEqual(r.days[1].by_template, { aanmaning_dag7: 1 });
});

test('simulatie: verse klant loopt de ladder af op de afgesproken dagen', () => {
  // Vervaldatum gisteren → vandaag is dag 1.
  const snap = snapshot({ today: '2026-09-07', customers: [klant('A', '2026-09-06')] });
  const r = simulateEngine(snap, { horizonDays: 32 });
  const byDate = Object.fromEntries(r.messages.map((m) => [m.template, m.date]));
  assert.equal(byDate.aanmaning_dag7,  '2026-09-07');  // dag 1
  assert.equal(byDate.aanmaning_dag14, '2026-09-13');  // dag 7
  assert.equal(byDate.aanmaning_dag17, '2026-09-20');  // dag 14
  assert.equal(byDate.aanmaning_dag21, '2026-09-27');  // dag 21
  assert.equal(byDate.aanmaning_dag37, '2026-10-06');  // dag 30
  assert.equal(r.same_day_bursts.length, 0, 'nooit twee sporten op één dag');
});

// ── INHAALGOLF ────────────────────────────────────────────────────────────
test('INHAALGOLF (zonder maatregel): bestaande run met vroege pointer bij 60 dagen te laat', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-07-09')],   // 60 dagen te laat
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  // disableDailyCap = de situatie VÓÓR de dagcap: dit is wat er zonder
  // vangnet zou gebeuren.
  const r = simulateEngine(snap, { horizonDays: 3, disableDailyCap: true, disableWaitClamp: true });

  // Alle vijf sporten zijn al voorbij → alle vijf mogen, en de motor doet
  // er maximaal één per uurlijkse tick. Resultaat: vijf berichten op dag 1.
  assert.equal(r.days[0].total, 5, 'vijf berichten op dag 1');
  assert.equal(r.totals.messages, 5, 'daarna is de workflow op');
  const burst = r.same_day_bursts[0];
  assert.equal(burst.count, 5);
  assert.deepEqual(burst.templates, [
    'aanmaning_dag7', 'aanmaning_dag14', 'aanmaning_dag17', 'aanmaning_dag21', 'aanmaning_dag37',
  ]);
  // Eén per tick, dus vijf opeenvolgende uren vanaf het begin van het venster.
  assert.deepEqual(burst.hours, [6, 7, 8, 9, 10], 'UTC-uren = 08:00-12:00 Amsterdam');
  // De cooldown vangt dit NIET af: die geldt alleen bij het starten van een
  // nieuwe run, niet tussen de stappen van een lopende run.
  const mm = r.multi_message_customers[0];
  assert.equal(mm.within_single_run, true);
  assert.equal(mm.min_gap_hours, 1);
  assert.equal(mm.cooldown_would_cover, false);
});

test('DAGCAP (default 1): dempt diezelfde golf tot één bericht per dag', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-07-09')],
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  // Geen opties: de simulator neemt de dagcap uit de settings (default 1),
  // net als de motor.
  const r = simulateEngine(snap, { horizonDays: 8 });
  assert.deepEqual(r.meta.options.maxSendsPerCustomerPerDay, { whatsapp: 1, email: 1 },
    'cap komt uit de settings, per kanaal');
  assert.equal(r.same_day_bursts.length, 0, 'geen enkele dag met 2 berichten');
  assert.deepEqual(r.days.slice(0, 5).map((d) => d.total), [1, 1, 1, 1, 1]);
  assert.equal(r.totals.messages, 5, 'zelfde vijf berichten, uitgesmeerd over vijf dagen');
});

test('INHAALGOLF: pointer-backfill levert één passend bericht in plaats van vijf', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-07-09')],
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  const r = simulateEngine(snap, { horizonDays: 8, backfillPointer: true });
  assert.equal(r.totals.messages, 1, 'alleen de sport die bij 60 dagen te laat hoort');
  assert.equal(r.messages[0].template, 'aanmaning_dag37');
  assert.equal(r.same_day_bursts.length, 0);
});

test('INHAALGOLF (zonder maatregel): klant die pas 8 dagen te laat is haalt 2 sporten in', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-08-30')],   // 8 dagen te laat
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  const zonder = simulateEngine(snap, { horizonDays: 2, disableDailyCap: true, disableWaitClamp: true });
  assert.equal(zonder.days[0].total, 2);
  assert.deepEqual(zonder.days[0].by_template, { aanmaning_dag7: 1, aanmaning_dag14: 1 });

  // Met de dagcap: één op dag 1, de tweede op dag 2.
  const met = simulateEngine(snap, { horizonDays: 2 });
  assert.deepEqual(met.days.map((d) => d.total), [1, 1]);
  assert.equal(met.same_day_bursts.length, 0);
});

// ── Cooldown ──────────────────────────────────────────────────────────────
test('cooldown: blokkeert het STARTEN van een run binnen 7 dagen na een send', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-08-01')],
    lastSendByCustomer: { A: '2026-09-05T09:00:00Z' },  // 2 dagen geleden
  });
  const r = simulateEngine(snap, { horizonDays: 4 });
  // Pas vanaf 12-09 (7 dagen na de laatste send) mag er een run starten.
  assert.equal(r.totals.runs_started, 0);
  assert.equal(r.totals.messages, 0);
});

test('cooldown: is niet van toepassing binnen één lopende run', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-07-09')],
    lastSendByCustomer: { A: '2026-09-06T09:00:00Z' },
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  const r = simulateEngine(snap, { horizonDays: 2, disableDailyCap: true, disableWaitClamp: true });
  assert.equal(r.totals.messages, 5, 'cooldown remt de stappen binnen de run niet');
  // De dagcap doet dat wél — dát is het verschil tussen de twee mechanismen.
  const metCap = simulateEngine(snap, { horizonDays: 2 });
  assert.equal(metCap.totals.messages, 2, 'dagcap: één per dag, dus 2 in 2 dagen');
});

// ── Overige guards ────────────────────────────────────────────────────────
test('guards: blokkerende handmatige actie houdt de run stil', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-07-09')],
    blockedCustomers: ['A'],
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  assert.equal(simulateEngine(snap, { horizonDays: 3 }).totals.messages, 0);
});

test('guards: terminale pipeline-fase en needs_attention starten/advancen niet', () => {
  const terminaal = simulateEngine(snapshot({
    customers: [klant('A', '2026-08-01', { stage_slug: 'opgelost' })],
  }), { horizonDays: 3 });
  assert.equal(terminaal.totals.messages, 0);

  const attentie = simulateEngine(snapshot({
    customers: [klant('B', '2026-07-09')],
    runs: [{
      id: 'run-B', workflow_id: 'wf1', customer_id: 'B', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: true,
    }],
  }), { horizonDays: 3 });
  assert.equal(attentie.totals.messages, 0);
});

test('guards: kantooruren — niets vóór 08:00 of na 20:00 Amsterdam', () => {
  const r = simulateEngine(snapshot({
    today: '2026-09-07', customers: [klant('A', '2026-09-06')],
  }), { horizonDays: 1 });
  for (const m of r.messages) {
    // September = CEST (UTC+2): 08:00 lokaal = 06:00 UTC, 20:00 = 18:00 UTC.
    assert.ok(m.hour >= 6 && m.hour < 18, `bericht op UTC-uur ${m.hour} valt buiten het venster`);
  }
});

// ── Nog-niet-vervallen cohort ─────────────────────────────────────────────
test('not_yet_due: rapporteert per klant wanneer de poort opengaat en wat er dan gebeurt', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [
      klant('A', '2026-09-08'),   // vervalt morgen  → poort dag 9
      klant('B', '2026-09-20'),   // vervalt over 13 → poort dag 21
      klant('C', '2026-08-01'),   // al te laat → hoort hier NIET in
    ],
  });
  const r = simulateEngine(snap, { horizonDays: 16 });
  const ids = r.not_yet_due.map((x) => x.customer_id);
  assert.deepEqual(ids, ['A', 'B']);

  const a = r.not_yet_due.find((x) => x.customer_id === 'A');
  assert.equal(a.days_until_due, 1);
  assert.equal(a.gate_opens_on, '2026-09-09');
  assert.equal(a.enters_engine_on, '2026-09-09');
  assert.equal(a.first_message_template, 'aanmaning_dag7');

  const b = r.not_yet_due.find((x) => x.customer_id === 'B');
  assert.equal(b.gate_opens_on, '2026-09-21');
  assert.equal(b.enters_engine_on, '2026-09-21');
});

// ── Rapport-vorm ──────────────────────────────────────────────────────────
test('rapport: dag-uitsplitsing per template en per workflow telt op tot het totaal', () => {
  const snap = snapshot({
    today: '2026-09-07',
    customers: [klant('A', '2026-09-06'), klant('B', '2026-09-06'), klant('C', '2026-09-06')],
  });
  const r = simulateEngine(snap, { horizonDays: 10 });
  const somDagen = r.days.reduce((s, d) => s + d.total, 0);
  assert.equal(somDagen, r.totals.messages);
  assert.equal(r.days[0].by_template.aanmaning_dag7, 3);
  assert.equal(r.days[0].by_workflow.Aanmaningen, 3);
  assert.equal(r.days[0].unique_customers, 3);
  assert.equal(r.meta.grace_days, 0);
  assert.equal(r.meta.cooldown_days, 7);
});

// ── Rapport-opmaak (het script) ───────────────────────────────────────────
// De rapport-renderer wordt hier gedraaid op een synthetische snapshot, zodat
// een opmaakfout niet pas opduikt wanneer het script tegen productie draait.
test('rapportage: buildReportText rendert alle vier de secties zonder te crashen', async () => {
  const { buildReportText } = await import('../scripts/dunning-dry-run-simulatie.js');
  const snap = snapshot({
    today: '2026-09-07',
    customers: [
      klant('A', '2026-07-09'),   // 60 dagen te laat → inhaalgolf
      klant('B', '2026-09-06'),   // dag 1
      klant('C', '2026-09-12'),   // nog niet vervallen
    ],
    runs: [{
      id: 'run-A', workflow_id: 'wf1', customer_id: 'A', status: 'active',
      current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
    }],
  });
  const base       = simulateEngine(snap, { horizonDays: 8 });
  const throttled  = simulateEngine(snap, { horizonDays: 8, maxSendsPerCustomerPerDay: 1 });
  const backfilled = simulateEngine(snap, { horizonDays: 8, backfillPointer: true });
  const longRun    = simulateEngine(snap, { horizonDays: 15 });

  const txt = buildReportText(snap, base, throttled, backfilled, longRun, 14);
  assert.match(txt, /## 1\. Berichten per dag/);
  assert.match(txt, /## 2\. Klanten met meerdere berichten kort na elkaar/);
  assert.match(txt, /## 3\. Inhaalgolf/);
  assert.match(txt, /## 4\. Klanten met een nog niet vervallen factuur \(komende 14 dagen\)/);
  assert.match(txt, /Klant A/);
  assert.match(txt, /aanmaning_dag7/);
  // De what-if-regels moeten echte getallen tonen, geen undefined/NaN.
  assert.doesNotMatch(txt, /undefined|NaN/);
});

// ── SCENARIO-BEREKENING op de gemeten live verdeling ──────────────────────
//
// Gemeten via de CRM-API op 2026-09-07 (156 klanten in de wanbetalerslijst):
//   run_status active =  21, waarvan 16 met 30+ dagen te laat
//   run_status paused =  68, waarvan 49 met 30+ dagen te laat
//   zonder run        =  67, allemaal nog niet vervallen
//
// De 5 actieve runs onder de 30 dagen hebben we niet per klant gemeten; die
// modelleren we op een gespreide reeks (3/8/12/18/25 dagen te laat). Pas
// ACTIVE_ONDER_30 aan als de echte verdeling bekend is — de 16 zware gevallen
// en de dag-1-conclusie veranderen daar niet van.
const ACTIVE_30PLUS      = 16;
const ACTIVE_ONDER_30    = [3, 8, 12, 18, 25];
const PAUSED_30PLUS      = 49;
const PAUSED_ONDER_30    = 19;
const ZONDER_RUN         = 67;

function liveSnapshot() {
  const customers = [];
  const runs = [];
  const push = (id, dagenTeLaat, runStatus) => {
    const due = new Date(Date.parse('2026-09-07T00:00:00Z') - dagenTeLaat * 86400000)
      .toISOString().slice(0, 10);
    customers.push({
      id, name: `Klant ${id}`, is_company: false, stage_slug: 'aangemaand',
      invoices: [{ id: `inv-${id}`, invoice_number: `2026/${id}`, due_date: due, open_amount: 450 }],
    });
    if (runStatus) {
      runs.push({
        id: `run-${id}`, workflow_id: 'wf1', customer_id: id, status: runStatus,
        current_step_id: 's1', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
        ...(runStatus === 'paused' ? { paused_by_conversation_id: `conv-${id}` } : {}),
      });
    }
  };
  for (let i = 0; i < ACTIVE_30PLUS; i++)   push(`A30-${i}`, 45, 'active');
  ACTIVE_ONDER_30.forEach((d, i) =>          push(`A-${i}`, d, 'active'));
  for (let i = 0; i < PAUSED_30PLUS; i++)   push(`P30-${i}`, 45, 'paused');
  for (let i = 0; i < PAUSED_ONDER_30; i++) push(`P-${i}`, 10, 'paused');
  for (let i = 0; i < ZONDER_RUN; i++) {
    // Nog niet vervallen: vervaldatum 1 t/m 20 dagen in de toekomst.
    const due = new Date(Date.parse('2026-09-07T00:00:00Z') + ((i % 20) + 1) * 86400000)
      .toISOString().slice(0, 10);
    customers.push({
      id: `N-${i}`, name: `NietVervallen ${i}`, is_company: false, stage_slug: null,
      invoices: [{ id: `inv-N${i}`, invoice_number: `2026/N${i}`, due_date: due, open_amount: 300 }],
    });
  }
  return snapshot({ today: '2026-09-07', customers, runs });
}

test('SCENARIO: dag 1 na deploy op de gemeten live verdeling', () => {
  const snap = liveSnapshot();
  assert.equal(snap.customers.length, 156, 'de verdeling telt op tot 156 klanten');
  assert.equal(snap.runs.filter((r) => r.status === 'active').length, 21);
  assert.equal(snap.runs.filter((r) => r.status === 'paused').length, 68);

  // 1) Zonder maatregel — de branch zoals die was vóór deze commit.
  const zonder = simulateEngine(snap, { horizonDays: 8, disableDailyCap: true, disableWaitClamp: true });
  // 16 klanten × 5 sporten + de 5 lichtere actieve runs met hun eigen sporten.
  assert.equal(zonder.days[0].total, 92, '92 berichten op één ochtend');
  assert.equal(zonder.days[0].by_template.aanmaning_dag37, 16, '16× de zwaarste template op dag 1');
  // 20 van de 21 actieve runs krijgen meerdere berichten op dag 1; alleen de
  // klant die pas 3 dagen te laat is heeft maar één sport bereikt.
  assert.equal(new Set(zonder.same_day_bursts.map((b) => b.customer_id)).size, 20);

  // 2) Alleen de dagcap (zonder de wait-klem) — één per klant per dag.
  const capOnly = simulateEngine(snap, { horizonDays: 8, disableWaitClamp: true });
  assert.equal(capOnly.days[0].total, 21, 'elke actieve run precies één bericht');
  assert.equal(capOnly.same_day_bursts.length, 0);
  assert.equal(capOnly.days[0].by_template.aanmaning_dag7, 21, 'allemaal nog het vriendelijke duwtje');

  // 3) Backfill + dagcap (de geleverde combinatie).
  const beide = simulateEngine(snap, { horizonDays: 8, backfillPointer: true });
  assert.equal(beide.days[0].total, 21);
  assert.equal(beide.same_day_bursts.length, 0);
  assert.equal(beide.days[0].by_template.aanmaning_dag37, 16, 'de 16 krijgen meteen de juiste sport');
  // Geen "misschien had je het gemist" naar iemand die 45 dagen te laat is.
  // (De klant die pas 3 dagen te laat is krijgt terecht wél aanmaning_dag7.)
  const zwaar = beide.messages.filter((m) => m.customer_id.startsWith('A30-'));
  assert.equal(zwaar.length, 16);
  assert.ok(zwaar.every((m) => m.template === 'aanmaning_dag37'),
    'de zware gevallen krijgen uitsluitend de sport die bij hun achterstand hoort');

  // Over acht dagen: de dagcap verplaatst berichten, de backfill schrapt ze.
  assert.equal(zonder.totals.messages, 121);
  assert.equal(capOnly.totals.messages, 121, 'dagcap smeert uit, schrapt niets');
  assert.equal(beide.totals.messages, 50, 'backfill schrapt de ingehaalde sporten');
  assert.deepEqual(capOnly.days.map((d) => d.total), [21, 20, 23, 22, 21, 5, 5, 4]);
  assert.deepEqual(beide.days.map((d) => d.total),   [21,  0,  5,  5,  5, 5, 5, 4]);

  // De geleverde branch (wait-klem + dagcap, zonder backfill) gedraagt zich op
  // dag 1 als scenario 2: de klem alleen dempt de golf al tot 1 per dag.
  const branch = simulateEngine(snap, { horizonDays: 8 });
  assert.equal(branch.days[0].total, 21);
  assert.equal(branch.same_day_bursts.length, 0);

  // Gepauzeerde runs sturen niets zolang ze gepauzeerd zijn — hun 49 zware
  // gevallen zijn de landmijn die de backfill moet ontmantelen.
  const paused = new Set(snap.runs.filter((r) => r.status === 'paused').map((r) => r.customer_id));
  assert.equal(zonder.messages.filter((m) => paused.has(m.customer_id)).length, 0);
});

// ── PER-KANAAL DAGCAP: het WhatsApp+e-mail-koppel ─────────────────────────
//
// De productie-workflow "Aanmaningen" (9805c900-1c74-4326-9d15-a1e49f754eb0)
// stuurt per ronde een WhatsApp ÉN een e-mail vlak na elkaar. De
// WhatsApp-templates staan op de ladder; de e-mailtemplates niet — hun naam
// is "Aanmaning dag N (E-mail)" en dat is geen ladder-sleutel, dus
// resolveStepTierDays geeft null en de e-mail volgt direct op de WhatsApp in
// dezelfde ronde. Met één gedeelde cap zou die e-mail elke ronde een dag
// vooruitgeschoven worden.
const EMAIL_TEMPLATES = {
  e7:  { id: 'e7',  name: 'Aanmaning dag 7 (E-mail)',  meta_template_name: null },
  e14: { id: 'e14', name: 'Aanmaning dag 14 (E-mail)', meta_template_name: null },
};

// Ronde 1: whatsapp + email, dan wait, dan ronde 2: whatsapp + email.
const KOPPEL_STEPS = [
  { id: 'k0', step_order: 0, step_type: 'whatsapp', config: { template_id: 't7'  } },
  { id: 'k1', step_order: 1, step_type: 'email',    config: { template_id: 'e7'  } },
  { id: 'k2', step_order: 2, step_type: 'wait',     config: { days: 6 } },
  { id: 'k3', step_order: 3, step_type: 'whatsapp', config: { template_id: 't14' } },
  { id: 'k4', step_order: 4, step_type: 'email',    config: { template_id: 'e14' } },
];

function koppelSnapshot({ today = '2026-09-07', dueDate = '2026-09-06', settings = {} } = {}) {
  return {
    today,
    settings: {
      graceDays: 0, cooldownDays: 7, ladder: DEFAULT_LADDER,
      officeHours: { tz: 'Europe/Amsterdam', start: '08:00', end: '20:00', days: [0,1,2,3,4,5,6] },
      ...settings,
    },
    templates: { ...TEMPLATES, ...EMAIL_TEMPLATES },
    workflows: [{ id: 'wf1', name: 'Aanmaningen', priority: 10, trigger_conditions: {}, steps: KOPPEL_STEPS }],
    customers: [{
      id: 'K', name: 'Klant K', is_company: false, stage_slug: 'nieuw',
      invoices: [{ id: 'inv-K', invoice_number: '2026/K', due_date: dueDate, open_amount: 500 }],
    }],
    runs: [],
    everRan: [], lastSendByCustomer: {}, blockedCustomers: [], breachedByCustomer: {},
  };
}

test('KOPPEL: whatsapp en e-mail van dezelfde ronde vertrekken op DEZELFDE dag', () => {
  // Vervaldatum gisteren → vandaag is dag 1, de sport van aanmaning_dag7.
  const r = simulateEngine(koppelSnapshot(), { horizonDays: 2 });
  const dag1 = r.messages.filter((m) => m.date === '2026-09-07');
  assert.equal(dag1.length, 2, 'twee berichten op dag 1: de WhatsApp en de e-mail');
  assert.deepEqual(dag1.map((m) => m.channel).sort(), ['email', 'whatsapp']);
  assert.deepEqual(dag1.map((m) => m.template).sort(),
    ['Aanmaning dag 7 (E-mail)', 'aanmaning_dag7']);
  // Zelfde tick, dus hetzelfde uur — geen dag ertussen.
  assert.equal(dag1[0].hour, dag1[1].hour, 'beide in dezelfde tick');
  // En het telt niet als inhaalgolf: per kanaal is het er één.
  assert.equal(r.same_day_bursts.length, 0);
});

test('KOPPEL: de e-mail loopt NIET permanent een dag achter de WhatsApp aan', () => {
  // Twee volledige rondes over 10 dagen: elke ronde moet WA+mail op één dag.
  const r = simulateEngine(koppelSnapshot(), { horizonDays: 10 });
  const perDag = {};
  for (const m of r.messages) (perDag[m.date] ||= []).push(m.channel);
  const dagenMetPost = Object.keys(perDag).sort();
  assert.equal(dagenMetPost.length, 2, 'twee verzenddagen: ronde 1 en ronde 2');
  for (const d of dagenMetPost) {
    assert.deepEqual(perDag[d].sort(), ['email', 'whatsapp'], `${d}: koppel compleet`);
  }
  assert.equal(dagenMetPost[0], '2026-09-07', 'ronde 1 op dag 1');
  assert.equal(dagenMetPost[1], '2026-09-13', 'ronde 2 op dag 7 (ladder-sport aanmaning_dag14)');
});

test('KOPPEL: een TWEEDE WhatsApp op dezelfde dag wordt wél tegengehouden', () => {
  // Klant is 60 dagen te laat: beide WhatsApp-sporten zijn gepasseerd, dus
  // zonder cap zou ronde 2 dezelfde dag volgen. De e-mail van ronde 1 mag mee,
  // de WhatsApp van ronde 2 niet.
  const snap = koppelSnapshot({ dueDate: '2026-07-09' });
  snap.runs = [{
    id: 'run-K', workflow_id: 'wf1', customer_id: 'K', status: 'active',
    current_step_id: 'k0', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
  }];
  const r = simulateEngine(snap, { horizonDays: 3 });

  const dag1 = r.messages.filter((m) => m.date === '2026-09-07');
  assert.equal(dag1.length, 2, 'ronde 1 compleet: 1 WhatsApp + 1 e-mail');
  assert.deepEqual(dag1.map((m) => m.channel).sort(), ['email', 'whatsapp']);
  assert.equal(dag1.filter((m) => m.channel === 'whatsapp').length, 1,
    'precies één WhatsApp op dag 1 — de tweede is door de dagcap tegengehouden');

  // Ronde 2 landt op de volgende dag, weer als compleet koppel.
  const dag2 = r.messages.filter((m) => m.date === '2026-09-08');
  assert.equal(dag2.length, 2);
  assert.deepEqual(dag2.map((m) => m.channel).sort(), ['email', 'whatsapp']);
  assert.equal(r.same_day_bursts.length, 0, 'nooit twee van hetzelfde kanaal op één dag');
});

test('KOPPEL: de e-mail heeft een eigen budget naast de WhatsApp', () => {
  // De cap is per kanaal gesleuteld. Beide kanalen hebben op dezelfde dag hun
  // eigen teller, dus de e-mail van ronde 1 verbruikt de WhatsApp-cap niet en
  // omgekeerd.
  const r = simulateEngine(koppelSnapshot(), { horizonDays: 1 });
  assert.equal(r.messages.filter((m) => m.channel === 'whatsapp').length, 1);
  assert.equal(r.messages.filter((m) => m.channel === 'email').length, 1);
  assert.deepEqual(r.meta.options.maxSendsPerCustomerPerDay, { whatsapp: 1, email: 1 });
});

test('KOPPEL: cap per kanaal is los instelbaar', () => {
  const snap = koppelSnapshot({ dueDate: '2026-07-09' });   // 60 dagen te laat
  snap.runs = [{
    id: 'run-K', workflow_id: 'wf1', customer_id: 'K', status: 'active',
    current_step_id: 'k0', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
  }];
  // De wait-klem is hier uitgezet, anders is die de beperkende factor en zie
  // je het effect van de cap niet. WhatsApp 2 per dag, e-mail 1 per dag:
  // beide rondes op dag 1, maar de tweede e-mail wordt tegengehouden.
  const r = simulateEngine(snap, {
    horizonDays: 2, disableWaitClamp: true,
    maxSendsPerCustomerPerDay: { whatsapp: 2, email: 1 },
  });
  const dag1 = r.messages.filter((m) => m.date === '2026-09-07');
  assert.equal(dag1.filter((m) => m.channel === 'whatsapp').length, 2, 'WhatsApp-cap 2 → twee sporten');
  assert.equal(dag1.filter((m) => m.channel === 'email').length, 1, 'e-mail-cap 1 → één mail');
});

test('KOPPEL: de wait-klem is de eerste rem, de dagcap het vangnet', () => {
  // Zelfde klant van 60 dagen te laat, nu met de klem AAN (de geleverde
  // branch): de klem alleen houdt ronde 2 al tegen tot de volgende dag, ook
  // als de WhatsApp-cap ruimte zou geven.
  const snap = koppelSnapshot({ dueDate: '2026-07-09' });
  snap.runs = [{
    id: 'run-K', workflow_id: 'wf1', customer_id: 'K', status: 'active',
    current_step_id: 'k0', next_action_at: '2026-09-07T00:00:00Z', needs_attention: false,
  }];
  const r = simulateEngine(snap, { horizonDays: 2, maxSendsPerCustomerPerDay: { whatsapp: 5, email: 5 } });
  const dag1 = r.messages.filter((m) => m.date === '2026-09-07');
  assert.equal(dag1.length, 2, 'alleen ronde 1 op dag 1, ondanks een ruime cap');
  assert.deepEqual(dag1.map((m) => m.channel).sort(), ['email', 'whatsapp']);
});
