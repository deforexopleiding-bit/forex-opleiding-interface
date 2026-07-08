import { supabase } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// GET  /api/agent-learnings?agent_name=<name>&limit=20
//      → { learnings: [{id, trigger_text, ideal_response, created_at}] }
// POST /api/agent-learnings
//      { agent_id, agent_name, trigger_text, ideal_response } → { ok: true, id }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Security H1 — RBAC-gate. Pragmatische keuze: één permission voor beide
  // methoden — een user die learnings ziet mag er in deze admin-tool ook
  // toevoegen. Verfijning naar 'agents.train.rule' voor POST kan later
  // zonder de flow te breken.
  const allowed = await requirePermission(req, 'agents.view.overview');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (agents.view.overview)' });

  if (req.method === 'GET') {
    const { agent_name, limit = '20' } = req.query;
    if (!agent_name) return res.status(400).json({ error: 'agent_name vereist' });

    const { data, error } = await supabase
      .from('agent_learnings')
      .select('id, trigger_text, ideal_response, created_at')
      .eq('agent_name', agent_name)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 20, 100));

    if (error) {
      console.error('[agent-learnings] GET fout:', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ learnings: data || [] });
  }

  if (req.method === 'POST') {
    const { agent_id, agent_name, trigger_text, ideal_response } = req.body || {};
    if (!agent_name || !trigger_text || !ideal_response) {
      return res.status(400).json({ error: 'agent_name, trigger_text en ideal_response zijn vereist' });
    }

    const { data, error } = await supabase
      .from('agent_learnings')
      .insert({
        agent_id:       agent_id || null,
        agent_name,
        trigger_text,
        ideal_response,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[agent-learnings] POST fout:', error.message);
      return res.status(500).json({ error: error.message });
    }
    console.log('[agent-learnings] opgeslagen id:', data.id, 'voor agent:', agent_name);
    return res.status(200).json({ ok: true, id: data.id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
