// api/lisa-feedback.js
// Lisa feedback per bericht (👍/👎) — voedt later het leersysteem / config-voorbeelden.
//
//   POST /api/lisa-feedback
//   body: {
//     message_id:         uuid     (verplicht)
//     conversation_id:    uuid     (verplicht)
//     rating:             'good' | 'bad' | 'neutral'
//     reason?:            string   (bij 'bad': wat ging fout)
//     suggested_response?: string  (bij 'bad': hoe had Lisa moeten antwoorden)
//     use_as_example?:    boolean  (markeer als voorbeeld in config)
//   }
//
// Auth: verifyAdmin + requirePermissionFailOpen('lisa.sandbox.use'). Schrijven via supabaseAdmin.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

const VALID_RATINGS = ['good', 'bad', 'neutral'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  if (!(await requirePermissionFailOpen(req, 'lisa.sandbox.use'))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.sandbox.use' });
  }

  const body = req.body || {};
  if (!body.message_id || !body.conversation_id) {
    return res.status(400).json({ error: 'message_id en conversation_id zijn vereist.' });
  }
  const rating = VALID_RATINGS.includes(body.rating) ? body.rating : null;
  if (!rating) return res.status(400).json({ error: "rating moet 'good', 'bad' of 'neutral' zijn." });

  const { data, error } = await supabaseAdmin.from('lisa_feedback')
    .insert({
      message_id: body.message_id,
      conversation_id: body.conversation_id,
      feedback_type: 'message',
      rating,
      reason: body.reason || null,
      suggested_response: body.suggested_response || null,
      use_as_example: !!body.use_as_example,
      created_by: admin.user.id,
    })
    .select('id').single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true, id: data.id });
}
