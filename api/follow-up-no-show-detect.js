// DISABLED 2026-05-20: no-show detection mag alleen via Dave's
// outcome-modal. Deze cron is uitgeschakeld in vercel.json.
// File blijft staan voor toekomstige refactor of als spec wijzigt.
// Endpoint blijft callable via HTTP (auth-gate beschermt) maar
// wordt niet meer automatisch getriggerd.
//
// api/follow-up-no-show-detect.js
//
// Cron-endpoint dat elke 5 min detecteert of geplande appointments
// een no-show zijn geworden. Twee detectie-paden:
//
// PAD A — Met zoom_meeting_id (Zoom meeting is gestart):
//   Appointment heeft zoom_meeting_id, scheduled_at + 10min < now,
//   status nog scheduled/in_progress. Check events_log of er een
//   participant_joined event was met email != Dave. Geen match → no_show.
//
// PAD B — Zonder zoom_meeting_id (lead is nooit op Zoom verschenen):
//   Appointment heeft GEEN zoom_meeting_id, scheduled_at + 30min < now,
//   status nog scheduled. Direct no_show (lead heeft de Zoom-link niet
//   gebruikt).
//
// Schedule: */5 * * * *
// Auth: CRON_SECRET via Authorization header
//
// Side-effect: schrijft no-show event naar follow_up_events_log voor audit.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { addGhlTags } from './ghl-tag-helper.js';

const PATH_A_BUFFER_MIN = 10;
const PATH_B_BUFFER_MIN = 30;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  if (!process.env.DAVE_ZOOM_EMAIL) {
    console.error('[no-show-detect] DAVE_ZOOM_EMAIL niet geconfigureerd');
    return res.status(500).json({ error: 'DAVE_ZOOM_EMAIL niet geconfigureerd.' });
  }

  const now = new Date();
  const pathACutoff = new Date(now.getTime() - PATH_A_BUFFER_MIN * 60_000);
  const pathBCutoff = new Date(now.getTime() - PATH_B_BUFFER_MIN * 60_000);

  const detectedNoShows = [];
  const errors = [];

  try {
    // PAD A — Met zoom_meeting_id
    const { data: pathACandidates, error: pathAErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, zoom_meeting_id, scheduled_at, status, lead_name, lead_ghl_contact_id, owner_id')
      .not('zoom_meeting_id', 'is', null)
      .lt('scheduled_at', pathACutoff.toISOString())
      .in('status', ['scheduled', 'in_progress']);

    if (pathAErr) {
      console.error('[no-show-detect] PAD A query error:', pathAErr.message);
      errors.push({ path: 'A', error: pathAErr.message });
    } else {
      for (const appt of pathACandidates || []) {
        const isNoShow = await checkLeadJoined(appt.zoom_meeting_id);
        if (!isNoShow) continue;

        const marked = await markAsNoShow(appt, 'path_a_no_lead_joined');
        if (marked) detectedNoShows.push({ id: appt.id, path: 'A', lead: appt.lead_name });
      }
    }

    // PAD B — Zonder zoom_meeting_id
    const { data: pathBCandidates, error: pathBErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, scheduled_at, status, lead_name, lead_ghl_contact_id, owner_id')
      .is('zoom_meeting_id', null)
      .lt('scheduled_at', pathBCutoff.toISOString())
      .eq('status', 'scheduled');

    if (pathBErr) {
      console.error('[no-show-detect] PAD B query error:', pathBErr.message);
      errors.push({ path: 'B', error: pathBErr.message });
    } else {
      for (const appt of pathBCandidates || []) {
        const marked = await markAsNoShow(appt, 'path_b_never_joined_zoom');
        if (marked) detectedNoShows.push({ id: appt.id, path: 'B', lead: appt.lead_name });
      }
    }

    return res.status(200).json({
      checked_path_a: pathACandidates?.length || 0,
      checked_path_b: pathBCandidates?.length || 0,
      no_shows_detected: detectedNoShows.length,
      errors: errors.length,
      details: detectedNoShows,
    });
  } catch (err) {
    console.error('[no-show-detect] exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function checkLeadJoined(zoomMeetingId) {
  // Returns true als geen lead-participant joined (= no-show)
  // Returns false als wel een participant joined die niet Dave is
  const { data: events } = await supabaseAdmin
    .from('follow_up_events_log')
    .select('payload')
    .eq('source', 'zoom')
    .eq('event_type', 'meeting.participant_joined')
    .filter('payload->object->>id', 'eq', String(zoomMeetingId));

  if (!events || events.length === 0) return true;

  const daveEmail = process.env.DAVE_ZOOM_EMAIL.toLowerCase();

  for (const evt of events) {
    const participantEmail = (evt.payload?.payload?.object?.participant?.email || '').toLowerCase();

    // Participant zonder e-mail = telefonisch ingebeld of Zoom-gast zonder account.
    // Behandel als geldige join — niet als no-show.
    if (!participantEmail) {
      return false;
    }

    // Geldige e-mail die niet van Dave is = lead joinde
    if (participantEmail !== daveEmail) {
      return false;
    }
  }

  return true; // alleen Dave joinde, of niemand anders
}

async function markAsNoShow(appt, reason) {
  // Guard: alleen overschrijven als status nog scheduled/in_progress is
  const { data: current } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('status')
    .eq('id', appt.id)
    .maybeSingle();

  if (!current || !['scheduled', 'in_progress'].includes(current.status)) {
    console.log('[no-show-detect] status al gewijzigd, skip:', appt.id, current?.status);
    return false;
  }

  const { error: updateErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({ status: 'no_show', updated_at: new Date().toISOString() })
    .eq('id', appt.id)
    .in('status', ['scheduled', 'in_progress']); // double-check race

  if (updateErr) {
    console.error('[no-show-detect] update error:', updateErr.message);
    return false;
  }

  await supabaseAdmin
    .from('follow_up_events_log')
    .insert({
      source: 'cron',
      event_type: 'no_show_detected',
      payload: { appointment_id: appt.id, reason, scheduled_at: appt.scheduled_at },
      processed: true,
    });

  // Tag in GHL voor follow-up workflow
  if (appt.lead_ghl_contact_id) {
    try {
      await addGhlTags(appt.lead_ghl_contact_id, ['followup-no-show'], {
        source: 'no-show-detect',
        appointment_id: appt.id,
        owner_id: appt.owner_id,
      });
    } catch (err) {
      console.error('[no-show-detect] tag-call exception:', err.message);
      // Niet blokkerend — no-show status is al gezet
    }
  }
  return true;
}
