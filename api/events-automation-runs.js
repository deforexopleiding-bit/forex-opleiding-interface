import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  const q = req.query || {};
  const runId = typeof q.run_id === 'string' ? q.run_id : null;
  const automationId = typeof q.automation_id === 'string' ? q.automation_id : null;
  const attendeeId = typeof q.attendee_id === 'string' ? q.attendee_id : null;
  try {
    if (runId) {
      if (!UUID_RE.test(runId)) return res.status(400).json({ error: 'run_id ongeldig' });
      const { data: run } = await supabaseAdmin.from('event_automation_runs').select('*').eq('id', runId).maybeSingle();
      const { data: log } = await supabaseAdmin.from('event_automation_run_log').select('*').eq('run_id', runId).order('step_index', { ascending: true });
      return res.status(200).json({ ok: true, run: run || null, log: log || [] });
    }
    let query = supabaseAdmin.from('event_automation_runs').select('*').order('started_at', { ascending: false }).limit(200);
    if (automationId) { if (!UUID_RE.test(automationId)) return res.status(400).json({ error: 'automation_id ongeldig' }); query = query.eq('automation_id', automationId); }
    if (attendeeId) { if (!UUID_RE.test(attendeeId)) return res.status(400).json({ error: 'attendee_id ongeldig' }); query = query.eq('attendee_id', attendeeId); }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, runs: data || [] });
  } catch (e) {
    console.error('[events-automation-runs]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
