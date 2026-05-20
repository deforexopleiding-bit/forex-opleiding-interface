// api/follow-up-archief.js
//
// GET endpoint voor archief-tab: afgeronde en no-show appointments
// (completed, no_show, cancelled, verplaatst)
//
// Query params:
//   q        — optionele zoekterm op lead_name (ILIKE)
//   page     — paginanummer (default 1)
//   pageSize — vast 20

import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  const q        = (req.query.q || '').trim();
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const from     = (page - 1) * pageSize;
  const to       = from + pageSize - 1;

  let query = supabase
    .from('follow_up_appointments')
    .select(
      'id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, owner_id, snelle_notitie',
      { count: 'exact' }
    )
    .in('status', ['completed', 'no_show', 'cancelled', 'verplaatst'])
    .order('scheduled_at', { ascending: false })
    .range(from, to);

  if (q) {
    const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
    query = query.ilike('lead_name', `%${escaped}%`);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('[archief] error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const total      = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return res.status(200).json({
    period:       'archief',
    total,
    page,
    pageSize,
    totalPages,
    appointments: data || [],
  });
}
