// api/_lib/dunning-engine.js
//
// Dunning workflow engine. Twee fases per run:
//
//   1) detectAndStartRuns — scant actieve dunning_workflows, matched klanten met
//      openstaande facturen op trigger_conditions, en start een run met de
//      eerste stap als er nog geen actieve run loopt voor die klant.
//
//   2) advanceActiveRuns — picked actieve runs waarvan next_action_at <= nu,
//      controleert stop-conditie (geen open invoices meer = paid), voert de
//      huidige stap uit via step-executor, schrijft log en schuift de pointer
//      door naar de volgende stap. Wait-steps zetten next_action_at op nu+days.
//
// Idempotent en time-budget-aware: stopt netjes als elapsed > abortMs zodat
// Vercel 60s hard timeout niet halverwege een mutatie knipt.
//
// Geen direct DB-mutatie buiten supabaseAdmin (RLS-bypass). Geen HTTP layer —
// caller (cron-endpoint) wraps deze module.

import { supabaseAdmin } from '../supabase.js';
import {
  executeEmailStep,
  executeWhatsappStep,
  executeWaitStep,
  executeTaskStep,
} from './dunning-step-executors.js';
import { markOverdue } from './mentor-ledger-engine.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

/**
 * Entry-point. Wordt aangeroepen vanuit api/cron-dunning-engine.js
 * en (optioneel) vanuit een handmatige debug-endpoint met mode="manual".
 */
