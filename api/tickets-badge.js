// api/tickets-badge.js
//
// GET → { count: N }
//
// Lichte response voor sidebar-badge polling. Telt open + in_progress
// tickets toegewezen aan de ingelogde gebruiker. Geen filters, geen lijst.

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

  // count: 'exact', head: true → alleen count, geen data-rijen over de draad.
  const { count, error } = await supabase
    .from('tickets')
    .select('id', { count: 'exact', head: true })
    .eq('assigned_to', user.id)
    .in('status', ['open', 'in_progress']);

  if (error) {
    console.error('[tickets-badge] error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ count: count || 0 });
}
