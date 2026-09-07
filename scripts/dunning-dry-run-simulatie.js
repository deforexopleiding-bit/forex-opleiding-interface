#!/usr/bin/env node
// scripts/dunning-dry-run-simulatie.js
//
// DRY-RUN: wat zou de aanmaan-motor met deze branch doen op de eerste
// cron-run na deploy, en op de dagen daarna?
//
// ══════════════════════════════════════════════════════════════════════════
//  READ-ONLY. Dit script doet uitsluitend SELECT-queries. Het verstuurt
//  niets (geen Meta, geen SMTP), schrijft niets naar de database en raakt
//  geen productiedata aan. De enige uitvoer is een rapport op stdout en,
//  desgevraagd, een bestand op je eigen schijf.
// ══════════════════════════════════════════════════════════════════════════
//
// Gebruik (lokaal, met de productie-keys uit 1Password):
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/dunning-dry-run-simulatie.js
//
// Opties:
//   --days=8              horizon van het hoofdrapport (default 8)
//   --not-yet-due=14      horizon voor het nog-niet-vervallen cohort (default 14)
//   --today=YYYY-MM-DD    simuleer alsof het een andere dag is (default: vandaag NL)
//   --json=pad.json       schrijf het volledige rapport-object weg
//   --md=pad.md           schrijf het tekstrapport weg
//   --max-per-dag=1       what-if: hoogstens N ladder-sporten per klant per dag
//   --backfill            what-if: zet eerst elke run-pointer op de sport die
//                         bij de huidige days_overdue hoort (zonder te sturen)
//
// De what-if-knoppen zitten ALLEEN in de simulator, niet in de motor.

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { simulateEngine, oldestDueIso } from '../api/_lib/dunning-simulate.js';
import {
  todayIsoInTz, parseLadder, parseGraceDays, DEFAULT_LADDER, isOverdue, daysOverdueSigned,
} from '../api/_lib/dunning-overdue-guard.js';
import { parseOfficeHoursConfig } from '../api/_lib/dunning-office-hours.js';
import { hasOpenBlockingAction } from '../api/_lib/pending-actions-guard.js';
import { customerDisplayName } from '../api/_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const PAGE = 1000;

// ── CLI-args ──────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const HORIZON      = Number(args.days) || 8;
const NOT_YET_DUE  = Number(args['not-yet-due']) || 14;
const MAX_PER_DAY  = args['max-per-dag'] !== undefined ? Number(args['max-per-dag']) : null;
const BACKFILL     = args.backfill === true;

// Client lazy aanmaken: zo blijft dit bestand importeerbaar in een test die
// alleen de rapport-opmaak controleert (zonder keys, zonder DB).
let _db = null;
function client() {
  if (_db) return _db;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn vereist (read-only gebruikt).');
  }
  _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _db;
}

/** Gepagineerde SELECT — PostgREST kapt zonder .range() af op 1000 rijen. */
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

