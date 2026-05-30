// api/lead-sources.js
// GET → { sources: [...] } actieve lead-bronnen voor wizard dropdown.

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const { data, error } = await supabaseAdmin
    .from('lead_sources').select('id, name, is_active')
    .eq('is_active', true).order('name');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ sources: data || [] });
}
