// api/follow-up-alle-komende.js
//
// GET endpoint: alle komende afspraken vanaf vandaag 00:00, max 100.

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

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, owner_id, snelle_notitie')
    .gte('scheduled_at', today.toISOString())
    .in('status', ['scheduled', 'in_progress'])
    .order('scheduled_at', { ascending: true })
    .limit(100);

  if (error) {
    console.error('[alle-komende] error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    period: 'all-komende',
    count: data?.length || 0,
    appointments: data || [],
  });
}
