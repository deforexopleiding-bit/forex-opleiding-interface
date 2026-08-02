// api/_lib/wanbetalers-flow-test.js
//
// Shared helpers voor de fase-3 flow-test-endpoints. Herbruikt de echte
// productie-engine (runEngine) en de productie-pause-hook
// (pauseRunsForConversation). GEEN duplicaat, GEEN mock — zodat een
// geslaagde flow-test bewijst dat productie ook werkt.
//
// Alle helpers zijn expliciet is_test-scoped:
//   - customer altijd via getSandboxCustomer() (is_test=true)
//   - runs geselecteerd op .eq('customer_id', sandbox.id)
//   - conversation-insert altijd met customer_id = sandbox.id + is_test-check
//
// Elke helper returnt { ok, ...detail } zodat de caller er stap-status van
// kan bouwen.

import { supabaseAdmin } from '../supabase.js';
import { getSandboxCustomer } from './wanbetalers-sandbox.js';
import { runEngine } from './dunning-engine.js';

const FLOW_PRESETS = {
  single: { invoice_count: 1, days_overdue: 1,  amount_per_invoice_eur: 250 },
  multi:  { invoice_count: 3, days_overdue: 14, amount_per_invoice_eur: 250 },
};

// ── Sandbox-klant ophalen met defense-in-depth is_test-check ─────────────
export async function loadSandboxCustomerOrFail() {
  const customer = await getSandboxCustomer();
  if (!customer)                return { ok: false, error: 'Geen sandbox-test-persoon gevonden — seed eerst via het paneel of sectie 1/2.' };
  if (customer.is_test !== true) return { ok: false, error: 'SANDBOX_GUARD_FAILED: sandbox-klant heeft is_test !== true.' };
  return { ok: true, customer };
}

export function flowPreset(flow) {
  const p = FLOW_PRESETS[flow];
  if (!p) throw new Error(`Onbekende flow '${flow}'; verwacht 'single' of 'multi'`);
  return p;
}

// ── Reset + seed voor flow-tests. Minimaal (geen sub/deal — die zijn niet
//    nodig voor flow-overgangen). Hard is_test-scoped.
export async function resetAndSeedForFlowTest(customer, flow) {
  const p = flowPreset(flow);
  const nowIso = new Date().toISOString();
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  // 1) Test-invoices verwijderen (dubbele guard).
  const { error: delInvErr } = await supabaseAdmin
    .from('invoices').delete()
    .eq('customer_id', customer.id).eq('is_test', true);
  if (delInvErr) return { ok: false, error: 'invoices delete: ' + delInvErr.message };

  // 2) Bestaande runs voor deze klant verwijderen (via customer_id-scope).
  //    Runs zijn per definitie test-scope want customer is is_test=true.
  //    dunning_log.run_id staat NULL na cascade of blijft dangling; we
  //    laten 'em zo (audit-trail, wist door reset-endpoint pas).
  const { error: delRunErr } = await supabaseAdmin
    .from('dunning_workflow_runs').delete()
    .eq('customer_id', customer.id);
  if (delRunErr) return { ok: false, error: 'runs delete: ' + delRunErr.message };

  // 3) Pipeline stage terug naar 'nieuw' (upsert, customer_id UNIQUE).
  const { error: pipeErr } = await supabaseAdmin
    .from('dunning_pipeline_customers').upsert({
      customer_id      : customer.id,
      stage_slug       : 'nieuw',
      stage_changed_at : nowIso,
      stage_changed_by : 'sandbox:flow-test',
      last_activity_at : nowIso,
    }, { onConflict: 'customer_id' });
  if (pipeErr) return { ok: false, error: 'pipeline upsert: ' + pipeErr.message };

  // 4) N test-invoices met backdated due_date (is_test hardcoded).
  const invRows = Array.from({ length: p.invoice_count }).map((_, i) => ({
    customer_id  : customer.id,
    amount_total : p.amount_per_invoice_eur,
    amount_paid  : 0,
    status       : 'open',
    due_date     : daysAgo(p.days_overdue),
    issue_date   : daysAgo(p.days_overdue + 14),
    invoice_number: 'FLOWTEST-' + Date.now().toString(36) + '-' + (i + 1),
    is_test      : true,
  }));
  const { error: insErr } = await supabaseAdmin.from('invoices').insert(invRows);
  if (insErr) return { ok: false, error: 'invoices insert: ' + insErr.message };

  return { ok: true, flow, invoice_count: invRows.length, days_overdue: p.days_overdue };
}

