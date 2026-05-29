// api/profiles-list.js
//
// GET → { members: [{ id, full_name, email, role }] }
//
// Lijst actieve profiles voor assignee-dropdowns (task-modal, ticket-create, etc).
// Gebruikt supabaseAdmin omdat profiles-RLS niet uniform is (zelfde pattern als
// ticket-detail.js assignees-fetch). Niet te verwarren met /api/team-members
// dat de aparte team_members-tabel exposeert.

import { createUserClient, supabaseAdmin } from './supabase.js';

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

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, role')
    .eq('is_active', true)
    .order('full_name', { ascending: true, nullsFirst: false });

  if (error) {
    console.error('[profiles-list]', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ members: data || [] });
}
