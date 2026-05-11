export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL/KEY niet geconfigureerd', sent: [] });
  }

  try {
    const page  = Math.max(1, parseInt(req.query?.page  || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const url = `${supabaseUrl}/rest/v1/email_replies` +
      `?select=email_id,email_subject,final_reply,from_address,to_address,cc_address,bcc_address,sent_at` +
      `&order=sent_at.desc` +
      `&limit=${limit}&offset=${offset}`;

    const response = await fetch(url, {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      console.error('[sent-replies] Supabase fout:', response.status, txt);
      return res.status(200).json({ sent: [], count: 0, page, limit, error: txt });
    }

    const data = await response.json();
    console.log('[sent-replies] Opgehaald:', Array.isArray(data) ? data.length : 0, 'rijen');

    const rows = (Array.isArray(data) ? data : []).map((row) => ({
      email_id:   row.email_id,
      created_at: row.sent_at,
      to:         row.to_address,
      from:       row.from_address,
      subject:    row.email_subject,
      body:       row.final_reply,
      cc:         row.cc_address,
      bcc:        row.bcc_address,
    }));

    // Dedupliceer op email_id
    const seen   = new Set();
    const unique = rows.filter((r) => {
      const key = r.email_id || r.created_at;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ sent: unique, count: unique.length, page, limit });
  } catch (err) {
    console.error('[sent-replies] fout:', err.message);
    return res.status(500).json({ error: err.message, sent: [] });
  }
}
