// api/follow-up-opvolglijst.js
//
// GET — Uniforme opvolglijst met VIER bronnen:
//   1. 'event_noshow'    — no-show attendees van afgeronde events
//                          (dezelfde regel als follow-up-no-show-list.js).
//   2. 'zoom_noshow'     — follow_up_appointments met status='no_show'
//                          (zoom_meeting_id set → 'Zoom no-show', anders
//                          'Afspraak no-show').
//   3. 'zoom_reschedule' — follow_up_appointments met
//                          status='wacht_op_reschedule'.
//   4. 'zoom_cancelled'  — follow_up_appointments met status='cancelled'.
//
// Uitgesloten: items met een afschrijf-marker
//   event_attendees.no_show_followup_status IN ('ander_event',
//     'geen_interesse','afgeschreven')
//   follow_up_appointments.follow_up_afgeschreven_at IS NOT NULL
//
// Response (uniform-schema):
//   { count, counts: { event_noshow, zoom_noshow, zoom_reschedule, zoom_cancelled },
//     items: [
//       { uid, herkomst, herkomst_label, type ('attendee'|'appointment'),
//         ref_id, name, email, phone, event_title|null, scheduled_at|null,
//         lead_id|null, lead_status|null, questionnaire_filled, actie_hint,
//         attendee_id (voor 'attendee'), event_id (voor 'attendee'),
//         no_show_followup_status (voor 'attendee'),
//         appointment_status (voor 'appointment') } ] }
//
// Fail-soft 42P01/42703 → betrokken bron wordt overgeslagen (lege
// deellijst), rest gaat door.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const OPEN_ATT_STATUSES = new Set([null, 'open', 'niet_bereikt', 'terugbellen']);

