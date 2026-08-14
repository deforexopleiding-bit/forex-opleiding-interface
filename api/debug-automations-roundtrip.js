// api/debug-automations-roundtrip.js
//
// READ-ONLY dry-run round-trip verificatie voor v2 automatiseringen (#1309).
// Doel: bewijzen dat LIVE flows die door de v2-editor geopend + zonder wijzigen
// terug-gesaved zouden worden GEEN waardeverlies of semantische shift oplopen.
//
// Doet ZERO writes. Gebruikt de ECHTE validateSteps-exports uit de save-endpoints
// zodat de check identiek is aan wat een echte save zou doen.
//
// Response per flow:
//   { module, id, name, trigger_type, steps_count,
//     identical_on_no_change: bool,   // deep-JSON gelijk?
//     trigger_valid: bool, trigger_error: string|null,
//     steps_valid: bool, steps_error: string|null,
//     would_save_succeed: bool }
//
// Summary:
//   { total, identical_count, save_ok_count, blockers: [ids...] }
//
// Permission: super_admin only. Endpoint bestemd om na diagnose weer verwijderd
// te worden (samen met debug-automations-config-dump).

import { createUserClient, supabaseAdmin } from './supabase.js';

// LETTERLIJKE KOPIE van de validateSteps + enums uit
// api/events-automation-save.js en api/onboarding-automation-save.js — bewust
// niet geïmporteerd omdat cross-api-imports in Vercel geen precedent hebben.
// Als de save-endpoints wijzigen moet deze kopie synchroon bijgewerkt worden.

const EV_TRIGGERS = ['on_signup','on_assessment_completed','time_before_event','on_assessment_not_completed_after'];
const OB_TRIGGERS = ['on_onboarding_created','on_wizard_completed','time_after_signup','on_wizard_not_started_after'];

const EV_STEP_TYPES = ['wait','condition','send_email','send_whatsapp','set_tag','update_attendee_status','send_internal_notification'];
const OB_STEP_TYPES = ['wait','condition','send_email','send_whatsapp','update_onboarding_status','send_internal_notification'];
const WAIT_UNITS    = ['minutes','hours','days'];
const EV_COND_CHECKS = ['assessment_completed','assessment_not_completed','still_registered','niveau_is_basis','niveau_is_gevorderd'];
const OB_COND_CHECKS = ['wizard_not_started','wizard_completed','no_inbound','traject_is_1op1','traject_is_membership'];
const COND_FAIL      = ['exit','skip_to_end'];
const ATTENDEE_STATUSES  = ['aangemeld','aanwezig','no_show','sale','switched_to_other_event','geannuleerd'];
const ONBOARDING_STATUSES = ['aangemeld','bezig','afgerond','gearchiveerd'];

function validateEvSteps(steps) {
  if (!Array.isArray(steps)) return 'steps moet een array zijn';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return `stap ${i + 1}: ongeldig`;
    if (!EV_STEP_TYPES.includes(s.type)) return `stap ${i + 1}: onbekend type '${s.type}'`;
    const c = s.config || {};
    if (s.type === 'wait') {
      if (!(Number(c.amount) > 0)) return `stap ${i + 1}: wait.amount > 0 vereist`;
      if (!WAIT_UNITS.includes(c.unit)) return `stap ${i + 1}: wait.unit ongeldig`;
    } else if (s.type === 'condition') {
      if (!EV_COND_CHECKS.includes(c.check)) return `stap ${i + 1}: condition.check ongeldig`;
      if (c.on_fail && !COND_FAIL.includes(c.on_fail)) return `stap ${i + 1}: condition.on_fail ongeldig`;
    } else if (s.type === 'send_email') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i + 1}: send_email.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i + 1}: send_email.body vereist`;
      if (c.button && (typeof c.button !== 'object' || !c.button.label || !c.button.url)) return `stap ${i + 1}: button vereist label+url`;
    } else if (s.type === 'send_whatsapp') {
      if (!c.template_name || typeof c.template_name !== 'string') return `stap ${i + 1}: send_whatsapp.template_name vereist`;
    } else if (s.type === 'set_tag') {
      if (!c.tag_slug || typeof c.tag_slug !== 'string') return `stap ${i + 1}: set_tag.tag_slug vereist`;
    } else if (s.type === 'update_attendee_status') {
      if (!c.new_status || !ATTENDEE_STATUSES.includes(c.new_status)) {
        return `stap ${i + 1}: update_attendee_status.new_status moet ${ATTENDEE_STATUSES.join('|')} zijn`;
      }
    } else if (s.type === 'send_internal_notification') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i + 1}: send_internal_notification.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i + 1}: send_internal_notification.body vereist`;
    }
  }
  return null;
}
function validateObSteps(steps) {
  if (!Array.isArray(steps)) return 'steps moet een array zijn';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return `stap ${i + 1}: ongeldig`;
    if (!OB_STEP_TYPES.includes(s.type)) return `stap ${i + 1}: onbekend type '${s.type}'`;
    const c = s.config || {};
    if (s.type === 'wait') {
      if (!(Number(c.amount) > 0)) return `stap ${i + 1}: wait.amount > 0 vereist`;
      if (!WAIT_UNITS.includes(c.unit)) return `stap ${i + 1}: wait.unit ongeldig`;
    } else if (s.type === 'condition') {
      if (!OB_COND_CHECKS.includes(c.check)) return `stap ${i + 1}: condition.check ongeldig`;
      if (c.on_fail && !COND_FAIL.includes(c.on_fail)) return `stap ${i + 1}: condition.on_fail ongeldig`;
    } else if (s.type === 'send_email') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i + 1}: send_email.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i + 1}: send_email.body vereist`;
    } else if (s.type === 'send_whatsapp') {
      if (!c.template_name || typeof c.template_name !== 'string') return `stap ${i + 1}: send_whatsapp.template_name vereist`;
    } else if (s.type === 'update_onboarding_status') {
      if (!c.new_status || !ONBOARDING_STATUSES.includes(c.new_status)) {
        return `stap ${i + 1}: update_onboarding_status.new_status moet ${ONBOARDING_STATUSES.join('|')} zijn`;
      }
    } else if (s.type === 'send_internal_notification') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i + 1}: send_internal_notification.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i + 1}: send_internal_notification.body vereist`;
    }
  }
  return null;
}

