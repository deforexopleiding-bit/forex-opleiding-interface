// api/events-attendee-move.js
// POST -> verplaats een deelnemer naar een ander event.
//
// Permission: events.attendee.create (operatie creëert nieuwe rij op doel-event).
//
// Body (JSON):
//   {
//     attendee_id:     uuid (verplicht) — bron-deelnemer
//     target_event_id: uuid (verplicht) — doel-event
//     send_invite:     bool (optioneel, default false) — keuze-link sturen
//   }
//
// Flow:
//   1. Valideer bron-attendee + doel-event + niet-zelfde-event.
//   2. Capacity-check op doel-event (status 'aangemeld' = actief).
//   3. Email-duplicaat-check op doel-event (case-insensitive, partial unique).
//   4. INSERT nieuwe rij op doel-event met overgenomen identificerende velden
//      (first_name, last_name, email, phone, customer_id, deal_id,
//      assessment_response_id) + switched_from_event_id=source.event_id +
//      switched_at=now + status='aangemeld'.
//   5. Kopieer tags van bron naar nieuwe rij (best-effort).
//   6. UPDATE bron: status='switched_to_other_event', switched_at=now.
//   7. Audit-log entries op beide rijen.
//   8. Optioneel: invite (WhatsApp + e-mail) op nieuwe rij (niet-blokkerend).
//
// Response 201:
//   { source_attendee_id, new_attendee: {...row}, target_event_id,
//     invite?: { ok, mail?, whatsapp?, error? } }
//
// Errors:
//   400  body-validatie (UUIDs ontbreken / SAME_EVENT)
//   401  geen sessie
//   403  geen rechten
//   404  attendee of doel-event niet gevonden
//   409  SEATS_FULL / EMAIL_EXISTS / EVENT_ARCHIVED
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendEventAttendeeInvite } from './_lib/events-invite.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ['aangemeld', 'aanwezig', 'sale'];

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
  if (!(await requirePermission(req, 'events.attendee.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.create)' });
  }

  const body = req.body || {};
  const attendeeId    = body.attendee_id ? String(body.attendee_id) : null;
  const targetEventId = body.target_event_id ? String(body.target_event_id) : null;
  const sendInvite    = body.send_invite === true || body.send_invite === 'true';

  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }
  if (!targetEventId || !UUID_RE.test(targetEventId)) {
    return res.status(400).json({ error: 'target_event_id (uuid) vereist' });
  }

  try {
    // Bron-attendee.
    const { data: source, error: srcErr } = await supabaseAdmin
      .from('event_attendees')
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, assessment_response_id, source, automation_enabled
      `)
      .eq('id', attendeeId)
      .maybeSingle();
    if (srcErr) throw new Error('source-attendee: ' + srcErr.message);
    if (!source) return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    if (source.event_id === targetEventId) {
      return res.status(400).json({
        code:  'SAME_EVENT',
        error: 'Bron- en doel-event zijn hetzelfde',
      });
    }

    // Doel-event.
    const { data: targetEvent, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, capacity, status')
      .eq('id', targetEventId)
      .maybeSingle();
    if (evErr) throw new Error('target-event: ' + evErr.message);
    if (!targetEvent) return res.status(404).json({ error: 'Doel-event niet gevonden' });
    if (targetEvent.status === 'archived') {
      return res.status(409).json({
        code:  'EVENT_ARCHIVED',
        error: 'Doel-event is gearchiveerd',
      });
    }

    // Capacity-check op doel-event.
    const { count: activeCnt, error: cErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', targetEventId)
      .in('status', ACTIVE_STATUSES);
    if (cErr) throw new Error('capacity-count: ' + cErr.message);
    const cnt = typeof activeCnt === 'number' ? activeCnt : 0;
    if (cnt >= targetEvent.capacity) {
      return res.status(409).json({
        code:  'SEATS_FULL',
        error: `Doel-event is vol (${cnt}/${targetEvent.capacity})`,
      });
    }

    const nowIso = new Date().toISOString();

    // INSERT nieuwe rij op doel-event.
    const insertRow = {
      event_id:                targetEventId,
      first_name:              source.first_name,
      last_name:               source.last_name,
      email:                   source.email,
      phone:                   source.phone,
      status:                  'aangemeld',
      customer_id:             source.customer_id,
      deal_id:                 source.deal_id,
      assessment_response_id:  source.assessment_response_id,
      switched_from_event_id:  source.event_id,
      switched_at:             nowIso,
      // Behoud het oorspronkelijke kanaal bij een move zodat de attendee-
      // herkomst niet verloren gaat. Fallback 'manual' want de move-actie
      // zelf gebeurt via admin-UI.
      source:                  source.source || 'manual',
      // Behoud automation-opt-in van de bron-rij. Stilte attendees blijven
      // stil; opt-in attendees krijgen op het nieuwe event hun automation-flow.
      automation_enabled:      source.automation_enabled !== false,
      created_by_user_id:      user?.id || null,
    };

    const { data: newRow, error: insErr } = await supabaseAdmin
      .from('event_attendees')
      .insert(insertRow)
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, subscription_id,
        ghl_contact_id, ghl_form_submission_id, assessment_response_id,
        switched_from_event_id, switched_at,
        registered_at, attended_at, no_show_marked_at, sale_at,
        follow_up_flagged, follow_up_reason,
        created_at, updated_at
      `)
      .single();

    if (insErr) {
      if (insErr.code === '23505') {
        return res.status(409).json({
          code:  'EMAIL_EXISTS',
          error: 'Deze email is al aangemeld voor het doel-event',
        });
      }
      throw new Error('attendee-insert: ' + insErr.message);
    }

    // Tags overnemen (best-effort).
    let tagsCopied = 0;
    try {
      const { data: srcTags, error: tagFetchErr } = await supabaseAdmin
        .from('event_attendee_tags')
        .select('tag_slug, source')
        .eq('attendee_id', source.id);
      if (tagFetchErr) {
        console.error('[events-attendee-move tag-fetch]', tagFetchErr.message);
      } else if (srcTags && srcTags.length > 0) {
        const rowsToInsert = srcTags.map((t) => ({
          attendee_id:      newRow.id,
          tag_slug:         t.tag_slug,
          source:           t.source || 'manual',
          added_by_user_id: user?.id || null,
        }));
        const { error: tagInsErr } = await supabaseAdmin
          .from('event_attendee_tags')
          .insert(rowsToInsert);
        if (tagInsErr) {
          console.error('[events-attendee-move tag-insert]', tagInsErr.message);
        } else {
          tagsCopied = rowsToInsert.length;
        }
      }
    } catch (e) {
      console.error('[events-attendee-move tag-copy]', e?.message || e);
    }

    // UPDATE bron-attendee: markeer als geswitched.
    const { error: updErr } = await supabaseAdmin
      .from('event_attendees')
      .update({
        status:      'switched_to_other_event',
        switched_at: nowIso,
      })
      .eq('id', source.id);
    if (updErr) {
      // Niet fataal; nieuwe rij staat al. Log en ga door.
      console.error('[events-attendee-move source-update]', updErr.message);
    }

    // Audit-log entries (fail-soft).
    try {
      await supabaseAdmin.from('event_attendee_audit_log').insert([
        {
          attendee_id:  source.id,
          action:       'moved_out',
          before_state: { event_id: source.event_id, status: source.status },
          after_state:  {
            event_id: source.event_id,
            status:   'switched_to_other_event',
            moved_to_event_id:    targetEventId,
            moved_to_attendee_id: newRow.id,
          },
          by_user_id:   user?.id || null,
        },
        {
          attendee_id:  newRow.id,
          action:       'moved_in',
          before_state: null,
          after_state:  {
            event_id:               newRow.event_id,
            status:                 newRow.status,
            switched_from_event_id: source.event_id,
            moved_from_attendee_id: source.id,
            tags_copied:            tagsCopied,
          },
          by_user_id:   user?.id || null,
        },
      ]);
    } catch (e) {
      console.error('[events-attendee-move audit]', e?.message || e);
    }

    // Optionele invite-flow (niet-blokkerend).
    let invite = null;
    if (sendInvite) {
      try {
        invite = await sendEventAttendeeInvite({
          attendeeId:   newRow.id,
          sentByUserId: user?.id || null,
        });
      } catch (e) {
        console.error('[events-attendee-move invite]', e?.message || e);
        invite = { ok: false, error: e?.message || 'invite send failed' };
      }
    }

    return res.status(201).json({
      source_attendee_id: source.id,
      target_event_id:    targetEventId,
      new_attendee:       newRow,
      tags_copied:        tagsCopied,
      invite,
    });
  } catch (e) {
    console.error('[events-attendee-move]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