// ── Meest recente run voor de sandbox-klant. Scope: alleen sandbox. ──────
export async function findLatestRun(customerId) {
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, completed_at, completion_reason, paused_by_conversation_id, paused_conversation_reminder_count, paused_by_arrangement_id, updated_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('runs lookup: ' + error.message);
  return data || null;
}

// ── Snapshot van de run-status (voor voor/na-vergelijking) ───────────────
export async function captureRunState(customerId) {
  const run = await findLatestRun(customerId);
  if (!run) return { has_run: false };
  // Ook workflow-naam ophalen voor leesbaarheid.
  let workflowName = null;
  if (run.workflow_id) {
    const { data: wf } = await supabaseAdmin
      .from('dunning_workflows')
      .select('name')
      .eq('id', run.workflow_id)
      .maybeSingle();
    workflowName = wf?.name || null;
  }
  return {
    has_run:                        true,
    run_id:                         run.id,
    workflow_id:                    run.workflow_id,
    workflow_name:                  workflowName,
    status:                         run.status,
    current_step_id:                run.current_step_id,
    next_action_at:                 run.next_action_at,
    paused_by_conversation_id:      run.paused_by_conversation_id,
    paused_by_arrangement_id:       run.paused_by_arrangement_id,
    paused_conversation_reminder_count: run.paused_conversation_reminder_count,
    completed_at:                   run.completed_at,
    completion_reason:              run.completion_reason,
    updated_at:                     run.updated_at,
  };
}

// ── Draai de engine 1 keer op scope='test'. Idempotent. ──────────────────
export async function runEngineTestScope() {
  return await runEngine({ mode: 'sandbox', scope: 'test', abortMs: 45_000 });
}

// ── Simuleer inbound WA. Minimale versie voor flow-tests. ────────────────
// Bewust GEEN Joost-autonomie chain (die zit in sandbox-simulate-inbound
// voor het oefengesprek). Wij testen alleen de "run pauzeert bij inbound"-
// overgang, dus we hebben alleen conversation + message + pause-hook nodig.
//
// Alle writes hard scoped op sandbox-customer:
//   - conversation .eq('customer_id', customer.id) op adopt
//   - conversation insert met customer_id = customer.id
//   - pauseRunsForConversation krijgt customerId als 2e arg (guard binnen die
//     helper filtert al op customer_id)
export async function simulateSandboxInbound(customer, messageText = 'Ik zal deze week betalen.') {
  const nowIso = new Date().toISOString();

  // Finance-WABA phone_number_id (kan null zijn — dan legacy conversation).
  const { data: modCfg } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('phone_number_id')
    .eq('module', 'finance')
    .eq('is_active', true)
    .maybeSingle();
  const pnId = modCfg?.phone_number_id || null;

  const phoneRaw = String(customer.phone || '').trim();
  if (!phoneRaw) return { ok: false, error: 'Test-klant heeft geen telefoonnummer.' };
  const phone = phoneRaw.startsWith('+') ? phoneRaw : ('+' + phoneRaw);

  // find-or-create conversation. Scoped op sandbox-customer.
  async function _findConv() {
    let q = supabaseAdmin.from('whatsapp_conversations')
      .select('id, status, customer_id')
      .eq('phone_number', phone);
    q = (pnId == null) ? q.is('phone_number_id', null) : q.eq('phone_number_id', pnId);
    const { data } = await q.limit(1);
    return (data && data[0]) || null;
  }
  let existing = await _findConv();

  // Hijack-guard: nooit een gesprek adopten dat aan een andere klant hangt.
  if (existing && existing.customer_id && existing.customer_id !== customer.id) {
    return { ok: false, error: `Conversation ${existing.id} hoort al bij andere klant ${existing.customer_id} — abort` };
  }

  let convId;
  if (existing) {
    convId = existing.id;
    const nextStatus = (String(existing.status || 'open') === 'archived') ? 'archived' : 'open';
    await supabaseAdmin.from('whatsapp_conversations').update({
      last_message_at     : nowIso,
      last_message_preview: messageText.slice(0, 120),
      last_inbound_at     : nowIso,
      status              : nextStatus,
      customer_id         : customer.id,
    })
    .eq('id', existing.id)
    .or(`customer_id.eq.${customer.id},customer_id.is.null`);
  } else {
    const displayName = String(customer.first_name || '').replace(/^🧪 TEST — /, '') || 'Sandbox';
    const { data: inserted, error: cErr } = await supabaseAdmin
      .from('whatsapp_conversations').insert({
        phone_number        : phone,
        phone_number_id     : pnId,
        customer_id         : customer.id,
        display_name        : displayName,
        status              : 'open',
        last_message_at     : nowIso,
        last_message_preview: messageText.slice(0, 120),
        unread_count        : 1,
        last_inbound_at     : nowIso,
      }).select('id').single();
    if (cErr) return { ok: false, error: 'conv insert: ' + cErr.message };
    convId = inserted.id;
  }

  // Insert inbound message.
  const { data: msg, error: mErr } = await supabaseAdmin
    .from('whatsapp_messages').insert({
      conversation_id: convId,
      direction      : 'in',
      body           : messageText,
      status         : 'delivered',
      delivered_at   : nowIso,
      created_at     : nowIso,
    }).select('id').single();
  if (mErr) return { ok: false, error: 'msg insert: ' + mErr.message };

  // Trigger de ECHTE pauze-hook. Dit is dezelfde hook die de live
  // inbox-webhook aanroept (inbox-webhook.js). Als 'ie hier faalt te
  // pauzeren, faalt 'ie ook in productie — dat is precies wat de test moet
  // signaleren.
  let pauseResult = null;
  try {
    const { pauseRunsForConversation } = await import('./dunning-arrangement-hooks.js');
    pauseResult = await pauseRunsForConversation(convId, customer.id);
  } catch (e) {
    return { ok: false, error: 'pauseRunsForConversation faalde: ' + (e?.message || e), conversation_id: convId, message_id: msg.id };
  }

  return {
    ok:              true,
    conversation_id: convId,
    message_id:      msg.id,
    pause_result:    pauseResult,
  };
}

