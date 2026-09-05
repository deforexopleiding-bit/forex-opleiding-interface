// api/flow-drilldown-overview.js
//
// BP3 v41 (2026-09-04) — READ-ONLY drilldown-endpoint voor de resterende
// flows in #automatiseringen (Lisa, Bulk, Drip, Belronde, Events-runs,
// Onboarding-runs).
//
// GET ?flow=lisa|bulk|drip|belronde|events|onboarding
//
// Response shape (per flow):
//   { ok, generated_at, flow, buckets: { <key>: {count, rows, error?} } }
//
// Puur SELECT + count:'exact',head:true. Geen writes. Cron/actie-endpoints
// blijven onaangeroerd. Incasso-zone niet aangeraakt.
//
// RBAC: automatiseringen.module.view (fallback: super_admin), zelfde als
// automations-overview + toegang-flow-overview.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TOP_N = 20;

async function safeCountAndRows(table, applyFn, selectCols) {
  try {
    // Count
    let qc = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    if (applyFn) qc = applyFn(qc);
    const { count, error: cErr } = await qc;
    if (cErr) return { count: null, rows: [], error: cErr.message };
    // Rows
    let qr = supabaseAdmin.from(table).select(selectCols || '*').limit(TOP_N);
    if (applyFn) qr = applyFn(qr);
    const { data, error: rErr } = await qr;
    if (rErr) return { count: Number(count) || 0, rows: [], error: rErr.message };
    return { count: Number(count) || 0, rows: Array.isArray(data) ? data : [], error: null };
  } catch (e) {
    return { count: null, rows: [], error: e?.message || String(e) };
  }
}

async function safeCount(table, applyFn) {
  try {
    let q = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    if (applyFn) q = applyFn(q);
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: Number(count) || 0, error: null };
  } catch (e) {
    return { count: null, error: e?.message || String(e) };
  }
}

// ── Flow-builders ─────────────────────────────────────────────────────────

async function buildLisa() {
  // Bron: lisa_followups (status=scheduled = actief). Groepeer per followup_step.
  // We tellen alle actieve follow-ups en pakken top-N met join naar
  // lisa_conversations voor contact_name / phase.
  const SEL = 'id, conversation_id, followup_step, scheduled_for, is_regular_followup, is_delayed_response, is_response_delay, is_post_link_followup, lisa_conversations!inner(contact_name, instagram_handle, phase, followup_paused, human_takeover, stop_detected_at)';
  // Discovery: unieke followup_step-waardes ophalen (kleine query, best-effort).
  let steps = [];
  try {
    const { data } = await supabaseAdmin
      .from('lisa_followups')
      .select('followup_step').eq('status', 'scheduled').limit(1000);
    const seen = new Set();
    for (const r of (data || [])) {
      if (r && r.followup_step != null && !seen.has(r.followup_step)) seen.add(r.followup_step);
    }
    steps = [...seen].sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  } catch (_) { steps = []; }
  const buckets = {};
  // Buckets per step + één "totaal actief".
  const totaal = await safeCountAndRows('lisa_followups', (q) => q.eq('status', 'scheduled').order('scheduled_for', { ascending: true }), SEL);
  buckets.total_actief = totaal;
  for (const s of steps) {
    const r = await safeCountAndRows('lisa_followups', (q) => q.eq('status', 'scheduled').eq('followup_step', s).order('scheduled_for', { ascending: true }), SEL);
    buckets['step_' + s] = r;
  }
  // Cancelled/paused counters (context — niet inline getoond in de UI-hoofdrender).
  const paused = await safeCount('lisa_conversations', (q) => q.eq('followup_paused', true));
  const takeover = await safeCount('lisa_conversations', (q) => q.eq('human_takeover', true));
  buckets.ctx_paused   = { count: paused.count, rows: [], error: paused.error };
  buckets.ctx_takeover = { count: takeover.count, rows: [], error: takeover.error };
  return { steps, buckets };
}

async function buildBulk() {
  // Bron: leadsonderhoud_bulk_recipients gegroepeerd per status + top-jobs.
  const STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];
  const buckets = {};
  for (const st of STATUSES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await safeCount('leadsonderhoud_bulk_recipients', (q) => q.eq('status', st));
    buckets['status_' + st] = { count: r.count, rows: [], error: r.error };
  }
  // Top 10 recente jobs met per-job status-tellingen.
  let jobs = [];
  try {
    const { data: js } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('id, channel, template_name, status, created_at, is_test')
      .order('created_at', { ascending: false }).limit(10);
    jobs = Array.isArray(js) ? js : [];
  } catch (_) { jobs = []; }
  return { statuses: STATUSES, buckets, jobs };
}

