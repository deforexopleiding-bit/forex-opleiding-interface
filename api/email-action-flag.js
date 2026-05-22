// api/email-action-flag.js
// POST { email_id: '<mailbox>:<imap_uid>', requires_action: boolean }
// Handmatige override van requires_action op een mail in email_messages.

import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email_id, requires_action } = req.body || {};
  if (!email_id || typeof requires_action !== 'boolean') {
    return res.status(400).json({ error: 'email_id en requires_action (boolean) vereist' });
  }

  // Composite uid: '<mailbox>:<imap_uid>' — splits op laatste ':'
  const lastColon = String(email_id).lastIndexOf(':');
  if (lastColon === -1) {
    return res.status(400).json({ error: 'Ongeldig email_id formaat' });
  }
  const mailbox  = email_id.slice(0, lastColon);
  const imap_uid = email_id.slice(lastColon + 1);

  try {
    const { error } = await supabaseAdmin
      .from('email_messages')
      .update({ requires_action })
      .eq('mailbox', mailbox)
      .eq('imap_uid', imap_uid);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, requires_action });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
