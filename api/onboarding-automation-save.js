// api/onboarding-automation-save.js
//
// CRUD save voor onboarding_automations. Port van events-automation-save.js
// met onboarding-specifieke triggers + condities + step-types.
//
// Permission: onboarding.automation.edit (RBAC-migratie 2026-06-25).
// Body shape:
//   { id?, name, description?, enabled, trigger_type, trigger_config,
//     enroll_mode, steps }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TRIGGERS = [
  'on_onboarding_created',
  'on_wizard_completed',
  'time_after_signup',
  'on_wizard_not_started_after',
];
const ENROLL = ['new_only', 'include_existing'];
const STEP_TYPES = [
  'wait',
  'condition',
  'send_email',
  'send_whatsapp',
  'update_onboarding_status',
  'send_internal_notification',
];
const WAIT_UNITS = ['minutes', 'hours', 'days'];
const COND_CHECKS = [
  'wizard_not_started',
  'wizard_completed',
  'no_inbound',
  'traject_is_1op1',
  'traject_is_membership',
];
const COND_FAIL = ['exit', 'skip_to_end'];
const ONBOARDING_STATUSES = ['aangemeld','bezig','afgerond','gearchiveerd'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateSteps(steps) {
  if (!Array.isArray(steps)) return 'steps moet een array zijn';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return `stap ${i}: ongeldig`;
    if (!STEP_TYPES.includes(s.type)) return `stap ${i}: onbekend type '${s.type}'`;
    const c = s.config || {};
    if (s.type === 'wait') {
      if (!(Number(c.amount) > 0)) return `stap ${i}: wait.amount > 0 vereist`;
      if (!WAIT_UNITS.includes(c.unit)) return `stap ${i}: wait.unit ongeldig`;
    } else if (s.type === 'condition') {
      if (!COND_CHECKS.includes(c.check)) return `stap ${i}: condition.check ongeldig`;
      if (c.on_fail && !COND_FAIL.includes(c.on_fail)) return `stap ${i}: condition.on_fail ongeldig`;
    } else if (s.type === 'send_email') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i}: send_email.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i}: send_email.body vereist`;
    } else if (s.type === 'send_whatsapp') {
      if (!c.template_name || typeof c.template_name !== 'string') return `stap ${i}: send_whatsapp.template_name vereist`;
    } else if (s.type === 'update_onboarding_status') {
      if (!c.new_status || !ONBOARDING_STATUSES.includes(c.new_status)) {
        return `stap ${i}: update_onboarding_status.new_status moet ${ONBOARDING_STATUSES.join('|')} zijn`;
      }
    } else if (s.type === 'send_internal_notification') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i}: send_internal_notification.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i}: send_internal_notification.body vereist`;
      if (c.to_email && (typeof c.to_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.to_email))) {
        return `stap ${i}: send_internal_notification.to_email ongeldig`;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.automation.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.automation.edit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const id = typeof body.id === 'string' ? body.id.trim() : null;
  if (id && !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) ongeldig' });

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name vereist' });

  if (!TRIGGERS.includes(body.trigger_type)) {
    return res.status(400).json({ error: 'trigger_type ongeldig' });
  }
  const enroll_mode = ENROLL.includes(body.enroll_mode) ? body.enroll_mode : 'new_only';

  const trigger_config = (body.trigger_config && typeof body.trigger_config === 'object')
    ? body.trigger_config : {};
  if (body.trigger_type === 'time_after_signup' || body.trigger_type === 'on_wizard_not_started_after') {
    const hours = Number(trigger_config.hours_after_signup);
    const days  = Number(trigger_config.days_after_signup);
    const hasHours = Number.isFinite(hours) && hours > 0;
    const hasDays  = Number.isFinite(days)  && days  > 0;
    if (!hasHours && !hasDays) {
      return res.status(400).json({
        error: `${body.trigger_type} vereist trigger_config.hours_after_signup of days_after_signup > 0`,
      });
    }
  }

  const stepErr = validateSteps(body.steps);
  if (stepErr) return res.status(400).json({ error: stepErr });

  const enabled = body.enabled === true;

  try {
    let prev = null;
    if (id) {
      const { data } = await supabaseAdmin
        .from('onboarding_automations')
        .select('enabled, enabled_at')
        .eq('id', id)
        .maybeSingle();
      if (!data) return res.status(404).json({ error: 'Automation niet gevonden' });
      prev = data;
    }
    let enabled_at = prev ? prev.enabled_at : null;
    if (enabled && (!prev || prev.enabled !== true)) enabled_at = new Date().toISOString();

    const row = {
      name,
      description: typeof body.description === 'string' ? body.description.slice(0, 2000) : null,
      enabled, enabled_at,
      trigger_type: body.trigger_type, trigger_config,
      enroll_mode,
      steps: body.steps,
      updated_at: new Date().toISOString(),
    };

    let result;
    if (id) {
      const { data, error } = await supabaseAdmin
        .from('onboarding_automations')
        .update(row).eq('id', id).select('*').maybeSingle();
      if (error) throw new Error(error.message);
      result = data;
    } else {
      row.created_by_user_id = user.id;
      const { data, error } = await supabaseAdmin
        .from('onboarding_automations')
        .insert(row).select('*').maybeSingle();
      if (error) throw new Error(error.message);
      result = data;
    }
    return res.status(200).json({ ok: true, automation: result });
  } catch (e) {
    console.error('[onboarding-automation-save]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
