// api/follow-up-ghl-appointment-poll.js
//
// Cron-endpoint: pollt GHL Calendar Events API en upsert appointments
// naar follow_up_appointments. Draait elke 15 minuten via vercel.json.
//
// Haalt appointments op van vandaag 00:00 t/m +7 dagen.
// Idempotent: upsert op ghl_appointment_id.
// owner_id = DAVE_PROFILE_ID zodat sales-user (Dave) zijn eigen appointments via RLS kan zien

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { fetchGhlContact } from './_lib/ghl-contact.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const ABORT_MS = 55_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const requiredEnvVars = ['GHL_API_KEY', 'GHL_LOCATION_ID', 'GHL_DAVE_USER_ID', 'DAVE_PROFILE_ID'];
  for (const name of requiredEnvVars) {
    if (!process.env[name]) {
      console.error('[follow-up-ghl-poll] missing env var:', name);
      return res.status(500).json({ error: `Env var ${name} niet geconfigureerd.` });
    }
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
    url.searchParams.set('userId',     process.env.GHL_DAVE_USER_ID);
    url.searchParams.set('startTime',  String(startDate.getTime()));
    url.searchParams.set('endTime',    String(endDate.getTime()));

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

      if (event.assignedUserId && event.assignedUserId !== process.env.GHL_DAVE_USER_ID) {
        results.push({ id: event.id, skipped: true, reason: 'not-dave' });
        continue;
      }

      // Check of dit appointment al bestaat met een handmatig gemuteerde status
      const { data: existing } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, status')
        .eq('ghl_appointment_id', event.id)
        .maybeSingle();

      const manualStatuses = ['no_show', 'completed', 'in_progress', 'cancelled'];
      const ghlMappedStatus = mapGhlStatus(event.appointmentStatus);
      const useStatus = (existing && manualStatuses.includes(existing.status))
        ? existing.status  // Bewaar handmatig gezette status
        : ghlMappedStatus;

      // GHL is source of truth: als row eerder 'verplaatst' was (door onze UI)
      // maar GHL zet hem terug naar scheduled, zijn child-rijen (ghl_id=null) wees-rijen.
      const wasVerplaatst = existing?.status === 'verplaatst';

      if (existing && manualStatuses.includes(existing.status)) {
        console.log('[follow-up-ghl-poll] status behouden (handmatig gemuteerd):', event.id, existing.status);
      }

      // Email/phone: GHL calendar events bevatten niet altijd deze velden.
      // Als ze ontbreken in het event, haal ze op via de Contacts API.
      let leadEmail = event.email || null;
      let leadPhone = event.phone || null;

      if ((!leadEmail || !leadPhone) && event.contactId) {
        const contact = await fetchGhlContact(event.contactId);
        if (contact) {
          if (!leadEmail && contact.email) leadEmail = contact.email;
          if (!leadPhone && contact.phone) leadPhone = contact.phone;
        }
      }

      const row = {
        ghl_appointment_id: event.id,
        lead_name:           event.title || event.contactName || 'Onbekend',
        lead_email:          leadEmail,
        lead_phone:          leadPhone,
        lead_ghl_contact_id: event.contactId,
        scheduled_at:        event.startTime,
        duration_minutes:    event.durationMinutes || 30,
        status:              useStatus,
        owner_id:            process.env.DAVE_PROFILE_ID,
        updated_at:          new Date().toISOString(),
      };

      // 2-step pattern: SELECT existing → UPDATE of INSERT
      // Reden: partial-unique constraints zijn geen geldige ON CONFLICT-arbiter
      // in PostgREST. existing.id is al beschikbaar van de select boven.
      let error;
      if (existing?.id) {
        const { error: upErr } = await supabaseAdmin
          .from('follow_up_appointments')
          .update(row)
          .eq('id', existing.id);
        error = upErr;
      } else {
        const { error: insErr } = await supabaseAdmin
          .from('follow_up_appointments')
          .insert(row);
        error = insErr;
      }

      if (error) {
        console.error('[follow-up-ghl-poll] upsert fout:', event.id, error.message);
      }
      results.push({ id: event.id, ok: !error, email: leadEmail ? 'ja' : 'nee', error: error?.message || null });

      // GHL-rollback detectie: parent was 'verplaatst' maar GHL zette hem terug naar scheduled.
      // Cancel wees-children (ghl_id=null) zodat ze niet dubbel in de UI verschijnen.
      if (wasVerplaatst && useStatus === 'scheduled' && !error) {
        const { data: orphans, error: orphErr } = await supabaseAdmin
          .from('follow_up_appointments')
          .update({
            status: 'cancelled',
            updated_at: new Date().toISOString(),
          })
          .eq('parent_appointment_id', existing.id)
          .is('ghl_appointment_id', null)
          .eq('status', 'scheduled')
          .select('id');

        if (orphErr) {
          console.error('[appointment-poll] orphan cleanup failed:', existing.id, orphErr?.message, orphErr);
        } else if (orphans?.length > 0) {
          console.log('[appointment-poll] orphans gecancelled:', existing.id, 'children:', orphans.map(o => o.id));
        }
      }
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
    // noshow: poll mag GEEN no_show zetten — alleen via command-center
    // outcome (api/follow-up-outcomes.js). GHL markeert events autonoom
    // als noshow zodra tijd voorbij is, ook tijdens lopende calls.
    cancelled: 'cancelled',
    invalid:   'cancelled',
  };
  return map[ghlStatus] || 'scheduled';
}
