// api/follow-up-ghl-appointment-poll.js
//
// Cron-endpoint: pollt GHL Calendar Events API en upsert appointments
// naar follow_up_appointments. Draait elke 15 minuten via vercel.json.
//
// Haalt appointments op van vandaag 00:00 t/m +7 dagen.
// Idempotent: upsert op ghl_appointment_id.
// owner_id wordt NIET gezet bij poll — system-import zonder user-context.

import { supabaseAdmin, checkCronAuth } from './supabase.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const ABORT_MS = 55_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'GHL_API_KEY of GHL_LOCATION_ID niet geconfigureerd.' });
  }

  const startTime = Date.now();
  const results = [];

  try {
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    const url = new URL(`${GHL_API_BASE}/calendars/events`);
    url.searchParams.set('locationId', process.env.GHL_LOCATION_ID);
    url.searchParams.set('startTime', startDate.toISOString());
    url.searchParams.set('endTime', endDate.toISOString());

    const ghlRes = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: '2021-04-15',
      },
    });

    if (!ghlRes.ok) {
      const errText = await ghlRes.text();
      console.error('[follow-up-ghl-poll] GHL API fout:', ghlRes.status, errText);
      return res.status(500).json({ error: `GHL API fout ${ghlRes.status}: ${errText}` });
    }

    const json = await ghlRes.json();
    const events = json.events || json.data || [];

    for (const event of events) {
      if (Date.now() - startTime > ABORT_MS) {
        results.push({ skipped: true, reason: 'timeout' });
        break;
      }

      const row = {
        ghl_appointment_id: event.id,
        lead_name:           event.title || event.contactName || 'Onbekend',
        lead_email:          event.email || null,
        lead_phone:          event.phone || null,
        lead_ghl_contact_id: event.contactId,
        scheduled_at:        event.startTime,
        duration_minutes:    event.durationMinutes || 30,
        status:              mapGhlStatus(event.appointmentStatus),
        updated_at:          new Date().toISOString(),
      };

      const { error } = await supabaseAdmin
        .from('follow_up_appointments')
        .upsert(row, { onConflict: 'ghl_appointment_id', ignoreDuplicates: false });

      if (error) {
        console.error('[follow-up-ghl-poll] upsert fout:', event.id, error.message);
      }
      results.push({ id: event.id, ok: !error, error: error?.message || null });
    }

    const ok     = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.skipped).length;
    console.log(`[follow-up-ghl-poll] ${ok} gesynchroniseerd, ${failed} mislukt van ${events.length} events`);
    return res.status(200).json({ synced: ok, failed, total: events.length, results });
  } catch (err) {
    console.error('[follow-up-ghl-poll] onverwachte fout:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function mapGhlStatus(ghlStatus) {
  const map = {
    confirmed: 'scheduled',
    showed:    'completed',
    noshow:    'no_show',
    cancelled: 'cancelled',
    invalid:   'cancelled',
  };
  return map[ghlStatus] || 'scheduled';
}
