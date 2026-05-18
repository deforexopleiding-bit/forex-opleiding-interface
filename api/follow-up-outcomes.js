// api/follow-up-outcomes.js
//
// POST endpoint voor opslaan van post-call outcome.
// Body: { appointment_id, outcome, bezwaren: string[], warmte_score: 1-10,
//          terugkom_datum: 'YYYY-MM-DD', terugkom_datetime: ISO8601,
//          volgende_actie: string, notitie: string }
//
// Side-effect: update follow_up_appointments.status op basis van outcome.

import { createUserClient } from './supabase.js';
import { addGhlTags, tagsFromOutcome } from './ghl-tag-helper.js';

const OUTCOME_TO_STATUS = {
  klant_geworden:    'completed',
  geen_klant:        'completed',
  no_show:           'no_show',
  niet_bereikt:      'no_show',
  interesse_uitstel: 'completed',
  interesse_overleg: 'completed',
  geen_interesse:    'completed',
  niet_geschikt:     'completed',
};

const VALID_OUTCOMES = [
  'klant_geworden', 'geen_klant', 'no_show',
  'niet_bereikt', 'interesse_uitstel', 'interesse_overleg',
  'geen_interesse', 'niet_geschikt',
];
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

  // terugkom_datetime heeft prioriteit; terugkom_datum is backward-compat
  const terugkomDt = body.terugkom_datetime && !isNaN(Date.parse(body.terugkom_datetime))
    ? new Date(body.terugkom_datetime).toISOString()
    : null;
  const terugkomDatum = body.terugkom_datum && /^\d{4}-\d{2}-\d{2}$/.test(body.terugkom_datum)
    ? body.terugkom_datum
    : (terugkomDt ? terugkomDt.slice(0, 10) : null);

  const outcomeRow = {
    appointment_id,
    outcome,
    bezwaren: Array.isArray(body.bezwaren) ? body.bezwaren : null,
    volgende_actie: VALID_VOLGENDE_ACTIES.includes(body.volgende_actie) ? body.volgende_actie : null,
    terugkom_datum: terugkomDatum,
    terugkom_datetime: terugkomDt,
    warmte_score: Number.isInteger(body.warmte_score) && body.warmte_score >= 1 && body.warmte_score <= 10 ? body.warmte_score : null,
    notitie: typeof body.notitie === 'string' && body.notitie.length > 0 ? body.notitie : null,
    opvolging_status: terugkomDatum ? 'gepland' : null,
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

  // Haal contact-id op voor tag-call
  const { data: apptForTag } = await supabase
    .from('follow_up_appointments')
    .select('lead_ghl_contact_id, owner_id')
    .eq('id', appointment_id)
    .single();

  let tagResult = null;
  if (apptForTag?.lead_ghl_contact_id) {
    const tagsToAdd = tagsFromOutcome({
      outcome,
      bezwaren: outcomeRow.bezwaren,
    });

    if (tagsToAdd.length > 0) {
      try {
        tagResult = await addGhlTags(apptForTag.lead_ghl_contact_id, tagsToAdd, {
          source: 'outcome-save',
          appointment_id,
          outcome,
          owner_id: apptForTag.owner_id,
        });
      } catch (err) {
        console.error('[outcomes-post] tag-call exception:', err.message);
        // Niet blokkerend
      }
    }
  }

  return res.status(200).json({
    outcome_id: outcomeData.id,
    appointment_id,
    new_status: newStatus,
    tags: tagResult ? { added: tagResult.tagsAdded, errors: tagResult.errors } : null,
  });
}
