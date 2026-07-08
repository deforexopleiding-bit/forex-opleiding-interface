// api/follow-up-event-bellijst.js
//
// GET — deelnemers van het EERSTVOLGENDE aankomende event, met per
// attendee een indicatie of er al een follow_up_lead bestaat
// (source='event' met matching source_ref.attendee_id, of match op
// customer_id). Voor de cockpit-'Event-bellijst'-tab.
//
// Response:
//   { event: { id, title, starts_at, attendee_count } | null,
//     attendees: [
//       { id, name, email, phone, customer_id,
//         lead_id | null, lead_status | null } ] }
//
// 42P01/42703 fail-soft (lege lijst / event=null).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function displayName(a) {
  const parts = [a?.first_name, a?.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  const joined = parts.join(' ').trim();
  return joined || a?.email || '(onbekend)';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Hergebruik cockpit-permissies: events.event.view (voor Dave)
  // of sales.tab.retentie (voor sales in het algemeen).
  let allowed = await requirePermission(req, 'events.event.view');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    const nowIso = new Date().toISOString();

    // 1) Eerstvolgende aankomende event.
    const { data: eventRow, error: eventErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, status')
      .in('status', ['published', 'draft'])
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (eventErr) {
      if (eventErr.code === '42P01' || eventErr.code === '42703') {
        return res.status(200).json({ event: null, attendees: [] });
      }
      throw new Error('events fetch: ' + eventErr.message);
    }
    if (!eventRow) return res.status(200).json({ event: null, attendees: [] });

    // 2) Deelnemers van dat event.
    const { data: attendees, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, customer_id, first_name, last_name, email, phone, assessment_response_id')
      .eq('event_id', eventRow.id);

    if (attErr) {
      if (attErr.code === '42P01' || attErr.code === '42703') {
        return res.status(200).json({
          event: { id: eventRow.id, title: eventRow.title, starts_at: eventRow.starts_at, attendee_count: 0 },
          attendees: [],
        });
      }
      throw new Error('event_attendees fetch: ' + attErr.message);
    }

    // 3) Bestaande event-leads voor dit event (source_ref.event_id match).
    //    We halen alle event-leads waar de source_ref-jsonb dit event_id
    //    bevat; per attendee zoeken we vervolgens in JS naar de match op
    //    source_ref.attendee_id of customer_id.
    let existingLeads = [];
    {
      const { data: leads, error: leadsErr } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, customer_id, lead_status, source_ref')
        .eq('source', 'event')
        .filter('source_ref->>event_id', 'eq', eventRow.id);
      if (leadsErr && leadsErr.code !== '42P01' && leadsErr.code !== '42703') {
        // fail-soft: als de lookup breekt, sturen we attendees zonder lead-info.
        console.warn('[event-bellijst] leads lookup:', leadsErr.message);
      } else if (!leadsErr) {
        existingLeads = leads || [];
      }
    }

    // Index: attendee_id → lead, customer_id → lead (secundair).
    const leadByAttId  = new Map();
    const leadByCustId = new Map();
    for (const lead of existingLeads) {
      const attId = lead?.source_ref?.attendee_id;
      if (attId && !leadByAttId.has(attId)) leadByAttId.set(attId, lead);
      if (lead.customer_id && !leadByCustId.has(lead.customer_id)) {
        leadByCustId.set(lead.customer_id, lead);
      }
    }

    const items = (attendees || [])
      .map((a) => {
        const matchedLead = leadByAttId.get(a.id)
          || (a.customer_id ? leadByCustId.get(a.customer_id) : null)
          || null;
        return {
          id                    : a.id,
          name                  : displayName(a),
          email                 : a.email || null,
          phone                 : a.phone || null,
          customer_id           : a.customer_id || null,
          lead_id               : matchedLead?.id || null,
          lead_status           : matchedLead?.lead_status || null,
          assessment_response_id: a.assessment_response_id || null,
          questionnaire_filled  : !!a.assessment_response_id,
        };
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'nl'));

    return res.status(200).json({
      event: {
        id            : eventRow.id,
        title         : eventRow.title,
        starts_at     : eventRow.starts_at,
        attendee_count: items.length,
      },
      attendees: items,
    });
  } catch (e) {
    console.error('[follow-up-event-bellijst]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
