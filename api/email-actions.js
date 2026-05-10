import { supabase } from './supabase.js';

/*
  Supabase table (run once in SQL editor):

  CREATE TABLE IF NOT EXISTS email_actions (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    email_id      text NOT NULL,
    action        text NOT NULL,
    value         text,
    set_by        text,
    set_at        timestamptz DEFAULT now(),
    resolved_at   timestamptz,
    resolved_by   text
  );
  CREATE INDEX IF NOT EXISTS email_actions_email_id_idx ON email_actions (email_id);
*/

const VALID_ACTIONS = [
  'recategorize', 'mark-action', 'no-action',
  'snooze', 'unsnooze', 'mark-read', 'create-task'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email_id, action, value, set_by } = req.body || {};

  if (!email_id || !action) {
    return res.status(400).json({ error: 'email_id en action zijn vereist' });
  }
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Ongeldige actie: ' + action });
  }

  try {
    await supabase.from('email_actions').insert({
      email_id,
      action,
      value:  value != null ? String(value) : null,
      set_by: set_by || null,
      set_at: new Date().toISOString()
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.warn('email_actions insert mislukt:', err.message);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
