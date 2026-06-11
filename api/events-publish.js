// api/events-publish.js
// POST -> event publiceren (draft -> published).
//
// Permission: events.event.publish.
//
// Query: ?id=<uuid>  (verplicht)
//
// Voor F1 alleen lokale status-flip; F2 voegt outbound sync toe (Webflow CMS
// upsert + GoHighLevel form-create + Bubble LMS). Daarom geen webflow/ghl
// fields aangeraakt in dit endpoint.
//
// Status-overgang strict: alleen draft -> published toegestaan. Een al gepubliceerd
// event opnieuw publiceren is no-op (409). Voor draft hervatten gebruik events-update.
//
// Response 200: { event: { ...row } }

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
  if (!(await requirePermission(req, 'events.event.publish'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.publish)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: cur, error: curErr } = await supabaseAdmin
      .from('events')
      .select('id, status, title, starts_at, capacity')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw new Error('current-fetch: ' + curErr.message);
    if (!cur)   return res.status(404).json({ error: 'Event niet gevonden' });

    if (cur.status !== 'draft') {
      return res.status(409).json({
        error: `Alleen draft-events kunnen gepubliceerd worden (huidige status: ${cur.status})`,
      });
    }

    // Sanity-checks: een event zonder zinnige metadata mag niet live.
    if (!cur.title) return res.status(400).json({ error: 'Event heeft geen title' });
    if (!cur.starts_at) return res.status(400).json({ error: 'Event heeft geen starts_at' });
    if (!cur.capacity || cur.capacity <= 0) {
      return res.status(400).json({ error: 'Event heeft geen geldige capacity' });
    }

    const { data: ev, error } = await supabaseAdmin
      .from('events')
      .update({ status: 'published' })
      .eq('id', id)
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
        ghl_sync_status, ghl_last_synced_at,
        created_by_user_id, created_at, updated_at
      `)
      .maybeSingle();
    if (error) throw new Error('events-publish: ' + error.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    return res.status(200).json({ event: ev });
  } catch (e) {
    console.error('[events-publish]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
