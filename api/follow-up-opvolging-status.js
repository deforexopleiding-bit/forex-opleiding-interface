// api/follow-up-opvolging-status.js
//
// POST endpoint om opvolging_status op een follow_up_outcomes row bij te werken.
//
// Body: { appointment_id, action: 'geregeld'|'verzet', new_terugkom_datum? }
//   geregeld: zet opvolging_status='geregeld' + opvolging_geregeld_at=now
//   verzet:   zet opvolging_status='verzet'   + terugkom_datum=new_terugkom_datum

import { createUserClient } from './supabase.js';

const VALID_ACTIONS = ['geregeld', 'verzet'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  const { appointment_id, action, new_terugkom_datum } = req.body || {};

  if (!appointment_id || typeof appointment_id !== 'string') {
    return res.status(400).json({ error: 'appointment_id ontbreekt.' });
  }

  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action moet één van: ${VALID_ACTIONS.join(', ')}` });
  }

  if (action === 'verzet') {
    if (!new_terugkom_datum || !/^\d{4}-\d{2}-\d{2}$/.test(new_terugkom_datum)) {
      return res.status(400).json({ error: 'new_terugkom_datum (YYYY-MM-DD) verplicht bij verzet.' });
    }
  }

  const { data: outcome, error: outcomeErr } = await supabase
    .from('follow_up_outcomes')
    .select('id, opvolging_status, terugkom_datum')
    .eq('appointment_id', appointment_id)
    .order('ingevuld_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (outcomeErr) {
    return res.status(500).json({ error: outcomeErr.message });
  }
  if (!outcome) {
    return res.status(404).json({ error: 'Geen outcome gevonden voor deze appointment.' });
  }

  const updates = {};
  if (action === 'geregeld') {
    updates.opvolging_status = 'geregeld';
    updates.opvolging_geregeld_at = new Date().toISOString();
  } else {
    updates.opvolging_status = 'verzet';
    updates.terugkom_datum = new_terugkom_datum;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('follow_up_outcomes')
    .update(updates)
    .eq('id', outcome.id)
    .select('id, opvolging_status, opvolging_geregeld_at, terugkom_datum')
    .single();

  if (updateErr) {
    console.error('[opvolging-status] update error:', updateErr.message);
    return res.status(500).json({ error: updateErr.message });
  }

  return res.status(200).json({ updated });
}
