// api/event-attachments-list.js
// GET -> bibliotheek van e-mail-bijlagen voor de events-automations send_email-stap.
//
// Permission: events.event.view.
//
// Response:
//   { items: [{ id, label, filename, url, mime_type, size_bytes, created_at }] }
//   gesorteerd op created_at desc.
//
// Scaffolding gespiegeld van api/events-followups-list.js.

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
      .from('event_mail_attachments')
      .select('id, label, filename, url, mime_type, size_bytes, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error('attachments-list: ' + error.message);
    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[event-attachments-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