async function buildDrip() {
  // Bron: onderhoud_wachtrij (view). We tellen totaal + per soort. Groepering
  // op soort via GROUP BY werkt in postgrest via count-per-eq loop.
  // Verzamel unieke soorten uit een sample eerst, dan count per soort.
  let soorten = [];
  try {
    const { data } = await supabaseAdmin
      .from('onderhoud_wachtrij').select('soort').limit(500);
    const seen = new Set();
    for (const r of (data || [])) if (r && r.soort && !seen.has(r.soort)) seen.add(r.soort);
    soorten = [...seen].sort();
  } catch (_) { soorten = []; }
  const totaal = await safeCountAndRows('onderhoud_wachtrij', (q) => q.order('urgentie', { ascending: false }), '*');
  const perSoort = {};
  for (const s of soorten) {
    // eslint-disable-next-line no-await-in-loop
    const r = await safeCount('onderhoud_wachtrij', (q) => q.eq('soort', s));
    perSoort[s] = r.count;
  }
  return { soorten, perSoort, totaal };
}

async function buildBelronde() {
  const r = await safeCountAndRows('follow_up_leads',
    (q) => q.eq('lead_status', 'terugbellen').order('terugbel_datum', { ascending: true }),
    'id, lead_name, lead_email, lead_phone, terugbel_datum, source, source_ref, created_at');
  return { totaal: r };
}

async function buildEvents() {
  // Actieve runs per automation. Labels uit event_automations.
  let autos = [];
  try {
    const { data } = await supabaseAdmin
      .from('event_automations').select('id, name, enabled, trigger_type').order('name');
    autos = Array.isArray(data) ? data : [];
  } catch (_) { autos = []; }
  const perAuto = {};
  for (const a of autos) {
    // eslint-disable-next-line no-await-in-loop
    const r = await safeCount('event_automation_runs', (q) => q.eq('automation_id', a.id).eq('status', 'active'));
    perAuto[a.id] = { name: a.name, enabled: a.enabled, trigger_type: a.trigger_type, count: r.count, error: r.error };
  }
  return { autos, perAuto };
}

async function buildOnboarding() {
  let autos = [];
  try {
    const { data } = await supabaseAdmin
      .from('onboarding_automations').select('id, name, enabled, trigger_type').order('name');
    autos = Array.isArray(data) ? data : [];
  } catch (_) { autos = []; }
  const perAuto = {};
  for (const a of autos) {
    // eslint-disable-next-line no-await-in-loop
    const r = await safeCount('onboarding_automation_runs', (q) => q.eq('automation_id', a.id).eq('status', 'active'));
    perAuto[a.id] = { name: a.name, enabled: a.enabled, trigger_type: a.trigger_type, count: r.count, error: r.error };
  }
  return { autos, perAuto };
}

// BP3 v43 (2026-09-04) — per-stap counts. Labels uit steps-jsonb (aggregate,
// niet per-run steps_snapshot want stap-INDEX is stabiel over runs met dezelfde
// automation; als steps live wijzigen loopt de label mogelijk uit — dat is een
// bekende trade-off en gedocumenteerd in de discovery).
function _stepLabel(step, idx) {
  const t = String(step?.type || 'onbekend');
  const cfg = step?.config || {};
  const tpl = cfg.template_name ? ' · ' + String(cfg.template_name) : '';
  const wait = t === 'wait' && cfg.amount != null && cfg.unit ? ` (${cfg.amount} ${cfg.unit})` : '';
  const chk = t === 'condition' && cfg.check ? ' · ' + String(cfg.check) : '';
  return step?.name || `${t}${wait}${tpl}${chk}` || 'Stap ' + (idx + 1);
}
function _stepAccent(step) {
  const t = String(step?.type || '');
  if (t === 'wait')                       return 'muted';
  if (t === 'condition')                  return 'amber';
  if (t === 'send_email' || t === 'send_whatsapp') return 'blue';
  if (t === 'set_tag')                    return 'blue';
  if (t === 'update_attendee_status' || t === 'update_onboarding_status') return 'emerald';
  if (t === 'send_internal_notification') return 'blue';
  return 'muted';
}

async function buildEventsSteps() {
  let autos = [];
  try {
    const { data } = await supabaseAdmin
      .from('event_automations')
      .select('id, name, enabled, trigger_type, steps')
      .order('name');
    autos = Array.isArray(data) ? data : [];
  } catch (_) { autos = []; }
  const perAuto = {};
  for (const a of autos) {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const stepInfos = [];
    for (let i = 0; i < steps.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await safeCount('event_automation_runs',
        (q) => q.eq('automation_id', a.id).eq('status', 'active').eq('current_step_index', i));
      stepInfos.push({
        index: i, label: _stepLabel(steps[i], i), type: String(steps[i]?.type || ''),
        accent: _stepAccent(steps[i]), count: r.count, error: r.error,
      });
    }
    perAuto[a.id] = {
      name: a.name, enabled: a.enabled, trigger_type: a.trigger_type,
      steps: stepInfos,
    };
  }
  return { autos: autos.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, trigger_type: a.trigger_type })), perAuto };
}

