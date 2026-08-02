// api/wanbetalers-diagnose-data.js
//
// GET → JSON-snapshot van ALLE klanten met een open factuur (status
// open/partially_paid/overdue + bedrag_open > 0), voor gebruik door
// /modules/wanbetalers-diagnose.html. Puur diagnostiek: read-only,
// geen writes, geen side-effects. Super_admin only.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const MAX_MESSAGES_PER_CONV = 10;
const MAX_LOG_EVENTS_PER_RUN = 50;

// Cutoff: moment waarop de dag7/dag14-body-fix (#1046) live ging op
// productie. Sends vóór dit moment die faalden zijn HISTORISCH en dus
// niet meer relevant voor actie. Ná dit moment = potentieel actief
// probleem. Hardcoded (ipv env) omdat het een concreet historisch punt is.
const WA_FIX_CUTOFF_ISO = '2026-08-02T09:00:00Z';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  const admin = await verifyAdmin(req);
  if (!admin)                            return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (admin.profile?.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin.' });

  try {
    const { data: openInvs, error: iErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, status, issue_date, due_date, paid_date, is_test')
      .in('status', OPEN_STATUSES)
      .eq('is_test', false);
    if (iErr) throw new Error('invoices fetch: ' + iErr.message);

    const openWithAmount = (openInvs || []).filter((iv) =>
      Math.max(0, (Number(iv.amount_total) || 0)
                    - (Number(iv.amount_paid) || 0)
                    - (Number(iv.credited_amount) || 0)) > 0
    );
    const custIds = Array.from(new Set(openWithAmount.map((iv) => iv.customer_id).filter(Boolean)));

    if (custIds.length === 0) {
      return res.status(200).json({ generated_at: new Date().toISOString(), customers: [], signal_counts: {} });
    }

    // Extra: profiles van gebruikers die runs handmatig hebben gepauzeerd,
    // zodat de UI "Handmatig gepauzeerd door <naam>" kan tonen i.p.v. UUID.
    // We fetchen ALLE profiles in één keer (kleine tabel, geen N+1).
    const [
      customersRes, allInvoicesRes, runsRes, workflowsRes,
      stepsRes, pipelineRes, arrangementsRes, conversationsRes,
      profilesRes, analysesRes,
    ] = await Promise.all([
      supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email, phone, anonymized_at, archived_at')
        .in('id', custIds),
      supabaseAdmin.from('invoices')
        .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, status, issue_date, due_date, paid_date')
        .in('customer_id', custIds)
        .eq('is_test', false),
      supabaseAdmin.from('dunning_workflow_runs')
        .select('id, customer_id, workflow_id, status, current_step_id, next_action_at, started_at, completed_at, completion_reason, paused_by_conversation_id, paused_by_arrangement_id, paused_by_manual_user_id, paused_manual_reason, paused_at, updated_at, needs_attention, last_failure_reason')
        .in('customer_id', custIds),
      supabaseAdmin.from('dunning_workflows').select('id, name'),
      supabaseAdmin.from('dunning_workflow_steps').select('id, workflow_id, step_type, step_order, config'),
      supabaseAdmin.from('dunning_pipeline_customers')
        .select('customer_id, stage_slug, stage_changed_at, last_activity_at')
        .in('customer_id', custIds),
      supabaseAdmin.from('payment_arrangements')
        .select('id, customer_id, type, status, invoice_ids, details, created_at, updated_at, breach_handled_at')
        .in('customer_id', custIds),
      supabaseAdmin.from('whatsapp_conversations')
        .select('id, customer_id, status, last_inbound_at, last_message_at, last_message_preview, unread_count')
        .in('customer_id', custIds),
      supabaseAdmin.from('profiles')
        .select('id, full_name, email'),
      // Bestaande AI-analyses cache (nieuw sinds migratie 2026-08-02).
      // Fail-soft: catch geeft [] als tabel nog niet bestaat.
      supabaseAdmin.from('dunning_gesprek_analyse')
        .select('customer_id, afspraak_gemaakt, samenvatting, termijnen, vertrouwen, actie_nodig, heeft_arrangement, messages_count, customer_msg_count, outbound_msg_count, sufficient_data, geanalyseerd_op, geanalyseerd_door')
        .in('customer_id', custIds)
        .then((r) => r, () => ({ data: [], error: null })),
    ]);
    if (customersRes.error) throw new Error('customers: ' + customersRes.error.message);

    const customers    = customersRes.data     || [];
    const allInvoices  = allInvoicesRes.data   || [];
    const runs         = runsRes.data          || [];
    const workflows    = workflowsRes.data     || [];
    const steps        = stepsRes.data         || [];
    const pipeline     = pipelineRes.data      || [];
    const arrangements = arrangementsRes.data  || [];
    const conversations= conversationsRes.data || [];
    const profiles     = profilesRes.data      || [];
    const profileById  = new Map(profiles.map((p) => [p.id, p]));
    const analyses     = analysesRes.data      || [];
    const analysisByCust = new Map(analyses.map((a) => [a.customer_id, a]));

    const runIds = runs.map((r) => r.id);
    let logs = [];
    if (runIds.length > 0) {
      const totalCap = Math.min(20_000, MAX_LOG_EVENTS_PER_RUN * runIds.length);
      const { data: logRows } = await supabaseAdmin
        .from('dunning_log')
        .select('run_id, step_id, event_type, payload, created_at')
        .in('run_id', runIds)
        .order('created_at', { ascending: false })
        .limit(totalCap);
      logs = logRows || [];
    }

    const convIds = conversations.map((c) => c.id);
    let messages = [];
    if (convIds.length > 0) {
      const totalMsgCap = Math.min(10_000, MAX_MESSAGES_PER_CONV * convIds.length + 100);
      const { data: msgRows } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('id, conversation_id, direction, body, status, created_at')
        .in('conversation_id', convIds)
        .order('created_at', { ascending: false })
        .limit(totalMsgCap);
      messages = msgRows || [];
    }

    const wfById   = new Map(workflows.map((w) => [w.id, w]));
    const stepById = new Map(steps.map((s) => [s.id, s]));
    const pipeByCust = new Map(pipeline.map((p) => [p.customer_id, p]));
    const runsByCust = groupBy(runs, 'customer_id');
    const invsByCust = groupBy(allInvoices, 'customer_id');
    const arrByCust  = groupBy(arrangements, 'customer_id');
    const convByCust = groupBy(conversations, 'customer_id');
    const logsByRun  = groupBy(logs, 'run_id');
    const msgsByConv = groupBy(messages, 'conversation_id');

    const customerData = customers.map((c) => buildCustomerRecord({
      customer: c,
      invoices: invsByCust[c.id] || [],
      runs:     runsByCust[c.id] || [],
      pipe:     pipeByCust.get(c.id) || null,
      arrangements: arrByCust[c.id] || [],
      conversations: (convByCust[c.id] || []),
      wfById, stepById, profileById,
      logsByRun, msgsByConv,
      cached_analysis: analysisByCust.get(c.id) || null,
    }));

    customerData.sort((a, b) => (b.summary.total_open_eur || 0) - (a.summary.total_open_eur || 0));

    const signalCounts = {};
    for (const c of customerData) {
      for (const s of (c.signals || [])) {
        signalCounts[s.code] = (signalCounts[s.code] || 0) + 1;
      }
    }

    return res.status(200).json({
      generated_at:  new Date().toISOString(),
      customers:     customerData,
      signal_counts: signalCounts,
    });
  } catch (e) {
    console.error('[wanbetalers-diagnose-data]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

function groupBy(arr, key) {
  const out = {};
  for (const row of arr || []) {
    const k = row[key];
    if (!k) continue;
    if (!out[k]) out[k] = [];
    out[k].push(row);
  }
  return out;
}
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400_000));
}
function openAmount(inv) {
  return Math.max(0, (Number(inv.amount_total) || 0)
                       - (Number(inv.amount_paid) || 0)
                       - (Number(inv.credited_amount) || 0));
}
function customerDisplay(c) {
  const isC = !!c.is_company;
  const name = isC
    ? (c.company_name || '(bedrijf zonder naam)')
    : ([c.first_name, c.last_name].filter(Boolean).join(' ') || '(zonder naam)');
  return name + (c.anonymized_at ? ' [geanonimiseerd]' : '')
              + (c.archived_at ? ' [gearchiveerd]' : '');
}

function buildCustomerRecord(ctx) {
  const { customer, invoices, runs, pipe, arrangements, conversations,
          wfById, stepById, profileById, logsByRun, msgsByConv,
          cached_analysis } = ctx;

  const openInvs = invoices.filter((iv) => OPEN_STATUSES.includes(iv.status) && openAmount(iv) > 0);
  const totalOpenEur = openInvs.reduce((sum, iv) => sum + openAmount(iv), 0);
  const oldestDue = openInvs.map((iv) => iv.due_date).filter(Boolean).sort()[0] || null;
  const daysOverdue = oldestDue ? Math.max(0, Math.floor((Date.now() - new Date(oldestDue).getTime()) / 86400_000)) : null;

  const payments = invoices
    .filter((iv) => iv.paid_date || (Number(iv.amount_paid) || 0) > 0)
    .map((iv) => ({
      invoice_number: iv.invoice_number,
      status:         iv.status,
      amount_total:   Number(iv.amount_total) || 0,
      amount_paid:    Number(iv.amount_paid)  || 0,
      paid_date:      iv.paid_date,
    }))
    .sort((a, b) => (b.paid_date || '').localeCompare(a.paid_date || ''));

  const activeRun = runs.find((r) => r.status === 'active' || r.status === 'paused')
    || runs.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0]
    || null;
  const wf = activeRun ? wfById.get(activeRun.workflow_id) : null;
  const step = activeRun ? stepById.get(activeRun.current_step_id) : null;

  let runReason = null;
  let runReasonLabel = null;
  if (activeRun && activeRun.status === 'paused') {
    if (activeRun.paused_by_conversation_id) { runReason = 'inbox_reply';  runReasonLabel = 'Klant reageerde (WhatsApp)'; }
    else if (activeRun.paused_by_arrangement_id) { runReason = 'arrangement'; runReasonLabel = 'Regeling loopt / breach'; }
    else if (activeRun.paused_by_manual_user_id) {
      runReason = 'manual';
      const p = profileById ? profileById.get(activeRun.paused_by_manual_user_id) : null;
      const who = p ? (p.full_name || p.email || activeRun.paused_by_manual_user_id) : activeRun.paused_by_manual_user_id;
      runReasonLabel = 'Handmatig gepauzeerd door ' + who
        + (activeRun.paused_manual_reason ? ' (' + activeRun.paused_manual_reason + ')' : '')
        + (activeRun.paused_at ? ' — ' + new Date(activeRun.paused_at).toISOString().slice(0,10) : '');
    }
    else { runReason = 'wees'; runReasonLabel = 'GEEN REDEN (wees-run — pre-fix)'; }
  }

  const runLogs = [];
  for (const r of runs) {
    const events = logsByRun[r.id] || [];
    for (const ev of events) runLogs.push({ ...ev, run_id: r.id, run_status: r.status });
  }
  runLogs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const sendEvents = runLogs.filter((e) => /^(email|whatsapp)_(sent|send_failed)$/.test(e.event_type));

  const convSummaries = conversations.map((cv) => {
    const msgs = (msgsByConv[cv.id] || []).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return {
      id:                cv.id,
      status:            cv.status,
      last_inbound_at:   cv.last_inbound_at,
      last_message_at:   cv.last_message_at,
      unread_count:      cv.unread_count || 0,
      messages_shown:    msgs.slice(0, MAX_MESSAGES_PER_CONV).map((m) => ({
        created_at: m.created_at,
        direction:  m.direction,
        body:       String(m.body || '').slice(0, 200),
        status:     m.status,
      })),
      total_messages:    msgs.length,
    };
  });
  const totalMessages = convSummaries.reduce((s, c) => s + c.total_messages, 0);
  const lastInbound = convSummaries.map((c) => c.last_inbound_at).filter(Boolean).sort().reverse()[0] || null;

  const arrangementSummary = arrangements.map((a) => ({
    id:         a.id,
    type:       String(a.type || '').toUpperCase(),
    status:     String(a.status || '').toUpperCase(),
    details:    a.details || {},
    created_at: a.created_at,
    updated_at: a.updated_at,
  }));
  const hasActiveArr = arrangementSummary.some((a) => a.status === 'ACTIEF' || a.status === 'VOORGESTELD');

  const timeline = [];
  for (const ev of runLogs.slice(0, 100)) {
    timeline.push({ at: ev.created_at, kind: 'log', event: ev.event_type, payload: ev.payload || {} });
  }
  for (const cv of convSummaries) {
    for (const m of cv.messages_shown) {
      timeline.push({
        at: m.created_at, kind: 'msg', event: 'wa_' + (m.direction === 'in' ? 'inbound' : 'outbound'),
        body: m.body, msg_status: m.status,
      });
    }
  }
  for (const p of payments) {
    if (p.paid_date) {
      timeline.push({ at: p.paid_date + 'T00:00:00Z', kind: 'payment', event: 'payment',
                      invoice: p.invoice_number, amount_paid: p.amount_paid });
    }
  }
  for (const a of arrangementSummary) {
    timeline.push({ at: a.created_at, kind: 'arrangement', event: 'arr_created',
                    arr_type: a.type, arr_status: a.status });
  }
  timeline.sort((a, b) => (b.at || '').localeCompare(a.at || ''));

  const signals = [];
  if (runReason === 'wees') {
    signals.push({ code: 'wees_run', severity: 'high', msg: 'Wees-run: paused zonder reden-flag (vóór #1051-fix).' });
  }
  if (activeRun?.needs_attention) {
    signals.push({ code: 'needs_attention', severity: 'high', msg: 'Run heeft needs_attention=true (3× gefaald).' });
  }
  const inGesprek = !!lastInbound && (daysSince(lastInbound) !== null && daysSince(lastInbound) <= 30);
  if (inGesprek && !hasActiveArr) {
    signals.push({ code: 'gesprek_zonder_regeling', severity: 'medium',
                   msg: 'In gesprek (recent inbound) maar geen vastgelegde regeling.' });
  }
  const recentPayments = payments.filter((p) => p.paid_date && daysSince(p.paid_date + 'T00:00:00Z') <= 120);
  const uniquePayDates = new Set(recentPayments.map((p) => p.paid_date));
  if (uniquePayDates.size >= 2 && !hasActiveArr && totalOpenEur > 0) {
    signals.push({ code: 'termijn_zonder_regeling', severity: 'medium',
                   msg: `Betaalt in termijnen (${uniquePayDates.size} paid_date-momenten in laatste 120d) zonder vastgelegde regeling.` });
  }
  const failedSends = sendEvents.filter((e) => e.event_type.endsWith('_send_failed'));
  if (failedSends.length > 0) {
    signals.push({ code: 'aanmaning_faalde', severity: 'medium',
                   msg: `${failedSends.length} gefaalde aanmaning(en) in dunning_log.` });
  }
  // Specifiek WhatsApp-fails uitsplitsen: historisch (vóór fix) vs actief
  // (na fix). Actief = real red flag (verzending is nog stuk); historisch =
  // pre-fix rommel die alleen ter info wordt getoond.
  const waFailsHist = failedSends.filter((e) => e.event_type === 'whatsapp_send_failed' && e.created_at && e.created_at < WA_FIX_CUTOFF_ISO);
  const waFailsAct  = failedSends.filter((e) => e.event_type === 'whatsapp_send_failed' && (!e.created_at || e.created_at >= WA_FIX_CUTOFF_ISO));
  if (waFailsAct.length > 0) {
    signals.push({ code: 'wa_faalde_actief', severity: 'high',
                   msg: `${waFailsAct.length} gefaalde WhatsApp-send(s) NA de dag7/14-fix — actief probleem.` });
  } else if (waFailsHist.length > 0) {
    signals.push({ code: 'wa_faalde_historisch', severity: 'low',
                   msg: `${waFailsHist.length} historisch gefaalde WhatsApp-send(s) (vóór dag7/14-fix van 2 aug 09:00).` });
  }
  if (activeRun && activeRun.status === 'active' && activeRun.next_action_at
      && new Date(activeRun.next_action_at).getTime() < Date.now() - 3*86400_000) {
    signals.push({ code: 'stille_actieve_run', severity: 'medium',
                   msg: 'Run staat active + next_action_at ligt >3d in het verleden — engine zou moeten oppikken.' });
  }

  // Volgende actie in het verleden (los van run-status). Overlapt gedeeltelijk
  // met stille_actieve_run maar dekt ook paused runs waar next_action_at
  // achterhaald is. Threshold 1 dag — kleiner dan stille_actieve_run's 3d
  // omdat "verstreken" een breder signaal is (paused runs mogen niet ticken,
  // maar de datum toont wél dat er iets is blijven liggen).
  const daysPastNextAction = (activeRun && activeRun.next_action_at)
    ? Math.floor((Date.now() - new Date(activeRun.next_action_at).getTime()) / 86400_000)
    : null;
  if (daysPastNextAction !== null && daysPastNextAction >= 1) {
    signals.push({ code: 'next_action_verstreken', severity: 'medium',
                   msg: `Volgende actie ligt ${daysPastNextAction} dag(en) in het verleden — flow had moeten doorlopen.` });
  }
  if (totalOpenEur === 0 && activeRun && ['active','paused'].includes(activeRun.status)) {
    signals.push({ code: 'run_open_zonder_openstaand', severity: 'low',
                   msg: '€0 openstaand maar run staat nog active/paused — kandidaat om te cancellen.' });
  }
  if (customer.anonymized_at && totalOpenEur > 0) {
    signals.push({ code: 'anonymized_met_openstaand', severity: 'high',
                   msg: 'Klant is geanonimiseerd maar heeft nog openstaand bedrag.' });
  }

  return {
    customer_id: customer.id,
    name:        customerDisplay(customer),
    email:       customer.email || null,
    phone:       customer.phone || null,
    summary: {
      total_open_eur:     Number(totalOpenEur.toFixed(2)),
      open_invoice_count: openInvs.length,
      days_overdue:       daysOverdue,
      pipeline_stage:     pipe?.stage_slug || null,
      pipeline_since:     pipe?.stage_changed_at || null,
      last_inbound_at:    lastInbound,
      total_messages:     totalMessages,
    },
    run: activeRun ? {
      id:             activeRun.id,
      status:         activeRun.status,
      workflow_name:  wf?.name || null,
      step_order:     step?.step_order ?? null,
      step_type:      step?.step_type || null,
      step_title:     step?.config?.title || null,
      next_action_at: activeRun.next_action_at,
      updated_at:     activeRun.updated_at,
      needs_attention: !!activeRun.needs_attention,
      reason:         runReason,
      reason_label:   runReasonLabel,
      paused_at:      activeRun.paused_at || null,
      days_past_next_action: daysPastNextAction,
    } : null,
    arrangements: arrangementSummary,
    conversations: convSummaries,
    payments,
    open_invoices: openInvs.map((iv) => ({
      invoice_number: iv.invoice_number,
      due_date:       iv.due_date,
      status:         iv.status,
      bedrag_open:    Number(openAmount(iv).toFixed(2)),
    })),
    sends: sendEvents.map((e) => ({
      at:                 e.created_at,
      event_type:         e.event_type,
      meta_template_name: e.payload?.meta_template_name || null,
      to:                 e.payload?.to || null,
      wamid:              e.payload?.meta_wamid || null,
      error:              e.payload?.error || null,
      meta_code:          e.payload?.meta_code || null,
      // era: historisch (vóór dag7/14-fix) vs actief (na). Alleen zinvol
      // voor whatsapp_send_failed — voor sent/email negeren we het (era='n/a').
      era: (e.event_type === 'whatsapp_send_failed')
        ? ((e.created_at && e.created_at < WA_FIX_CUTOFF_ISO) ? 'historisch' : 'actief')
        : 'n/a',
    })),
    timeline: timeline.slice(0, 100),
    signals,
    cached_analysis: cached_analysis ? {
      afspraak_gemaakt:   cached_analysis.afspraak_gemaakt,
      samenvatting:       cached_analysis.samenvatting,
      termijnen:          Array.isArray(cached_analysis.termijnen) ? cached_analysis.termijnen : [],
      vertrouwen:         cached_analysis.vertrouwen,
      actie_nodig:        cached_analysis.actie_nodig,
      heeft_arrangement:  cached_analysis.heeft_arrangement,
      messages_count:     cached_analysis.messages_count,
      customer_msg_count: cached_analysis.customer_msg_count,
      outbound_msg_count: cached_analysis.outbound_msg_count,
      sufficient_data:    cached_analysis.sufficient_data,
      geanalyseerd_op:    cached_analysis.geanalyseerd_op,
      geanalyseerd_door_email: (profileById && cached_analysis.geanalyseerd_door)
        ? (profileById.get(cached_analysis.geanalyseerd_door)?.email || null) : null,
      geanalyseerd_door_name:  (profileById && cached_analysis.geanalyseerd_door)
        ? (profileById.get(cached_analysis.geanalyseerd_door)?.full_name || null) : null,
    } : null,
  };
}
