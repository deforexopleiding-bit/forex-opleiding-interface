import { createUserClient } from './supabase.js';
import { safeError } from './_lib/safe-error.js';

const TRUSTED_SENDER_EMAILS  = ['no-reply-forms@webflow.com', 'noreply@send.lcmsgsndr.net', 'info+deforexopleiding.nl@send.lcmsgsndr.net'];
const TRUSTED_SENDER_DOMAINS = ['webflow.com', 'send.lcmsgsndr.net', 'lcmsgsndr.net'];

export default async function handler(req, res) {
  const supabase = createUserClient(req);
  res.setHeader('Cache-Control', 'no-store');

  // GET — haal patronen op, optioneel gefilterd op source
  if (req.method === 'GET') {
    const { source } = req.query || {};
    try {
      let query = supabase
        .from('email_patterns')
        .select('sender_email, sender_domain, category, confidence, source, times_seen')
        .order('confidence', { ascending: false })
        .limit(500);
      if (source) query = query.eq('source', source);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({ patterns: data || [] });
    } catch (err) {
      // Behoud patterns:[] in de response-shape voor de FE — details naar log.
      console.error('[email-patterns GET]', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis. Probeer het later opnieuw.', patterns: [] });
    }
  }

  // DELETE — verwijder stale Reclame-patronen voor vertrouwde afzenders
  if (req.method === 'DELETE') {
    try {
      let deleted = 0;
      for (const email of TRUSTED_SENDER_EMAILS) {
        const { error } = await supabase.from('email_patterns')
          .delete().eq('sender_email', email).eq('category', 'Reclame');
        if (!error) deleted++;
      }
      for (const domain of TRUSTED_SENDER_DOMAINS) {
        const { error } = await supabase.from('email_patterns')
          .delete().eq('sender_domain', domain).eq('category', 'Reclame');
        if (!error) deleted++;
      }
      // Ook verwijder eventuele deforexopleiding Reclame entries
      await supabase.from('email_patterns').delete()
        .eq('category', 'Reclame')
        .ilike('sender_domain', '%deforexopleiding%');
      console.log('[email-patterns DELETE] Stale Reclame patronen verwijderd');
      return res.status(200).json({ ok: true, cleaned: deleted });
    } catch (err) {
      return safeError(res, 500, err);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
