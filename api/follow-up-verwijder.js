// api/follow-up-verwijder.js
//
// POST { appointment_id, reden? }
//
// Verwijdert een appointment (soft-delete naar status 'verwijderd'):
//   1. GHL cancel via PUT /calendars/events/appointments/{id} — best-effort
//   2. Zoom meeting DELETE — best-effort
//   3. DB status → 'verwijderd' + reden append aan snelle_notitie
//   4. Audit log in follow_up_events_log
//
// Toegestaan voor alle statussen behalve al 'verwijderd'.
// Sales mag alleen eigen appointments verwijderen.

import { createClient } from '@supabase/supabase-js';
import { deleteZoomMeeting } from './_lib/zoom-meeting.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const ALLOWED_ROLES     = ['sales', 'manager', 'admin', 'super_admin'];
const DELETABLE_STATUSES = ['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled', 'verplaatst'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const userToken = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(userToken);
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

  const { appointment_id, reden } = req.body || {};
  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id verplicht' });
  }

  const { data: appt, error: fetchErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, owner_id, status, ghl_appointment_id, zoom_meeting_id, snelle_notitie')
    .eq('id', appointment_id)
    .maybeSingle();

  if (fetchErr || !appt) {
    return res.status(404).json({ error: 'Appointment niet gevonden' });
  }

  if (profile.role === 'sales' && appt.owner_id !== user.id) {
    return res.status(403).json({ error: 'Niet jouw appointment' });
  }

  if (!DELETABLE_STATUSES.includes(appt.status)) {
    return res.status(400).json({ error: `Appointment is al verwijderd (status: ${appt.status})` });
  }

  // ── GHL cancel — best-effort (appointment kan al afgerond/gecanceld zijn) ──
  let ghlCancelled = false;
  if (appt.ghl_appointment_id) {
    const ghlToken = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
    try {
      const ghlRes = await fetch(
        `${GHL_BASE}/calendars/events/appointments/${appt.ghl_appointment_id}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ghlToken}`,
            Version: GHL_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ appointmentStatus: 'cancelled' }),
        }
      );
      if (ghlRes.ok) {
        ghlCancelled = true;
      } else {
        console.warn('[verwijder] GHL cancel niet gelukt (best-effort):', ghlRes.status);
      }
    } catch (err) {
      console.warn('[verwijder] GHL exception (best-effort):', err.message);
    }
  }

  // ── Zoom delete — best-effort ────────────────────────────────────────────
  let zoomDeleted = false;
  if (appt.zoom_meeting_id) {
    try {
      await deleteZoomMeeting(appt.zoom_meeting_id);
      zoomDeleted = true;
    } catch (err) {
      console.warn('[verwijder] Zoom delete niet gelukt (best-effort):', err.message);
    }
  }

  // ── DB update: status=verwijderd + reden append aan snelle_notitie ────────
  const nu = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
  const redenSuffix = reden?.trim() ? `\n[${nu}] Verwijderd: ${reden.trim()}` : '';
  const newNote = ((appt.snelle_notitie || '') + redenSuffix).trim().slice(0, 2000) || null;

  const { error: updateErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({
      status: 'verwijderd',
      snelle_notitie: newNote,
      updated_at: new Date().toISOString(),
    })
    .eq('id', appointment_id);

  if (updateErr) {
    console.error('[verwijder] DB update failed:', updateErr.message);
    return res.status(500).json({ error: 'DB-update faalde: ' + updateErr.message });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await supabaseAdmin
    .from('follow_up_events_log')
    .insert({
      appointment_id,
      event_type: 'appointment_deleted',
      source: 'manual',
      payload: {
        reden: reden?.trim() || null,
        ghl_cancelled: ghlCancelled,
        zoom_deleted: zoomDeleted,
        changed_by: user.id,
      },
    });

  return res.status(200).json({
    success: true,
    ghl_cancelled: ghlCancelled,
    zoom_deleted: zoomDeleted,
  });
}
