// api/_lib/onboarding-automation-engine.js
//
// Port van api/_lib/events-automation-engine.js naar onboarding-context.
// Bevat:
//   - enrollDueOnboardings({now})  — cron-poll voor time-based triggers +
//     catch-up voor hook-driven triggers (on_onboarding_created /
//     on_wizard_completed) wanneer een hook gemist is.
//   - enrollForTrigger({onboardingId, triggerType})  — direct geënroleerd
//     vanuit hooks in onboarding-create.js / onboarding-complete.js
//     (instant — geen wait op de minuut-cron).
//   - stepDueRuns({now})  — stepper voor active runs (wait/condition/send/etc).
//
// Pure helpers (computeNextRunAt / evaluateCondition / advanceRun) zijn
// geexporteerd en DB-/netwerk-vrij zodat de hele staploop offline getest
// kan worden.
//
// Stap-types Fase 1:
//   - wait                            (amount + unit minutes|hours|days)
//   - condition                       (5 checks; on_fail = exit|skip_to_end)
//   - send_email                      (subject + body)
//   - send_whatsapp                   (template_name; APPROVED-gate)
//   - update_onboarding_status        (new_status; idempotent)
//   - send_internal_notification      (subject + body; optionele to_email)
//
// Condities Fase 1:
//   - wizard_not_started   — status === 'aangemeld' EN current_step==0 EN answers leeg
//   - wizard_completed     — status === 'afgerond'
//   - no_inbound           — geen inbound message op de onboarding-lijn voor deze klant
//   - traject_is_1op1      — traject.type === '1op1'
//   - traject_is_membership — traject.type === 'membership'

import { supabaseAdmin } from '../supabase.js';
import { sendOnboardingTemplateGeneric } from './onboarding-template-send.js';
import { sendMail, sendOnboardingMail } from '../mailer.js';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const MAX_SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60_000;
const ONBOARDING_STATUSES = ['aangemeld','bezig','afgerond','gearchiveerd'];

// Fase 3b automation-tester — test-runs (run.is_test=true) versnellen wait-
// stappen naar deze duur ongeacht waitConfig.unit/amount. 15s = lang genoeg
// dat de engine z'n DB-write doet en weer wordt opgepikt door de eerstvolgende
// cron-tick, kort genoeg dat de hele flow in minuten te doorlopen is.
// Mirror van events-automation-engine.js TEST_WAIT_MS.
const TEST_WAIT_MS = 15 * 1000;

// ── Pure helpers ────────────────────────────────────────────────────────────

export function computeNextRunAt(waitConfig, fromMs) {
  const amount = Number(waitConfig && waitConfig.amount);
  const unit = waitConfig && waitConfig.unit;
  const ms = UNIT_MS[unit];
  if (!Number.isFinite(amount) || amount < 0 || !ms) return new Date(fromMs);
  return new Date(fromMs + amount * ms);
}

export function isWizardStarted(ob) {
  if (!ob) return false;
  if (ob.status && ob.status !== 'aangemeld') return true;
  if (Number.isFinite(Number(ob.current_step)) && Number(ob.current_step) > 0) return true;
  if (ob.answers && typeof ob.answers === 'object' && Object.keys(ob.answers).length > 0) return true;
  return false;
}

export function buildConditionState(onboarding, traject, extras) {
  const trajectType = (traject && typeof traject.type === 'string')
    ? traject.type.trim().toLowerCase() : '';
  return {
    wizard_not_started:  !isWizardStarted(onboarding),
    wizard_completed:    onboarding && onboarding.status === 'afgerond',
    no_inbound:          !!(extras && extras.no_inbound === true),
    invoice_unpaid:      !!(extras && extras.invoice_unpaid === true),
    traject_is_1op1:       trajectType === '1op1',
    traject_is_membership: trajectType === 'membership',
  };
}

export function evaluateCondition(check, state) {
  switch (check) {
    case 'wizard_not_started':     return state.wizard_not_started === true;
    case 'wizard_completed':       return state.wizard_completed === true;
    case 'no_inbound':              return state.no_inbound === true;
    case 'invoice_unpaid':         return state.invoice_unpaid === true;
    case 'traject_is_1op1':         return state.traject_is_1op1 === true;
    case 'traject_is_membership':   return state.traject_is_membership === true;
    default:                        return true;
  }
}

