import { supabase } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const action = req.method === 'GET'
    ? (req.query?.action || 'list')
    : (req.body?.action  || 'log');

  // ── log (POST) ─────────────────────────────────────────────────────────
  if (action === 'log') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { agent_name, action_type, target_type, target_id, details,
            approved_by, success, error_message, approval_id } = req.body || {};

    if (!agent_name || !action_type) return res.status(400).json({ error: 'agent_name en action_type zijn verplicht' });

    const { error } = await supabase.from('agent_audit_log').insert({
      agent_name,
      action:       action_type,
      payload:      { target_type: target_type || null, target_id: target_id || null, details: details || null },
      result:       {},
      status:       success === false ? 'error' : 'success',
      error_message: error_message || null,
      approval_id:  approval_id || null,
      triggered_by: approved_by || 'system',
      created_at:   new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── list (GET) ─────────────────────────────────────────────────────────
  if (action === 'list') {
    const { agent_filter, action_type_filter, since, until, status_filter } = req.query || {};
    const limit = Math.min(parseInt(req.query?.limit) || 50, 200);

    let query = supabase.from('agent_audit_log')
      .select('id, agent_name, action, payload, result, status, error_message, approval_id, triggered_by, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (agent_filter)       query = query.eq('agent_name', agent_filter);
    if (action_type_filter) query = query.eq('action', action_type_filter);
    if (status_filter)      query = query.eq('status', status_filter);
    if (since)              query = query.gte('created_at', since);
    if (until)              query = query.lte('created_at', until);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ entries: data || [], count: (data || []).length });
  }

  // ── summary (GET) ──────────────────────────────────────────────────────
  if (action === 'summary') {
    const since24h = new Date(Date.now() - 86400000).toISOString();

    const [allRes, recentRes] = await Promise.all([
      supabase.from('agent_audit_log').select('agent_name, action, status, created_at').limit(500),
      supabase.from('agent_audit_log').select('id').gte('created_at', since24h),
    ]);

    const entries  = allRes.data || [];
    const byAgent  = {};
    const byAction = {};
    let   successes = 0;

    for (const e of entries) {
      byAgent[e.agent_name]  = (byAgent[e.agent_name]  || 0) + 1;
      byAction[e.action]     = (byAction[e.action]     || 0) + 1;
      if (e.status === 'success') successes++;
    }

    return res.status(200).json({
      total_actions:   entries.length,
      by_agent:        byAgent,
      by_action_type:  byAction,
      success_rate:    entries.length ? Math.round((successes / entries.length) * 100) : 100,
      last_24h_count:  (recentRes.data || []).length,
    });
  }

  // ── export_csv (GET) ───────────────────────────────────────────────────
  if (action === 'export_csv') {
    const agent_filter = req.query?.agent_filter || '';
    let query = supabase.from('agent_audit_log')
      .select('id, agent_name, action, status, error_message, triggered_by, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (agent_filter) query = query.eq('agent_name', agent_filter);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).map(e =>
      [e.id, e.agent_name, e.action, e.status, e.error_message || '', e.triggered_by, e.created_at].join(',')
    );
    const csv = ['id,agent_name,action,status,error_message,triggered_by,created_at', ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csv);
  }

  return res.status(400).json({ error: `Onbekende action: "${action}"` });
}
