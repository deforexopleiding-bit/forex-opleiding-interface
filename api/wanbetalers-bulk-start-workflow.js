// api/wanbetalers-bulk-start-workflow.js
//
// Bulk-start dunning workflows voor een selectie facturen vanuit de
// Wanbetalers-tab (modules/finance.html). Endpoint mapt de gekozen
// invoice_ids server-side naar unieke customer_ids en start per klant
// één dunning_workflow_run, analoog aan detectAndStartRuns() in
// api/_lib/dunning-engine.js maar dan handmatig getriggerd door een
// medewerker met `finance.dunning.execute`.
//
// Auth: Bearer JWT (createUserClient) + RBAC `finance.dunning.execute`.
// Methode: POST only.
//
// Body (JSON):
//   {
//     invoice_ids: [<uuid>, ...]   (1..MAX_BULK = 100)
//   }
//
// Per invoice_id semantiek (sequentieel, try/catch per item — geen early
// return bij faal, conform Lessons Learned #3):
//   1) Lookup invoice (id, customer_id, status, amount_total, amount_paid,
//      credited_amount). Niet gevonden → errors[].
//   2) Status ∉ OPEN_STATUSES → skipped[] reason='invoice_not_open'.
//   3) Customer al actieve run → skipped[] reason='already_active_run'.
//      (Eén klant kan meerdere geselecteerde facturen hebben; tweede hit
//      voor dezelfde customer in dezelfde call valt ook hieronder.)
//   4) Workflow-match: eerste is_active dunning_workflows op priority asc
//      die customer_type voldoet (b2b/b2c/any). Geen match → errors[]
//      reason='no_workflow_match'.
//   5) Eerste step (step_order=1) van workflow ontbreekt → errors[]
//      reason='workflow_has_no_steps'.
//   6) INSERT dunning_workflow_runs { workflow_id, customer_id,
//      status:'active', current_step_id:firstStep.id,
//      next_action_at: now, trigger_invoice_count: <aantal geselecteerd
//      voor deze customer> }.
//   7) INSERT dunning_log event_type='started' met payload
//      { trigger:'manual_bulk', triggered_by_user_id, invoice_ids,
//        workflow_id, workflow_name }.
//   8) added[] entry met { customer_id, run_id, invoice_count }.
//
// Audit (1 entry voor de gehele bulk — granulariteit per-customer staat
// al in dunning_log):
//   action='finance_dunning_run.bulk_start',
//   entity_type='dunning_workflow_run',
//   entity_id=null (aggregate),
//   after_json={ added_count, skipped_count, errors_count, invoice_ids }.
//
// Response shape (HTTP 200 ok / 207 multi-status / 400 bad input / 403):
//   {
//     total: N,
//     added: [{ customer_id, run_id, invoice_count }],
//     skipped: [{ invoice_id, customer_id?, reason }],
//     errors: [{ invoice_id, reason }]
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BULK = 100;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  // 1) Auth: geldige Bearer-JWT vereist.
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  // 2) RBAC.
  const allowed = await requirePermission(req, 'finance.dunning.execute');
  if (!allowed) {
    return res.status(403).json({
      error: 'Geen rechten (finance.dunning.execute)',
      feature: 'finance.dunning.execute',
    });
  }

  // 3) Body-validatie.
  const body = req.body || {};
  const ids = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
  if (ids.length === 0) {
    return res.status(400).json({
      error: 'invoice_ids moet minimaal 1 UUID bevatten',
      field: 'invoice_ids',
    });
  }
  if (ids.length > MAX_BULK) {
    return res.status(400).json({
      error: `invoice_ids overschrijdt max ${MAX_BULK} per bulk-call`,
      field: 'invoice_ids',
    });
  }
  const uniqueIds = [...new Set(ids.map((x) => String(x || '').trim()))];
  for (const id of uniqueIds) {
    if (!UUID_RE.test(id)) {
      return res.status(400).json({
        error: `Ongeldige UUID in invoice_ids: ${id}`,
        field: 'invoice_ids',
      });
    }
  }

  const added = [];
  const skipped = [];
  const errors = [];

  try {
    // 4) Pre-fetch alle invoices (1 query) met customer-join voor
    //    customer_type matching.
    const { data: invoiceRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select(
        'id, customer_id, status, amount_total, amount_paid, credited_amount, customers!inner(id, first_name, last_name, company_name, is_company, archived_at, anonymized_at)'
      )
      .in('id', uniqueIds);
    if (invErr) throw new Error('invoices pre-fetch: ' + invErr.message);
    const invoicesById = new Map((invoiceRows || []).map((r) => [r.id, r]));

    // 5) Workflows + steps één keer ophalen (max 1 query per workflow voor
    //    steps zou N+1 zijn; we doen 1 select op alle steps en groeperen
    //    client-side).
    const { data: workflows, error: wfErr } = await supabaseAdmin
      .from('dunning_workflows')
      .select('id, name, trigger_conditions, priority, is_active')
      .eq('is_active', true)
      .order('priority', { ascending: true });
    if (wfErr) throw new Error('workflows fetch: ' + wfErr.message);
    const activeWorkflows = workflows || [];

    let stepsByWorkflow = new Map();
    if (activeWorkflows.length > 0) {
      const wfIds = activeWorkflows.map((w) => w.id);
      const { data: stepRows, error: stepsErr } = await supabaseAdmin
        .from('dunning_workflow_steps')
        .select('id, workflow_id, step_order')
        .in('workflow_id', wfIds)
        .order('step_order', { ascending: true });
      if (stepsErr) throw new Error('steps fetch: ' + stepsErr.message);
      for (const s of stepRows || []) {
        if (!stepsByWorkflow.has(s.workflow_id)) {
          stepsByWorkflow.set(s.workflow_id, s);
        }
      }
    }

    // 6) Aggregate selectie per customer_id (zodat trigger_invoice_count
    //    correct telt en tweede invoice voor zelfde customer geen tweede
    //    run aanmaakt).
    const perCustomer = new Map();
    for (const invId of uniqueIds) {
      const inv = invoicesById.get(invId);
      if (!inv) {
        errors.push({ invoice_id: invId, reason: 'invoice_not_found' });
        continue;
      }
      if (!OPEN_STATUSES.includes(inv.status)) {
        skipped.push({
          invoice_id: invId,
          customer_id: inv.customer_id,
          reason: 'invoice_not_open',
        });
        continue;
      }
      const cust = inv.customers;
      if (!cust) {
        errors.push({ invoice_id: invId, reason: 'customer_not_found' });
        continue;
      }
      if (cust.archived_at || cust.anonymized_at) {
        skipped.push({
          invoice_id: invId,
          customer_id: inv.customer_id,
          reason: 'customer_archived_or_anonymized',
        });
        continue;
      }
      const agg = perCustomer.get(inv.customer_id) || {
        customer: cust,
        invoice_ids: [],
      };
      agg.invoice_ids.push(invId);
      perCustomer.set(inv.customer_id, agg);
    }

    // 7) Per customer: check actieve run + match workflow + insert run/log.
    for (const [customerId, agg] of perCustomer) {
      try {
        // a) Actieve run-check (hard gate uit dunning-engine).
        const { data: existing, error: exErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .select('id')
          .eq('customer_id', customerId)
          .eq('status', 'active')
          .limit(1)
          .maybeSingle();
        if (exErr) throw new Error('active-run lookup: ' + exErr.message);
        if (existing) {
          for (const invId of agg.invoice_ids) {
            skipped.push({
              invoice_id: invId,
              customer_id: customerId,
              reason: 'already_active_run',
            });
          }
          continue;
        }

        // b) Workflow-match: eerste actieve workflow op priority asc die
        //    customer_type voldoet. min_days_overdue / min_total_amount
        //    worden bewust GENEGEERD bij handmatige bulk-start — de
        //    medewerker heeft expliciet geselecteerd.
        let chosenWorkflow = null;
        for (const wf of activeWorkflows) {
          const tc = wf.trigger_conditions || {};
          const customerType = tc.customer_type || 'any';
          if (!matchesCustomerType(agg.customer, customerType)) continue;
          chosenWorkflow = wf;
          break;
        }
        if (!chosenWorkflow) {
          for (const invId of agg.invoice_ids) {
            errors.push({ invoice_id: invId, reason: 'no_workflow_match' });
          }
          continue;
        }

        const firstStep = stepsByWorkflow.get(chosenWorkflow.id);
        if (!firstStep) {
          for (const invId of agg.invoice_ids) {
            errors.push({ invoice_id: invId, reason: 'workflow_has_no_steps' });
          }
          continue;
        }

        // c) INSERT run.
        const nowIso = new Date().toISOString();
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .insert({
            workflow_id: chosenWorkflow.id,
            customer_id: customerId,
            status: 'active',
            current_step_id: firstStep.id,
            next_action_at: nowIso,
            trigger_invoice_count: agg.invoice_ids.length,
          })
          .select('id')
          .single();
        if (insErr) throw new Error('run insert: ' + insErr.message);

        // d) dunning_log entry (fail-soft).
        try {
          await supabaseAdmin.from('dunning_log').insert({
            run_id: inserted.id,
            step_id: firstStep.id,
            event_type: 'started',
            payload: {
              trigger: 'manual_bulk',
              triggered_by_user_id: user.id,
              workflow_id: chosenWorkflow.id,
              workflow_name: chosenWorkflow.name,
              customer_id: customerId,
              invoice_ids: agg.invoice_ids,
              trigger_invoice_count: agg.invoice_ids.length,
            },
          });
        } catch (logErr) {
          console.error('[wanbetalers-bulk-start-workflow] log insert failed', inserted.id, logErr.message);
        }

        added.push({
          customer_id: customerId,
          run_id: inserted.id,
          invoice_count: agg.invoice_ids.length,
        });
      } catch (e) {
        console.error('[wanbetalers-bulk-start-workflow] per-customer error', customerId, e.message);
        for (const invId of agg.invoice_ids) {
          errors.push({ invoice_id: invId, reason: e.message || 'unknown_error' });
        }
      }
    }

    // 8) Aggregate audit (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id,
        action: 'finance_dunning_run.bulk_start',
        entity_type: 'dunning_workflow_run',
        entity_id: null,
        after_json: {
          added_count: added.length,
          skipped_count: skipped.length,
          errors_count: errors.length,
          invoice_ids: uniqueIds,
        },
        ip_address: getClientIp(req),
      });
    } catch (auditErr) {
      console.error('[wanbetalers-bulk-start-workflow] audit insert failed', auditErr.message);
    }

    const httpStatus = errors.length === 0 ? 200 : 207;
    return res.status(httpStatus).json({
      total: uniqueIds.length,
      added,
      skipped,
      errors,
    });
  } catch (e) {
    console.error('[wanbetalers-bulk-start-workflow] fatal', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
