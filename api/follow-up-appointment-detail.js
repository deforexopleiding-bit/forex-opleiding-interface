// api/follow-up-appointment-detail.js
//
// GET endpoint voor één appointment met outcome + history voor lead-detail pagina.
// Query: ?id=<appointment_id>
//
// Returns: { appointment, outcome (or null), lead_history (other appointments same lead) }

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

  const id = req.query.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query parameter id ontbreekt.' });
  }

  const { data: appt, error: apptErr } = await supabase
    .from('follow_up_appointments')
    .select('*')
    .eq('id', id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: 'Appointment niet gevonden of geen toegang.' });
  }

  const { data: outcome } = await supabase
    .from('follow_up_outcomes')
    .select('*')
    .eq('appointment_id', id)
    .order('ingevuld_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: history } = await supabase
    .from('follow_up_appointments')
    .select('id, lead_name, scheduled_at, status, voicememo_status, duration_minutes')
    .eq('lead_ghl_contact_id', appt.lead_ghl_contact_id)
    .neq('id', id)
    .order('scheduled_at', { ascending: false })
    .limit(20);

  return res.status(200).json({
    appointment: appt,
    outcome: outcome || null,
    lead_history: history || [],
  });
}