function displayName(a) {
  const parts = [a?.first_name, a?.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  const joined = parts.join(' ').trim();
  return joined || a?.email || a?.lead_name || '(onbekend)';
}

function herkomstLabel(key) {
  switch (key) {
    case 'event_noshow':    return 'Event no-show';
    case 'zoom_noshow':     return 'Zoom no-show';
    case 'zoom_reschedule': return 'Zoom reschedule';
    case 'zoom_cancelled':  return 'Zoom geannuleerd';
    case 'appt_noshow':     return 'Afspraak no-show';
    case 'appt_reschedule': return 'Afspraak reschedule';
    case 'appt_cancelled':  return 'Afspraak geannuleerd';
    default:                return key;
  }
}

function actieHint(key) {
  switch (key) {
    case 'event_noshow':    return 'Bellen — kwam niet naar event';
    case 'zoom_noshow':     return 'Bellen — kwam niet opdagen bij Zoom-call';
    case 'zoom_reschedule': return 'Bellen — wil call verzetten';
    case 'zoom_cancelled':  return 'Bellen — call geannuleerd, nagaan waarom';
    case 'appt_noshow':     return 'Bellen — kwam niet opdagen';
    case 'appt_reschedule': return 'Bellen — wil verzetten';
    case 'appt_cancelled':  return 'Bellen — geannuleerd, nagaan waarom';
    default:                return 'Bellen';
  }
}

// ── Event no-shows ──────────────────────────────────────────────────────
async function fetchEventNoShows() {
  try {
    const { data: events, error: eventsErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, completed_at')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(200);
    if (eventsErr) {
      if (eventsErr.code === '42P01' || eventsErr.code === '42703') return [];
      throw new Error('events fetch: ' + eventsErr.message);
    }
    if (!events || !events.length) return [];
    const eventById = new Map(events.map((e) => [e.id, e]));
    const eventIds  = events.map((e) => e.id);

    const RICH = 'id, event_id, customer_id, first_name, last_name, email, phone, assessment_response_id, no_show_followup_status, no_show_followup_at';
    const CORE = 'id, event_id, customer_id, first_name, last_name, email, phone, assessment_response_id';
    let att = [];
    let { data, error } = await supabaseAdmin
      .from('event_attendees').select(RICH)
      .eq('status', 'no_show').eq('is_test', false).in('event_id', eventIds);
    if (error) {
      if (error.code === '42703') {
        const { data: d2, error: e2 } = await supabaseAdmin
          .from('event_attendees').select(CORE)
          .eq('status', 'no_show').eq('is_test', false).in('event_id', eventIds);
        if (e2) return [];
        att = (d2 || []).map((r) => ({ ...r, no_show_followup_status: null }));
      } else if (error.code === '42P01') {
        return [];
      } else {
        throw new Error('event_attendees: ' + error.message);
      }
    } else {
      att = data || [];
    }
    // Uitsluiten: al afgehandeld met een sluitende outcome. Afgeschreven
    // is nu ook een sluitende outcome; 'niet_bereikt' en 'terugbellen'
    // blijven zichtbaar met markering.
    att = att.filter((a) => OPEN_ATT_STATUSES.has(a.no_show_followup_status || null));
    if (!att.length) return [];

    // Lead-koppeling: pak alle event-leads en filter client-side op event_id.
    let leadsRaw = [];
    try {
      const { data: leads, error: leadsErr } = await supabaseAdmin
        .from('follow_up_leads').select('id, customer_id, lead_status, source_ref').eq('source', 'event');
      if (!leadsErr) leadsRaw = leads || [];
    } catch (_) {}
    const eventIdSet = new Set(eventIds);
    const usableLeads = leadsRaw.filter((l) => {
      const evId = l?.source_ref?.event_id;
      return evId && eventIdSet.has(evId);
    });
    const leadByAttId  = new Map();
    const leadByCustId = new Map();
    for (const lead of usableLeads) {
      const attId = lead?.source_ref?.attendee_id;
      if (attId && !leadByAttId.has(attId)) leadByAttId.set(attId, lead);
      if (lead.customer_id && !leadByCustId.has(lead.customer_id)) leadByCustId.set(lead.customer_id, lead);
    }

    return att.map((a) => {
      const ev = eventById.get(a.event_id) || {};
      const matchedLead = leadByAttId.get(a.id)
        || (a.customer_id ? leadByCustId.get(a.customer_id) : null)
        || null;
      return {
        uid                     : 'att:' + a.id,
        herkomst                : 'event_noshow',
        herkomst_label          : herkomstLabel('event_noshow'),
        type                    : 'attendee',
        ref_id                  : a.id,
        attendee_id             : a.id,
        event_id                : a.event_id,
        event_title             : ev.title || '(zonder titel)',
        scheduled_at            : ev.starts_at || null,
        event_completed_at      : ev.completed_at || null,
        name                    : displayName(a),
        email                   : a.email || null,
        phone                   : a.phone || null,
        customer_id             : a.customer_id || null,
        assessment_response_id  : a.assessment_response_id || null,
        questionnaire_filled    : !!a.assessment_response_id,
        lead_id                 : matchedLead?.id || null,
        lead_status             : matchedLead?.lead_status || null,
        no_show_followup_status : a.no_show_followup_status || null,
        actie_hint              : actieHint('event_noshow'),
      };
    });
  } catch (e) {
    console.warn('[opvolglijst event-noshows]', e?.message || e);
    return [];
  }
}

// ── Appointment-bronnen (zoom_noshow / zoom_reschedule / zoom_cancelled) ─
async function fetchAppointmentRows() {
  // We halen appointments met alle 3 statussen in één query op zodat er
  // maar één round-trip is. follow_up_afgeschreven_at IS NULL filtert
  // afgeschreven weg. Fail-soft bij 42703 (kolom ontbreekt) → geen filter.
  const RICH = 'id, lead_name, lead_email, lead_phone, scheduled_at, updated_at, status, zoom_meeting_id, zoom_join_url, owner_id, follow_up_afgeschreven_at';
  const CORE = 'id, lead_name, lead_email, lead_phone, scheduled_at, updated_at, status, zoom_meeting_id, zoom_join_url, owner_id';
  const STATUSES = ['no_show', 'wacht_op_reschedule', 'cancelled'];
  // Alleen recent (30 dagen) — voorkomt dat ancient cancelled/no-show-
  // appointments jaren later nog terug komen. Zelfde spirit als de
  // afgehandeld-view (3-daagse-window daar).
  const cutoffIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  let rows = [];
  try {
    let { data, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .select(RICH)
      .in('status', STATUSES)
      .gte('updated_at', cutoffIso)
      .is('follow_up_afgeschreven_at', null)
      .order('updated_at', { ascending: false })
      .limit(300);
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      // Migratie 025 niet gedraaid → val terug op CORE, geen afgeschreven-filter.
      const { data: d2, error: e2 } = await supabaseAdmin
        .from('follow_up_appointments')
        .select(CORE)
        .in('status', STATUSES)
        .gte('updated_at', cutoffIso)
        .order('updated_at', { ascending: false })
        .limit(300);
      if (e2) {
        if (e2.code === '42P01') return [];
        console.warn('[opvolglijst appts CORE fallback]', e2.message);
        return [];
      }
      rows = d2 || [];
    } else if (error) {
      if (error.code === '42P01') return [];
      console.warn('[opvolglijst appts]', error.message);
      return [];
    } else {
      rows = data || [];
    }
  } catch (e) {
    console.warn('[opvolglijst appts-catch]', e?.message || e);
    return [];
  }

  return rows.map((r) => {
    const isZoom = !!(r.zoom_meeting_id || r.zoom_join_url);
    let herkomst = 'appt_cancelled';
    if (r.status === 'no_show')                herkomst = isZoom ? 'zoom_noshow'     : 'appt_noshow';
    else if (r.status === 'wacht_op_reschedule') herkomst = isZoom ? 'zoom_reschedule' : 'appt_reschedule';
    else if (r.status === 'cancelled')         herkomst = isZoom ? 'zoom_cancelled'  : 'appt_cancelled';
    return {
      uid                     : 'appt:' + r.id,
      herkomst,
      herkomst_label          : herkomstLabel(herkomst),
      type                    : 'appointment',
      ref_id                  : r.id,
      appointment_id          : r.id,
      appointment_status      : r.status,
      name                    : r.lead_name || '(onbekend)',
      email                   : r.lead_email || null,
      phone                   : r.lead_phone || null,
      scheduled_at            : r.scheduled_at || null,
      updated_at              : r.updated_at || null,
      zoom_meeting_id         : r.zoom_meeting_id || null,
      zoom_join_url           : r.zoom_join_url || null,
      lead_id                 : null,
      lead_status             : null,
      questionnaire_filled    : false,
      actie_hint              : actieHint(herkomst),
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'events.event.view');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    const [eventItems, apptItems] = await Promise.all([
      fetchEventNoShows(),
      fetchAppointmentRows(),
    ]);

    const items = [...eventItems, ...apptItems];

    // Sortering: event-noshows eerst (recentste event first) + appt op
    // updated_at DESC. Simpel: recentste eerst globaal.
    items.sort((a, b) => {
      const ta = new Date(a.updated_at || a.event_completed_at || a.scheduled_at || 0).getTime();
      const tb = new Date(b.updated_at || b.event_completed_at || b.scheduled_at || 0).getTime();
      return tb - ta;
    });

    const counts = {
      event_noshow    : items.filter((x) => x.herkomst === 'event_noshow').length,
      zoom_noshow     : items.filter((x) => x.herkomst === 'zoom_noshow' || x.herkomst === 'appt_noshow').length,
      zoom_reschedule : items.filter((x) => x.herkomst === 'zoom_reschedule' || x.herkomst === 'appt_reschedule').length,
      zoom_cancelled  : items.filter((x) => x.herkomst === 'zoom_cancelled' || x.herkomst === 'appt_cancelled').length,
    };

    return res.status(200).json({
      count : items.length,
      counts,
      items,
    });
  } catch (e) {
    console.error('[follow-up-opvolglijst]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