export async function runEngine({ mode = 'cron', abortMs = 50_000 } = {}) {
  const startedAt = Date.now();
  const result = {
    mode,
    detected: 0,
    runs_advanced: 0,
    errors: [],
    duration_ms: 0,
  };

  try {
    result.detected = await detectAndStartRuns(startedAt, abortMs, result.errors);
  } catch (e) {
    result.errors.push({ phase: 'detect', error: e?.message || String(e) });
    console.error('[dunning-engine] detect fatal', e);
  }

  try {
    result.runs_advanced = await advanceActiveRuns(startedAt, abortMs, result.errors);
  } catch (e) {
    result.errors.push({ phase: 'advance', error: e?.message || String(e) });
    console.error('[dunning-engine] advance fatal', e);
  }

  result.duration_ms = Date.now() - startedAt;
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function nowIso() {
  return new Date().toISOString();
}

function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dueDateMs(isoDate) {
  if (!isoDate) return null;
  const ymd = String(isoDate).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function openAmount(inv) {
  const total = Number(inv?.amount_total) || 0;
  const paid = Number(inv?.amount_paid) || 0;
  const credited = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - credited);
}

function isCompany(customer) {
  if (!customer) return false;
  if (customer.is_company === true) return true;
  if (customer.company_name && String(customer.company_name).trim()) return true;
  return false;
}

function matchesCustomerType(customer, wanted) {
  if (!wanted || wanted === 'any') return true;
  const company = isCompany(customer);
  if (wanted === 'b2b') return company;
  if (wanted === 'b2c') return !company;
  return true;
}

/**
 * Fetch open invoices, optionally scoped to one customer_id. Returns rows with
 * embedded customer record (single-query, no N+1).
 *
 * D5 auto-pause: invoices die in een ACTIEF payment_arrangement zitten worden
 * uitgesloten — de dunning-engine mag klanten niet stalken zolang er een
 * actieve betaalafspraak loopt. Bij VERBROKEN/NAGEKOMEN/GEANNULEERD valt de
 * factuur vanzelf weer in scope op de volgende cron-run.
 */
async function fetchOpenInvoices(customerId = null) {
  let q = supabaseAdmin
    .from('invoices')
    .select(
      'id, customer_id, amount_total, amount_paid, credited_amount, due_date, status, invoice_number, customers!inner(id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at)'
    )
    .in('status', OPEN_STATUSES);
  if (customerId) q = q.eq('customer_id', customerId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return rows;

  // D5 — auto-pause: bouw set van invoice_ids die in een ACTIEF arrangement
  // zitten (UPPERCASE + legacy lowercase). Filter die invoices weg.
  try {
    const activeInvoiceIds = await fetchActiveArrangementInvoiceIds(customerId);
    if (activeInvoiceIds.size === 0) return rows;
    return rows.filter((inv) => !activeInvoiceIds.has(inv.id));
  } catch (e) {
    // Fail-soft: bij DB-issue logt + valt terug op ongefilterde set (oude
    // gedrag). Beter doorgaan met onnodige reminder dan een complete cron-stop.
    console.error('[dunning-engine] arrangement-pause lookup failed, continuing without filter', e?.message);
    return rows;
  }
}

/**
 * D5 helper: verzamel invoice_ids uit alle ACTIEF payment_arrangements.
 * Optioneel gescoped per customer_id voor de advance-fase (kleinere query).
 */
async function fetchActiveArrangementInvoiceIds(customerId = null) {
  let q = supabaseAdmin
    .from('payment_arrangements')
    .select('invoice_ids, customer_id, status')
    .in('status', ['ACTIEF', 'actief']);
  if (customerId) q = q.eq('customer_id', customerId);
  const { data, error } = await q;
  if (error) throw error;
  const set = new Set();
  for (const row of data || []) {
    const ids = Array.isArray(row.invoice_ids) ? row.invoice_ids : [];
    for (const id of ids) if (id) set.add(id);
  }
  return set;
}

/**
 * Aggregate open invoices per customer_id. Returns Map keyed by customer_id
 * met { customer, openInvoices, total_open_eur, oldest_due_iso, days_overdue }.
 */
function aggregatePerCustomer(rows) {
  const todayMs = todayMidnightMs();
  const per = new Map();
  for (const inv of rows) {
    const cust = inv.customers;
    if (!cust) continue;
    if (cust.archived_at || cust.anonymized_at) continue;

    const open = openAmount(inv);
    if (open <= 0) continue;

    const agg = per.get(inv.customer_id) || {
      customer: cust,
      openInvoices: [],
      total_open_eur: 0,
      oldest_due_iso: null,
    };
    agg.openInvoices.push(inv);
    agg.total_open_eur += open;

    if (inv.due_date) {
      const iso = String(inv.due_date).slice(0, 10);
      if (!agg.oldest_due_iso || iso < agg.oldest_due_iso) {
        agg.oldest_due_iso = iso;
      }
    }
    per.set(inv.customer_id, agg);
  }

  for (const agg of per.values()) {
    let days = 0;
    const oldestMs = dueDateMs(agg.oldest_due_iso);
    if (oldestMs != null && todayMs > oldestMs) {
      days = Math.floor((todayMs - oldestMs) / 86400000);
    }
    agg.days_overdue = days;
  }
  return per;
}

// ---------------------------------------------------------------------------
// Phase 1: detect + start
// ---------------------------------------------------------------------------

async function detectAndStartRuns(startedAt, abortMs, errors) {
  const { data: workflows, error: wfErr } = await supabaseAdmin
    .from('dunning_workflows')
    .select('id, name, trigger_conditions, priority, is_active')
    .eq('is_active', true)
    .order('priority', { ascending: true });
  if (wfErr) throw wfErr;

  let started = 0;

  // ── Cooldown-setting één keer per engine-run laden ─────────────────────
  // app_settings key 'dunning_cooldown_days' (integer, 1-90). Ontbreekt/
  // ongeldig → default 7. Cooldown vult de bestaande "actieve run"-skip
  // AAN: klanten die recent via de bulk-flow zijn benaderd worden ook
  // overgeslagen. Maakt de engine CONSERVATIEVER, nooit agressiever.
  let cooldownDays = 7;
  try {
    const { data: cdRow } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'dunning_cooldown_days')
      .maybeSingle();
    const raw = cdRow?.value?.days;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 90) cooldownDays = Math.trunc(n);
  } catch (e) {
    console.warn('[dunning-engine] cooldown-setting fail-soft, default 7:', e?.message || e);
  }
  const cooldownCutoffIso = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString();

  outer: for (const workflow of workflows || []) {
    if (elapsed(startedAt) > abortMs) break;

    const tc = workflow.trigger_conditions || {};
    const minDays = Number.isFinite(tc.min_days_overdue) ? tc.min_days_overdue : 14;
    const customerType = tc.customer_type || 'any';
    const minTotal = Number.isFinite(tc.min_total_amount) ? tc.min_total_amount : 0;

    let openRows;
    try {
      openRows = await fetchOpenInvoices(null);
    } catch (e) {
      errors.push({ phase: 'detect', workflow_id: workflow.id, error: e?.message || String(e) });
      console.error('[dunning-engine] fetch invoices failed', workflow.id, e?.message);
      continue;
    }

    const perCustomer = aggregatePerCustomer(openRows);

    // Load steps once per workflow.
    const { data: steps, error: stepsErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, workflow_id, step_order, step_type, config')
      .eq('workflow_id', workflow.id)
      .order('step_order', { ascending: true });
    if (stepsErr) {
      errors.push({ phase: 'detect', workflow_id: workflow.id, error: stepsErr.message });
      console.error('[dunning-engine] steps fetch failed', workflow.id, stepsErr.message);
      continue;
    }
    const firstStep = (steps || [])[0];
    if (!firstStep) {
      console.warn('[dunning-engine] workflow has no steps, skipping', workflow.id, workflow.name);
      continue;
    }

    for (const [customerId, agg] of perCustomer) {
      if (elapsed(startedAt) > abortMs) break outer;

      if (agg.days_overdue < minDays) continue;

      // F5.1 mentor-hook: zodra vaststaat dat de klant te laat is, openstaande
      // bonus-entries (pending) van die klant op 'wachten_op_betaling' zetten.
      // Non-blocking; engine is idempotent. Voor de matchesCustomerType-check
      // zodat álle te late klanten gemarkeerd worden, niet alleen die binnen
      // deze workflow vallen.
      try {
        await markOverdue({ customerId });
      } catch (e) {
        console.error('[dunning-engine] mentor-hook markOverdue:', e.message);
      }

      if (!matchesCustomerType(agg.customer, customerType)) continue;
      if (agg.total_open_eur < minTotal) continue;

      try {
        const { data: existing, error: exErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .select('id')
          .eq('customer_id', customerId)
          .eq('status', 'active')
          .limit(1)
          .maybeSingle();
        if (exErr) throw exErr;
        if (existing) continue;

        // COOLDOWN-check: sla klant over als recent (< cooldownDays) al
        // een bulk_reminder_sent-log voor deze klant bestaat. Bewuste
        // scope: alleen bulk-entries. Engine-dubbeling wordt al gedekt
        // door de actieve-run-check hierboven. Een gecombineerde join
        // engine-logs → runs.customer_id zou een aparte round-trip per
        // klant vereisen; niet nodig voor deze cooldown-doel.
        try {
          const { data: recentBulk } = await supabaseAdmin
            .from('dunning_log')
            .select('id, created_at')
            .eq('event_type', 'bulk_reminder_sent')
            .eq('payload->>customer_id', customerId)
            .gte('created_at', cooldownCutoffIso)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (recentBulk) continue;
        } catch (e) {
          console.warn('[dunning-engine] cooldown-check fail-soft:', customerId, e?.message || e);
          // Fail-open: bij DB-fout NIET skippen (anders schaadt een tijdelijke
          // glitch de aanmaan-flow). We laten 'm gewoon door.
        }

        const triggerCount = agg.openInvoices.length;
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .insert({
            workflow_id: workflow.id,
            customer_id: customerId,
            status: 'active',
            current_step_id: firstStep.id,
            next_action_at: nowIso(),
            trigger_invoice_count: triggerCount,
          })
          .select('id')
          .single();
        if (insErr) throw insErr;

        const { error: logErr } = await supabaseAdmin
          .from('dunning_log')
          .insert({
            run_id: inserted.id,
            step_id: firstStep.id,
            event_type: 'started',
            payload: {
              workflow_id: workflow.id,
              workflow_name: workflow.name,
              customer_id: customerId,
              trigger_invoice_count: triggerCount,
              total_open_eur: Number(agg.total_open_eur.toFixed(2)),
              days_overdue: agg.days_overdue,
            },
          });
        if (logErr) {
          console.error('[dunning-engine] log insert failed', inserted.id, logErr.message);
        }
        started++;
      } catch (e) {
        errors.push({
          phase: 'detect_start',
          workflow_id: workflow.id,
          customer_id: customerId,
          error: e?.message || String(e),
        });
        console.error('[dunning-engine] start run failed', workflow.id, customerId, e?.message);
      }
    }
  }

  return started;
}

// ---------------------------------------------------------------------------
// Phase 2: advance active runs
// ---------------------------------------------------------------------------

async function advanceActiveRuns(startedAt, abortMs, errors) {
  const now = nowIso();
  const { data: runs, error: runsErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select(
      'id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, trigger_invoice_count'
    )
    .eq('status', 'active')
    .or(`next_action_at.is.null,next_action_at.lte.${now}`);
  if (runsErr) throw runsErr;

  let advanced = 0;

  for (const run of runs || []) {
    if (elapsed(startedAt) > abortMs) break;

    try {
      // 1) Re-fetch open invoices for stop-condition + executor context.
      const customerRows = await fetchOpenInvoices(run.customer_id);
      const aggMap = aggregatePerCustomer(customerRows);
      const agg = aggMap.get(run.customer_id);
      const customer = agg?.customer || await fetchCustomerOnly(run.customer_id);
      const openInvoices = agg?.openInvoices || [];

      // STOP-CONDITIE: geen open invoices meer = klant heeft betaald.
      if (openInvoices.length === 0) {
        await supabaseAdmin
          .from('dunning_workflow_runs')
          .update({
            status: 'completed',
            completed_at: nowIso(),
            completion_reason: 'paid',
            updated_at: nowIso(),
          })
          .eq('id', run.id);
        await supabaseAdmin.from('dunning_log').insert({
          run_id: run.id,
          step_id: run.current_step_id,
          event_type: 'completed',
          payload: { reason: 'paid' },
        });
        advanced++;
        continue;
      }

      // 2) Current step + all steps for workflow.
      const { data: steps, error: stepsErr } = await supabaseAdmin
        .from('dunning_workflow_steps')
        .select('id, workflow_id, step_order, step_type, config')
        .eq('workflow_id', run.workflow_id)
        .order('step_order', { ascending: true });
      if (stepsErr) throw stepsErr;

      const currentStep = (steps || []).find((s) => s.id === run.current_step_id);
      if (!currentStep) {
        await supabaseAdmin
          .from('dunning_workflow_runs')
          .update({
            status: 'completed',
            completed_at: nowIso(),
            completion_reason: 'step_missing',
            updated_at: nowIso(),
          })
          .eq('id', run.id);
        await supabaseAdmin.from('dunning_log').insert({
          run_id: run.id,
          step_id: run.current_step_id,
          event_type: 'completed',
          payload: { reason: 'step_missing' },
        });
        advanced++;
        continue;
      }

      const nextStep = (steps || []).find((s) => s.step_order > currentStep.step_order) || null;

      // 3) Execute current step.
      const execArgs = { supabaseAdmin, run, step: currentStep, customer, openInvoices };
      let stepResult;
      switch (currentStep.step_type) {
        case 'email':
          stepResult = await executeEmailStep(execArgs);
          break;
        case 'whatsapp':
          stepResult = await executeWhatsappStep(execArgs);
          break;
        case 'wait':
          stepResult = await executeWaitStep(execArgs);
          break;
        case 'task':
          stepResult = await executeTaskStep(execArgs);
          break;
        case 'stop':
          stepResult = { status: 'ok', log_event: 'stop_step', log_payload: {} };
          break;
        default:
          stepResult = {
            status: 'failed',
            log_event: 'unknown_step_type',
            log_payload: { step_type: currentStep.step_type },
          };
      }

      // 4) Log result.
      await supabaseAdmin.from('dunning_log').insert({
        run_id: run.id,
        step_id: currentStep.id,
        event_type: stepResult.log_event,
        payload: stepResult.log_payload || {},
      });

      // 5) Advance pointer.
      const update = { updated_at: nowIso() };
      if (currentStep.step_type === 'wait') {
        const days = Number(currentStep?.config?.days) || 0;
        const nextMs = Date.now() + days * 86400000;
        update.next_action_at = new Date(nextMs).toISOString();
        update.current_step_id = nextStep ? nextStep.id : null;
        if (!nextStep) {
          update.status = 'completed';
          update.completed_at = nowIso();
          update.completion_reason = 'no_more_steps';
        }
      } else if (currentStep.step_type === 'stop') {
        update.status = 'completed';
        update.completed_at = nowIso();
        update.completion_reason = 'stop_step';
      } else {
        update.next_action_at = nowIso();
        update.current_step_id = nextStep ? nextStep.id : null;
        if (!nextStep) {
          update.status = 'completed';
          update.completed_at = nowIso();
          update.completion_reason = 'no_more_steps';
        }
      }

      await supabaseAdmin
        .from('dunning_workflow_runs')
        .update(update)
        .eq('id', run.id);

      advanced++;
    } catch (e) {
      errors.push({
        phase: 'advance',
        run_id: run.id,
        customer_id: run.customer_id,
        error: e?.message || String(e),
      });
      console.error('[dunning-engine] advance failed', run.id, e?.message);
    }
  }

  return advanced;
}

async function fetchCustomerOnly(customerId) {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at')
    .eq('id', customerId)
    .maybeSingle();
  if (error) {
    console.error('[dunning-engine] customer fetch failed', customerId, error.message);
    return null;
  }
  return data;
}