// ── Snooze: schuif next_action_at N dagen naar de toekomst. ─────────────
// Guard: run moet bij sandbox-customer horen én status='active' zijn.
export async function snoozeRunDays(runId, customerId, days) {
  const daysN = Math.max(1, Math.min(365, Number(days) || 7));
  const target = new Date(Date.now() + daysN * 86400 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .update({ next_action_at: target, updated_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .select('id, status, next_action_at');
  if (error) return { ok: false, error: 'snooze update: ' + error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: `SANDBOX_GUARD_FAILED: snooze op run ${runId} raakte 0 rijen (verwacht sandbox-customer + status=active)` };
  }
  return { ok: true, run: data[0], snoozed_days: daysN };
}

// ── Fast-forward: schuif next_action_at N dagen naar het verleden. ──────
// Zo simuleert een test dat de "snooze-datum" bereikt is zonder echt te
// wachten. Alleen deze run + sandbox-customer + status='active'.
export async function fastForwardRunNextActionDays(runId, customerId, days) {
  const daysN = Math.max(1, Math.min(365, Number(days) || 7));
  // Lees eerst next_action_at zodat we relative kunnen shiften.
  const { data: cur, error: rErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('next_action_at')
    .eq('id', runId)
    .eq('customer_id', customerId)
    .maybeSingle();
  if (rErr) return { ok: false, error: 'ff read: ' + rErr.message };
  if (!cur) return { ok: false, error: `SANDBOX_GUARD_FAILED: run ${runId} niet gevonden bij sandbox-klant` };
  const baseMs = cur.next_action_at ? new Date(cur.next_action_at).getTime() : Date.now();
  const target = new Date(baseMs - daysN * 86400 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .update({ next_action_at: target, updated_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('customer_id', customerId)
    .select('id, status, next_action_at');
  if (error) return { ok: false, error: 'ff update: ' + error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: `SANDBOX_GUARD_FAILED: ff op run ${runId} raakte 0 rijen` };
  }
  return { ok: true, run: data[0], shifted_days: daysN, new_next_action_at: target };
}

// ── Manual pause: zet status='paused' op de active run. ─────────────────
export async function manualPauseRun(runId, customerId) {
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .select('id, status');
  if (error) return { ok: false, error: 'pause update: ' + error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: `SANDBOX_GUARD_FAILED: pause op run ${runId} raakte 0 rijen (verwacht sandbox-customer + status=active)` };
  }
  return { ok: true, run: data[0] };
}

// ── Manual resume: zet status='active' + wis pauze-relicten (mirror run-control). ─
export async function manualResumeRun(runId, customerId) {
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .update({
      status:                                'active',
      next_action_at:                        new Date().toISOString(),
      paused_by_conversation_id:             null,
      paused_conversation_reminder_count:    0,
      paused_conversation_last_reminder_at:  null,
      paused_by_arrangement_id:              null,
      updated_at:                            new Date().toISOString(),
    })
    .eq('id', runId)
    .eq('customer_id', customerId)
    .eq('status', 'paused')
    .select('id, status');
  if (error) return { ok: false, error: 'resume update: ' + error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: `SANDBOX_GUARD_FAILED: resume op run ${runId} raakte 0 rijen (verwacht sandbox-customer + status=paused)` };
  }
  return { ok: true, run: data[0] };
}
