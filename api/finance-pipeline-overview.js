// api/finance-pipeline-overview.js
//
// GET /api/finance-pipeline-overview
//
// Samengesteld overzicht van de dunning-pipeline: KPI-strip bovenaan met
// 8 buckets, per-klant lijst met huidige stap + voorwaardelijke vooruit-
// blik + pauze-reden + incasso-conditie. Bedoeld voor de nieuwe
// Wanbetalers → Pipeline sub-tab (PR C).
//
// ── RBAC ──────────────────────────────────────────────────────────────
// finance.dunning.view — zelfde permissie als het bestaande
// api/finance-dunning-overview.js (r41). Dit endpoint is read-only en
// aggregeert dezelfde bronnen, dus geen strengere gate nodig. Pause/
// resume/skip acties (in PR B en bestaand run-control) vragen wél
// finance.dunning.execute.
//
// ── Schema-verificatie (les uit customer-dossier fiasco #920/#922) ────
// Elke select-lijst is 1:1 gecheckt tegen een bestaand endpoint:
//   dunning_workflow_runs   → finance-dunning-overview.js:100-104
//   dunning_workflow_steps  → finance-dunning-workflows-detail.js:36-40
//   dunning_workflows       → finance-dunning-workflows-detail.js:30
//   dunning_log             → wanbetalers-timeline.js:313-314
//   customers               → customer.js / customer-dossier.js (canonical)
//   invoices                → finance-dunning-overview.js:117-120
//   payment_arrangements    → arrangements-detail.js:44-49
//                              (post-#922: proposed_by/proposed_at/accepted_at,
//                               GEEN approved_by/approved_at)
//
// ── Aantal DB-queries ─────────────────────────────────────────────────
// Zes parallelle Promise.all-batches:
//   1. runs (WHERE status IN (active,paused) OR completed_at >= now-30d)
//   2. workflows (name lookup)
//   3. steps (voor alle betrokken workflows)
//   4. customers (basis-info per run.customer_id)
//   5. invoices open (aggregatie per customer_id)
//   6. arrangements (per customer_id — voor incasso-conditie)
//   7. dunning_log (recentste per run — voor pauze-reden-reconstructie)
//   8. dunning-settings (voor incasso-drempels)
// Totaal: ~8 queries voor de hele pipeline, ongeacht het aantal klanten.

