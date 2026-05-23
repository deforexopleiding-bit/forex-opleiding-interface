// api/email-thread.js
// Thread-view (betrouwbaar-lite): de verzonden antwoorden op een mail.
//
// POST { email_id }            → { replies: [...], count }   (antwoorden op die mail, nieuw→oud)
// POST { email_ids: [...] }    → { counts: { <email_id>: <aantal antwoorden> } }
//
// Koppeling via email_replies.email_id = composite uid van de beantwoorde mail
// (zelfde volledige-adres-prefix als de live lijst, dus geen mailbox-mapping nodig).

import { supabaseAdmin } from './supabase.js';

const CHUNK = 100; // PostgREST .in() URL-limiet veilig houden

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email_id, email_ids } = req.body || {};

  try {
    // ── Batch: tel antwoorden per email_id ──────────────────────────────────
    if (Array.isArray(email_ids)) {
      const counts = {};
      for (let i = 0; i < email_ids.length; i += CHUNK) {
        const slice = email_ids.slice(i, i + CHUNK);
        if (slice.length === 0) continue;
        const { data, error } = await supabaseAdmin
          .from('email_replies')
          .select('email_id')
          .in('email_id', slice);
        if (error) return res.status(500).json({ error: error.message });
        for (const r of (data || [])) {
          if (r.email_id) counts[r.email_id] = (counts[r.email_id] || 0) + 1;
        }
      }
      return res.status(200).json({ counts });
    }

    // ── Enkel: antwoorden op één mail ───────────────────────────────────────
    if (!email_id) {
      return res.status(400).json({ error: 'email_id of email_ids vereist' });
    }
    const { data, error } = await supabaseAdmin
      .from('email_replies')
      .select('id, email_id, email_subject, final_reply, from_address, to_address, cc_address, sent_at')
      .eq('email_id', email_id)
      .order('sent_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ replies: data || [], count: (data || []).length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
