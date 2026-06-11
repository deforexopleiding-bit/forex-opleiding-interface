// api/events-niveau-options.js
// GET -> lijst van actieve niveau-opties (basis / gevorderd / etc).
//
// Permission: events.event.view (lookup-data; nodig om events-formulieren te bouwen).
//
// Response: { options: [ { slug, label, sort_order, is_active } ] }
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
      .from('event_niveau_options')
      .select('slug, label, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true });
    if (error) throw new Error('niveau-options: ' + error.message);

    return res.status(200).json({ options: data || [] });
  } catch (e) {
    console.error('[events-niveau-options]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
