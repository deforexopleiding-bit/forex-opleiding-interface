import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// Fase 4A: 'on_assessment_not_completed_after' toegevoegd. Vereist eerst
// docs/sql-migrations/2026-06-18-events-automations-fase-4a.sql op prod;
// daarna laat de DB-CHECK 'em toe.
//
// 'on_call_status' vereist idem docs/sql-migrations/2026-09-14-events-geen-
// gehoor-laatste-kans.sql: die zet de CHECK op trigger_type opnieuw. Zonder
// die migratie geeft opslaan een 23514 vanuit Postgres — de app-validatie
// hieronder laat 'em door, de databank niet.
const TRIGGERS = ['on_signup', 'on_assessment_completed', 'time_before_event', 'on_assessment_not_completed_after', 'on_call_status'];

// De belstatussen waar een automatisatie op kan aanslaan. Spiegelt
// CALL_STATUS_OPTIONS in modules/klanten-v2/views/events-v2.js plus de twee
// die daar bewust geen keuze zijn ('liever_zoom', 'foutief_nummer'): een
// trigger mag op elke waarde die de kolom kan hebben, ook op een die je niet
// met de hand kiest. Lege belstatus is geen trigger — dat is 'nog niet
// gebeld', en daar is on_signup voor.
const CALL_STATUSES = [
  'bevestigd', 'gebeld', 'geen_gehoor', 'voicemail', 'komt_niet',
  'terugbellen', 'foutief_nummer', 'liever_zoom',
];
const SCOPES = ['all', 'niveau', 'events'];
const ENROLL = ['new_only', 'include_existing'];
// Fase 4A: 3 nieuwe step-types (pure app-validatie).
const STEP_TYPES = ['wait', 'condition', 'send_email', 'send_whatsapp', 'set_tag', 'update_attendee_status', 'send_internal_notification'];
const WAIT_UNITS = ['minutes', 'hours', 'days'];
// Fase 4A: niveau_is_basis / niveau_is_gevorderd toegevoegd.
// date_chosen SKIPPED — geen DB-veld of bestaande logica; TODO bij design fase 4b.
// 'geen_reactie_sinds_belstatus' meet buiten de attendee-rij (whatsapp_messages
// + email_messages sinds call_status_at) — zie _lib/events-geen-gehoor-reactie.js.
// Niet-meetbaar is NIET waar, zodat een plek nooit vervalt op een controle die
// niet kon draaien.
const COND_CHECKS = ['assessment_completed', 'assessment_not_completed', 'still_registered', 'niveau_is_basis', 'niveau_is_gevorderd', 'geen_reactie_sinds_belstatus'];
const COND_FAIL = ['exit', 'skip_to_end'];
const ATTENDEE_STATUSES = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event', 'geannuleerd'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateSteps(steps) {
  if (!Array.isArray(steps)) return 'steps moet een array zijn';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return `stap ${i + 1}: ongeldig`;
    if (!STEP_TYPES.includes(s.type)) return `stap ${i + 1}: onbekend type '${s.type}'`;
    const c = s.config || {};
    if (s.type === 'wait') {
      if (!(Number(c.amount) > 0)) return `stap ${i + 1}: wait.amount > 0 vereist`;
      if (!WAIT_UNITS.includes(c.unit)) return `stap ${i + 1}: wait.unit ongeldig`;
      // Optionele bovengrens: nooit later dan X uur voor het event. Alleen
      // valideren als hij MEEGESTUURD is — een wait zonder grens blijft een
      // geldige wait, en dat is de bestaande situatie.
      if (c.uiterlijk_uren_voor_event != null
          && !(Number.isFinite(Number(c.uiterlijk_uren_voor_event)) && Number(c.uiterlijk_uren_voor_event) >= 0)) {
        return `stap ${i + 1}: wait.uiterlijk_uren_voor_event moet een getal >= 0 zijn`;
      }
    } else if (s.type === 'condition') {
      if (!COND_CHECKS.includes(c.check)) return `stap ${i + 1}: condition.check ongeldig`;
      if (c.on_fail && !COND_FAIL.includes(c.on_fail)) return `stap ${i + 1}: condition.on_fail ongeldig`;
    } else if (s.type === 'send_email') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i + 1}: send_email.subject vereist`;
      if (!c.body || typeof c.body !== 'string') return `stap ${i + 1}: send_email.body vereist`;
      if (c.button && (typeof c.button !== 'object' || !c.button.label || !c.button.url)) return `stap ${i + 1}: button vereist label+url`;
    } else if (s.type === 'send_whatsapp') {
      if (!c.template_name || typeof c.template_name !== 'string') return `stap ${i + 1}: send_whatsapp.template_name vereist`;
    } else if (s.type === 'set_tag') {
      if (!c.tag_slug || typeof c.tag_slug !== 'string') return `stap ${i + 1}: set_tag.tag_slug vereist`;
    } else if (s.type === 'update_attendee_status') {
      if (!c.new_status || !ATTENDEE_STATUSES.includes(c.new_status)) {
        return `stap ${i + 1}: update_attendee_status.new_status moet ${ATTENDEE_STATUSES.join('|')} zijn`;
      }
      // Optionele belstatus, zodat dezelfde stap status 'geannuleerd' en
      // belstatus 'komt_niet' kan zetten. Ontbreekt hij, dan blijft de
      // belstatus ongemoeid — het bestaande gedrag.
      if (c.call_status != null && !CALL_STATUSES.includes(c.call_status)) {
        return `stap ${i + 1}: update_attendee_status.call_status moet ${CALL_STATUSES.join('|')} zijn`;
      }
    } else if (s.type === 'send_internal_notification') {
      if (!c.subject || typeof c.subject !== 'string') return `stap ${i + 1}: send_internal_notification.subject vereist`;
      if (!c.body    || typeof c.body    !== 'string') return `stap ${i + 1}: send_internal_notification.body vereist`;
      if (c.to_email && (typeof c.to_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.to_email))) {
        return `stap ${i + 1}: send_internal_notification.to_email ongeldig`;
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
  if (!(await requirePermission(req, 'events.event.edit'))) return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
  const id = typeof body.id === 'string' ? body.id.trim() : null;
  if (id && !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) ongeldig' });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name vereist' });
  if (!TRIGGERS.includes(body.trigger_type)) return res.status(400).json({ error: 'trigger_type ongeldig' });
  const scope_type = SCOPES.includes(body.scope_type) ? body.scope_type : 'all';
  const enroll_mode = ENROLL.includes(body.enroll_mode) ? body.enroll_mode : 'new_only';
  const trigger_config = (body.trigger_config && typeof body.trigger_config === 'object') ? body.trigger_config : {};
  if (body.trigger_type === 'time_before_event' && !(Number(trigger_config.hours_before) > 0)) {
    return res.status(400).json({ error: 'time_before_event vereist trigger_config.hours_before > 0' });
  }
  if (body.trigger_type === 'on_assessment_not_completed_after'
      && !(Number.isInteger(Number(trigger_config.hours_after_signup)) && Number(trigger_config.hours_after_signup) > 0)) {
    return res.status(400).json({ error: 'on_assessment_not_completed_after vereist trigger_config.hours_after_signup als positief geheel getal' });
  }
  // Een on_call_status zonder belstatus zou elke deelnemer kandideren: de
  // engine returnt dan [] (geen kandidaten), dus stil niets doen. Hier hard
  // weigeren zodat het verschil tussen 'verkeerd opgeslagen' en 'nog niemand
  // in die belstatus' zichtbaar blijft.
  if (body.trigger_type === 'on_call_status'
      && !CALL_STATUSES.includes(trigger_config.call_status)) {
    return res.status(400).json({
      error: 'on_call_status vereist trigger_config.call_status uit: ' + CALL_STATUSES.join(', '),
    });
  }
  const scope_config = (body.scope_config && typeof body.scope_config === 'object') ? body.scope_config : {};
  if (scope_type === 'niveau' && !scope_config.niveau) return res.status(400).json({ error: 'scope niveau vereist scope_config.niveau' });
  if (scope_type === 'events' && !Array.isArray(scope_config.event_ids)) return res.status(400).json({ error: 'scope events vereist scope_config.event_ids[]' });
  const stepErr = validateSteps(body.steps);
  if (stepErr) return res.status(400).json({ error: stepErr });
  const enabled = body.enabled === true;

  try {
    let prev = null;
    if (id) {
      const { data } = await supabaseAdmin.from('event_automations').select('enabled, enabled_at').eq('id', id).maybeSingle();
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
      scope_type, scope_config, enroll_mode,
      steps: body.steps,
      updated_at: new Date().toISOString(),
    };
    let result;
    if (id) {
      const { data, error } = await supabaseAdmin.from('event_automations').update(row).eq('id', id).select('*').maybeSingle();
      if (error) throw new Error(error.message);
      result = data;
    } else {
      row.created_by_user_id = user.id;
      const { data, error } = await supabaseAdmin.from('event_automations').insert(row).select('*').maybeSingle();
      if (error) throw new Error(error.message);
      result = data;
    }
    return res.status(200).json({ ok: true, automation: result });
  } catch (e) {
    console.error('[events-automation-save]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
