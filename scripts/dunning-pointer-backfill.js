#!/usr/bin/env node
// scripts/dunning-pointer-backfill.js
//
// EENMALIGE POINTER-BACKFILL voor de aanmaan-ladder.
//
// Waarom: de ladder hangt sinds deze branch aan `days_overdue`, maar de
// pointer van bestaande runs staat nog op de stap waar de oude, op de
// stap-pointer gebaseerde flow was gebleven. Een klant die 45 dagen te laat
// is terwijl zijn pointer op stap 1 staat, heeft ALLE ladder-sporten al
// gepasseerd — die zou anders de hele reeks alsnog aflopen (met de dagcap
// uitgesmeerd over vijf dagen, maar nog steeds vijf berichten, en het eerste
// is "misschien had je het gemist" na anderhalve maand).
//
// Dit script zet de pointer op de sport die bij de WERKELIJKE days_overdue
// hoort. Het verstuurt niets en wijzigt geen enkele andere kolom.
//
// ══════════════════════════════════════════════════════════════════════════
//  DRY-RUN IS DE DEFAULT. Zonder --apply wordt er niets geschreven.
//  Met --apply worden uitsluitend `dunning_workflow_runs.current_step_id`
//  (+ updated_at) gezet en `dunning_log`-regels toegevoegd. Er gaat GEEN
//  bericht uit: dit script raakt geen enkele send-code aan.
// ══════════════════════════════════════════════════════════════════════════
//
// GEPAUZEERDE RUNS DOEN MEE. Dat is geen detail maar de kern: gepauzeerde
// runs sturen nu niets, maar cascaderen alsnog zodra hun pauze wegvalt (een
// gesprek dat doodloopt, een arrangement dat eindigt). Ze overslaan zou de
// golf alleen maar uitstellen. Hun status blijft ongemoeid — alleen de
// pointer verschuift.
//
// IDEMPOTENT: staat de pointer al goed, dan gebeurt er niets. Een tweede run
// rapporteert nul verzettingen.
//
// Gebruik:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/dunning-pointer-backfill.js                 # dry-run
//   ... node scripts/dunning-pointer-backfill.js --apply       # echt verzetten
//
// Opties:
//   --apply              schrijf de wijzigingen weg (default: dry-run)
//   --fixture=pad.json   lees een snapshot uit een bestand i.p.v. Supabase
//                        (voor een dry-run op synthetische data, zonder keys)
//   --json=pad.json      schrijf het plan weg als JSON
//   --today=YYYY-MM-DD   reken alsof het een andere dag is

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  todayIsoInTz, daysOverdueSigned, parseLadder, resolveStepTierDays,
  DEFAULT_LADDER,
} from '../api/_lib/dunning-overdue-guard.js';
import { isSendStep } from '../api/_lib/dunning-office-hours.js';
import { customerDisplayName } from '../api/_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const PAGE = 1000;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const APPLY = args.apply === true;

let _db = null;
function client() {
  if (_db) return _db;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn vereist.');
  }
  _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _db;
}

async function all(buildQuery) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ── Snapshot: alleen wat de backfill nodig heeft ──────────────────────────
async function loadSnapshot(todayIso) {
  const db = client();
  const { data: ladderRow } = await db.from('app_settings').select('value').eq('key', 'dunning_ladder').maybeSingle();

  // Lopende runs: active ÉN paused. De gepauzeerde zijn juist de landmijn.
  const runs = await all(() => db.from('dunning_workflow_runs')
    .select('id, workflow_id, customer_id, status, current_step_id, needs_attention, paused_by_conversation_id, paused_by_arrangement_id, paused_manual_reason')
    .in('status', ['active', 'paused']));
  if (!runs.length) return { today: todayIso, ladder: parseLadder(ladderRow?.value), runs: [], steps: [], templates: {}, customers: {} };

  const steps = await all(() => db.from('dunning_workflow_steps')
    .select('id, workflow_id, step_order, step_type, config')
    .in('workflow_id', Array.from(new Set(runs.map((r) => r.workflow_id)))));
  const tpls = await all(() => db.from('dunning_templates')
    .select('id, name, meta_template_name'));

  const custIds = Array.from(new Set(runs.map((r) => r.customer_id).filter(Boolean)));
  const invRows = await all(() => db.from('invoices')
    .select('id, customer_id, due_date, amount_total, amount_paid, credited_amount, status, is_test, customers!inner(id, first_name, last_name, company_name, is_company, is_test)')
    .in('customer_id', custIds).in('status', OPEN_STATUSES).eq('is_test', false));

  const customers = {};
  for (const inv of invRows) {
    const open = Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.amount_paid) || 0) - (Number(inv.credited_amount) || 0));
    if (open <= 0) continue;
    const c = customers[inv.customer_id] || {
      id: inv.customer_id, name: customerDisplayName(inv.customers, '(zonder naam)'), oldest_due: null,
    };
    const iso = inv.due_date ? String(inv.due_date).slice(0, 10) : null;
    if (iso && (!c.oldest_due || iso < c.oldest_due)) c.oldest_due = iso;
    customers[inv.customer_id] = c;
  }

  return {
    today: todayIso,
    ladder: ladderRow ? parseLadder(ladderRow.value) : { ...DEFAULT_LADDER },
    runs, steps,
    templates: Object.fromEntries(tpls.map((t) => [t.id, t])),
    customers,
  };
}

