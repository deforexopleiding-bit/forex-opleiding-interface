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
import { upsertLeadAttribution } from './_lib/lead-attribution.js';
import { listUpcomingZoomMeetings } from './_lib/zoom-meeting.js';
import { listActiveCalendarIds } from './_lib/ghl-calendars.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const ABORT_MS = 55_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  // GHL_DAVE_USER_ID is niet meer vereist: we pollen per-calendar over ALLE
  // actieve agenda's i.p.v. per-user. DAVE_PROFILE_ID blijft de sync-owner (RLS).
  const requiredEnvVars = ['GHL_API_KEY', 'GHL_LOCATION_ID', 'DAVE_PROFILE_ID'];
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

    // Per-calendar over ALLE actieve GHL-agenda's (was: alleen userId=Dave).
    // Elk event krijgt zijn calendarId mee zodat we ghl_calendar_id kunnen zetten.
    const calendarIds = await listActiveCalendarIds({ token: process.env.GHL_API_KEY, locationId: process.env.GHL_LOCATION_ID });
    if (calendarIds.length === 0) {
      console.warn('[follow-up-ghl-poll] geen actieve calendars gevonden (of calendars-list faalde)');
    }
    // 2026-09-08 (PR reparatie) — Rollback van de PR B date-chunking:
    // GHL /calendars/events accepteerde de `limit=200`-hint niet en gaf
    // 422 Unprocessable Entity op elke chunk-fetch → sync viel volledig
    // stuk, functie 504't op 30s timeout. De opdracht van PR B (paginatie)
    // was ook niet nodig: GHL retourneert ALLE events in een start/end
    // window in één response zonder cursor-limiet, zolang alleen startTime
    // + endTime worden gestuurd. Terug naar één fetch per calendar over
    // een breder window (now-7d t/m now+90d) om ook net-verleden en
    // ver-toekomstige boekingen mee te nemen.
    //
    // Safety-gate (PR A) blijft actief PER CALENDAR: als de fetch voor
    // een specifieke agenda faalt (422 / 5xx / timeout / exception), wordt
    // die agenda gemarkeerd als incompleet. Ghost-cleanup + auto-resolve
    // slaan dan calls op die agenda over — nooit een 'scheduled'-rij
    // ten onrechte flippen omdat de events voor die agenda ontbraken.
    const eventsById = new Map();     // dedup over calendars, id-based
    const calendarsWithCompleteFetch = new Set();  // set van calId's waar de fetch WEL gelukt is
    let shapeLogged = false;
    // Verbreed window: 7 dagen terug (bevestigde no-shows) t/m 90 dagen
    // vooruit (zicht op langere-termijn boekingen).
    let fetchStartMs = startDate.getTime() - 7 * 86400000;
    let fetchEndMs   = startDate.getTime() + 90 * 86400000;

    // 2026-09-09 — Window-dekking DB-check: als er 'scheduled' rijen in de
    // DB staan die verder liggen dan de default 90d-horizon, verbreed het
    // fetch-window zodat ghost-cleanup + auto-resolve nooit een rij buiten
    // het gefetchte window aanraken. Zonder deze check zouden events voor
    // die verre rijen niet in de fetch zitten, en zou de cleanup ze
    // (afgeschermd door de aparte scheduled_at-bounds hieronder) simpelweg
    // overslaan — dan draaien we blind langs ver-toekomstige geboekte calls.
    const { data: maxRow } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('scheduled_at')
      .eq('status', 'scheduled')
      .not('ghl_appointment_id', 'is', null)
      .order('scheduled_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxScheduledMs = maxRow?.scheduled_at ? new Date(maxRow.scheduled_at).getTime() : null;
    if (maxScheduledMs && maxScheduledMs > fetchEndMs) {
      const bufferedEndMs = maxScheduledMs + 7 * 86400000; // 7d buffer voorbij max
      console.log('[follow-up-ghl-poll] fetch-window verbreed:',
        'max scheduled_at in DB is', new Date(maxScheduledMs).toISOString(),
        '— fetchEnd verplaatst naar', new Date(bufferedEndMs).toISOString());
      fetchEndMs = bufferedEndMs;
    }
    const fetchStartISO = new Date(fetchStartMs).toISOString();
    const fetchEndISO   = new Date(fetchEndMs).toISOString();

    for (const calId of calendarIds) {
      // 2026-09-09 — Defensieve pagination-detectie. LeadConnector
      // /calendars/events (Version 2021-04-15) retourneert per spec ALLE
      // events binnen het window in één response, zonder cursor/nextPage/
      // total-veld. HTTP 200 = compleet. We loggen echter de response-keys
      // + eventuele `total`/`count`/`nextPageToken`/`meta.pagination`, zodat
      // een stille API-wijziging (nieuwe cursor of impliciete cap) hier
      // opvalt: bij aanwijzing van truncatie markeren we de kalender NIET
      // als compleet, waardoor de safety-gate ghost-cleanup blokkeert voor
      // die agenda i.p.v. te flippen op onvolledige data.
      const url = new URL(`${GHL_API_BASE}/calendars/events`);
      url.searchParams.set('locationId', process.env.GHL_LOCATION_ID);
      url.searchParams.set('calendarId', calId);
      url.searchParams.set('startTime',  String(fetchStartMs));
      url.searchParams.set('endTime',    String(fetchEndMs));
      try {
        const ghlRes = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' },
        });
        if (!ghlRes.ok) {
          const errText = await ghlRes.text().catch(() => '');
          console.error('[follow-up-ghl-poll] GHL events fout',
            'calendar:', calId, 'status:', ghlRes.status, (errText || '').slice(0, 400));
          continue; // fail-soft — safety-gate voorkomt ghost-flip voor deze agenda
        }
        const json = await ghlRes.json();
        if (!shapeLogged) {
          console.log('[follow-up-ghl-poll] response-shape diagnostiek (eerste calendar):',
            'keys:', Object.keys(json || {}),
            'total:', json?.total, 'count:', json?.count,
            'nextPageToken:', json?.nextPageToken ?? json?.nextPage ?? json?.next_page_token ?? null,
            'meta:', json?.meta ? Object.keys(json.meta) : null,
            'events_length:', (json?.events || json?.data || []).length);
          shapeLogged = true;
        }
        const evs = json.events || json.data || [];

        // Pagination-drift detectie. Als één van deze signalen opduikt, kan
        // de response afgekapt zijn en is de kalender NIET veilig compleet.
        const hasNextCursor = !!(json?.nextPageToken || json?.nextPage
          || json?.next_page_token || json?.meta?.nextPageToken
          || json?.meta?.pagination?.nextPage || json?.pagination?.nextPage);
        const totalHint = Number.isFinite(json?.total) ? json.total : null;
        const truncated = hasNextCursor || (totalHint !== null && totalHint > evs.length);

        for (const e of evs) {
          if (!e.calendarId) e.calendarId = calId;
          if (e.id) eventsById.set(e.id, e);
        }

        if (truncated) {
          console.warn('[follow-up-ghl-poll] mogelijke truncatie gedetecteerd',
            'calendar:', calId, 'events_length:', evs.length,
            'total:', totalHint, 'hasNextCursor:', hasNextCursor,
            '— kalender NIET als compleet gemarkeerd, ghost-cleanup skipt deze run');
          // GEEN calendarsWithCompleteFetch.add() — safety-gate blijft
          // dicht voor deze agenda deze run. Zodra de shape-diagnostiek in
          // logs de nieuwe cursor-vorm laat zien, kan hier een echte
          // page-through loop komen (analoog aan andere GHL-endpoints).
        } else {
          calendarsWithCompleteFetch.add(calId);
        }
      } catch (e) {
        console.warn('[follow-up-ghl-poll] events-fetch exception',
          'calendar:', calId, e?.message || e);
      }
    }
    const events = Array.from(eventsById.values());
    console.log('[follow-up-ghl-poll] events opgehaald:', events.length,
      'over', calendarsWithCompleteFetch.size, '/', calendarIds.length, 'calendars (compleet)',
      'window:', fetchStartISO, '→', fetchEndISO);
    // Safety-gate signalering: als NIET alle calendars gelukt zijn, log het
    // en gebruik verderop calendarsWithCompleteFetch om per-calendar te
    // beslissen of ghost-cleanup mag draaien.
    const someCalendarsFailed = calendarsWithCompleteFetch.size < calendarIds.length;
    if (someCalendarsFailed) {
      console.warn('[follow-up-ghl-poll] safety-gate — niet alle agenda\'s compleet:',
        calendarIds.length - calendarsWithCompleteFetch.size, 'agenda(s) faalden;',
        'ghost-cleanup wordt voor die agenda\'s overgeslagen.');
    }

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

      // Guard tegen malformed events. Zonder id kunnen we niet upsert-by-id;
      // zonder startTime is scheduled_at NOT NULL constraint een gelijkstart.
      // Los loggen — een misparse mag de rest van de events niet blokkeren.
      if (!event.id) {
        console.warn('[follow-up-ghl-poll] skip event zonder id:', JSON.stringify(event).slice(0, 200));
        results.push({ skipped: true, reason: 'no_event_id' });
        continue;
      }
      if (!event.startTime) {
        console.warn('[follow-up-ghl-poll] skip event zonder startTime:',
          event.id, 'title:', event.title || event.contactName || '?');
        results.push({ id: event.id, skipped: true, reason: 'no_start_time' });
        continue;
      }

      // (Geen user-filter meer — we pollen alle agenda's.)

      // Check of dit appointment al bestaat met een handmatig gemuteerde status
      // TIJDELIJK — extra kolommen `lead_name, scheduled_at, updated_at` in de
      // select voor de diagnose-logregel hieronder. Verwijderen zodra de
      // "handmatig gemuteerd"-guard-diagnose klaar is.
      const { data: existing } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, status, zoom_meeting_id, zoom_join_url, ghl_calendar_id, lead_name, scheduled_at, updated_at')
        .eq('ghl_appointment_id', event.id)
        .maybeSingle();

      const manualStatuses = ['no_show', 'completed', 'in_progress', 'cancelled',
                              'verplaatst', 'verwijderd', 'wacht_op_reschedule'];
      const ghlMappedStatus = mapGhlStatus(event.appointmentStatus);
      const useStatus = (existing && manualStatuses.includes(existing.status))
        ? existing.status  // Bewaar handmatig gezette status
        : ghlMappedStatus;

      // GHL is source of truth: als row eerder 'verplaatst' was (door onze UI)
      // maar GHL zet hem terug naar scheduled, zijn child-rijen (ghl_id=null) wees-rijen.
      const wasVerplaatst = existing?.status === 'verplaatst';

      if (existing && manualStatuses.includes(existing.status)) {
        // TIJDELIJK — verwijderen zodra de "handmatig gemuteerd"-guard-diagnose
        // klaar is (2026-09-09). De guard hierboven is een pure hardcoded
        // whitelist over `existing.status`; er is GEEN manual_override kolom,
        // GEEN status_source veld, GEEN updated_at vs ghl_synced vergelijking.
        // Elke rij die door de ghost-flip bug op wacht_op_reschedule /
        // cancelled / no_show is beland wordt daardoor als "handmatig"
        // behandeld en NIET automatisch teruggezet — alleen de reverse-heal
        // fase kan die rijen nog herstellen. Deze log toont per getroffen rij
        // of het GHL-event momenteel actief is, zodat we in Vercel logs
        // kunnen zien hoeveel cat-B "actief in GHL" rijen door deze guard
        // vastgehouden worden.
        const GHL_ACTIVE_STATUSES_DIAG = new Set(['confirmed', 'booked', 'scheduled', 'showed']);
        const ghlStatusRaw = String(event.appointmentStatus || '').toLowerCase();
        const isGhlActive  = GHL_ACTIVE_STATUSES_DIAG.has(ghlStatusRaw);
        console.log('[follow-up-ghl-poll] status behouden (handmatig gemuteerd):',
          'db_id:', existing.id,
          '| naam:', existing.lead_name || event.title || event.contactName || '?',
          '| db_status:', existing.status,
          '| scheduled_at:', existing.scheduled_at,
          '| updated_at:', existing.updated_at,
          '| ghl_status_raw:', ghlStatusRaw || '(leeg)',
          '| ghl_active:', isGhlActive ? 'JA' : 'nee',
          '| ghl_appt_id:', event.id);
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
          // Meta/UTM/GHL-attributie vangen (fase 2 ROAS-fundering). Best-effort:
          // een fout hier mag NOOIT de poll breken — helper is defensief
          // (isMissingRelationError → skip; try/catch omheen als vangnet).
          try {
            await upsertLeadAttribution({
              ghl_contact_id: event.contactId,
              email:          contact.email || leadEmail,
              phone:          contact.phone || leadPhone,
              attr:           contact, // helper leest .attributionSource + .lastAttributionSource
            });
          } catch (e) {
            console.warn('[follow-up-ghl-poll] attribution upsert:', e?.message || e);
          }
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
        ghl_calendar_id:     event.calendarId   || existing?.ghl_calendar_id || null,
      };

      // 2-step pattern: SELECT existing → UPDATE of INSERT
      // Reden: partial-unique constraints zijn geen geldige ON CONFLICT-arbiter
      // in PostgREST. existing.id is al beschikbaar van de select boven.
      // Fail-soft voor de nieuwe ghl_calendar_id-kolom: draait migratie A nog
      // niet, dan strip 'em uit de write en probeer opnieuw (42703 = undefined column).
      async function schrijf(r) {
        if (existing?.id) return (await supabaseAdmin.from('follow_up_appointments').update(r).eq('id', existing.id)).error;
        return (await supabaseAdmin.from('follow_up_appointments').insert(r)).error;
      }
      let error = await schrijf(row);
      if (error && (error.code === '42703' || /ghl_calendar_id/.test(error.message || '')) && 'ghl_calendar_id' in row) {
        const { ghl_calendar_id: _weg, ...zonder } = row;
        error = await schrijf(zonder);
      }

      if (error) {
        console.error('[follow-up-ghl-poll] upsert fout:', event.id, error.message);
      } else if (!existing?.id) {
        // Nieuwe DB-rij aangemaakt — expliciet loggen zodat we per run
        // zien welke GHL-events voor 't eerst binnen kwamen. Belangrijk
        // voor triage van "wel in GHL, niet in CRM"-cases.
        console.log('[follow-up-ghl-poll] INSERT nieuwe rij:',
          event.id, '|', row.lead_name, '|', row.scheduled_at, '|', useStatus);
      }
      results.push({
        id: event.id,
        ok: !error,
        inserted: !error && !existing?.id,
        email: leadEmail ? 'ja' : 'nee',
        error: error?.message || null,
      });

      // Sync-brug (2026-08-20 fix Kandidaat F): schrijf leads.afspraak_op
      // op basis van deze appointment. Alleen bij succesvolle upsert; fail-
      // soft (een fout hier mag de poll niet stoppen).
      if (!error) {
        try {
          const leadSync = await syncLeadAfspraakOp({
            leadEmail:   leadEmail,
            scheduledAt: event.startTime,
            status:      useStatus,
          });
          if (leadSync && leadSync.matched === 'email') {
            console.log('[follow-up-ghl-poll] leads.afspraak_op gesynct:', event.id, leadEmail, '→', leadSync.afspraak_op);
          }
        } catch (e) {
          console.warn('[follow-up-ghl-poll] lead-sync faalde (fail-soft):', event.id, e?.message || e);
        }
      }

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
    // 2026-09-08 (PR A safety-gate — PER CALENDAR):
    // Ghost-cleanup mag ALLEEN draaien op rijen waar de events-fetch voor die
    // specifieke agenda gelukt is. Zonder complete lijst per agenda zou de
    // ghost-check DB-rijen ten onrechte als "verweesd" markeren (bewijs:
    // sep-2026 kennismakings-agenda 76% van week 14+ op 'wacht_op_reschedule'
    // door truncatie). Faalt een agenda-fetch (422 / 5xx / timeout), dan
    // slaan we cleanup voor die agenda over — de rest gaat wél door.
    let ghostsHandled = 0;
    const completeCalendarIds = Array.from(calendarsWithCompleteFetch);
    if (completeCalendarIds.length === 0) {
      console.warn('[follow-up-ghl-poll] safety-gate ACTIEF — geen enkele agenda compleet, ghost-cleanup + auto-resolve OVERGESLAGEN');
    } else if (events.length > 0) {
      const ghlIds = new Set(events.map(e => e.id));

      // 2026-09-09 — Cleanup-scope is STRIKT gelijk aan het fetch-window.
      // Een 'scheduled' rij buiten [fetchStartISO, fetchEndISO] mag NOOIT
      // naar wacht_op_reschedule, want daar hebben we geen events voor
      // opgehaald. Fetch-window is bovendien dynamisch verbreed als de DB
      // een rij verder dan de default 90d bevat (zie block bovenaan).
      const { data: dbScheduled } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, ghl_appointment_id, ghl_calendar_id, lead_name, scheduled_at')
        .eq('status', 'scheduled')
        .not('ghl_appointment_id', 'is', null)
        .in('ghl_calendar_id', completeCalendarIds)  // per-calendar safety-gate
        .gte('scheduled_at', fetchStartISO)          // window-safety-gate
        .lt('scheduled_at', fetchEndISO);

      const ghosts = (dbScheduled || []).filter(a => !ghlIds.has(a.ghl_appointment_id));
      console.log('[follow-up-ghl-poll] ghosts found:', ghosts.length);

      for (const ghost of ghosts) {
        // Status flip naar 'wacht_op_reschedule' (klant heeft via GHL gereschedduld)
        await supabaseAdmin
          .from('follow_up_appointments')
          .update({
            status: 'wacht_op_reschedule',
            updated_at: new Date().toISOString(),
          })
          .eq('id', ghost.id);

        // Audit-log entry
        const { error: auditErr } = await supabaseAdmin
          .from('follow_up_events_log')
          .insert({
            source: 'cron',
            event_type: 'appointment_ghost_wacht_op_reschedule',
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

        console.log('[follow-up-ghl-poll] ghost wacht_op_reschedule:', ghost.id, ghost.lead_name, ghost.scheduled_at);
        ghostsHandled++;
      }

      if (ghostsHandled > 0) {
        console.log(`[follow-up-ghl-poll] ${ghostsHandled} ghost(s) als wacht_op_reschedule gemarkeerd`);
      }
    } else {
      console.log('[follow-up-ghl-poll] events.length=0, ghost-cleanup overgeslagen');
    }

    // ── Auto-resolve: wacht_op_reschedule rijen waarvan de lead een nieuwe scheduled heeft ──
    // 2026-09-08 (PR A safety-gate — PER CALENDAR): auto-resolve mag alleen
    // draaien voor rijen op agenda's waar de events-fetch compleet is. Deze
    // loop kan 'wacht_op_reschedule' → 'cancelled' flippen op basis van
    // dezelfde onvolledige data — nog een cascade-stap die verkeerde
    // status-drift veroorzaakt bij incomplete fetch.
    const { data: waitingList } = (completeCalendarIds.length === 0)
      ? { data: [] }
      : await supabaseAdmin
          .from('follow_up_appointments')
          .select('id, lead_ghl_contact_id, lead_name, scheduled_at')
          .eq('status', 'wacht_op_reschedule')
          .not('lead_ghl_contact_id', 'is', null)
          .in('ghl_calendar_id', completeCalendarIds)  // per-calendar safety-gate
          .gte('scheduled_at', fetchStartISO)           // window-safety-gate
          .lt('scheduled_at', fetchEndISO);

    let resolvedCount = 0;
    for (const waiting of (waitingList || [])) {
      const { data: newScheduled } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id')
        .eq('lead_ghl_contact_id', waiting.lead_ghl_contact_id)
        .eq('status', 'scheduled')
        .gte('scheduled_at', new Date().toISOString())
        .neq('id', waiting.id)
        .limit(1);

      if (newScheduled && newScheduled.length > 0) {
        await supabaseAdmin
          .from('follow_up_appointments')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', waiting.id);

        await supabaseAdmin
          .from('follow_up_events_log')
          .insert({
            source: 'cron',
            event_type: 'appointment_auto_resolved',
            payload: {
              appointment_id: waiting.id,
              lead_name: waiting.lead_name,
              old_status: 'wacht_op_reschedule',
              new_status: 'cancelled',
              resolved_by_appointment: newScheduled[0].id,
              reason: 'Klant heeft nieuwe afspraak ingepland',
            },
            processed: true,
          });

        resolvedCount++;
        console.log('[follow-up-ghl-poll] auto-resolved:', waiting.id, waiting.lead_name);
      }
    }

    if (resolvedCount > 0) {
      console.log(`[follow-up-ghl-poll] ${resolvedCount} wacht_op_reschedule auto-resolved`);
    }

    // ── REVERSE HEAL — TIJDELIJKE opruim-pass voor flip-bug collateral ─────
    //
    // BELANGRIJK: de manualStatuses-guard in de main-sync-loop blijft
    // ONGEWIJZIGD. GHL wordt NIET leidend. Deze pass is puur eenmalig
    // opruimen van rijen die door de flip-bug (PR B #1531 → 422 → poll
    // ghost-flip → auto-resolve cascade) verkeerd op cancelled of
    // wacht_op_reschedule zijn beland.
    //
    // Bron-set:
    //   * wacht_op_reschedule → altijd herstellen als GHL-event actief is.
    //   * cancelled           → altijd herstellen als GHL-event actief is.
    //   * no_show             → NIET herstellen (setter-eigen; blijft van
    //                            de appointment-setter zelf).
    //
    // Doel-status via mapGhlStatus (spiegelt de main-sync-loop):
    //   confirmed / booked / scheduled → scheduled
    //   showed                          → completed
    //   GHL cancelled / noshow / invalid → NIET herstellen.
    //
    // Gates die intact blijven:
    //   * completeCalendarIds (per-calendar safety-gate)
    //   * scheduled_at IN [fetchStartISO, fetchEndISO] (window-gate)
    //   * event moet in de huidige GHL-fetch zitten (evt lookup)
    //   * race-guard .eq('status', row.status) op de UPDATE
    //
    // TIJDELIJK — verwijderen zodra:
    //   1. de collateral verifieerbaar weg is (recon-endpoint → 0
    //      cat-B rijen met actief GHL-event), én
    //   2. CRM→GHL annuleren-stap er is (dan is de gebruikers-cancel
    //      idempotent aan beide kanten en heeft deze auto-heal geen
    //      opruimtaak meer).
    // Dan gaat dit HELE reverse-heal-blok eruit in één opruim-PR.
    const GHL_ACTIVE_STATUSES = new Set(['confirmed', 'booked', 'scheduled', 'showed']);

    let reverseHealedGhosts    = 0;   // uit bron wacht_op_reschedule
    let reverseHealedCancelled = 0;   // uit bron cancelled

    if (events.length === 0 || completeCalendarIds.length === 0) {
      if (completeCalendarIds.length === 0) {
        console.warn('[follow-up-ghl-poll] REVERSE HEAL overgeslagen — geen enkele agenda compleet');
      }
    } else {
      const eventsByGhlId = new Map(events.map(e => [e.id, e]));

      // Kandidaat-rijen: wacht_op_reschedule + cancelled (no_show bewust weg).
      // Geen updated_at-datumgate meer — de bug-window was te smal en liet
      // pre-2026-09-08 collateral (auto-resolve-slachtoffers Sep 4-8) hangen.
      const { data: sourceRows } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, ghl_appointment_id, ghl_calendar_id, lead_name, scheduled_at, status, updated_at')
        .in('status', ['wacht_op_reschedule', 'cancelled'])
        .not('ghl_appointment_id', 'is', null)
        .in('ghl_calendar_id', completeCalendarIds)
        .gte('scheduled_at', fetchStartISO)
        .lt('scheduled_at', fetchEndISO);

      for (const row of (sourceRows || [])) {
        const evt = eventsByGhlId.get(row.ghl_appointment_id);
        if (!evt) continue;                                     // event niet meer in GHL

        const ghlStatus = String(evt.appointmentStatus || '').toLowerCase();
        if (!GHL_ACTIVE_STATUSES.has(ghlStatus)) continue;      // niet actief → skip

        const target = mapGhlStatus(ghlStatus);                 // scheduled of completed
        if (!target || target === row.status) continue;          // niks te wijzigen

        const { error: updErr } = await supabaseAdmin
          .from('follow_up_appointments')
          .update({ status: target, updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', row.status);                            // race-guard
        if (updErr) {
          console.error('[follow-up-ghl-poll] reverse-heal update failed:',
            row.id, row.lead_name, row.status, '->', target, updErr?.message);
          continue;
        }

        await supabaseAdmin.from('follow_up_events_log').insert({
          source: 'cron',
          event_type: 'appointment_reverse_healed',
          payload: {
            appointment_id: row.id,
            ghl_appointment_id: row.ghl_appointment_id,
            lead_name: row.lead_name,
            scheduled_at: row.scheduled_at,
            from_status: row.status,
            to_status: target,
            ghl_status: ghlStatus,
            reason: 'TIJDELIJKE opruim-pass flip-bug collateral — GHL-event weer actief',
          },
          processed: true,
        });

        // Per-rij logging (Vercel-log tuning): id + naam + oude → nieuwe status.
        console.log('[follow-up-ghl-poll] reverse-heal:',
          row.id, '|', row.lead_name, '|', row.status, '->', target,
          '(ghl:', ghlStatus + ')');

        if (row.status === 'wacht_op_reschedule')  reverseHealedGhosts++;
        else if (row.status === 'cancelled')       reverseHealedCancelled++;
      }

      const totalHealed = reverseHealedGhosts + reverseHealedCancelled;
      if (totalHealed > 0) {
        console.log('[follow-up-ghl-poll] REVERSE HEAL totaal:', totalHealed,
          '(wacht_op_reschedule:', reverseHealedGhosts,
          '| cancelled:', reverseHealedCancelled + ')');
      }
    }
    // ── EINDE REVERSE HEAL — TIJDELIJKE opruim-pass ─────────────────────────

    const ok     = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.skipped).length;
    console.log(`[follow-up-ghl-poll] ${ok} gesynchroniseerd, ${failed} mislukt van ${events.length} events`);
    return res.status(200).json({
      synced: ok, failed, total: events.length,
      ghosts: ghostsHandled, resolved: resolvedCount,
      reverse_healed_ghosts:    reverseHealedGhosts,
      reverse_healed_cancelled: reverseHealedCancelled,
      results,
    });
  } catch (err) {
    console.error('[follow-up-ghl-poll] onverwachte fout:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Sync-brug: schrijf leads.afspraak_op na iedere follow_up_appointments-
// upsert of status-flip in deze poll. Kandidaat F uit DIAGNOSE-3 (2026-08-20):
// tot dusver zette alleen api/lisa-ghl-appointment-webhook.js dat veld —
// call-boekingen via de Follow-up/GHL-agenda (deze poll) verschenen niet in
// de Leads-module omdat de brug ontbrak. Spiegelt exact het gedrag van
// koppelAfspraakAanLead in de Lisa-webhook: case-insensitive email-match,
// verwijderd_op-filter, fail-soft. Alleen email — de leads-tabel heeft
// GEEN ghl_contact_id, dus phone-fallback is hier niet zinvol.
//
// IDEMPOTENT: fetcht huidige leads.afspraak_op en schrijft alleen bij
// verschil. Anders zou elke 15-min-poll-cyclus onnodig N writes doen.
async function syncLeadAfspraakOp({ leadEmail, scheduledAt, status }) {
  const activeStatuses = ['scheduled', 'confirmed', 'rescheduled'];
  const cancelStatuses = ['cancelled', 'canceled', 'no_show', 'noshow'];
  const stLower = String(status || '').toLowerCase();
  let target;
  if (activeStatuses.includes(stLower)) target = scheduledAt || null;
  else if (cancelStatuses.includes(stLower)) target = null;
  else return { skipped: 'status_no_change', status };

  const email = String(leadEmail || '').trim().toLowerCase();
  if (!email) return { skipped: 'no_email' };

  const escLike = (s) => s.replace(/[%_\\]/g, (m) => '\\' + m);
  const { data: cur, error: selErr } = await supabaseAdmin
    .from('leads')
    .select('id, afspraak_op')
    .ilike('email', escLike(email))
    .is('verwijderd_op', null);
  if (selErr) throw new Error('leads-select: ' + selErr.message);
  if (!cur || !cur.length) return { matched: 'none', email };

  const targetIso = target ? new Date(target).toISOString() : null;
  const toUpdate = cur.filter((l) => {
    const curIso = l.afspraak_op ? new Date(l.afspraak_op).toISOString() : null;
    return curIso !== targetIso;
  });
  if (!toUpdate.length) return { matched: 'noop', count: cur.length };

  const { error: updErr } = await supabaseAdmin
    .from('leads')
    .update({ afspraak_op: target })
    .in('id', toUpdate.map((l) => l.id));
  if (updErr) throw new Error('leads-update: ' + updErr.message);
  return { matched: 'email', count: toUpdate.length, afspraak_op: target };
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
