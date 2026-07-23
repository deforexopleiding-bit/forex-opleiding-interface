// api/follow-up-event-bellijst.js
//
// GET — deelnemers van een aankomend event, met per attendee een
// indicatie of er al een follow_up_lead bestaat (source='event' met
// matching source_ref.attendee_id, of match op customer_id).
// Voor de cockpit-'Event-bellijst'-tab.
//
// Query-params:
//   list=upcoming  → returnt { events: [{id,title,starts_at}, ...] }
//                    (aankomende events voor de picker, max 50).
//                    Bewust in dít endpoint i.p.v. /api/events-list omdat
//                    events-list alleen events.event.view accepteert,
//                    terwijl deze bellijst ook door sales.tab.retentie /
//                    sales.customer.view gebruikers wordt bezocht — zij
//                    zouden anders een 403 krijgen op de picker.
//   event_id=<uuid> (optioneel) → toon de bellijst voor dat specifieke
//                    event i.p.v. het eerstvolgende. Valideert UUID +
//                    bestaan + status ∈ (published, draft). Onbekend of
//                    verkeerde status → 400.
//   (default)      → eerstvolgende aankomende event.
//
// Response (default / event_id):
//   { event: { id, title, starts_at, attendee_count } | null,
//     attendees: [
//       { id, name, email, phone, customer_id,
//         lead_id | null, lead_status | null,
//         call_status | null, call_status_at | null } ] }
//
// call_status is de PRIMAIRE bron voor de UI-badge in de event-bellijst
// (event-specifieke bel-uitkomst: bevestigd/komt_niet/geen_gehoor/
// voicemail/terugbellen/foutief_nummer). lead_status blijft in de payload
// voor legacy-callers maar de renderer valt daar NIET meer op terug — zie
// _renderEventBellijst() in modules/follow-up.html.
//
// 42P01/42703 fail-soft (lege lijst / event=null / events=[]).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const q = req.query || {};

  // Sub-endpoint: picker-opties. Geeft alleen id/title/starts_at terug
  // van maximaal 50 aankomende events (status IN published/draft,
  // starts_at >= now, oplopend). Zelfde RBAC-triple als de bellijst
  // zelf — geen mismatch met /api/events-list.
  if (String(q.list || '').toLowerCase() === 'upcoming') {
    try {
      const nowIso = new Date().toISOString();
      const { data: rows, error: listErr } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at')
        .in('status', ['published', 'draft'])
        .gte('starts_at', nowIso)
        .order('starts_at', { ascending: true })
        .limit(50);
      if (listErr) {
        if (listErr.code === '42P01' || listErr.code === '42703') {
          return res.status(200).json({ events: [] });
        }
        throw new Error('events list: ' + listErr.message);
      }
      return res.status(200).json({ events: rows || [] });
    } catch (e) {
      console.error('[follow-up-event-bellijst list=upcoming]', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  try {
    const nowIso = new Date().toISOString();

    // 1) Event-selectie: expliciet event_id-param, anders de eerstvolgende.
    let eventRow = null;
    const rawEventId = q.event_id ? String(q.event_id).trim() : '';
    if (rawEventId) {
      if (!UUID_RE.test(rawEventId)) {
        return res.status(400).json({ error: 'Ongeldig event_id (geen uuid)' });
      }
      const { data: row, error: byIdErr } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at, status')
        .eq('id', rawEventId)
        .maybeSingle();
      if (byIdErr) {
        if (byIdErr.code === '42P01' || byIdErr.code === '42703') {
          return res.status(200).json({ event: null, attendees: [] });
        }
        throw new Error('events fetch (by id): ' + byIdErr.message);
      }
      if (!row) return res.status(404).json({ error: 'Event niet gevonden' });
      if (!['published', 'draft'].includes(String(row.status || '').toLowerCase())) {
        return res.status(400).json({ error: 'Event heeft geen zichtbare status (published/draft)' });
      }
      eventRow = row;
    } else {
      const { data: firstRow, error: eventErr } = await supabaseAdmin
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
      if (!firstRow) return res.status(200).json({ event: null, attendees: [] });
      eventRow = firstRow;
    }

    // 2) Deelnemers van dat event. call_status/-_at (migratie 023) is
    //    de event-specifieke bel-uitkomst en de primaire bron voor de
    //    UI-badge; lead_status van de gekoppelde follow_up_lead is de
    //    generieke "afgehandeld"-sentinel en misleidend als label ("verlengd"
    //    = "abonnement verlengd" in de retentie-oorsprong).
    const { data: attendees, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, customer_id, first_name, last_name, email, phone, assessment_response_id, call_status, call_status_at')
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
          call_status           : a.call_status || null,
          call_status_at        : a.call_status_at || null,
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
