import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { data, error } = await supabase
      .from('email_actions')
      .select('email_id, value, created_at')
      .eq('action', 'reply_sent')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    const sent = (data || []).map((row) => {
      let parsed = {};
      try { parsed = JSON.parse(row.value || '{}'); } catch {}
      return { email_id: row.email_id, created_at: row.created_at, ...parsed };
    });

    return res.status(200).json({ sent, count: sent.length });
  } catch (err) {
    console.error('[sent-replies] fout:', err.message);
    return res.status(500).json({ error: err.message, sent: [] });
  }
}
