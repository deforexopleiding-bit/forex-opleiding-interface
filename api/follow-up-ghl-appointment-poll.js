// api/follow-up-ghl-appointment-poll.js
//
// Cron-endpoint: pollt GHL Calendar Events API en upsert appointments
// naar follow_up_appointments. Draait elke 15 minuten via vercel.json.
//
// Haalt appointments op van vandaag 00:00 t/m +30 dagen.
// Idempotent: upsert op ghl_appointment_id.
// owner_id = DAVE_PROFILE_ID zodat sales-user (Dave) zijn eigen appointments via RLS kan zien

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { fetchGhlContact } from './_lib/ghl-contact.js';
import { listUpcomingZoomMeetings } from './_lib/zoom-meeting.js';

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
    endDate.setDate(endDate.getDate() + 30);

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

    // Haal Dave's upcoming Zoom-meetings op (graceful: lege array bij fout)
    const zoomUserId = process.env.ZOOM_USER_ID;
    const zoomMeetings = await listUpcomingZoomMeetings(zoomUserId);

    // Bouw match-map: ISO-minuut ('YYYY-MM-DDTHH:MM') → array van { id, join_url, topic }
    const zoomByMinute = new Map();
    for (const m of zoomMeetings) {
      const key = new Date(m.start_time).toISOString().slice(0, 16);
      const entry = { id: String(m.id), join_url: m.join_url || null, topic: m.topic || '' };
      const arr = zoomByMinute.get(key);
      if (arr) arr.push(entry);
      else zoomByMinute.set(key, [entry]);
    }
    console.log('[follow-up-ghl-poll] zoom upcoming meetings:', zoomMeetings.length);

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
        .select('id, status, zoom_meeting_id, zoom_join_url')
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

      // Match Zoom-meeting op start_time-minuut + topic-fallback
      const apptMinute = new Date(event.startTime).toISOString().slice(0, 16);
      const zoomCandidates = zoomByMinute.get(apptMinute) || [];
      let zoomMatch = null;
      if (zoomCandidates.length === 1) {
        zoomMatch = zoomCandidates[0];
      } else if (zoomCandidates.length > 1) {
        const title = (event.title || '').toLowerCase();
        zoomMatch = zoomCandidates.find(c => title && c.topic.toLowerCase().includes(title)) || zoomCandidates[0];
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
        zoom_meeting_id:     zoomMatch?.id       || existing?.zoom_meeting_id || null,
        zoom_join_url:       zoomMatch?.join_url || existing?.zoom_join_url   || null,
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

    // ── Ghost-cleanup: scheduled DB-rijen die GHL niet meer teruggeeft ────────
    let ghostsHandled = 0;
    if (events.length > 0) {
      const ghlIds = new Set(events.map(e => e.id));

      const { data: dbScheduled } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, ghl_appointment_id, lead_name, scheduled_at')
        .eq('status', 'scheduled')
        .not('ghl_appointment_id', 'is', null)
        .gte('scheduled_at', startDate.toISOString())
        .lt('scheduled_at', endDate.toISOString());

      const ghosts = (dbScheduled || []).filter(a => !ghlIds.has(a.ghl_appointment_id));
      console.log('[follow-up-ghl-poll] ghosts found:', ghosts.length);

      for (const ghost of ghosts) {
        // Status flip naar 'verplaatst' (klant heeft via GHL gereschedduld)
        await supabaseAdmin
          .from('follow_up_appointments')
          .update({
            status: 'verplaatst',
            updated_at: new Date().toISOString(),
          })
          .eq('id', ghost.id);

        // Audit-log entry
        const { error: auditErr } = await supabaseAdmin
          .from('follow_up_events_log')
          .insert({
            source: 'cron',
            event_type: 'appointment_ghost_verplaatst',
            payload: {
              appointment_id: ghost.id,
              ghl_appointment_id: ghost.ghl_appointment_id,
              lead_name: ghost.lead_name,
              scheduled_at: ghost.scheduled_at,
              cleanup_source: 'ghl-poll-ghost-cleanup',
              reason: 'GHL stuurde event niet meer (klant rescheduled of geannuleerd)',
              poll_window_days: 30,
            },
            processed: true,
          });
        if (auditErr) {
          console.error('[follow-up-ghl-poll] ghost audit-log insert FAILED:', auditErr);
        }

        console.log('[follow-up-ghl-poll] ghost verplaatst:', ghost.id, ghost.lead_name, ghost.scheduled_at);
        ghostsHandled++;
      }

      if (ghostsHandled > 0) {
        console.log(`[follow-up-ghl-poll] ${ghostsHandled} ghost(s) als verplaatst gemarkeerd`);
      }
    } else {
      console.log('[follow-up-ghl-poll] events.length=0, ghost-cleanup overgeslagen');
    }

    const ok     = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.skipped).length;
    console.log(`[follow-up-ghl-poll] ${ok} gesynchroniseerd, ${failed} mislukt van ${events.length} events`);
    return res.status(200).json({ synced: ok, failed, total: events.length, ghosts: ghostsHandled, results });
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
