// api/events-status-aggregate.js
// GET → per-event aggregate voor dashboard "Eerstkomende events" rij.
// Per event: aantal actieve attendees (aangemeld+aanwezig) dat een vragenlijst
// heeft ingevuld (assessment_response_id NOT NULL) en aantal dat gebeld is
// (called_at NOT NULL). Alleen actieve (aangemeld/aanwezig, NIET is_test)
// tellen mee, consistent met getConfirmedCount() in events-list.
//
// Query-params:
//   event_ids   comma-separated UUIDs (verplicht; max 20 per call)
//
// Response:
//   {
//     items: [
//       { event_id, active_count, questionnaire_count, called_count },
//       ...
//     ]
//   }
//
// Permission: events.view (fallback: events.attendee.view).
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { CONFIRMED_STATUSES } from './_lib/event-registration.js';

const MAX_EVENTS = 20;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = (await requirePermission(req, 'events.view'))
    || (await requirePermission(req, 'events.attendee.view'));
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    const raw = String(req.query.event_ids || '').trim();
    if (!raw) return res.status(400).json({ error: 'event_ids verplicht' });
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_EVENTS);
    if (!ids.length) return res.status(400).json({ error: 'event_ids leeg na parse' });

    // Eén batch-query voor alle events. In-memory aggregeren.
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('event_id, status, assessment_response_id, called_at, is_test')
      .in('event_id', ids)
      .eq('is_test', false)
      .in('status', CONFIRMED_STATUSES)
      .limit(10000);
    if (error) throw new Error('event_attendees: ' + error.message);

    const byEvent = new Map();
    for (const id of ids) byEvent.set(id, { event_id: id, active_count: 0, questionnaire_count: 0, called_count: 0 });
    for (const row of (data || [])) {
      const agg = byEvent.get(row.event_id);
      if (!agg) continue;
      agg.active_count += 1;
      if (row.assessment_response_id) agg.questionnaire_count += 1;
      if (row.called_at)              agg.called_count += 1;
    }

    return res.status(200).json({ items: Array.from(byEvent.values()) });
  } catch (e) {
    console.error('[events-status-aggregate]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