async function setting(key) {
  const db = client();
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

// ── Snapshot bouwen ───────────────────────────────────────────────────────
async function buildSnapshot(todayIso) {
  const db = client();
  const [cooldownRaw, graceRaw, ladderRaw, officeRaw] = await Promise.all([
    setting('dunning_cooldown_days'), setting('dunning_grace_days'),
    setting('dunning_ladder'), setting('dunning_office_hours'),
  ]);
  const cooldownDays = (() => {
    const n = Number(cooldownRaw?.days);
    return (Number.isFinite(n) && n >= 1 && n <= 90) ? Math.trunc(n) : 7;
  })();

  const workflowRows = await all(() => db.from('dunning_workflows')
    .select('id, name, priority, trigger_conditions, is_active').eq('is_active', true));
  const stepRows = await all(() => db.from('dunning_workflow_steps')
    .select('id, workflow_id, step_order, step_type, config')
    .in('workflow_id', workflowRows.map((w) => w.id)));
  const tplRows = await all(() => db.from('dunning_templates')
    .select('id, name, kind, meta_template_name, is_active'));

  // Open facturen + klant. Zelfde filters als de motor.
  const invRows = await all(() => db.from('invoices')
    .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status, is_test, customers!inner(id, first_name, last_name, company_name, is_company, archived_at, anonymized_at, is_test)')
    .in('status', OPEN_STATUSES).eq('is_test', false).eq('customers.is_test', false));

  // Facturen in een ACTIEF arrangement vallen buiten de motor (D5 auto-pause).
  const arrRows = await all(() => db.from('payment_arrangements')
    .select('id, customer_id, invoice_ids, status, breach_handled_at')
    .in('status', ['ACTIEF', 'actief', 'VERBROKEN']));
  const pausedInvoiceIds = new Set();
  const breachedByCustomer = {};
  for (const a of arrRows) {
    if (['ACTIEF', 'actief'].includes(a.status)) {
      for (const id of (a.invoice_ids || [])) if (id) pausedInvoiceIds.add(id);
    } else if (a.status === 'VERBROKEN' && !a.breach_handled_at) {
      if (!breachedByCustomer[a.customer_id]) breachedByCustomer[a.customer_id] = a.id;
    }
  }

  const perCust = new Map();
  for (const inv of invRows) {
    const c = inv.customers;
    if (!c || c.archived_at || c.anonymized_at) continue;
    if (pausedInvoiceIds.has(inv.id)) continue;
    const open = Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.amount_paid) || 0) - (Number(inv.credited_amount) || 0));
    if (open <= 0) continue;
    const agg = perCust.get(inv.customer_id) || {
      id: inv.customer_id, name: customerDisplayName(c, '(zonder naam)'),
      is_company: c.is_company === true, company_name: c.company_name || null,
      stage_slug: null, invoices: [],
    };
    agg.invoices.push({ id: inv.id, invoice_number: inv.invoice_number, due_date: inv.due_date, issue_date: inv.issue_date, open_amount: open });
    perCust.set(inv.customer_id, agg);
  }
  const custIds = Array.from(perCust.keys());

  // Pipeline-fase (terminale fases starten geen run).
  if (custIds.length) {
    const pcRows = await all(() => db.from('dunning_pipeline_customers')
      .select('customer_id, stage_slug').in('customer_id', custIds));
    for (const p of pcRows) {
      const c = perCust.get(p.customer_id);
      if (c) c.stage_slug = p.stage_slug;
    }
  }

  // Runs: lopend (active/paused) + alle voor de run_once-guard.
  const runRows = await all(() => db.from('dunning_workflow_runs')
    .select('id, workflow_id, customer_id, status, current_step_id, next_action_at, needs_attention, paused_by_conversation_id, paused_by_arrangement_id'));
  const liveRuns = runRows.filter((r) => ['active', 'paused'].includes(r.status));

  // Laatste engine-send per klant (cooldown).
  const runToCust = new Map(runRows.map((r) => [r.id, r.customer_id]));
  const logRows = await all(() => db.from('dunning_log')
    .select('run_id, event_type, created_at, payload')
    .in('event_type', ['email_sent', 'whatsapp_sent', 'bulk_reminder_sent'])
    .gte('created_at', new Date(Date.now() - 120 * 86400000).toISOString()));
  const lastSendByCustomer = {};
  for (const l of logRows) {
    const cid = runToCust.get(l.run_id) || l.payload?.customer_id || null;
    if (!cid) continue;
    if (!lastSendByCustomer[cid] || l.created_at > lastSendByCustomer[cid]) lastSendByCustomer[cid] = l.created_at;
  }

  // Blokkerende handmatige acties.
  const blockedCustomers = [];
  if (custIds.length) {
    const paRows = await all(() => db.from('pending_actions')
      .select('customer_id, action_type, status').in('customer_id', custIds));
    const byCust = new Map();
    for (const a of paRows) {
      if (!byCust.has(a.customer_id)) byCust.set(a.customer_id, []);
      byCust.get(a.customer_id).push(a);
    }
    for (const [cid, list] of byCust) if (hasOpenBlockingAction(list)) blockedCustomers.push(cid);
  }

  return {
    today: todayIso,
    settings: {
      graceDays: graceRaw ? parseGraceDays(graceRaw.days) : 0,
      cooldownDays,
      ladder: ladderRaw ? parseLadder(ladderRaw) : { ...DEFAULT_LADDER },
      officeHours: parseOfficeHoursConfig(officeRaw),
    },
    templates: Object.fromEntries(tplRows.map((t) => [t.id, t])),
    workflows: workflowRows.map((w) => ({
      ...w,
      steps: stepRows.filter((s) => s.workflow_id === w.id).sort((a, b) => a.step_order - b.step_order),
    })),
    customers: Array.from(perCust.values()),
    runs: liveRuns,
    everRan: runRows.map((r) => ({ workflow_id: r.workflow_id, customer_id: r.customer_id })),
    lastSendByCustomer,
    blockedCustomers,
    breachedByCustomer,
  };
}

