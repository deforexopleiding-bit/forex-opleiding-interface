#!/usr/bin/env node
// scripts/dunning-backfill-sql-check.mjs
//
// Toetst docs/sql-migrations/2026-09-07-dunning-pointer-backfill.sql tegen
// scripts/dunning-pointer-backfill.js op DEZELFDE fixture, en controleert dat
// beide op exact hetzelfde plan uitkomen: dezelfde runs, dezelfde doelstap,
// dezelfde sport, dezelfde reden bij overslaan, dezelfde toon-verlaging.
//
// Zonder deze toets is de SQL-variant een bewering. Mét deze toets is het een
// gecontroleerde kopie van het script dat al in de PR-tests zit.
//
// Vereist een lege PostgreSQL-database (de check dropt en herbouwt `public`)
// en `psql` op het PATH. Draai NOOIT tegen productie.
//
//   PGHOST=/tmp PGPORT=5433 PGUSER=postgres PGDATABASE=postgres \
//     node scripts/dunning-backfill-sql-check.mjs
//
// Wat het doet:
//   1. bouwt uit de fixture een minimale kopie van de tabellen die de backfill
//      leest (runs, steps, templates, invoices, customers, app_settings);
//   2. draait blok 1 (read-only) met de peildatum vastgezet op de fixture-dag;
//   3. draait het node-script met --fixture en dezelfde --today;
//   4. vergelijkt veld voor veld;
//   5. draait blok 2, controleert dat de pointers precies op het node-plan
//      landen, dat er per verzetting één dunning_log-regel is, en dat blok 1
//      daarna nul verzettingen meer geeft (idempotent);
//   6. speelt de race na: een run die er tussendoor al voorbij geschoven is
//      wordt overgeslagen, zonder log-regel.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = 'scripts/fixtures/dunning-backfill-voorbeeld.json';
const SQLFILE = 'docs/sql-migrations/2026-09-07-dunning-pointer-backfill.sql';
const TMP = mkdtempSync(join(tmpdir(), 'backfill-sql-'));

const snap = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const TODAY = snap.today;

function psql(argv, opts = {}) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', ...argv], {
    encoding: 'utf8', ...opts,
  });
}

// ── 1. fixture → tabellen ────────────────────────────────────────────────
function bouwFixtureSql() {
  const q = (v) => v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
  const L = [
    'set client_min_messages = warning;',
    'drop schema if exists public cascade; create schema public;',
    'create table app_settings (key text primary key, value jsonb);',
    'create table customers (id text primary key, first_name text, last_name text, company_name text, is_company boolean default false, is_test boolean default false);',
    'create table invoices (id text primary key, customer_id text, due_date date, amount_total numeric, amount_paid numeric, credited_amount numeric, status text, is_test boolean default false);',
    'create table dunning_templates (id text primary key, name text, meta_template_name text);',
    'create table dunning_workflow_steps (id text primary key, workflow_id text, step_order int, step_type text, config jsonb);',
    'create table dunning_workflow_runs (id text primary key, workflow_id text, customer_id text, status text, current_step_id text, needs_attention boolean default false, paused_by_conversation_id text, paused_by_arrangement_id text, paused_manual_reason text, updated_at timestamptz default now());',
    'create table dunning_log (id bigserial primary key, run_id text, step_id text, event_type text, payload jsonb, created_at timestamptz default now());',
    `insert into app_settings values ('dunning_ladder', ${q(JSON.stringify(snap.ladder))}::jsonb);`,
  ];
  for (const t of Object.values(snap.templates)) {
    L.push(`insert into dunning_templates values (${q(t.id)}, ${q(t.name)}, ${q(t.meta_template_name)});`);
  }
  for (const s of snap.steps) {
    L.push(`insert into dunning_workflow_steps values (${q(s.id)}, ${q(s.workflow_id)}, ${s.step_order}, ${q(s.step_type)}, ${q(JSON.stringify(s.config || {}))}::jsonb);`);
  }
  let n = 0;
  for (const c of Object.values(snap.customers)) {
    // De fixture geeft per klant een naam + de oudste vervaldatum. De naam gaat
    // heel in first_name (customerDisplayName plakt first + last aan elkaar),
    // de oudste vervaldatum wordt één openstaande factuur.
    L.push(`insert into customers (id, first_name, is_company, is_test) values (${q(c.id)}, ${q(c.name)}, false, false);`);
    if (c.oldest_due) L.push(`insert into invoices values (${q('inv-' + (++n))}, ${q(c.id)}, ${q(c.oldest_due)}, 100, 0, 0, 'open', false);`);
  }
  for (const r of snap.runs) {
    L.push(`insert into dunning_workflow_runs (id, workflow_id, customer_id, status, current_step_id, needs_attention, paused_by_conversation_id, paused_by_arrangement_id, paused_manual_reason) values (${q(r.id)}, ${q(r.workflow_id)}, ${q(r.customer_id)}, ${q(r.status)}, ${q(r.current_step_id)}, ${r.needs_attention ? 'true' : 'false'}, ${q(r.paused_by_conversation_id)}, ${q(r.paused_by_arrangement_id)}, ${q(r.paused_manual_reason)});`);
  }
  const p = join(TMP, 'fixture.sql');
  writeFileSync(p, L.join('\n'));
  return p;
}

