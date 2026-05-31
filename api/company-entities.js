// api/company-entities.js
// GET → actieve bedrijfsentiteiten (TL departments) voor wizard-stap 0.
// Permission: sales.deal.create (Dave).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
  }

  try {
    const { data, error } = await supabaseAdmin.from('company_entities')
      .select('tl_department_id, name, label, description, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (error) throw error;
    return res.status(200).json({ entities: data || [] });
  } catch (e) {
    console.error('[company-entities]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
