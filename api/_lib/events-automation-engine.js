// api/_lib/events-automation-engine.js
// De motor achter de events-automations: enrollment (trigger->scope->enroll_mode)
// en de stepper (wait plant door, condition vertakt, send_email/send_whatsapp
// via events-send). At-most-once per stap via event_automation_run_log.
// Pure helpers (computeNextRunAt/evaluateCondition/advanceRun) zijn geexporteerd
// en DB-/netwerk-vrij zodat de hele staploop offline getest kan worden.

import { supabaseAdmin } from '../supabase.js';
import { sendEventEmail, sendEventWhatsAppTemplate } from './events-send.js';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const MAX_SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60_000;

// ── Pure helpers ────────────────────────────────────────────────────────────

export function computeNextRunAt(waitConfig, fromMs) {
  const amount = Number(waitConfig && waitConfig.amount);
  const unit = waitConfig && waitConfig.unit;
  const ms = UNIT_MS[unit];
  if (!Number.isFinite(amount) || amount < 0 || !ms) return new Date(fromMs);
  return new Date(fromMs + amount * ms);
}

export function buildConditionState(attendee) {
  const status = attendee && attendee.status;
  return {
    assessment_completed: !!(attendee && attendee.assessment_response_id),
    status,
    still_registered: status !== 'switched_to_other_event' && status !== 'no_show',
  };
}

export function evaluateCondition(check, state) {
  switch (check) {
    case 'assessment_completed':     return state.assessment_completed === true;
    case 'assessment_not_completed': return state.assessment_completed === false;
    case 'still_registered':         return state.still_registered === true;
    default:                         return true; // onbekende check blokkeert niet
  }
}

/**
 * Verwerkt zoveel mogelijk stappen voor EEN run in een begrensde loop.
 * deps = { isStepDone(idx)->bool, recordLog(idx,type,result), sendEmail(step,ctx), sendWhatsApp(step,ctx) }
 * Returnt de nieuwe run-velden (geen DB-write hier).
 */
export async function advanceRun({ run, attendee, event, now = new Date(), deps, maxIterations = 25 }) {
  const steps = Array.isArray(run.steps_snapshot) ? run.steps_snapshot : [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let idx = run.current_step_index || 0;
  let status = 'active';
  let nextRunAt = null;
  let attempts = run.attempts || 0;
  let lastError = run.last_error || null;

  for (let i = 0; i < maxIterations; i++) {
    if (idx >= steps.length) { status = 'completed'; nextRunAt = null; break; }
    const step = steps[idx] || {};
    const type = step.type;

    if (type === 'wait') {
      nextRunAt = computeNextRunAt(step.config, nowMs);
      idx += 1; attempts = 0; status = 'active';
      break; // wait persisteren; engine hervat bij volgende due-tick
    }

    if (type === 'condition') {
      const state = buildConditionState(attendee);
      const pass = evaluateCondition(step.config && step.config.check, state);
      await deps.recordLog(idx, 'condition', { ok: true, pass, check: step.config && step.config.check });
      if (pass) { idx += 1; attempts = 0; continue; }
      const onFail = (step.config && step.config.on_fail) || 'exit';
      if (onFail === 'skip_to_end') { idx = steps.length; continue; }
      status = 'exited'; nextRunAt = null;
      break;
    }

    if (type === 'send_email' || type === 'send_whatsapp') {
      if (await deps.isStepDone(idx)) { idx += 1; attempts = 0; continue; }
      let result;
      try {
        result = type === 'send_email'
          ? await deps.sendEmail(step, { attendee, event })
          : await deps.sendWhatsApp(step, { attendee, event });
      } catch (e) {
        result = { ok: false, error: (e && e.message) || 'send threw' };
      }
      if (result && result.ok) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; lastError = null; continue;
      }
      if (result && result.skipped) { // bv. no-phone / template niet APPROVED → finaliseer, niet retryen
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; continue;
      }
      attempts += 1;
      lastError = (result && result.error) || 'send failed';
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await deps.recordLog(idx, type, { ok: false, error: lastError, gave_up: true });
        idx += 1; attempts = 0; continue;
      }
      nextRunAt = new Date(nowMs + RETRY_BACKOFF_MS); // retry zelfde stap
      break;
    }

    // onbekend staptype → log skip + door
    await deps.recordLog(idx, type || 'unknown', { ok: true, skipped: true, reason: 'unknown-step-type' });
    idx += 1; attempts = 0;
  }

  return {
    current_step_index: idx,
    status,
    next_run_at: nextRunAt,
    attempts,
    last_error: lastError,
    completed_at: status === 'completed' ? new Date(nowMs) : (run.completed_at || null),
  };
}

