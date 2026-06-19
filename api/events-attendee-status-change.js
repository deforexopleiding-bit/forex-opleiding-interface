// api/events-attendee-status-change.js
// POST -> wijzig status van een deelnemer + auto-stempels + auto-tagging.
//
// Permission: events.attendee.status_change.
//
// Body (JSON):
//   {
//     attendee_id: uuid    (verplicht),
//     new_status:  string  (verplicht — aangemeld|aanwezig|no_show|sale|switched_to_other_event),
//     reason:      string  (optioneel — vrij tekstveld voor audit-log)
//   }
//
// Timestamp-stempels per nieuwe status:
//   aangemeld                 -> wist attended_at / no_show_marked_at / sale_at (terug naar nul)
//   aanwezig                  -> set attended_at = now()
//   no_show                   -> set no_show_marked_at = now()
//                                 + auto-tag 'event-no-show' (source='system')
//   sale                      -> set sale_at = now()
//   switched_to_other_event   -> set switched_at = now()
//
// Audit-log: action='status_changed' met before/after + reason.
//
// Response 200: { attendee: { ...row } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event', 'geannuleerd'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.status_change'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.status_change)' });
  }

  const body = req.body || {};
  const attendeeId = body.attendee_id ? String(body.attendee_id) : null;
  const newStatus  = body.new_status ? String(body.new_status).toLowerCase() : null;
  const reason     = body.reason != null ? String(body.reason).trim() : null;

  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }
  if (!newStatus || !VALID_STATUS.includes(newStatus)) {
    return res.status(400).json({ error: `new_status moet ${VALID_STATUS.join('|')} zijn` });
  }

  try {
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, status, attended_at, no_show_marked_at, sale_at, switched_at')
      .eq('id', attendeeId)
      .maybeSingle();
    if (beforeErr) throw new Error('before-fetch: ' + beforeErr.message);
    if (!before)   return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    if (before.status === newStatus) {
      return res.status(409).json({
        error: `Status is al '${newStatus}'`,
      });
    }

    const nowIso = new Date().toISOString();
    const patch = { status: newStatus };

    switch (newStatus) {
      case 'aangemeld':
        patch.attended_at = null;
        patch.no_show_marked_at = null;
        patch.sale_at = null;
        // switched_at NIET wissen (historische info bij terugzetten)
        break;
      case 'aanwezig':
        patch.attended_at = nowIso;
        patch.no_show_marked_at = null;
        break;
      case 'no_show':
        patch.no_show_marked_at = nowIso;
        patch.attended_at = null;
        break;
      case 'sale':
        patch.sale_at = nowIso;
        // sale impliceert aanwezig: stempel die ook als nog niet gezet
        if (!before.attended_at) patch.attended_at = nowIso;
        break;
      case 'switched_to_other_event':
        patch.switched_at = nowIso;
        break;
      default: break;
    }

    const { data: row, error } = await supabaseAdmin
      .from('event_attendees')
      .update(patch)
      .eq('id', attendeeId)
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, subscription_id,
        ghl_contact_id, ghl_form_submission_id, assessment_response_id,
        switched_from_event_id, switched_at,
        registered_at, attended_at, no_show_marked_at, sale_at,
        follow_up_flagged, follow_up_reason,
        created_at, updated_at
      `)
      .maybeSingle();
    if (error) throw new Error('status-update: ' + error.message);
    if (!row)  return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    // Auto-tag bij no_show -> event-no-show (system-source, idempotent via PK).
    if (newStatus === 'no_show') {
      try {
        const { error: tagErr } = await supabaseAdmin
          .from('event_attendee_tags')
          .upsert({
            attendee_id:      attendeeId,
            tag_slug:         'event-no-show',
            source:           'system',
            source_ref:       'auto:status_change',
            added_by_user_id: user?.id || null,
          }, { onConflict: 'attendee_id,tag_slug' });
        if (tagErr) console.error('[events-attendee-status-change auto-tag]', tagErr.message);
      } catch (e) {
        console.error('[events-attendee-status-change auto-tag]', e.message);
      }
    }

    // Audit-log
    try {
      await supabaseAdmin.from('event_attendee_audit_log').insert({
        attendee_id:  attendeeId,
        action:       'status_changed',
        before_state: { status: before.status },
        after_state:  { status: newStatus, reason },
        by_user_id:   user?.id || null,
      });
    } catch (e) {
      console.error('[events-attendee-status-change audit]', e.message);
    }

    return res.status(200).json({ attendee: row });
  } catch (e) {
    console.error('[events-attendee-status-change]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
