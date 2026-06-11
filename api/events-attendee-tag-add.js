// api/events-attendee-tag-add.js
// POST -> handmatig tag toekennen aan een deelnemer.
//
// Permission: events.attendee.tag_assign.
//
// Body (JSON): { attendee_id: uuid, tag_slug: string }
//
// Source = 'manual' (system-tags worden automatisch gezet door
// events-attendee-status-change.js bij no_show).
//
// Idempotent: bij duplicate (PK 23505) -> 200 met already=true.
//
// Audit-log entry 'tag_added' op event_attendee_audit_log.
//
// Response 201: { tag: { attendee_id, tag_slug, source, added_at } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'events.attendee.tag_assign'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.tag_assign)' });
  }

  const body = req.body || {};
  const attendeeId = body.attendee_id ? String(body.attendee_id) : null;
  const tagSlug    = body.tag_slug ? String(body.tag_slug).trim().toLowerCase() : null;

  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }
  if (!tagSlug) return res.status(400).json({ error: 'tag_slug vereist' });

  try {
    // Tag bestaat in catalog?
    const { data: cat, error: catErr } = await supabaseAdmin
      .from('event_tags_catalog')
      .select('slug')
      .eq('slug', tagSlug)
      .maybeSingle();
    if (catErr) throw new Error('tag-lookup: ' + catErr.message);
    if (!cat)   return res.status(400).json({ error: `tag_slug '${tagSlug}' bestaat niet in catalog` });

    // Attendee bestaat?
    const { data: att, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee-lookup: ' + attErr.message);
    if (!att)   return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    const { data: row, error } = await supabaseAdmin
      .from('event_attendee_tags')
      .insert({
        attendee_id:      attendeeId,
        tag_slug:         tagSlug,
        source:           'manual',
        added_by_user_id: user?.id || null,
      })
      .select('attendee_id, tag_slug, source, added_at, added_by_user_id')
      .single();

    if (error) {
      if (error.code === '23505') {
        const { data: existing } = await supabaseAdmin
          .from('event_attendee_tags')
          .select('attendee_id, tag_slug, source, added_at, added_by_user_id')
          .eq('attendee_id', attendeeId)
          .eq('tag_slug', tagSlug)
          .maybeSingle();
        return res.status(200).json({ tag: { ...(existing || {}), already: true } });
      }
      throw new Error('tag-insert: ' + error.message);
    }

    // Audit-log (fail-soft)
    try {
      await supabaseAdmin.from('event_attendee_audit_log').insert({
        attendee_id:  attendeeId,
        action:       'tag_added',
        before_state: null,
        after_state:  { tag_slug: tagSlug, source: 'manual' },
        by_user_id:   user?.id || null,
      });
    } catch (e) {
      console.error('[events-attendee-tag-add audit]', e.message);
    }

    return res.status(201).json({ tag: row });
  } catch (e) {
    console.error('[events-attendee-tag-add]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
