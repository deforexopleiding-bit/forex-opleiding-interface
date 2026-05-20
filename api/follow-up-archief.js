// api/follow-up-archief.js
//
// GET endpoint voor archief-tab: afgeronde en no-show appointments
// (completed, no_show, cancelled, verplaatst), max 50 meest recente.

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

  const { data, error } = await supabase
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, owner_id, snelle_notitie')
    .in('status', ['completed', 'no_show', 'cancelled', 'verplaatst'])
    .order('scheduled_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[archief] error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    period: 'archief',
    count: data?.length || 0,
    appointments: data || [],
  });
}
