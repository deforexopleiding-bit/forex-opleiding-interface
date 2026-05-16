// api/follow-up-messages.js
//
// GET endpoint voor messages van een specifieke lead-contact.
// Query: ?contact_id=<ghl_contact_id>
//
// RLS-aware via createUserClient — Dave ziet zijn eigen, ADMIN_ROLES alles.

import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  const contactId = req.query.contact_id;
  if (!contactId || typeof contactId !== 'string') {
    return res.status(400).json({ error: 'Query parameter contact_id ontbreekt.' });
  }

  const since = new Date();
  since.setDate(since.getDate() - 90);

  const { data, error } = await supabase
    .from('follow_up_messages')
    .select('id, direction, channel, body, sent_at, template_id, source')
    .eq('lead_ghl_contact_id', contactId)
    .gte('sent_at', since.toISOString())
    .order('sent_at', { ascending: true })
    .limit(500);

  if (error) {
    console.error('[messages-get] db error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    contact_id: contactId,
    count: data?.length || 0,
    messages: data || [],
  });
}