// ── Rapport ───────────────────────────────────────────────────────────────
function tabel(obj) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '  (geen)';
  return rows.map(([k, v]) => `  ${String(k).padEnd(28)} ${String(v).padStart(5)}`).join('\n');
}

export function buildReportText(snap, base, throttled, backfilled, notYetDueReport, notYetDueDays = NOT_YET_DUE) {
  const L = [];
  const p = (s = '') => L.push(s);

  p('# Dry-run aanmaan-motor — wat gebeurt er na deploy');
  p('');
  p(`Peildatum          : ${base.meta.start_date} (Europe/Amsterdam)`);
  p(`Horizon            : ${base.meta.horizon_days} dagen`);
  p(`Gratieperiode      : ${base.meta.grace_days} dag(en)`);
  p(`Cooldown           : ${base.meta.cooldown_days} dagen`);
  p(`Ladder             : ${Object.entries(base.meta.ladder).map(([k, v]) => `${k}=dag ${v}`).join(', ')}`);
  p(`Klanten met open facturen: ${base.meta.customers_in_snapshot}`);
  p(`Lopende runs       : ${base.meta.existing_runs_in_snapshot}`);
  p('');
  p('AANNAMES: niemand betaalt, niemand antwoordt, geen nieuwe facturen, elke');
  p('send slaagt, niemand grijpt handmatig in. De uitkomst is dus een');
  p('BOVENGRENS — in werkelijkheid vertrekken er minder berichten.');
  p('');

  p('## 1. Berichten per dag');
  p('');
  for (const d of base.days) {
    p(`### Dag ${d.day_index} — ${d.date}: ${d.total} bericht(en), ${d.unique_customers} klant(en), ${d.runs_started} nieuwe run(s)`);
    if (d.total) {
      p('  per template:');
      p(tabel(d.by_template));
      p('  per workflow:');
      p(tabel(d.by_workflow));
    }
    p('');
  }
  p(`TOTAAL over ${base.meta.horizon_days} dagen: ${base.totals.messages} berichten naar ${base.totals.unique_customers} klanten.`);
  p('  per template:'); p(tabel(base.totals.by_template));
  p('  per workflow:'); p(tabel(base.totals.by_workflow));
  p('');

  p('## 2. Klanten met meerdere berichten kort na elkaar');
  p('');
  if (!base.multi_message_customers.length) {
    p('  Geen enkele klant krijgt meer dan één bericht in dit venster.');
  } else {
    p(`  ${base.multi_message_customers.length} klant(en) krijgen meer dan één bericht.`);
    p('  Kolom "cooldown dekt": zou de 7-daagse cooldown deze reeks tegenhouden?');
    p('  (Antwoord is nee zodra de berichten binnen ÉÉN lopende run vallen — de');
    p('   cooldown geldt alleen bij het STARTEN van een nieuwe run.)');
    p('');
    for (const m of base.multi_message_customers.slice(0, 50)) {
      p(`  ${m.customer_name} (${m.customer_id})`);
      p(`    ${m.count} berichten · kortste tussenpoos ${m.min_gap_hours} uur · ` +
        `binnen één run: ${m.within_single_run ? 'ja' : 'nee'} · cooldown dekt: ${m.cooldown_would_cover ? 'ja' : 'NEE'}`);
      for (const x of m.messages) p(`      ${x.date} ${String(x.hour).padStart(2, '0')}:00 UTC · ${x.template} · ${x.days_overdue} dagen te laat`);
    }
    if (base.multi_message_customers.length > 50) p(`  … en nog ${base.multi_message_customers.length - 50} klant(en), zie het JSON-rapport.`);
  }
  p('');

  p('## 3. Inhaalgolf');
  p('');
  const burstKlanten = new Set(base.same_day_bursts.map((b) => b.customer_id));
  p(`  Klanten met >1 bericht op dezelfde dag: ${burstKlanten.size}`);
  p(`  Zwaarste dag voor één klant           : ${base.same_day_bursts[0]?.count || 0} berichten`);
  p('');
  for (const b of base.same_day_bursts.slice(0, 30)) {
    p(`  ${b.date} · ${b.customer_name} · ${b.count}× · ${b.templates.join(' → ')} · ${b.days_overdue} dagen te laat`);
  }
  if (base.same_day_bursts.length > 30) p(`  … en nog ${base.same_day_bursts.length - 30} geval(len).`);
  p('');
  p('  What-if A — hoogstens één ladder-sport per klant per dag:');
  p(`    totaal ${throttled.totals.messages} berichten, ` +
    `${new Set(throttled.same_day_bursts.map((b) => b.customer_id)).size} klant(en) met een dagburst.`);
  p(`    dagverdeling: ${throttled.days.map((d) => d.total).join(' / ')}`);
  p('  What-if B — eenmalige pointer-backfill (zet de pointer op de juiste sport, verstuurt niets):');
  p(`    totaal ${backfilled.totals.messages} berichten, ` +
    `${new Set(backfilled.same_day_bursts.map((b) => b.customer_id)).size} klant(en) met een dagburst.`);
  p(`    dagverdeling: ${backfilled.days.map((d) => d.total).join(' / ')}`);
  p('');

  p(`## 4. Klanten met een nog niet vervallen factuur (komende ${notYetDueDays} dagen)`);
  p('');
  const nyd = notYetDueReport.not_yet_due;
  p(`  Vandaag nog niet vervallen: ${nyd.length} klant(en).`);
  const entering = nyd.filter((x) => x.enters_engine_on);
  p(`  Daarvan komt de motor binnen ${notYetDueDays} dagen in beeld bij: ${entering.length}`);
  p('');
  const perDag = {};
  for (const x of entering) perDag[x.enters_engine_on] = (perDag[x.enters_engine_on] || 0) + 1;
  p('  instroom per dag:');
  p(tabel(perDag));
  p('');
  p('  detail (vervaldatum → poort open → eerste bericht):');
  for (const x of nyd.slice(0, 100)) {
    p(`    ${x.customer_name.padEnd(32).slice(0, 32)} vervalt ${x.oldest_due_date} (over ${x.days_until_due}d) · ` +
      `poort ${x.gate_opens_on} · ${x.first_message_on ? `${x.first_message_template} op ${x.first_message_on}` : 'nog geen bericht binnen horizon'}`);
  }
  if (nyd.length > 100) p(`    … en nog ${nyd.length - 100} klant(en), zie het JSON-rapport.`);
  p('');
  return L.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const todayIso = typeof args.today === 'string' ? args.today : todayIsoInTz();
  console.error('[dry-run] snapshot laden (read-only)…');
  const snap = await buildSnapshot(todayIso);
  console.error(`[dry-run] ${snap.customers.length} klanten, ${snap.runs.length} lopende runs, ${snap.workflows.length} actieve workflows.`);

  const base       = simulateEngine(snap, { horizonDays: HORIZON, maxSendsPerCustomerPerDay: MAX_PER_DAY, backfillPointer: BACKFILL });
  const throttled  = simulateEngine(snap, { horizonDays: HORIZON, maxSendsPerCustomerPerDay: 1 });
  const backfilled = simulateEngine(snap, { horizonDays: HORIZON, backfillPointer: true });
  const longRun    = simulateEngine(snap, { horizonDays: Math.max(HORIZON, NOT_YET_DUE + 1) });

  const tekst = buildReportText(snap, base, throttled, backfilled, longRun, NOT_YET_DUE);
  console.log(tekst);

  if (typeof args.md === 'string')   { writeFileSync(args.md, tekst); console.error(`[dry-run] rapport → ${args.md}`); }
  if (typeof args.json === 'string') {
    writeFileSync(args.json, JSON.stringify({ base, throttled, backfilled, not_yet_due: longRun.not_yet_due }, null, 2));
    console.error(`[dry-run] JSON → ${args.json}`);
  }
  console.error('[dry-run] klaar. Er is niets verzonden en niets weggeschreven naar de database.');
}

// Alleen draaien wanneer het bestand direct wordt uitgevoerd (niet bij import
// vanuit een test).
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  main().catch((e) => { console.error('[dry-run] fout:', e?.message || e); process.exit(1); });
}