// ── 2. de twee blokken uit het migratiebestand halen ─────────────────────
const HUIDIGE_DAG = "select (now() at time zone 'Europe/Amsterdam')::date as today";
function splitsBlokken() {
  const s = readFileSync(SQLFILE, 'utf8');
  const i = s.indexOf('-- BLOK 2 —');
  if (i < 0) throw new Error('BLOK 2-kop niet gevonden in ' + SQLFILE);
  // Peildatum vastzetten op de fixture-dag zodat de toets niet van de kalender
  // afhangt. Dat is de ENIGE wijziging aan de SQL die getoetst wordt.
  const vast = `select date '${TODAY}' as today`;
  const b1 = join(TMP, 'blok1.sql'); writeFileSync(b1, s.slice(0, i).replaceAll(HUIDIGE_DAG, vast));
  const b2 = join(TMP, 'blok2.sql'); writeFileSync(b2, s.slice(i).replaceAll(HUIDIGE_DAG, vast));
  if (!readFileSync(b1, 'utf8').includes(vast)) throw new Error('peildatum-regel niet gevonden in blok 1');
  return { b1, b2 };
}

function csv(pad) {
  const txt = psql(['--csv', '-f', pad]);
  const rows = []; let row = [], f = '', quoted = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (quoted) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else quoted = false; } else f += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// ── uitvoeren ────────────────────────────────────────────────────────────
const fouten = [];
const check = (ok, wat) => { console.log(`  ${ok ? '✓' : '✗'} ${wat}`); if (!ok) fouten.push(wat); };
const eq = (a, b, wat, id) => { if (String(a) !== String(b)) fouten.push(`${id}: ${wat} — node=${a} sql=${b}`); };

const fixtureSql = bouwFixtureSql();
const { b1, b2 } = splitsBlokken();

console.log(`Fixture: ${FIXTURE} · peildatum ${TODAY} · ${snap.runs.length} runs\n`);

psql(['-f', fixtureSql]);
const sqlPlan = csv(b1);

execFileSync('node', ['scripts/dunning-pointer-backfill.js', `--fixture=${FIXTURE}`,
  `--today=${TODAY}`, `--json=${join(TMP, 'node-plan.json')}`], { stdio: 'ignore' });
const nodePlan = JSON.parse(readFileSync(join(TMP, 'node-plan.json'), 'utf8'));

const nodeMoves = new Map(nodePlan.moves.map((m) => [m.run_id, m]));
const nodeSkips = new Map(nodePlan.skipped.map((s) => [s.run_id, s]));
const sqlMoves  = new Map(sqlPlan.filter((r) => r.besluit === 'VERZETTEN').map((r) => [r.run_id, r]));
const sqlSkips  = new Map(sqlPlan.filter((r) => r.besluit === 'OVERSLAAN').map((r) => [r.run_id, r]));

console.log('BLOK 1 versus het node-script');
check(sqlPlan.length === snap.runs.length, `elke run precies één regel (${sqlPlan.length})`);
check(nodeMoves.size === sqlMoves.size, `zelfde aantal verzettingen (node ${nodeMoves.size} · sql ${sqlMoves.size})`);
check(nodeSkips.size === sqlSkips.size, `zelfde aantal overgeslagen (node ${nodeSkips.size} · sql ${sqlSkips.size})`);