/**
 * Verwerkt zoveel mogelijk stappen voor EEN run in een begrensde loop.
 * deps = { isStepDone(idx)->bool, recordLog(idx,type,result), sendEmail(step,ctx),
 *          sendWhatsApp(step,ctx), updateOnboardingStatus(step,ctx),
 *          sendInternalNotification(step,ctx), conditionState }
 * Returnt de nieuwe run-velden (geen DB-write hier).
 */
export async function advanceRun({ run, onboarding, traject, conditionState, now = new Date(), deps, maxIterations = 25 }) {
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
      // Fase 3b — test-runs versnellen elke wait naar TEST_WAIT_MS. Override
      // gebeurt NA computeNextRunAt zodat de pure helper unit-testbaar blijft
      // zonder is_test-context.
      if (run.is_test === true) {
        nextRunAt = new Date(nowMs + TEST_WAIT_MS);
      }
      idx += 1; attempts = 0; status = 'active';
      break;
    }

    if (type === 'condition') {
      const pass = evaluateCondition(step.config && step.config.check, conditionState || {});
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
          ? await deps.sendEmail(step, { onboarding, traject, stepIndex: idx })
          : await deps.sendWhatsApp(step, { onboarding, traject, stepIndex: idx });
      } catch (e) {
        result = { ok: false, error: (e && e.message) || 'send threw' };
      }
      if (result && result.ok) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; lastError = null; continue;
      }
      if (result && (result.skipped || result.permanent)) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; continue;
      }
      attempts += 1;
      lastError = (result && result.error) || 'send failed';
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await deps.recordLog(idx, type, { ok: false, error: lastError, gave_up: true });
        idx += 1; attempts = 0; continue;
      }
      nextRunAt = new Date(nowMs + RETRY_BACKOFF_MS);
      break;
    }

    if (type === 'update_onboarding_status' || type === 'send_internal_notification') {
      if (await deps.isStepDone(idx)) { idx += 1; attempts = 0; continue; }
      let result;
      try {
        if (type === 'update_onboarding_status') {
          result = await deps.updateOnboardingStatus(step, { onboarding, traject, stepIndex: idx });
        } else {
          result = await deps.sendInternalNotification(step, { onboarding, traject, stepIndex: idx });
        }
      } catch (e) {
        result = { ok: false, error: (e && e.message) || 'step threw' };
      }
      if (result && result.ok) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; lastError = null; continue;
      }
      if (result && result.skipped) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; continue;
      }
      await deps.recordLog(idx, type, { ok: false, error: (result && result.error) || 'step failed' });
      idx += 1; attempts = 0; continue;
    }

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

  let q = supabaseAdmin
    .from('onboardings')
    .select('id, status, created_at, completed_at, automation_enabled, archived_at, customer_id')
    .eq('automation_enabled', true)
    // Fase 3b — test-onboardings (is_test=true) krijgen hun runs direct
    // ingeschoten door /api/onboarding-automation-test. De candidate-poll
    // mag ze daarom NIET oppakken voor andere automations (anders schiet
    // elke enabled automation sends naar het test-contact).
    .eq('is_test', false)
    .is('archived_at', null)
    .limit(500);

  const newOnly = auto.enroll_mode === 'new_only' && auto.enabled_at;

  if (auto.trigger_type === 'on_onboarding_created') {
    if (newOnly) q = q.gte('created_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_wizard_completed') {
    q = q.eq('status', 'afgerond').not('completed_at', 'is', null);
    if (newOnly) q = q.gte('completed_at', auto.enabled_at);
  } else if (auto.trigger_type === 'time_after_signup') {
    const cfg = auto.trigger_config || {};
    const hours = Number(cfg.hours_after_signup);
    const days  = Number(cfg.days_after_signup);
    let totalHours = 0;
    if (Number.isFinite(hours) && hours > 0) totalHours += hours;
    if (Number.isFinite(days) && days > 0)   totalHours += days * 24;
    if (totalHours <= 0) return [];
    const cutoff = new Date(now.getTime() - totalHours * 3_600_000).toISOString();
    q = q.lte('created_at', cutoff);
    if (newOnly) q = q.gte('created_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_wizard_not_started_after') {
    const cfg = auto.trigger_config || {};
    const hours = Number(cfg.hours_after_signup);
    const days  = Number(cfg.days_after_signup);
    let totalHours = 0;
    if (Number.isFinite(hours) && hours > 0) totalHours += hours;
    if (Number.isFinite(days) && days > 0)   totalHours += days * 24;
    if (totalHours <= 0) return [];
    const cutoff = new Date(now.getTime() - totalHours * 3_600_000).toISOString();
    // Wizard niet gestart: status='aangemeld' EN (current_step is null or 0) EN answers leeg.
    // Voorfilter op status; current_step + answers check doen we in JS (jsonb-emptiness is
    // lastig server-side).
    q = q
      .eq('status', 'aangemeld')
      .lte('created_at', cutoff);
    if (newOnly) q = q.gte('created_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_first_call_in') {
    const cfg = auto.trigger_config || {};
    const days = Number(cfg.days_before_call);
    if (!Number.isFinite(days) || days < 0) return [];
    const target   = new Date(now); target.setDate(target.getDate() + days);
    const dayStart = new Date(target); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(target); dayEnd.setHours(23, 59, 59, 999);
    const { data: dls, error: dErr } = await supabaseAdmin
      .from('deals')
      .select('customer_id')
      .not('first_call_at', 'is', null)
      .gte('first_call_at', dayStart.toISOString())
      .lte('first_call_at', dayEnd.toISOString());
    if (dErr) throw new Error('first_call deals: ' + dErr.message);
    const custIds = [...new Set((dls || []).map((d) => d.customer_id).filter(Boolean))];
    if (!custIds.length) return [];
    q = q.in('customer_id', custIds);
    if (newOnly) q = q.gte('created_at', auto.enabled_at);
  } else {
    return [];
  }

  const { data, error } = await q;
  if (error) throw new Error('candidates: ' + error.message);

  let rows = data || [];

  // Voor on_wizard_not_started_after: nog JS-filter op current_step + answers
  // (we hebben ze nodig om de "is wizard echt nog niet gestart"-check te doen).
  if (auto.trigger_type === 'on_wizard_not_started_after') {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const { data: extra, error: exErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, current_step, answers')
      .in('id', ids);
    if (exErr) throw new Error('candidates extra: ' + exErr.message);
    const extraById = new Map((extra || []).map((r) => [r.id, r]));
    rows = rows.filter((r) => {
      const e = extraById.get(r.id) || {};
      return !isWizardStarted({ status: r.status, current_step: e.current_step, answers: e.answers });
    });
  }

  return rows;
}

async function enrollOnce(auto, onboarding, nowIso) {
  const { data, error } = await supabaseAdmin
    .from('onboarding_automation_runs')
    .insert({
      automation_id:      auto.id,
      onboarding_id:      onboarding.id,
      status:             'active',
      current_step_index: 0,
      next_run_at:        nowIso,
      steps_snapshot:     auto.steps || [],
      context:            {},
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return { ok: true, dup: true };
    return { ok: false, error: error.message };
  }
  return { ok: true, dup: false, id: data?.id || null };
}

/**
 * Direct-enroll voor hook-driven triggers (on_onboarding_created /
 * on_wizard_completed). Fail-soft: throws nooit. Caller checkt summary.
 */
export async function enrollForTrigger({ onboardingId, triggerType, now = new Date() } = {}) {
  const summary = { trigger: triggerType, onboarding_id: onboardingId, enrolled: 0, errors: [] };
  if (!onboardingId) { summary.error = 'no-onboarding-id'; return summary; }
  if (!['on_onboarding_created','on_wizard_completed'].includes(triggerType)) {
    summary.error = 'invalid-trigger';
    return summary;
  }

  try {
    // Onboarding loaden + automation_enabled-gate.
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, automation_enabled, archived_at')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) { summary.error = 'db-error: ' + obErr.message; return summary; }
    if (!ob)   { summary.error = 'onboarding-not-found'; return summary; }
    if (ob.archived_at)        { summary.error = 'archived'; return summary; }
    if (ob.automation_enabled === false) { summary.error = 'automation-disabled-for-onboarding'; return summary; }

    const { data: autos, error: aErr } = await supabaseAdmin
      .from('onboarding_automations')
      .select('id, trigger_type, trigger_config, enroll_mode, enabled_at, steps')
      .eq('enabled', true)
      .eq('trigger_type', triggerType);
    if (aErr) { summary.error = 'automations-load: ' + aErr.message; return summary; }

    const nowIso = now.toISOString();
    for (const auto of (autos || [])) {
      try {
        const r = await enrollOnce(auto, ob, nowIso);
        if (r.ok && !r.dup) summary.enrolled += 1;
        if (!r.ok) summary.errors.push({ automation_id: auto.id, error: r.error });
      } catch (e) {
        summary.errors.push({ automation_id: auto.id, error: e?.message || 'enroll threw' });
      }
    }
  } catch (e) {
    summary.error = 'fatal: ' + (e?.message || e);
  }

  return summary;
}

/**
 * Cron-poll voor time-based triggers + catch-up van hook-driven triggers
 * (mocht een hook gemist zijn). Fail-soft per automation.
 */
export async function enrollDueOnboardings({ now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const summary = { automations: 0, enrolled: 0, perAutomation: [] };

  const { data: autos, error } = await supabaseAdmin
    .from('onboarding_automations')
    .select('id, trigger_type, trigger_config, enroll_mode, enabled_at, steps')
    .eq('enabled', true);
  if (error) throw new Error('enroll: load automations: ' + error.message);
  summary.automations = (autos || []).length;

  for (const auto of (autos || [])) {
    try {
      const candidates = await loadCandidatesForAutomation(auto, now);

      // Bestaande runs voor deze automation om duplicates te skippen.
      const { data: existingRows } = await supabaseAdmin
        .from('onboarding_automation_runs')
        .select('onboarding_id')
        .eq('automation_id', auto.id);
      const existing = new Set((existingRows || []).map((r) => r.onboarding_id));

      const toEnroll = candidates.filter((c) => !existing.has(c.id)).slice(0, 200);

      let enrolled = 0;
      for (const ob of toEnroll) {
        const r = await enrollOnce(auto, ob, nowIso);
        if (r.ok && !r.dup) enrolled += 1;
        if (!r.ok) console.error('[onboarding-automation enroll] insert:', r.error);
      }
      summary.enrolled += enrolled;
      summary.perAutomation.push({ id: auto.id, trigger: auto.trigger_type, candidates: candidates.length, enrolled });
    } catch (e) {
      console.error('[onboarding-automation enroll] automation', auto.id, e.message);
      summary.perAutomation.push({ id: auto.id, error: e.message });
    }
  }
  return summary;
}

// ── Stepper ────────────────────────────────────────────────────────────────

async function loadInboundContext(onboarding) {
  // no_inbound-conditie: kijk naar whatsapp_conversations op de onboarding-
  // lijn voor deze klant; als er geen last_inbound_at is, geldt no_inbound=true.
  try {
    if (!onboarding?.customer_id) return { no_inbound: true };
    const { data: modCfg } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'onboarding')
      .eq('is_active', true)
      .maybeSingle();
    if (!modCfg?.phone_number_id) return { no_inbound: true };
    const { data: cust } = await supabaseAdmin
      .from('customers')
      .select('phone')
      .eq('id', onboarding.customer_id)
      .maybeSingle();
    const digits = String(cust?.phone || '').replace(/\D/g, '');
    if (!digits || digits.length < 8) return { no_inbound: true };
    const phonePlus = '+' + digits;
    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, last_inbound_at')
      .eq('phone_number', phonePlus)
      .eq('phone_number_id', modCfg.phone_number_id)
      .maybeSingle();
    return { no_inbound: !conv || !conv.last_inbound_at };
  } catch {
    return { no_inbound: true };
  }
}

async function loadInvoiceUnpaidContext(onboarding) {
  try {
    if (!onboarding?.customer_id) return { invoice_unpaid: false }; // niet bepaalbaar → niet vuren
    const { data: paid } = await supabaseAdmin
      .from('invoices')
      .select('id')
      .eq('customer_id', onboarding.customer_id)
      .eq('status', 'paid')
      .limit(1)
      .maybeSingle();
    return { invoice_unpaid: !paid };
  } catch {
    return { invoice_unpaid: false };
  }
}

export async function stepDueRuns({ now = new Date(), limit = 100, abortMs = 50_000 } = {}) {
  const startMs = Date.now();
  const nowIso = now.toISOString();
  const summary = { processed: 0, completed: 0, exited: 0, cancelled: 0 };

  const { data: runs, error } = await supabaseAdmin
    .from('onboarding_automation_runs')
    .select('*')
    .eq('status', 'active')
    .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`)
    .order('next_run_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error('step: load runs: ' + error.message);

  for (const run of (runs || [])) {
    if (Date.now() - startMs > abortMs) break;
    try {
      const { data: onboarding } = await supabaseAdmin
        .from('onboardings')
        .select('id, customer_id, traject_id, status, current_step, answers, archived_at, token')
        .eq('id', run.onboarding_id)
        .maybeSingle();
      if (!onboarding) {
        await supabaseAdmin.from('onboarding_automation_runs')
          .update({ status: 'cancelled', next_run_at: null, last_error: 'onboarding gone', updated_at: nowIso })
          .eq('id', run.id);
        summary.cancelled += 1;
        continue;
      }
      if (onboarding.archived_at) {
        await supabaseAdmin.from('onboarding_automation_runs')
          .update({ status: 'cancelled', next_run_at: null, last_error: 'archived', updated_at: nowIso })
          .eq('id', run.id);
        summary.cancelled += 1;
        continue;
      }

      let traject = null;
      if (onboarding.traject_id) {
        const { data: tr } = await supabaseAdmin
          .from('onboarding_trajecten')
          .select('id, label, type')
          .eq('id', onboarding.traject_id)
          .maybeSingle();
        traject = tr || null;
      }

      const inboundCtx = await loadInboundContext(onboarding);
      const invoiceCtx = await loadInvoiceUnpaidContext(onboarding);
      const conditionState = buildConditionState(onboarding, traject, { ...inboundCtx, ...invoiceCtx });

      const deps = {
        isStepDone: async (idx) => {
          const { data } = await supabaseAdmin
            .from('onboarding_automation_run_log')
            .select('id').eq('run_id', run.id).eq('step_index', idx).maybeSingle();
          return !!data;
        },
        recordLog: async (idx, stepType, result) => {
          const { error: e } = await supabaseAdmin
            .from('onboarding_automation_run_log')
            .insert({ run_id: run.id, step_index: idx, step_type: stepType, result });
          if (e && e.code !== '23505') console.error('[onboarding-automation log]', e.message);
        },
        sendEmail: async (step, _ctx) => {
          const subject = step?.config?.subject;
          const body    = step?.config?.body;
          if (!subject || !body) return { ok: false, error: 'subject + body verplicht', permanent: true };
          // Email-adres: customer.email opzoeken.
          const { data: cust } = await supabaseAdmin
            .from('customers')
            .select('email, first_name, last_name')
            .eq('id', onboarding.customer_id)
            .maybeSingle();
          const to = cust?.email;
          if (!to) return { ok: false, error: 'geen e-mailadres', skipped: true };
          try {
            // Simple variable-resolve: {{klant.voornaam}}, {{onboarding.wizard_link}}
            const wizardLink = onboarding.token
              ? `https://forex-opleiding-interface.vercel.app/modules/onboarding.html?t=${encodeURIComponent(onboarding.token)}`
              : '';
            const replacements = {
              '{{klant.voornaam}}':         String(cust?.first_name || '').trim(),
              '{{klant.achternaam}}':        String(cust?.last_name  || '').trim(),
              '{{klant.email}}':             String(cust?.email      || '').trim(),
              '{{onboarding.wizard_link}}':  wizardLink,
            };
            let subj = String(subject), bod = String(body);
            for (const [k, v] of Object.entries(replacements)) {
              subj = subj.split(k).join(v);
              bod  = bod.split(k).join(v);
            }
            // sendOnboardingMail = eigen onboarding@-transport (auth = onboarding@).
            // Veilige fallback naar info@ als ONBOARDING_MAIL_PASS ontbreekt;
            // de send_internal_notification-tak hieronder blijft op sendMail
            // (info@) want dat is interne team-mail, geen klant-mail.
            const result = await sendOnboardingMail({
              to,
              subject: subj,
              text:    bod,
              html:    `<p>${bod.replace(/\n/g, '<br>')}</p>`,
            });
            if (result && result.ok === false) {
              return { ok: false, error: result.error || 'mail failed' };
            }
            return { ok: true, to };
          } catch (e) {
            return { ok: false, error: e?.message || 'mail threw' };
          }
        },
        sendWhatsApp: async (step, _ctx) => {
          const templateName = step?.config?.template_name;
          if (!templateName) return { ok: false, error: 'template_name verplicht', permanent: true };
          const result = await sendOnboardingTemplateGeneric({
            onboardingId: onboarding.id,
            templateName,
            languageCode: step?.config?.language || 'nl',
            source:       'automation',
            sentByUserId: null,
            auditAction:  'onboarding.automation.template.sent',
          });
          if (result?.sent === true) return { ok: true, meta_wamid: result.meta_wamid || null };
          // Niet-recover-baar (skipped / no-phone / template-niet-approved) → permanent.
          const permReasons = new Set([
            'geen-telefoon','no-token','customer-not-found','no-customer',
            'template-niet-gevonden','template-niet-approved','geen-module-config',
            'meta-niet-geconfigureerd','archived','not-found',
          ]);
          if (result?.reason && permReasons.has(result.reason)) {
            return { ok: false, error: result.error || result.reason, permanent: true, skipped: true };
          }
          return { ok: false, error: result?.error || result?.reason || 'send failed' };
        },
        updateOnboardingStatus: async (step, _ctx) => {
          const newStatus = step?.config?.new_status;
          if (!newStatus) return { ok: false, error: 'new_status ontbreekt' };
          if (!ONBOARDING_STATUSES.includes(newStatus)) {
            return { ok: false, error: 'new_status ongeldig' };
          }
          if (onboarding.status === newStatus) {
            return { ok: true, skipped: true, reason: 'already-status' };
          }
          try {
            const { error: e } = await supabaseAdmin
              .from('onboardings')
              .update({ status: newStatus, updated_at: nowIso })
              .eq('id', onboarding.id);
            if (e) return { ok: false, error: e.message };
            return { ok: true, new_status: newStatus, previous_status: onboarding.status };
          } catch (e) {
            return { ok: false, error: e?.message || 'status-update failed' };
          }
        },
        sendInternalNotification: async (step) => {
          const subject = step?.config?.subject;
          const body    = step?.config?.body;
          if (!subject || !body) return { ok: false, error: 'subject + body verplicht' };
          const to = step?.config?.to_email
            || process.env.INTERNAL_NOTIFICATION_EMAIL
            || 'jeffrey@deforexopleiding.nl';
          try {
            const ctxLine = `[Onboarding ${onboarding.id} · status ${onboarding.status}]`;
            const result = await sendMail({
              to,
              subject: '[INTERNAL] ' + subject,
              text:    body + '\n\n' + ctxLine,
              html:    `<p>${String(body).replace(/\n/g, '<br>')}</p><hr><p style="color:#888;font-size:12px">${ctxLine}</p>`,
            });
            if (result && result.ok === false) {
              return { ok: false, error: result.error || 'mail failed' };
            }
            return { ok: true, to };
          } catch (e) {
            return { ok: false, error: e?.message || 'internal-notification failed' };
          }
        },
      };

      const u = await advanceRun({ run, onboarding, traject, conditionState, now, deps });
      await supabaseAdmin.from('onboarding_automation_runs').update({
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
      console.error('[onboarding-automation step] run', run.id, e.message);
      try {
        await supabaseAdmin.from('onboarding_automation_runs')
          .update({ last_error: e.message, updated_at: nowIso }).eq('id', run.id);
      } catch {}
    }
  }
  return summary;
}