// ── Plan: welke pointer moet waarheen? ────────────────────────────────────
// PURE — draait net zo goed op een fixture als op de live snapshot.
export function planBackfill(snap) {
  const ladder = snap.ladder || DEFAULT_LADDER;
  const stepsByWf = new Map();
  for (const st of snap.steps || []) {
    if (!stepsByWf.has(st.workflow_id)) stepsByWf.set(st.workflow_id, []);
    stepsByWf.get(st.workflow_id).push(st);
  }
  for (const list of stepsByWf.values()) list.sort((a, b) => Number(a.step_order) - Number(b.step_order));

  const moves = [];
  const skipped = [];
  for (const run of snap.runs || []) {
    const cust = (snap.customers || {})[run.customer_id];
    const steps = stepsByWf.get(run.workflow_id) || [];
    const cur = steps.find((s) => s.id === run.current_step_id) || null;
    const naam = cust?.name || run.customer_id;

    if (!cust || !cust.oldest_due) { skipped.push({ run_id: run.id, customer_name: naam, reason: 'geen openstaande factuur met vervaldatum' }); continue; }
    if (!steps.length)             { skipped.push({ run_id: run.id, customer_name: naam, reason: 'workflow zonder stappen' }); continue; }
    if (run.needs_attention)       { skipped.push({ run_id: run.id, customer_name: naam, reason: 'needs_attention — mens moet er eerst naar kijken' }); continue; }

    const signed = daysOverdueSigned(cust.oldest_due, snap.today);
    if (signed == null || signed < 1) { skipped.push({ run_id: run.id, customer_name: naam, reason: `nog niet vervallen (${signed} dagen)` }); continue; }

    // Hoogste send-stap waarvan de ladder-sport al gepasseerd is.
    let target = null, targetTier = null;
    for (const st of steps) {
      if (!isSendStep(st.step_type)) continue;
      const tier = resolveStepTierDays(st, (snap.templates || {})[st?.config?.template_id] || null, ladder);
      if (tier != null && signed >= tier) { target = st; targetTier = tier; }
    }
    if (!target) { skipped.push({ run_id: run.id, customer_name: naam, reason: 'geen ladder-sport bereikt' }); continue; }
    if (cur && Number(cur.step_order) >= Number(target.step_order)) {
      skipped.push({ run_id: run.id, customer_name: naam, reason: 'pointer staat al goed of verder' });
      continue;   // ← idempotentie
    }

    const tpl = (snap.templates || {})[target?.config?.template_id] || null;
    moves.push({
      run_id: run.id,
      run_status: run.status,
      customer_id: run.customer_id,
      customer_name: naam,
      days_overdue: signed,
      oldest_due_date: cust.oldest_due,
      from_step_id: cur?.id || null,
      from_step_order: cur?.step_order ?? null,
      to_step_id: target.id,
      to_step_order: target.step_order,
      to_template: tpl?.meta_template_name || tpl?.name || null,
      ladder_rung: targetTier,
      paused_reason: run.status === 'paused'
        ? (run.paused_by_conversation_id ? 'gesprek' : run.paused_by_arrangement_id ? 'arrangement' : (run.paused_manual_reason || 'overig'))
        : null,
    });
  }
  moves.sort((a, b) => b.days_overdue - a.days_overdue);
  return { moves, skipped };
}

