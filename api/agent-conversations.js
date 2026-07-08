import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// GET  /api/agent-conversations?agent_name=<name>
//      → { messages: [{role, content, created_at, conversation_session}], session_id }
// POST /api/agent-conversations  { action: 'new_session' }
//      → { session_id: 'session_<timestamp>' }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Security H1 — RBAC-gate.
  const allowed = await requirePermission(req, 'agents.view.chat');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (agents.view.chat)' });

  const supabase = createUserClient(req);

  if (req.method === 'GET') {
    const { agent_name, session } = req.query;
    if (!agent_name && !session) return res.status(400).json({ error: 'agent_name of session vereist' });

    let query = supabase
      .from('agent_conversations')
      .select('role, content, created_at, conversation_session')
      .order('created_at', { ascending: true })
      .limit(60);

    if (session)     query = query.eq('conversation_session', session);
    else             query = query.eq('agent_name', agent_name);

    const { data, error } = await query;
    if (error) {
      console.error('[agent-conversations] GET fout:', error.message);
      return res.status(500).json({ error: error.message });
    }
    // Als session expliciet opgegeven maar leeg → geef de session_id terug zodat
    // de frontend de sessie kan bewaren voor toekomstige berichten
    const resolvedSessionId = data?.[0]?.conversation_session || session || null;
    return res.status(200).json({
      messages:   data || [],
      session_id: resolvedSessionId,
    });
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'new_session') {
      return res.status(200).json({ session_id: 'session_' + Date.now() });
    }
    return res.status(400).json({ error: 'Onbekende actie' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
