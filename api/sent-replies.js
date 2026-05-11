import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const page  = Math.max(1, parseInt(req.query?.page  || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50', 10)));
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    const { data, error, count } = await supabase
      .from('email_actions')
      .select('email_id, value, set_at, created_at', { count: 'exact' })
      .eq('action', 'reply_sent')
      .order('set_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    const sent = (data || []).map((row) => {
      let parsed = {};
      try { parsed = JSON.parse(row.value || '{}'); } catch {}
      return { email_id: row.email_id, created_at: row.set_at || row.created_at, ...parsed };
    });

    // Dedupliceer op email_id: frontend + server kunnen allebei opslaan
    // Eerste (meest recente) entry per email_id wint (data al DESC gesorteerd)
    const seen = new Set();
    const unique = sent.filter((r) => {
      const key = r.email_id && r.email_id !== 'manual' ? r.email_id : r.created_at;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ sent: unique, count: count ?? unique.length, page, limit });
  } catch (err) {
    console.error('[sent-replies] fout:', err.message);
    return res.status(500).json({ error: err.message, sent: [] });
  }
}
