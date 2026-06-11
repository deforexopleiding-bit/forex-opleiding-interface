// api/events-attendee-tag-remove.js
// POST -> handmatige tag verwijderen van een deelnemer.
//
// Permission: events.attendee.tag_assign.
//
// Body (JSON): { attendee_id: uuid, tag_slug: string }
//
// Validatie: alleen rijen met source='manual' verwijderbaar. System-tags
// (source='system' zoals event-no-show) NIET verwijderbaar via dit endpoint
// — die volgen automatisch de status-flow.
//
// Audit-log entry 'tag_removed'.
//
// Response 200: { removed: true } of 404 / 409.

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
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('event_attendee_tags')
      .select('attendee_id, tag_slug, source')
      .eq('attendee_id', attendeeId)
      .eq('tag_slug', tagSlug)
      .maybeSingle();
    if (exErr) throw new Error('tag-lookup: ' + exErr.message);
    if (!existing) return res.status(404).json({ error: 'Tag is niet gekoppeld aan deze deelnemer' });
    if (existing.source !== 'manual') {
      return res.status(409).json({
        code:  'SYSTEM_TAG_PROTECTED',
        error: `Tag '${tagSlug}' is een system-tag (source='${existing.source}') en kan niet handmatig worden verwijderd`,
      });
    }

    const { error: delErr } = await supabaseAdmin
      .from('event_attendee_tags')
      .delete()
      .eq('attendee_id', attendeeId)
      .eq('tag_slug', tagSlug)
      .eq('source', 'manual'); // defensief: ook in WHERE meeschuiven om system-tags niet per ongeluk te raken
    if (delErr) throw new Error('tag-delete: ' + delErr.message);

    // Audit-log
    try {
      await supabaseAdmin.from('event_attendee_audit_log').insert({
        attendee_id:  attendeeId,
        action:       'tag_removed',
        before_state: { tag_slug: tagSlug, source: 'manual' },
        after_state:  null,
        by_user_id:   user?.id || null,
      });
    } catch (e) {
      console.error('[events-attendee-tag-remove audit]', e.message);
    }

    return res.status(200).json({ removed: true });
  } catch (e) {
    console.error('[events-attendee-tag-remove]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