// ── Uitvoeren ─────────────────────────────────────────────────────────────
async function apply(moves, todayIso) {
  const db = client();
  let ok = 0, fail = 0;
  for (const m of moves) {
    // Try/catch per rij: één fout mag de rest niet blokkeren.
    try {
      // Race-veilig: alleen verzetten als de pointer nog staat waar we 'm zagen.
      const q = db.from('dunning_workflow_runs')
        .update({ current_step_id: m.to_step_id, updated_at: new Date().toISOString() })
        .eq('id', m.run_id);
      const { data, error } = await (m.from_step_id ? q.eq('current_step_id', m.from_step_id) : q).select('id');
      if (error) throw new Error(error.message);
      if (!data || !data.length) { console.warn(`  ~ ${m.customer_name}: pointer intussen gewijzigd, overgeslagen`); continue; }

      const { error: logErr } = await db.from('dunning_log').insert({
        run_id: m.run_id,
        step_id: m.to_step_id,
        event_type: 'pointer_backfill',
        payload: {
          reason: 'eenmalige ladder-backfill: pointer op de sport die bij days_overdue hoort',
          run_status: m.run_status,
          customer_id: m.customer_id,
          days_overdue: m.days_overdue,
          oldest_due_date: m.oldest_due_date,
          from_step_id: m.from_step_id,
          from_step_order: m.from_step_order,
          to_step_id: m.to_step_id,
          to_step_order: m.to_step_order,
          to_template: m.to_template,
          ladder_rung: m.ladder_rung,
          today_amsterdam: todayIso,
          sent_anything: false,
        },
      });
      if (logErr) console.warn(`  ~ ${m.customer_name}: log-insert faalde (${logErr.message}) — pointer is wel verzet`);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ! ${m.customer_name} (${m.run_id}): ${e?.message || e}`);
    }
  }
  return { ok, fail };
}

export function renderPlan(snap, plan, applied) {
  const L = [];
  const p = (s = '') => L.push(s);
  p('# Pointer-backfill aanmaan-ladder');
  p('');
  p(`Peildatum : ${snap.today}`);
  p(`Modus     : ${applied ? 'APPLY (wijzigingen weggeschreven)' : 'DRY-RUN (niets gewijzigd)'}`);
  p(`Ladder    : ${Object.entries(snap.ladder || {}).map(([k, v]) => `${k}=dag ${v}`).join(', ')}`);
  p(`Runs bekeken: ${(snap.runs || []).length}`);
  p('');
  p(`## Te verzetten pointers: ${plan.moves.length}`);
  p('');
  const perStatus = {};
  for (const m of plan.moves) perStatus[m.run_status] = (perStatus[m.run_status] || 0) + 1;
  for (const [k, v] of Object.entries(perStatus)) p(`  ${k}: ${v}`);
  const perTpl = {};
  for (const m of plan.moves) perTpl[m.to_template || '(geen template)'] = (perTpl[m.to_template || '(geen template)'] || 0) + 1;
  p('');
  p('  doel-sport:');
  for (const [k, v] of Object.entries(perTpl).sort((a, b) => b[1] - a[1])) p(`    ${String(k).padEnd(20)} ${v}`);
  p('');
  for (const m of plan.moves.slice(0, 200)) {
    p(`  ${String(m.customer_name).padEnd(30).slice(0, 30)} ${String(m.days_overdue).padStart(4)}d te laat · ` +
      `${m.run_status.padEnd(6)}${m.paused_reason ? `(${m.paused_reason})`.padEnd(14) : ''.padEnd(14)} · ` +
      `stap ${m.from_step_order ?? '?'} → ${m.to_step_order} · ${m.to_template} (sport dag ${m.ladder_rung})`);
  }
  if (plan.moves.length > 200) p(`  … en nog ${plan.moves.length - 200}.`);
  p('');
  p(`## Overgeslagen: ${plan.skipped.length}`);
  const perReason = {};
  for (const s of plan.skipped) perReason[s.reason] = (perReason[s.reason] || 0) + 1;
  for (const [k, v] of Object.entries(perReason).sort((a, b) => b[1] - a[1])) p(`  ${String(k).padEnd(50)} ${v}`);
  p('');
  p('Er is geen enkel bericht verstuurd; dit script raakt geen send-code aan.');
  return L.join('\n');
}

async function main() {
  const todayIso = typeof args.today === 'string' ? args.today : todayIsoInTz();
  const snap = typeof args.fixture === 'string'
    ? { ...JSON.parse(readFileSync(args.fixture, 'utf8')), today: todayIso }
    : await loadSnapshot(todayIso);

  const plan = planBackfill(snap);
  console.log(renderPlan(snap, plan, false));

  if (typeof args.json === 'string') {
    writeFileSync(args.json, JSON.stringify(plan, null, 2));
    console.error(`[backfill] plan → ${args.json}`);
  }

  if (!APPLY) {
    console.error('');
    console.error('[backfill] DRY-RUN: er is niets gewijzigd. Draai opnieuw met --apply om de pointers echt te verzetten.');
    return;
  }
  if (typeof args.fixture === 'string') {
    console.error('[backfill] --apply werkt niet samen met --fixture (er is geen database om naar te schrijven).');
    process.exit(1);
  }
  console.error(`[backfill] APPLY: ${plan.moves.length} pointer(s) verzetten…`);
  const res = await apply(plan.moves, todayIso);
  console.error(`[backfill] klaar: ${res.ok} verzet, ${res.fail} mislukt. Er is niets verstuurd.`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  main().catch((e) => { console.error('[backfill] fout:', e?.message || e); process.exit(1); });
}
