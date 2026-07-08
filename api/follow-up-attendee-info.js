// api/follow-up-attendee-info.js
//
// GET ?attendee_id=<uuid>
//
// Lightweight helper voor de follow-up cockpit: haalt per attendee de
// info op die renderLeadContext nodig heeft om de vragenlijst-cell +
// "opnieuw toesturen"-knop te tonen — ook voor event-leads die NIET via
// de Event-bellijst zijn geopend (bv. via de reguliere Werklijst-tab).
//
// Response:
//   { attendee_id, event_id, event_title, event_starts_at,
//     assessment_response_id | null, questionnaire_filled: boolean }
//
// Fail-soft 42P01/42703 → 200 met NULL-shape zodat de UI geen error toont.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const q = req.query || {};
  const attendeeId = q.attendee_id ? String(q.attendee_id).trim() : '';
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }

  try {
    const { data: att, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, assessment_response_id')
      .eq('id', attendeeId)
      .maybeSingle();

    if (attErr) {
      if (attErr.code === '42P01' || attErr.code === '42703') {
        return res.status(200).json({
          attendee_id           : attendeeId,
          event_id              : null,
          event_title           : null,
          event_starts_at       : null,
          assessment_response_id: null,
          questionnaire_filled  : false,
        });
      }
      throw new Error('attendee fetch: ' + attErr.message);
    }
    if (!att) return res.status(404).json({ error: 'Attendee niet gevonden' });

    let event = null;
    if (att.event_id) {
      const { data: ev } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at')
        .eq('id', att.event_id)
        .maybeSingle();
      event = ev || null;
    }

    return res.status(200).json({
      attendee_id           : att.id,
      event_id              : att.event_id || null,
      event_title           : event?.title || null,
      event_starts_at       : event?.starts_at || null,
      assessment_response_id: att.assessment_response_id || null,
      questionnaire_filled  : !!att.assessment_response_id,
    });
  } catch (e) {
    console.error('[follow-up-attendee-info]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
