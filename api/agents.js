import { supabase } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  // Security H1 — RBAC-gate.
  const allowed = await requirePermission(req, 'agents.view.overview');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (agents.view.overview)' });

  try {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('is_active', true)
      .order('created_at');
    if (error) throw error;
    return res.status(200).json({ agents: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message, agents: [] });
  }
}
