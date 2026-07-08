// api/follow-up-no-show-list.js
//
// GET — No-show attendees van AFGERONDE events (events.completed_at IS
// NOT NULL) die nog opgevolgd moeten worden. Per attendee: koppel bestaande
// follow_up_lead (source='event') op source_ref.attendee_id.
//
// Filter-regel — welke no-shows tonen we?
//   - no_show_followup_status IS NULL      → nog niet opgevolgd
//   - no_show_followup_status = 'open'     → expliciet nog te doen
//   - no_show_followup_status = 'niet_bereikt' → blijft in de lijst met badge
//   - no_show_followup_status = 'terugbellen'  → blijft in de lijst met badge
// Afgehandelde statussen ('ander_event', 'geen_interesse') worden UIT
// gefilterd.
//
// Response:
//   { count, attendees: [
//       { attendee_id, event_id, event_title, event_date, event_completed_at,
//         first_name, last_name, name, email, phone, customer_id,
//         questionnaire_filled, assessment_response_id,
//         lead_id | null, lead_status | null,
//         no_show_followup_status | null } ] }
//
// Fail-soft 42P01/42703 → { count: 0, attendees: [] } zodat de UI netjes
// leeg toont vóór de migratie.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function displayName(a) {
  const parts = [a?.first_name, a?.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  const joined = parts.join(' ').trim();
  return joined || a?.email || '(onbekend)';
}

const OPEN_STATUSES = new Set([null, 'open', 'niet_bereikt', 'terugbellen']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Zelfde permissie-triage als de event-bellijst.
  let allowed = await requirePermission(req, 'events.event.view');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    // 1) Afgeronde events (completed_at IS NOT NULL). We nemen ALLE
    //    events op — het no-show-workflow is niet aan een status-enum
    //    gekoppeld maar aan de completed_at-stempel.
    const { data: events, error: eventsErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, completed_at')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(200);

    if (eventsErr) {
      if (eventsErr.code === '42P01' || eventsErr.code === '42703') {
        return res.status(200).json({ count: 0, attendees: [] });
      }
      throw new Error('events fetch: ' + eventsErr.message);
    }
    if (!events || events.length === 0) {
      return res.status(200).json({ count: 0, attendees: [] });
    }

    const eventById = new Map(events.map((e) => [e.id, e]));
    const eventIds  = events.map((e) => e.id);

    // 2) No-show attendees op deze events. Test-rijen filteren.
    let att = [];
    {
      const RICH = 'id, event_id, customer_id, first_name, last_name, email, phone, assessment_response_id, no_show_followup_status, no_show_followup_at';
      const CORE = 'id, event_id, customer_id, first_name, last_name, email, phone, assessment_response_id';
      let cols = RICH;
      let query = supabaseAdmin
        .from('event_attendees')
        .select(cols)
        .eq('status', 'no_show')
        .eq('is_test', false)
        .in('event_id', eventIds);

      const { data, error } = await query;
      if (error) {
        // 42703 op no_show_followup_* → migratie ontbreekt; retry met CORE.
        if (error.code === '42703') {
          cols = CORE;
          const { data: d2, error: e2 } = await supabaseAdmin
            .from('event_attendees')
            .select(CORE)
            .eq('status', 'no_show')
            .eq('is_test', false)
            .in('event_id', eventIds);
          if (e2) {
            if (e2.code === '42P01') return res.status(200).json({ count: 0, attendees: [] });
            throw new Error('event_attendees fetch: ' + e2.message);
          }
          att = (d2 || []).map((r) => ({ ...r, no_show_followup_status: null, no_show_followup_at: null }));
        } else if (error.code === '42P01') {
          return res.status(200).json({ count: 0, attendees: [] });
        } else {
          throw new Error('event_attendees fetch: ' + error.message);
        }
      } else {
        att = data || [];
      }
    }

    // 3) Filter alleen open no-shows (client-side — zelfde regel als het
    //    partial-index-filter in de migratie, plus 'open'-alias).
    att = att.filter((a) => OPEN_STATUSES.has(a.no_show_followup_status || null));

    if (att.length === 0) {
      return res.status(200).json({ count: 0, attendees: [] });
    }

    // 4) Bestaande follow_up_leads met source='event'. We filteren
    //    client-side op event_id in de eventIds-set (PostgREST kent geen
    //    IN-operator op jsonb-paden zonder .or() met N-elementen). Index
    //    leads op attendee_id en customer_id.
    let existingLeads = [];
    {
      const { data: leads, error: leadsErr } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, customer_id, lead_status, source_ref')
        .eq('source', 'event');
      if (leadsErr && leadsErr.code !== '42P01' && leadsErr.code !== '42703') {
        console.warn('[no-show-list] leads lookup:', leadsErr.message);
      } else if (!leadsErr) {
        const eventIdSet = new Set(eventIds);
        existingLeads = (leads || []).filter((lead) => {
          const evId = lead?.source_ref?.event_id;
          return evId && eventIdSet.has(evId);
        });
      }
    }
    const leadByAttId  = new Map();
    const leadByCustId = new Map();
    for (const lead of existingLeads) {
      const attId = lead?.source_ref?.attendee_id;
      if (attId && !leadByAttId.has(attId)) leadByAttId.set(attId, lead);
      if (lead.customer_id && !leadByCustId.has(lead.customer_id)) {
        leadByCustId.set(lead.customer_id, lead);
      }
    }

    // 5) Bouw items — sorteer op event.completed_at DESC + naam ASC binnen event.
    const items = att.map((a) => {
      const ev = eventById.get(a.event_id) || {};
      const matchedLead = leadByAttId.get(a.id)
        || (a.customer_id ? leadByCustId.get(a.customer_id) : null)
        || null;
      return {
        attendee_id             : a.id,
        event_id                : a.event_id,
        event_title             : ev.title || '(zonder titel)',
        event_date              : ev.starts_at || null,
        event_completed_at      : ev.completed_at || null,
        first_name              : a.first_name || null,
        last_name               : a.last_name || null,
        name                    : displayName(a),
        email                   : a.email || null,
        phone                   : a.phone || null,
        customer_id             : a.customer_id || null,
        assessment_response_id  : a.assessment_response_id || null,
        questionnaire_filled    : !!a.assessment_response_id,
        lead_id                 : matchedLead?.id || null,
        lead_status             : matchedLead?.lead_status || null,
        no_show_followup_status : a.no_show_followup_status || null,
      };
    });

    items.sort((a, b) => {
      const ta = a.event_completed_at ? new Date(a.event_completed_at).getTime() : 0;
      const tb = b.event_completed_at ? new Date(b.event_completed_at).getTime() : 0;
      if (ta !== tb) return tb - ta;                                            // recent-afgerond eerst
      return (a.name || '').localeCompare(b.name || '', 'nl');
    });

    return res.status(200).json({ count: items.length, attendees: items });
  } catch (e) {
    console.error('[follow-up-no-show-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