import { supabase, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import {
  classifyRunBucket,
  reconstructPauseReason,
  projectRunTimeline,
  incassoCondition,
  buildBucketCounts,
} from './_lib/pipeline-overview-helpers.js';

const DAY_MS      = 24 * 60 * 60 * 1000;
const BRON_CAP    = 500;
const KLAAR_WINDOW_DAYS = 30;
const OPEN_INVOICE_STATUSES = ['outstanding', 'overdue', 'sent', 'draft'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // ── RBAC bovenaan ────────────────────────────────────────────────────
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  const token = authHeader.slice(7);
  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const nowMs = Date.now();
  const klaarSinceIso = new Date(nowMs - KLAAR_WINDOW_DAYS * DAY_MS).toISOString();

  try {
    // ── Fase 1: runs (active + paused + recent-completed/cancelled) ────
    // supabase-js v2 heeft geen native OR-over-and-groups zonder .or(),
    // dus we gebruiken twee queries + merge (simpeler dan een raw .or()
    // string met datum-quoting).
    const [openRunsRes, klaarRunsRes] = await Promise.all([
      supabaseAdmin.from('dunning_workflow_runs')
        .select('id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, completed_at, completion_reason, updated_at, paused_by_conversation_id, paused_by_arrangement_id, trigger_invoice_count')
        .in('status', ['active', 'paused'])
        .order('next_action_at', { ascending: true, nullsFirst: true })
        .limit(BRON_CAP),
      supabaseAdmin.from('dunning_workflow_runs')
        .select('id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, completed_at, completion_reason, updated_at, paused_by_conversation_id, paused_by_arrangement_id, trigger_invoice_count')
        .in('status', ['completed', 'cancelled'])
        .gte('completed_at', klaarSinceIso)
        .order('completed_at', { ascending: false })
        .limit(BRON_CAP),
    ]);
    if (openRunsRes.error) throw new Error('runs (open): ' + openRunsRes.error.message);
    if (klaarRunsRes.error) throw new Error('runs (klaar): ' + klaarRunsRes.error.message);

    const runs = [...(openRunsRes.data || []), ...(klaarRunsRes.data || [])];
    if (runs.length === 0) {
      return res.status(200).json(emptyResponse(nowMs));
    }

    const workflowIds = Array.from(new Set(runs.map((r) => r.workflow_id).filter(Boolean)));
    const customerIds = Array.from(new Set(runs.map((r) => r.customer_id).filter(Boolean)));
    const runIds      = runs.map((r) => r.id);

    // ── Fase 2: parallelle lookups ────────────────────────────────────
    const [
      workflowsRes,
      stepsRes,
      customersRes,
      invoicesRes,
      arrangementsRes,
      logsRes,
      settingsRow,
    ] = await Promise.all([
      workflowIds.length
        ? supabaseAdmin.from('dunning_workflows').select('id, name').in('id', workflowIds)
        : Promise.resolve({ data: [], error: null }),
      workflowIds.length
        ? supabaseAdmin.from('dunning_workflow_steps')
            .select('id, workflow_id, step_order, step_type, config, created_at')
            .in('workflow_id', workflowIds)
            .order('step_order', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabaseAdmin.from('customers').select('id, first_name, last_name, is_company, company_name, email').in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabaseAdmin.from('invoices')
            .select('id, customer_id, amount_total, amount_paid, credited_amount, status')
            .in('customer_id', customerIds)
            .in('status', OPEN_INVOICE_STATUSES)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabaseAdmin.from('payment_arrangements')
            .select('id, customer_id, type, status, created_at, updated_at')
            .in('customer_id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      // Recentste dunning_log per run — client-side groeperen.
      // 500-cap * ~10 log-rijen per run = 5000; we halen max 2000 op
      // (nieuwste per run wint bij desc-sort + first-hit-per-run).
      runIds.length
        ? supabaseAdmin.from('dunning_log')
            .select('id, run_id, event_type, payload, created_at')
            .in('run_id', runIds)
            .order('created_at', { ascending: false })
            .limit(2000)
        : Promise.resolve({ data: [], error: null }),
      fetchDunningSettings(),
    ]);

    // Fail-soft: individuele fouten mogen het endpoint niet stuk maken.
    if (workflowsRes.error)   console.warn('[pipeline] workflows:',   workflowsRes.error.message);
    if (stepsRes.error)       console.warn('[pipeline] steps:',       stepsRes.error.message);
    if (customersRes.error)   console.warn('[pipeline] customers:',   customersRes.error.message);
    if (invoicesRes.error)    console.warn('[pipeline] invoices:',    invoicesRes.error.message);
    if (arrangementsRes.error) console.warn('[pipeline] arrangements:', arrangementsRes.error.message);
    if (logsRes.error)        console.warn('[pipeline] logs:',        logsRes.error.message);

    // ── Fase 3: indexeer op id/scope voor snelle lookup ──────────────
    const workflowById = new Map();
    for (const w of workflowsRes.data || []) workflowById.set(w.id, w);

    const stepsByWorkflow = new Map();
    for (const s of stepsRes.data || []) {
      if (!stepsByWorkflow.has(s.workflow_id)) stepsByWorkflow.set(s.workflow_id, []);
      stepsByWorkflow.get(s.workflow_id).push(s);
    }

    const customerById = new Map();
    for (const c of customersRes.data || []) customerById.set(c.id, c);

    // Aggregate open invoices per customer.
    const openInvByCust = new Map();
    for (const iv of invoicesRes.data || []) {
      const open = Math.max(0, (Number(iv.amount_total) || 0) - (Number(iv.amount_paid) || 0) - (Number(iv.credited_amount) || 0));
      if (open <= 0) continue;
      if (!openInvByCust.has(iv.customer_id)) openInvByCust.set(iv.customer_id, { count: 0, total: 0 });
      const agg = openInvByCust.get(iv.customer_id);
      agg.count += 1;
      agg.total += open;
    }

    const arrangementsByCust = new Map();
    for (const a of arrangementsRes.data || []) {
      if (!arrangementsByCust.has(a.customer_id)) arrangementsByCust.set(a.customer_id, []);
      arrangementsByCust.get(a.customer_id).push(a);
    }

    // Groepeer logs per run — recentste eerst (query is al DESC gesort).
    const latestLogByRun = new Map();
    for (const log of logsRes.data || []) {
      if (!latestLogByRun.has(log.run_id)) latestLogByRun.set(log.run_id, log);
    }

    // Refusal-flag per customer: laatste refusal_flagged - refusal_cleared.
    const refusalByCust = new Map();
    for (const log of logsRes.data || []) {
      if (log.event_type !== 'payment_refusal_flagged'
          && log.event_type !== 'payment_refusal_cleared') continue;
      const run = runs.find((r) => r.id === log.run_id);
      const cid = run?.customer_id;
      if (!cid) continue;
      if (!refusalByCust.has(cid)) {
        refusalByCust.set(cid, log.event_type === 'payment_refusal_flagged');
      }
    }

    // ── Fase 4: per-run classify + project + build item ─────────────
    const items = runs.map((run) => {
      const latestLog = latestLogByRun.get(run.id) || null;
      const bucket    = classifyRunBucket(run, latestLog, nowMs);
      run._bucket     = bucket;   // mutatie is ok — bepaald voor bucket-tellers

      const customer = customerById.get(run.customer_id) || null;
      const custName = customerDisplayName(customer, '(zonder naam)');
      const workflow = workflowById.get(run.workflow_id) || null;
      const stepsForWf = stepsByWorkflow.get(run.workflow_id) || [];
      const projection = projectRunTimeline(run, stepsForWf, nowMs);
      const pauseReason = reconstructPauseReason(run, latestLog);

      const inv = openInvByCust.get(run.customer_id) || { count: 0, total: 0 };
      const incasso = incassoCondition(
        arrangementsByCust.get(run.customer_id) || [],
        !!refusalByCust.get(run.customer_id),
        settingsRow
      );

      return {
        run_id:              run.id,
        bucket,
        customer: customer ? {
          id:    customer.id,
          name:  custName,
          email: customer.email || null,
        } : { id: run.customer_id, name: '(onbekend)', email: null },
        workflow: workflow ? { id: workflow.id, name: workflow.name } : null,
        status:              run.status,
        completion_reason:   run.completion_reason || null,
        started_at:          run.started_at || null,
        completed_at:        run.completed_at || null,
        updated_at:          run.updated_at || null,
        current_step:        projection?.current_step || null,
        total_steps:         projection?.total_steps || (stepsForWf.length || null),
        next_action:         projection?.next_action || null,
        next_contact:        projection?.next_contact || null,
        is_estimate:         projection?.is_estimate === true,
        open_invoices: {
          count: inv.count,
          total_amount: Math.round(inv.total * 100) / 100,
        },
        pause_reason:        pauseReason,
        incasso,
      };
    });

    // ── Fase 5: KPI-tellers ─────────────────────────────────────────
    const { counts, klaar_by_reason } = buildBucketCounts(runs);

    return res.status(200).json({
      generated_at: new Date(nowMs).toISOString(),
      counts,
      klaar_by_reason,
      items,
      _meta: {
        run_count:  runs.length,
        window_days: KLAAR_WINDOW_DAYS,
      },
    });
  } catch (err) {
    console.error('[pipeline-overview]', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Interne serverfout' });
  }
}

function emptyResponse(nowMs) {
  return {
    generated_at: new Date(nowMs).toISOString(),
    counts: {
      deze_week: 0, loopt: 0,
      wacht_klant: 0, wacht_regeling: 0, wacht_gesprek: 0, wacht_handmatig: 0,
      wacht_openstaande_actie: 0,
      klaar: 0,
    },
    klaar_by_reason: {},
    items: [],
    _meta: { run_count: 0, window_days: KLAAR_WINDOW_DAYS },
  };
}

// Dunning-settings voor incasso-drempels. Fail-soft: returnt {}
// zodat incassoCondition op defaults valt.
async function fetchDunningSettings() {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'dunning_incasso_auto')
      .maybeSingle();
    return (data && data.value && typeof data.value === 'object') ? data.value : {};
  } catch (_) { return {}; }
}
