import { createClient } from '@supabase/supabase-js';
import { updateZoomMeetingTime } from './_lib/zoom-meeting.js';
import { updateGhlAppointmentTime } from './_lib/ghl-appointment.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_ROLES = ['sales', 'manager', 'admin', 'super_admin'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Ongeldige token' });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }

  const { appointment_id, new_datetime, duration_minutes = 30 } = req.body;
  if (!appointment_id || !new_datetime) {
    return res.status(400).json({ error: 'appointment_id en new_datetime vereist' });
  }

  // Fetch huidige appointment
  const { data: oldAppt, error: fetchErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('*')
    .eq('id', appointment_id)
    .maybeSingle();

  if (fetchErr || !oldAppt) {
    return res.status(404).json({ error: 'Appointment niet gevonden' });
  }

  // Sales: alleen eigen appointments
  if (profile.role === 'sales' && oldAppt.owner_id !== user.id) {
    return res.status(403).json({ error: 'Niet jouw appointment' });
  }

  const newStart = new Date(new_datetime);
  const newEnd = new Date(newStart.getTime() + duration_minutes * 60 * 1000);

  // Step 1: Zoom meeting tijd updaten (best effort)
  let zoomResult = null;
  if (oldAppt.zoom_meeting_id) {
    try {
      zoomResult = await updateZoomMeetingTime(
        oldAppt.zoom_meeting_id,
        newStart.toISOString(),
        duration_minutes
      );
    } catch (zoomErr) {
      console.error('[verplaats-call] Zoom update failed:', zoomErr.message);
      // Niet abort — DB update mag wel doorgaan
    }
  }

  // Step 2: GHL appointment tijd updaten (best effort)
  let ghlResult = null;
  if (oldAppt.ghl_appointment_id) {
    try {
      ghlResult = await updateGhlAppointmentTime(
        oldAppt.ghl_appointment_id,
        newStart.toISOString(),
        newEnd.toISOString()
      );
    } catch (ghlErr) {
      console.error('[verplaats-call] GHL update failed:', ghlErr.message);
    }
  }

  // Step 3: Maak NIEUWE appointment-rij (nieuwe scheduled_at, parent_appointment_id = oud id)
  const { data: newAppt, error: insertErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .insert({
      ghl_appointment_id: oldAppt.ghl_appointment_id,
      zoom_meeting_id: oldAppt.zoom_meeting_id,
      zoom_join_url: oldAppt.zoom_join_url,
      lead_name: oldAppt.lead_name,
      lead_email: oldAppt.lead_email,
      lead_phone: oldAppt.lead_phone,
      lead_ghl_contact_id: oldAppt.lead_ghl_contact_id,
      scheduled_at: newStart.toISOString(),
      duration_minutes,
      status: 'scheduled',
      voicememo_status: 'pending',
      owner_id: oldAppt.owner_id,
      parent_appointment_id: oldAppt.id,
    })
    .select()
    .single();

  if (insertErr) {
    return res.status(500).json({ error: insertErr.message });
  }

  // Update oude rij naar 'verplaatst'
  await supabaseAdmin
    .from('follow_up_appointments')
    .update({ status: 'verplaatst' })
    .eq('id', oldAppt.id);

  // Audit log
  await supabaseAdmin
    .from('follow_up_events_log')
    .insert({
      appointment_id: newAppt.id,
      event_type: 'call_verplaatst',
      source: 'manual',
      payload: {
        from_appointment_id: oldAppt.id,
        from_datetime: oldAppt.scheduled_at,
        to_datetime: newStart.toISOString(),
        zoom_updated: !!zoomResult,
        ghl_updated: !!ghlResult,
        changed_by: user.id,
      },
    });

  return res.status(200).json({
    success: true,
    new_appointment: newAppt,
    zoom_updated: !!zoomResult,
    ghl_updated: !!ghlResult,
  });
}
