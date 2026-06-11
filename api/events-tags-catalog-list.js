// api/events-tags-catalog-list.js
// GET -> lijst van beschikbare tags uit event_tags_catalog.
//
// Permission: events.event.view (algemene module-toegang volstaat — catalog is
// statische lookup-data; alleen de manage-catalog-actie zit achter
// events.tag.manage_catalog).
//
// Response: { tags: [ { slug, label, color, description, is_system, sort_order } ] }
// Sortering: sort_order ASC, label ASC.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('event_tags_catalog')
      .select('slug, label, color, description, is_system, sort_order')
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true });
    if (error) throw new Error('tags-catalog: ' + error.message);

    return res.status(200).json({ tags: data || [] });
  } catch (e) {
    console.error('[events-tags-catalog-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
