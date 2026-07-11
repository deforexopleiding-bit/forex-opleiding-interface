// api/incasso-bureaus-list.js
// GET → { items: [...] } actieve incasso-bureaus. Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('dunning_incasso_bureaus')
      .select('id, name, email, country, address, notes, is_active, created_at')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[incasso-bureaus-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
