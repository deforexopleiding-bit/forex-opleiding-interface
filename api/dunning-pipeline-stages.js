// api/dunning-pipeline-stages.js
// GET → fase-definities (voor kanban-kolommen).
// Permission: finance.dunning.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('dunning_pipeline_stages')
      .select('id, slug, label, sort_order, color, is_active, is_terminal')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw new Error(error.message);
    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[dunning-pipeline-stages]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
