// api/events-delete.js
// POST -> soft-delete (archive) van een event.
//
// Permission: events.event.delete.
//
// Query: ?id=<uuid>  (verplicht)
//
// Pattern: GEEN hard-delete. We zetten status='archived' zodat eventuele
// historische attendees + audit-log behouden blijven (event_attendees.event_id
// is ON DELETE RESTRICT). Een hard-delete zou alleen mogelijk zijn op events
// zonder attendees + zonder mentors, wat fragiel is in productie.
//
// Status-check: een event met status='cancelled' is OK om te archiveren.
// Een actief gepubliceerd event archiveren mag ook (UI moet bevestigen).
//
// Response 200: { event: { ...row } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { hardDeleteEventOutbound } from './_lib/event-sync-orchestrator.js';

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
  if (!(await requirePermission(req, 'events.event.delete'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.delete)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: cur, error: curErr } = await supabaseAdmin
      .from('events')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw new Error('current-fetch: ' + curErr.message);
    if (!cur)   return res.status(404).json({ error: 'Event niet gevonden' });

    if (cur.status === 'archived') {
      return res.status(409).json({ error: 'Event is al gearchiveerd' });
    }

    const { data: ev, error } = await supabaseAdmin
      .from('events')
      .update({ status: 'archived' })
      .eq('id', id)
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
        ghl_sync_status, ghl_last_synced_at,
        created_by_user_id, created_at, updated_at
      `)
      .maybeSingle();
    if (error) throw new Error('events-delete (archive): ' + error.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    // Blok 1 item 6: archive = permanent uit Webflow CMS (geen draft-park).
    // hardDeleteEventOutbound doet DELETE /items/{id} (zonder /live) en nult
    // webflow_item_id, plus GHL options refresh (event filtert uit
    // computeUpcomingLabels door status='archived'). 404 op Webflow = success
    // (item al weg, idempotent). AWAITED; targets intern geisoleerd.
    let sync = null;
    try {
      sync = await hardDeleteEventOutbound(ev.id);
    } catch (syncErr) {
      console.error('[events-delete sync]', syncErr?.message || syncErr);
      sync = { error: syncErr?.message || 'sync exception' };
    }

    // Refetch om bijgewerkte sync-metadata terug te geven.
    let evAfter = ev;
    try {
      const { data: refetched } = await supabaseAdmin
        .from('events')
        .select(`
          id, title, starts_at, ends_at, location, capacity, status, niveau,
          description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
          ghl_sync_status, ghl_last_synced_at,
          created_by_user_id, created_at, updated_at
        `)
        .eq('id', ev.id)
        .maybeSingle();
      if (refetched) evAfter = refetched;
    } catch {}

    return res.status(200).json({ event: evAfter, sync });
  } catch (e) {
    console.error('[events-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