async function buildOnboardingSteps() {
  let autos = [];
  try {
    const { data } = await supabaseAdmin
      .from('onboarding_automations')
      .select('id, name, enabled, trigger_type, steps')
      .order('name');
    autos = Array.isArray(data) ? data : [];
  } catch (_) { autos = []; }
  const perAuto = {};
  for (const a of autos) {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const stepInfos = [];
    for (let i = 0; i < steps.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await safeCount('onboarding_automation_runs',
        (q) => q.eq('automation_id', a.id).eq('status', 'active').eq('current_step_index', i));
      stepInfos.push({
        index: i, label: _stepLabel(steps[i], i), type: String(steps[i]?.type || ''),
        accent: _stepAccent(steps[i]), count: r.count, error: r.error,
      });
    }
    perAuto[a.id] = { name: a.name, enabled: a.enabled, trigger_type: a.trigger_type, steps: stepInfos };
  }
  return { autos: autos.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, trigger_type: a.trigger_type })), perAuto };
}

async function buildCall() {
  // follow_up_appointments waar scheduled + toekomst.
  const base = (q) => q.eq('status', 'scheduled').gt('scheduled_at', new Date().toISOString());
  const buckets = {};
  buckets['bevestigd']       = await safeCountAndRows('follow_up_appointments', (q) => base(q).not('bevestigd_at', 'is', null).order('bevestigd_at', { ascending: false }), '*');
  buckets['bev_verstuurd']   = await safeCountAndRows('follow_up_appointments', (q) => base(q).not('bevestiging_sent_at', 'is', null).is('bevestigd_at', null).order('bevestiging_sent_at', { ascending: true }), '*');
  buckets['reminder_24u']    = await safeCountAndRows('follow_up_appointments', (q) => base(q).not('reminder_24u_at', 'is', null).is('reminder_2u_at', null).order('reminder_24u_at', { ascending: true }), '*');
  buckets['reminder_2u']     = await safeCountAndRows('follow_up_appointments', (q) => base(q).not('reminder_2u_at', 'is', null).is('reminder_30m_at', null).order('reminder_2u_at', { ascending: true }), '*');
  buckets['reminder_30m']    = await safeCountAndRows('follow_up_appointments', (q) => base(q).not('reminder_30m_at', 'is', null).order('reminder_30m_at', { ascending: true }), '*');
  return { buckets };
}

async function buildNoshow() {
  // No-show signals + 14d future-call-reminder.
  const signals = {};
  signals['open']              = await safeCountAndRows('student_signals', (q) => q.eq('type', 'no_show').eq('status', 'open').order('created_at', { ascending: false }), '*');
  signals['opnieuw_opvolgen']  = await safeCountAndRows('student_signals', (q) => q.eq('type', 'no_show').eq('status', 'opnieuw_opvolgen').order('created_at', { ascending: false }), '*');
  signals['afgehandeld']       = await safeCountAndRows('student_signals', (q) => q.eq('type', 'no_show').eq('status', 'afgehandeld').order('created_at', { ascending: false }), '*');
  signals['reden_ontbreekt']   = await safeCountAndRows('student_signals', (q) => q.eq('type', 'no_show').is('reason_given_at', null).order('created_at', { ascending: false }), '*');

  // 14d-window onboardings.
  const today = new Date().toISOString().slice(0, 10);
  const in14d = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const window14 = {};
  const baseWin = (q) => q.gte('start_date', today).lte('start_date', in14d).not('mentor_user_id', 'is', null).neq('status', 'gearchiveerd');
  window14['openstaand']    = await safeCountAndRows('onboardings', (q) => baseWin(q).is('first_call_reminder_task_at', null).order('start_date', { ascending: true }), '*');
  window14['taak_aangemaakt'] = await safeCountAndRows('onboardings', (q) => baseWin(q).not('first_call_reminder_task_at', 'is', null).order('first_call_reminder_task_at', { ascending: false }), '*');

  return { signals, window14, today, in14d };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'automatiseringen.module.view');
  if (!allowed) {
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
    allowed = !!prof && prof.is_active && prof.role === 'super_admin';
  }
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (automatiseringen.module.view)' });

  const flow = String(req.query?.flow || '').toLowerCase();
  const builders = {
    lisa: buildLisa,
    bulk: buildBulk,
    drip: buildDrip,
    belronde: buildBelronde,
    events: buildEvents,
    onboarding: buildOnboarding,
    events_steps:      buildEventsSteps,
    onboarding_steps:  buildOnboardingSteps,
    call:              buildCall,
    noshow:            buildNoshow,
  };
  const fn = builders[flow];
  if (!fn) return res.status(400).json({ error: 'flow moet één van zijn: ' + Object.keys(builders).join(', ') });

  try {
    const payload = await fn();
    return res.status(200).json({ ok: true, generated_at: new Date().toISOString(), flow, ...payload });
  } catch (e) {
    console.error('[flow-drilldown-overview] ' + flow + ' fail:', e?.message || e);
    return res.status(500).json({ ok: false, flow, error: e?.message || String(e) });
  }
}
