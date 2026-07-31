// api/leadsonderhoud-stap-verwijderen.js
// POST -> verwijdert één stap. Gate: leads.view. Body: { id }. Response: { ok:true }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const id = (req.body || {}).id;
  if (!id) return res.status(400).json({ error: 'id ontbreekt' });

  try {
    const { error } = await supabaseAdmin.from('onderhoud_stappen').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('stap-verwijderen mislukt:', e.message);
    return res.status(500).json({ error: 'Verwijderen mislukt' });
  }
}
