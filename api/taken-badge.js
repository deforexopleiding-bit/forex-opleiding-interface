// api/taken-badge.js
//
// GET → { count: N }
//
// Telt open taken (status != 'done') waar de ingelogde user betrokken is:
//   - assigned_to_id = user.id   OF
//   - taken_assignees.assignee_id = user.id
// Twee queries, gemerged via Set om dubbeltellingen te voorkomen.

import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    // Pad 1: directe assignee via taken_items.assigned_to_id.
    const [directRes, joinRes] = await Promise.all([
      supabase.from('taken_items')
        .select('id')
        .eq('assigned_to_id', user.id)
        .neq('status', 'done'),
      supabase.from('taken_assignees')
        .select('task_id')
        .eq('assignee_id', user.id),
    ]);

    if (directRes.error) throw directRes.error;
    if (joinRes.error)   throw joinRes.error;

    const ids = new Set();
    for (const r of directRes.data || []) ids.add(r.id);

    // Pad 2 vereist een tweede status-filter op taken_items.
    const joinTaskIds = (joinRes.data || []).map(r => r.task_id);
    if (joinTaskIds.length) {
      const { data, error } = await supabase
        .from('taken_items')
        .select('id')
        .in('id', joinTaskIds)
        .neq('status', 'done');
      if (error) throw error;
      for (const r of data || []) ids.add(r.id);
    }

    return res.status(200).json({ count: ids.size });
  } catch (err) {
    console.error('[taken-badge]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
