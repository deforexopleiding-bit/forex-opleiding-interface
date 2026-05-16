// api/follow-up-outcomes.js
//
// POST endpoint voor opslaan van post-call outcome.
// Body: { appointment_id, outcome: 'klant_geworden'|'geen_klant'|'no_show',
//          bezwaren: string[], warmte_score: 1-10, terugkom_datum: 'YYYY-MM-DD',
//          volgende_actie: string, notitie: string }
//
// Side-effect: update follow_up_appointments.status op basis van outcome.

import { createUserClient } from './supabase.js';

const OUTCOME_TO_STATUS = {
  klant_geworden: 'completed',
  geen_klant: 'completed',
  no_show: 'no_show',
};

const VALID_OUTCOMES = ['klant_geworden', 'geen_klant', 'no_show'];
const VALID_VOLGENDE_ACTIES = ['bellen', 'email', 'event', 'sluiten', 'niet_meer_opvolgen'];

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

  const body = req.body || {};
  const { appointment_id, outcome } = body;

  if (!appointment_id || typeof appointment_id !== 'string') {
    return res.status(400).json({ error: 'appointment_id ontbreekt of ongeldig.' });
  }
  if (!VALID_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: `outcome moet één van: ${VALID_OUTCOMES.join(', ')}` });
  }

  const outcomeRow = {
    appointment_id,
    outcome,
    bezwaren: Array.isArray(body.bezwaren) ? body.bezwaren : null,
    volgende_actie: VALID_VOLGENDE_ACTIES.includes(body.volgende_actie) ? body.volgende_actie : null,
    terugkom_datum: body.terugkom_datum && /^\d{4}-\d{2}-\d{2}$/.test(body.terugkom_datum) ? body.terugkom_datum : null,
    warmte_score: Number.isInteger(body.warmte_score) && body.warmte_score >= 1 && body.warmte_score <= 10 ? body.warmte_score : null,
    notitie: typeof body.notitie === 'string' && body.notitie.length > 0 ? body.notitie : null,
    opvolging_status: body.terugkom_datum ? 'gepland' : null,
    niet_meer_opvolgen: body.volgende_actie === 'niet_meer_opvolgen',
    ingevuld_door: user.id,
  };

  const { data: outcomeData, error: outcomeErr } = await supabase
    .from('follow_up_outcomes')
    .insert(outcomeRow)
    .select('id')
    .single();

  if (outcomeErr) {
    console.error('[outcomes-post] insert error:', outcomeErr.message);
    return res.status(500).json({ error: outcomeErr.message });
  }

  const newStatus = OUTCOME_TO_STATUS[outcome];
  const { error: updateErr } = await supabase
    .from('follow_up_appointments')
    .update({ status: newStatus })
    .eq('id', appointment_id);

  if (updateErr) {
    console.error('[outcomes-post] status update error:', updateErr.message);
    return res.status(500).json({ error: 'Outcome saved but status update failed: ' + updateErr.message });
  }

  return res.status(200).json({
    outcome_id: outcomeData.id,
    appointment_id,
    new_status: newStatus,
  });
}
