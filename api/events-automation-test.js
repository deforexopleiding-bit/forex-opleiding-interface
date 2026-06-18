// api/events-automation-test.js
// POST -> trigger een echte automation-run met een synthetische test-attendee.
//
// Use-case: Jeffrey wil een end-to-end test van een mail/WhatsApp-flow zonder
// een echte deelnemer te risken. De endpoint:
//   1. INSERT een event_attendees-rij met is_test=true en name-prefix "TEST · "
//      zodat er nooit verwarring is met echte data.
//   2. INSERT direct een event_automation_runs-rij (status='active',
//      current_step_index=0, next_run_at=now, is_test=true) — bypasst dus
//      het normale trigger_type-pad (on_signup / time_before_event /
//      assessment_completed). De engine pikt 'm bij de eerstvolgende tick op
//      en versnelt elke wait-stap naar 15s (zie events-automation-engine.js).
//
// Permission: events.event.edit (zelfde als andere automation-mutaties).
//
// Body:
//   {
//     automation_id: uuid (verplicht),
//     event_id     : uuid (verplicht — koppel test-attendee aan dit event),
//     first_name   : string,
//     last_name    : string,
//     email        : string,
//     phone        : string (E.164 met +, bv. +31612345678),
//     accelerate_waits: boolean (default true) — momenteel altijd 15s als
//                       is_test=true; deze flag is in de body alleen voor
//                       forward-compat (false zou de engine straks de normale
//                       wait-tijden laten respecteren).
//   }
//
// Response 200: { ok:true, attendee_id, run_id }
// Response 400: validatie-fout
// Response 403: geen rechten
// Response 404: automation of event niet gevonden
// Response 500: DB-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[0-9]{8,15}$/;
const NAME_MAX = 80;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  const body = req.body || {};
  const automationId = typeof body.automation_id === 'string' ? body.automation_id.trim() : '';
  const eventId      = typeof body.event_id === 'string'      ? body.event_id.trim()      : '';
  const firstName    = typeof body.first_name === 'string'    ? body.first_name.trim()    : '';
  const lastName     = typeof body.last_name === 'string'     ? body.last_name.trim()     : '';
  const email        = typeof body.email === 'string'         ? body.email.trim()         : '';
  const phone        = typeof body.phone === 'string'         ? body.phone.trim()         : '';

  if (!automationId || !UUID_RE.test(automationId)) {
    return res.status(400).json({ error: 'automation_id (uuid) vereist' });
  }
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }
  if (!firstName || firstName.length > NAME_MAX) {
    return res.status(400).json({ error: `first_name vereist (max ${NAME_MAX} chars)` });
  }
  if (!lastName || lastName.length > NAME_MAX) {
    return res.status(400).json({ error: `last_name vereist (max ${NAME_MAX} chars)` });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email ongeldig' });
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'phone moet E.164-formaat hebben (bv. +31612345678)' });
  }

  try {
    // Automation + event bestaan-check (404 → duidelijker dan een 500 op
    // FK-violation).
    const { data: autom, error: autErr } = await supabaseAdmin
      .from('event_automations')
      .select('id, name, enabled')
      .eq('id', automationId)
      .maybeSingle();
    if (autErr) throw new Error('automation-lookup: ' + autErr.message);
    if (!autom)  return res.status(404).json({ error: 'Automation niet gevonden' });
    if (!autom.enabled) {
      return res.status(400).json({ error: 'Automation staat uit — zet \'m eerst aan' });
    }

    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, status')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event-lookup: ' + evErr.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    // 1) INSERT test-attendee. Name geprefixt met "TEST · " zodat de rij in
    //    UI's die de filter (per ongeluk) niet toepassen ook visueel niet
    //    voor echte data doorgaat.
    const nowIso = new Date().toISOString();
    const { data: att, error: attInsErr } = await supabaseAdmin
      .from('event_attendees')
      .insert({
        event_id:           eventId,
        first_name:         'TEST · ' + firstName,
        last_name:          lastName,
        email,
        phone,
        status:             'aangemeld',
        is_test:            true,
        registered_at:      nowIso,
        created_by_user_id: user.id,
      })
      .select('id')
      .single();
    if (attInsErr) throw new Error('test-attendee insert: ' + attInsErr.message);

    // 2) INSERT automation-run. status='active' + current_step_index=0 +
    //    next_run_at=now → engine pikt 'm bij eerstvolgende tick op en doet
    //    stap 0; vanaf daar versnelt 'ie elke wait naar 15s omdat is_test=true.
    //    NB: steps_snapshot wordt door de engine zelf gelezen uit
    //    event_automations bij start; we hoeven 'm hier niet te kopiëren.
    const { data: run, error: runInsErr } = await supabaseAdmin
      .from('event_automation_runs')
      .insert({
        automation_id:      automationId,
        attendee_id:        att.id,
        status:             'active',
        current_step_index: 0,
        next_run_at:        nowIso,
        is_test:            true,
      })
      .select('id')
      .single();
    if (runInsErr) {
      // Cleanup attendee zodat we geen orphan TEST·-rij achterlaten als de
      // run-INSERT faalt. Best-effort: log + door als delete óók faalt.
      try {
        await supabaseAdmin.from('event_attendees').delete().eq('id', att.id);
      } catch (delErr) {
        console.error('[events-automation-test] cleanup orphan attendee fail:', delErr?.message || delErr);
      }
      throw new Error('automation-run insert: ' + runInsErr.message);
    }

    return res.status(200).json({
      ok:          true,
      attendee_id: att.id,
      run_id:      run.id,
    });
  } catch (e) {
    console.error('[events-automation-test]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
