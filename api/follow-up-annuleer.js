// api/follow-up-annuleer.js
//
// POST { appointment_id, reden? }
//
// Annuleert een scheduled appointment:
//   1. GHL cancel via PUT /calendars/events/appointments/{id} — blocking
//   2. DB status → 'cancelled' + reden append aan snelle_notitie
//   3. Audit log in follow_up_events_log
//
// Zoom delete: geen helper beschikbaar → best-effort skip.

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const ALLOWED_ROLES = ['sales', 'manager', 'admin', 'super_admin'];

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

  if (appt.status !== 'scheduled') {
    return res.status(400).json({ error: `Kan alleen scheduled annuleren (status nu: ${appt.status})` });
  }

  // ── Validate-first: GHL cancel — blocking ────────────────────────────────
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
      if (!ghlRes.ok) {
        const body = await ghlRes.text();
        console.error('[annuleer-call] GHL cancel failed:', ghlRes.status, body);
        return res.status(422).json({
          error: mapGhlError(ghlRes.status, body),
          ghl_status: ghlRes.status,
        });
      }
      ghlCancelled = true;
    } catch (err) {
      console.error('[annuleer-call] GHL exception:', err.message);
      return res.status(500).json({ error: 'GHL onbereikbaar — probeer opnieuw' });
    }
  }

  // ── DB update: status=cancelled + reden append aan snelle_notitie ─────────
  const nu = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
  const redenSuffix = reden?.trim() ? `\n[${nu}] Geannuleerd: ${reden.trim()}` : '';
  const newNote = ((appt.snelle_notitie || '') + redenSuffix).trim().slice(0, 2000) || null;

  const { error: updateErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({
      status: 'cancelled',
      snelle_notitie: newNote,
      updated_at: new Date().toISOString(),
    })
    .eq('id', appointment_id);

  if (updateErr) {
    console.error('[annuleer-call] DB update failed:', updateErr.message);
    return res.status(500).json({
      error: 'Annulering doorgevoerd in GHL maar DB-update faalde: ' + updateErr.message,
    });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await supabaseAdmin
    .from('follow_up_events_log')
    .insert({
      appointment_id,
      event_type: 'appointment_cancelled',
      source: 'manual',
      payload: {
        reden: reden?.trim() || null,
        ghl_cancelled: ghlCancelled,
        changed_by: user.id,
      },
    });

  return res.status(200).json({
    success: true,
    ghl_cancelled: ghlCancelled,
  });
}

function mapGhlError(status, body) {
  if (status === 400) return `Ongeldige aanvraag bij GHL: ${body.slice(0, 120)}`;
  if (status === 401) return 'Geen GHL-toegang (token-issue) — neem contact op met beheerder';
  if (status === 404) return 'Afspraak bestaat niet meer in GHL';
  if (status >= 500) return 'GHL is tijdelijk niet beschikbaar — probeer het over enkele minuten opnieuw';
  return `GHL-fout ${status}: ${body.slice(0, 120)}`;
}
