// api/sales-wizard-drafts.js
// GET    → eigen draft of null
// POST/PUT → upsert (auto-save)
// DELETE → cleanup na submit
// Permission: sales.customer.create (om wizard te mogen gebruiken).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'sales.customer.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.customer.create)' });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('sales_wizard_drafts').select('*').eq('user_id', user.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ draft: data || null });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const { draft_json, last_step } = req.body || {};
    if (!draft_json || typeof draft_json !== 'object') {
      return res.status(400).json({ error: 'draft_json (object) vereist' });
    }
    const payload = {
      user_id: user.id,
      draft_json,
      last_step: Math.max(1, Math.min(4, Number(last_step) || 1)),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabaseAdmin
      .from('sales_wizard_drafts')
      .upsert(payload, { onConflict: 'user_id' })
      .select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ draft: data });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabaseAdmin.from('sales_wizard_drafts').delete().eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader('Allow', 'GET, POST, PUT, DELETE');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
