// api/events-attendee-comms.js
// GET -> communicatie-historie + geplande communicatie voor één attendee.
//
// Permission: events.attendee.view.
//
// Query-param:
//   attendee_id  uuid (verplicht)
//
// Response:
//   {
//     items: [
//       { channel: 'email'|'whatsapp',
//         status : 'verzonden'|'gepland',
//         at     : <iso timestamp>,
//         label  : <step_type / automation-naam / template> }, ...
//     ],
//     note: 'Handmatig verstuurde losse e-mails worden niet gelogd.'
//   }
// Gesorteerd: verzonden eerst (recent boven), gepland onderaan op datum.
//
// Bronnen (Optie B uit recon-rapport):
//   - GEPLAND: event_automation_runs met status='active' + next_run_at.
//     step_type wordt afgeleid uit steps_snapshot[current_step_index].type.
//   - VERZONDEN automation: event_automation_run_log (executed_at + step_type).
//     result.ok bepaalt niet de status (spec houdt 'verzonden'|'gepland' enum);
//     mislukte stappen tellen als 'verzonden' (poging) zodat de tijdlijn
//     compleet blijft.
//   - VERZONDEN manueel WhatsApp: whatsapp_messages waar
//       direction='out' AND sent_by_user_id IS NOT NULL
//       AND conversation_id IN (conv-ids van attendee.customer_id).
//     Dedup met automation-driven WhatsApp: events-automation-engine zet
//     sentByUserId=null voor automation-runs, dus die rijen vallen
//     automatisch buiten dit filter.
//   - Manueel verstuurde losse e-mails worden NIET gelogd: niet per rij
//     getoond. UI toont een voetnoot.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// step_type → channel mapping. Onbekend type wordt overgeslagen
// (bv. 'wait' / 'condition' zijn geen communicatie-stappen).
const STEP_TYPE_TO_CHANNEL = {
  send_email   : 'email',
  send_whatsapp: 'whatsapp',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.view)' });
  }

  const attendeeId = req.query?.attendee_id ? String(req.query.attendee_id).trim() : '';
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }

  try {
    // 1) Attendee context (event_id + customer_id voor de WhatsApp-join).
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, customer_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee-lookup: ' + attErr.message);
    if (!attendee) return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    const items = [];

    // 2) Automation runs voor deze attendee.
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('event_automation_runs')
      .select('id, automation_id, status, current_step_index, next_run_at, steps_snapshot')
      .eq('attendee_id', attendeeId);
    if (runsErr) {
      console.error('[events-attendee-comms runs]', runsErr.message);
    }

    // 2a) Automation-namen ophalen (best-effort; label bevat 'm in de UI).
    const automationIds = Array.from(new Set((runs || []).map((r) => r.automation_id).filter(Boolean)));
    const autoNameById = new Map();
    if (automationIds.length > 0) {
      try {
        const { data: autos } = await supabaseAdmin
          .from('event_automations')
          .select('id, name')
          .in('id', automationIds);
        for (const a of autos || []) autoNameById.set(a.id, a.name);
      } catch (e) {
        console.error('[events-attendee-comms automations]', e?.message || e);
      }
    }

    // 2b) GEPLAND: actieve runs met next_run_at + huidige step-type.
    for (const run of runs || []) {
      if (run.status !== 'active' || !run.next_run_at) continue;
      const steps = Array.isArray(run.steps_snapshot) ? run.steps_snapshot : [];
      const step  = steps[run.current_step_index] || null;
      const channel = step && STEP_TYPE_TO_CHANNEL[step.type] || null;
      if (!channel) continue; // alleen mail/WhatsApp tonen
      items.push({
        channel,
        status: 'gepland',
        at    : run.next_run_at,
        label : autoNameById.get(run.automation_id) || step.type || 'Automation',
      });
    }

    // 3) VERZONDEN automation: per run de log-entries ophalen.
    const runIds = (runs || []).map((r) => r.id);
    const runById = new Map((runs || []).map((r) => [r.id, r]));
    if (runIds.length > 0) {
      const { data: logs, error: logErr } = await supabaseAdmin
        .from('event_automation_run_log')
        .select('run_id, step_index, step_type, executed_at, result')
        .in('run_id', runIds);
      if (logErr) {
        console.error('[events-attendee-comms run-log]', logErr.message);
      }
      for (const lg of logs || []) {
        const channel = STEP_TYPE_TO_CHANNEL[lg.step_type];
        if (!channel) continue;
        const run = runById.get(lg.run_id);
        const autoName = run ? autoNameById.get(run.automation_id) : null;
        items.push({
          channel,
          status: 'verzonden',
          at    : lg.executed_at,
          label : autoName || lg.step_type,
        });
      }
    }

    // 4) Manuele uitgaande WhatsApp via customer-koppeling. Dedup met
    //    automation-WhatsApp: filter sent_by_user_id IS NOT NULL omdat
    //    events-automation-engine sentByUserId=null doorgeeft.
    if (attendee.customer_id) {
      try {
        const { data: convs, error: convErr } = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('id')
          .eq('customer_id', attendee.customer_id);
        if (convErr) {
          console.error('[events-attendee-comms convs]', convErr.message);
        }
        const convIds = (convs || []).map((c) => c.id);
        if (convIds.length > 0) {
          const { data: msgs, error: msgErr } = await supabaseAdmin
            .from('whatsapp_messages')
            .select('template_name, body, sent_at, created_at, sent_by_user_id')
            .in('conversation_id', convIds)
            .eq('direction', 'out')
            .not('sent_by_user_id', 'is', null);
          if (msgErr) {
            console.error('[events-attendee-comms wa-msgs]', msgErr.message);
          }
          for (const m of msgs || []) {
            const at = m.sent_at || m.created_at;
            if (!at) continue;
            const label = m.template_name
              ? `Template: ${m.template_name}`
              : (m.body ? m.body.slice(0, 60) : 'WhatsApp');
            items.push({
              channel: 'whatsapp',
              status : 'verzonden',
              at,
              label,
            });
          }
        }
      } catch (e) {
        console.error('[events-attendee-comms wa-exception]', e?.message || e);
      }
    }

    // 5) Sorteer: verzonden eerst (recent boven), gepland onderaan op datum.
    items.sort((a, b) => {
      // status group: verzonden < gepland (zodat verzonden bovenaan)
      if (a.status !== b.status) {
        return a.status === 'verzonden' ? -1 : 1;
      }
      // binnen group: verzonden = recent boven (desc), gepland = eerstvolgende boven (asc)
      const ta = new Date(a.at).getTime() || 0;
      const tb = new Date(b.at).getTime() || 0;
      return a.status === 'verzonden' ? (tb - ta) : (ta - tb);
    });

    return res.status(200).json({
      items,
      note: 'Handmatig verstuurde losse e-mails worden niet gelogd.',
    });
  } catch (e) {
    console.error('[events-attendee-comms]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