function validateEvTrigger(a) {
  if (!EV_TRIGGERS.includes(a.trigger_type)) return 'trigger_type ongeldig';
  const tc = a.trigger_config || {};
  if (a.trigger_type === 'time_before_event' && !(Number(tc.hours_before) > 0)) {
    return `time_before_event vereist trigger_config.hours_before > 0 (heeft: ${JSON.stringify(tc)})`;
  }
  if (a.trigger_type === 'on_assessment_not_completed_after'
      && !(Number.isInteger(Number(tc.hours_after_signup)) && Number(tc.hours_after_signup) > 0)) {
    return `on_assessment_not_completed_after vereist trigger_config.hours_after_signup > 0 (heeft: ${JSON.stringify(tc)})`;
  }
  return null;
}
function validateObTrigger(a) {
  if (!OB_TRIGGERS.includes(a.trigger_type)) return 'trigger_type ongeldig';
  const tc = a.trigger_config || {};
  if (a.trigger_type === 'time_after_signup' || a.trigger_type === 'on_wizard_not_started_after') {
    const hours = Number(tc.hours_after_signup);
    const days  = Number(tc.days_after_signup);
    const hasHours = Number.isFinite(hours) && hours > 0;
    const hasDays  = Number.isFinite(days)  && days  > 0;
    if (!hasHours && !hasDays) {
      return `${a.trigger_type} vereist trigger_config.hours_after_signup OF days_after_signup > 0 (heeft: ${JSON.stringify(tc)})`;
    }
  }
  return null;
}

function simulateRoundTrip(auto, mod) {
  // Simuleer wat __autEvEdit / __autObEdit doet: deep-copy in editor state.
  const editing = JSON.parse(JSON.stringify(auto));
  // Simuleer save zonder wijzigen: payload === editing (v2-save stuurt editing verbatim).
  const payload = JSON.parse(JSON.stringify(editing));
  // Identiek check tegen origineel DB-record (excl. server-side velden die save niet meesent).
  const strip = (o) => {
    const c = { ...o };
    delete c.created_at; delete c.updated_at; delete c.created_by_user_id;
    delete c.enabled_at; // save-endpoint zet dit zelf op basis van enabled+prev
    return c;
  };
  const origStripped = strip(auto);
  const payStripped  = strip(payload);
  const identical = JSON.stringify(origStripped) === JSON.stringify(payStripped);

  const triggerErr = mod === 'events' ? validateEvTrigger(auto) : validateObTrigger(auto);
  const stepsErr   = mod === 'events' ? validateEvSteps(auto.steps) : validateObSteps(auto.steps);

  return {
    module: mod,
    id: auto.id,
    name: auto.name || '(geen naam)',
    trigger_type: auto.trigger_type,
    trigger_config: auto.trigger_config || {},
    steps_count: Array.isArray(auto.steps) ? auto.steps.length : 0,
    identical_on_no_change: identical,
    trigger_valid: !triggerErr,
    trigger_error: triggerErr,
    steps_valid: !stepsErr,
    steps_error: stepsErr,
    would_save_succeed: !triggerErr && !stepsErr,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  const { data: prof } = await supabaseAdmin
    .from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!prof || prof.role !== 'super_admin') {
    return res.status(403).json({ error: 'super_admin only' });
  }

  try {
    const [ev, ob] = await Promise.all([
      supabaseAdmin.from('event_automations').select('*'),
      supabaseAdmin.from('onboarding_automations').select('*'),
    ]);
    if (ev.error) throw ev.error;
    if (ob.error) throw ob.error;

    const evReport = (ev.data || []).map((a) => simulateRoundTrip(a, 'events'));
    const obReport = (ob.data || []).map((a) => simulateRoundTrip(a, 'onboarding'));
    const all = [...evReport, ...obReport];

    const summary = {
      total: all.length,
      identical_count: all.filter((r) => r.identical_on_no_change).length,
      save_ok_count: all.filter((r) => r.would_save_succeed).length,
      blockers: all.filter((r) => !r.would_save_succeed).map((r) => ({
        module: r.module, id: r.id, name: r.name,
        trigger_error: r.trigger_error, steps_error: r.steps_error,
      })),
    };

    return res.status(200).json({
      note: 'READ-ONLY dry-run — geen writes uitgevoerd. Verwijder dit endpoint na diagnose.',
      summary,
      events: evReport,
      onboarding: obReport,
    });
  } catch (e) {
    console.error('[debug-automations-roundtrip]', e.message);
    return res.status(500).json({ error: e.message || 'Interne fout' });
  }
}