for (const [id, m] of nodeMoves) {
  const s = sqlMoves.get(id);
  if (!s) { fouten.push(`${id}: node verzet, sql niet`); continue; }
  eq(m.to_step_id, s.naar_step_id, 'doelstap', id);
  eq(m.to_step_order, s.naar_stap, 'doel step_order', id);
  eq(m.to_template, s.doel_sport_template, 'doel-template', id);
  eq(m.ladder_rung, s.doel_sport_dag, 'ladder-sport', id);
  eq(m.days_overdue, s.dagen_te_laat, 'dagen te laat', id);
  eq(m.customer_name, s.klant, 'klantnaam', id);
  eq(m.tone_downgrade, s.toon_verlaagd === 't', 'toon-verlaging', id);
  eq(m.from_step_id ?? '', s.van_step_id, 'vanaf-stap', id);
  eq(m.highest_reached_template ?? '', s.hoogste_bereikte_template, 'hoogste bereikte sport', id);
  eq(m.reached_rungs, s.bereikte_sporten, 'aantal bereikte sporten', id);
  eq(m.paused_reason ?? '', s.pauze_reden, 'pauzereden', id);
}
for (const [id, s] of nodeSkips) {
  const r = sqlSkips.get(id);
  if (!r) { fouten.push(`${id}: node slaat over, sql niet`); continue; }
  eq(s.reason, r.reden, 'reden van overslaan', id);
}
for (const id of sqlMoves.keys()) if (!nodeMoves.has(id)) fouten.push(`${id}: sql verzet, node niet`);
check(fouten.length === 0, 'alle velden identiek (doelstap, sport, naam, pauzereden, toon-verlaging, reden)');

const tel = (rows, key) => rows.reduce((a, r) => (a[r[key] || '—'] = (a[r[key] || '—'] || 0) + 1, a), {});
console.log('\n  doel-template  node:', JSON.stringify(tel(nodePlan.moves, 'to_template')));
console.log('  doel-template  sql :', JSON.stringify(tel([...sqlMoves.values()], 'doel_sport_template')));
console.log('  toon-verlaagd  node:', nodePlan.moves.filter((m) => m.tone_downgrade).length,
            '· sql:', [...sqlMoves.values()].filter((r) => r.toon_verlaagd === 't').length);

console.log('\nBLOK 2 — schrijven');
const verzet = csv(b2);
check(verzet.length === nodeMoves.size, `verzet precies de ${nodeMoves.size} runs uit het plan`);

const naRows = csv(join(TMP, 'na.sql'), writeFileSync(join(TMP, 'na.sql'),
  'select id, current_step_id from dunning_workflow_runs order by id;') || undefined);
const na = Object.fromEntries(naRows.map((r) => [r.id, r.current_step_id]));
check([...nodeMoves.values()].every((m) => na[m.run_id] === m.to_step_id),
  'elke pointer staat exact waar het node-plan hem wilde');

writeFileSync(join(TMP, 'log.sql'), "select count(*) as n from dunning_log where event_type = 'pointer_backfill';");
check(Number(csv(join(TMP, 'log.sql'))[0].n) === nodeMoves.size,
  `één dunning_log-regel per verzetting (${nodeMoves.size})`);

const naPlan = csv(b1);
check(naPlan.every((r) => r.besluit === 'OVERSLAAN'),
  'idempotent: blok 1 daarna nul verzettingen');

console.log('\nRACE — een run die er tussendoor al voorbij geschoven is');
psql(['-f', fixtureSql]);
const doelVanEerste = nodePlan.moves[0];
writeFileSync(join(TMP, 'race.sql'),
  `update dunning_workflow_runs set current_step_id = '${doelVanEerste.to_step_id}' where id = '${doelVanEerste.run_id}';`);
psql(['-f', join(TMP, 'race.sql')]);
const naRace = csv(b2);
check(naRace.length === nodeMoves.size - 1, `die ene run wordt overgeslagen (${naRace.length} i.p.v. ${nodeMoves.size})`);
check(!naRace.some((r) => r.run_id === doelVanEerste.run_id), 'en komt niet in de uitvoer voor');
writeFileSync(join(TMP, 'log2.sql'),
  `select count(*) as n from dunning_log where event_type = 'pointer_backfill' and run_id = '${doelVanEerste.run_id}';`);
check(Number(csv(join(TMP, 'log2.sql'))[0].n) === 0, 'en krijgt geen log-regel');

console.log('');
if (fouten.length) {
  console.log(`MISLUKT — ${fouten.length} verschil(len):`);
  fouten.slice(0, 30).forEach((f) => console.log('  ' + f));
  process.exit(1);
}
console.log('GESLAAGD — de SQL-variant komt op exact hetzelfde plan uit als het node-script.');