// ── Enrollment ──────────────────────────────────────────────────────────────

async function loadCandidatesForAutomation(auto, now) {
  const nowIso = now.toISOString();

  // Bepaal toegestane event_ids o.b.v. scope (+ time_before_event-window).
  // null = geen event-id-restrictie (scope 'all').
  let allowedEventIds = null;
  if (auto.scope_type === 'niveau' && auto.scope_config && auto.scope_config.niveau) {
    const { data: evs, error } = await supabaseAdmin
      .from('events').select('id').eq('niveau', auto.scope_config.niveau);
    if (error) throw new Error('candidates niveau-events: ' + error.message);
    allowedEventIds = (evs || []).map((e) => e.id);
  } else if (auto.scope_type === 'events' && Array.isArray(auto.scope_config && auto.scope_config.event_ids)) {
    allowedEventIds = auto.scope_config.event_ids;
  }

  if (auto.trigger_type === 'time_before_event') {
    const hours = Number(auto.trigger_config && auto.trigger_config.hours_before) || 0;
    const upper = new Date(now.getTime() + hours * 3_600_000).toISOString();
    const { data: evs, error } = await supabaseAdmin
      .from('events').select('id').gt('starts_at', nowIso).lte('starts_at', upper);
    if (error) throw new Error('candidates window-events: ' + error.message);
    const windowIds = (evs || []).map((e) => e.id);
    allowedEventIds = (allowedEventIds == null)
      ? windowIds
      : allowedEventIds.filter((id) => windowIds.includes(id));
  }

  // Lege scope/window → geen kandidaten.
  if (allowedEventIds != null && allowedEventIds.length === 0) return [];

  let q = supabaseAdmin
    .from('event_attendees')
    .select('id, event_id, registered_at, assessment_response_id, assessment_linked_at, status')
    .limit(500);
  if (allowedEventIds != null) q = q.in('event_id', allowedEventIds);

  const newOnly = auto.enroll_mode === 'new_only' && auto.enabled_at;
  if (auto.trigger_type === 'on_signup') {
    if (newOnly) q = q.gte('registered_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_assessment_completed') {
    q = q.not('assessment_response_id', 'is', null);
    if (newOnly) q = q.gte('assessment_linked_at', auto.enabled_at);
  } else if (auto.trigger_type === 'time_before_event') {
    if (newOnly) q = q.gte('registered_at', auto.enabled_at);
  } else {
    return [];
  }

  const { data, error } = await q;
  if (error) throw new Error('candidates: ' + error.message);
  return data || [];
}

export async function enrollDueAttendees({ now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const summary = { automations: 0, enrolled: 0, perAutomation: [] };

  const { data: autos, error } = await supabaseAdmin
    .from('event_automations')
    .select('id, trigger_type, trigger_config, scope_type, scope_config, enroll_mode, enabled_at, steps')
    .eq('enabled', true);
  if (error) throw new Error('enroll: load automations: ' + error.message);
  summary.automations = (autos || []).length;

  for (const auto of (autos || [])) {
    try {
      const candidates = await loadCandidatesForAutomation(auto, now);
      // reeds-ingeschreven attendee_ids voor deze automation
      const { data: existingRows } = await supabaseAdmin
        .from('event_automation_runs')
        .select('attendee_id')
        .eq('automation_id', auto.id);
      const existing = new Set((existingRows || []).map((r) => r.attendee_id));
      const toEnroll = candidates.filter((c) => !existing.has(c.id)).slice(0, 200);

      let enrolled = 0;
      for (const att of toEnroll) {
        const { data, error: insErr } = await supabaseAdmin
          .from('event_automation_runs')
          .insert({
            automation_id: auto.id,
            attendee_id: att.id,
            event_id: att.event_id,
            status: 'active',
            current_step_index: 0,
            next_run_at: nowIso,
            steps_snapshot: auto.steps || [],
            context: {},
          })
          .select('id')
          .maybeSingle();
        if (insErr) {
          if (insErr.code !== '23505') console.error('[events-automation enroll] insert:', insErr.message);
          continue;
        }
        if (data) enrolled += 1;
      }
      summary.enrolled += enrolled;
      summary.perAutomation.push({ id: auto.id, trigger: auto.trigger_type, candidates: candidates.length, enrolled });
    } catch (e) {
      console.error('[events-automation enroll] automation', auto.id, e.message);
      summary.perAutomation.push({ id: auto.id, error: e.message });
    }
  }
  return summary;
}

// ── Stepper ───────────────────────────────────────────────────────────────

export async function stepDueRuns({ now = new Date(), limit = 100, abortMs = 50_000 } = {}) {
  const startMs = Date.now();
  const nowIso = now.toISOString();
  const summary = { processed: 0, completed: 0, exited: 0, cancelled: 0 };

  const { data: runs, error } = await supabaseAdmin
    .from('event_automation_runs')
    .select('*')
    .eq('status', 'active')
    .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`)
    .order('next_run_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error('step: load runs: ' + error.message);

  for (const run of (runs || [])) {
    if (Date.now() - startMs > abortMs) break;
    try {
      const { data: attendee } = await supabaseAdmin
        .from('event_attendees')
        .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id, status, assessment_response_id')
        .eq('id', run.attendee_id)
        .maybeSingle();
      if (!attendee) {
        await supabaseAdmin.from('event_automation_runs')
          .update({ status: 'cancelled', next_run_at: null, last_error: 'attendee gone', updated_at: nowIso })
          .eq('id', run.id);
        summary.cancelled += 1;
        continue;
      }
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at, ends_at, location, niveau, capacity, status')
        .eq('id', attendee.event_id)
        .maybeSingle();

      const deps = {
        isStepDone: async (idx) => {
          const { data } = await supabaseAdmin
            .from('event_automation_run_log')
            .select('id').eq('run_id', run.id).eq('step_index', idx).maybeSingle();
          return !!data;
        },
        recordLog: async (idx, stepType, result) => {
          const { error: e } = await supabaseAdmin
            .from('event_automation_run_log')
            .insert({ run_id: run.id, step_index: idx, step_type: stepType, result });
          if (e && e.code !== '23505') console.error('[events-automation log]', e.message);
        },
        sendEmail: (step, ctx) => sendEventEmail({
          attendee: ctx.attendee, event: ctx.event,
          subject: step.config && step.config.subject, body: step.config && step.config.body,
        }),
        sendWhatsApp: (step, ctx) => sendEventWhatsAppTemplate({
          attendee: ctx.attendee, event: ctx.event,
          templateName: step.config && step.config.template_name, sentByUserId: null,
        }),
      };

      const u = await advanceRun({ run, attendee, event, now, deps });
      await supabaseAdmin.from('event_automation_runs').update({
        current_step_index: u.current_step_index,
        status: u.status,
        next_run_at: u.next_run_at ? new Date(u.next_run_at).toISOString() : null,
        attempts: u.attempts,
        last_error: u.last_error,
        completed_at: u.completed_at ? new Date(u.completed_at).toISOString() : null,
        updated_at: nowIso,
      }).eq('id', run.id);

      summary.processed += 1;
      if (u.status === 'completed') summary.completed += 1;
      if (u.status === 'exited') summary.exited += 1;
    } catch (e) {
      console.error('[events-automation step] run', run.id, e.message);
      try {
        await supabaseAdmin.from('event_automation_runs')
          .update({ last_error: e.message, updated_at: nowIso }).eq('id', run.id);
      } catch {}
    }
  }
  return summary;
}
