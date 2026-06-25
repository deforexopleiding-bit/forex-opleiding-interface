// api/onboarding-automation-runs.js
//
// GET → read-only observability voor onboarding-automation runs.
// Port van api/events-automation-runs.js naar de onboarding_automation_*
// tabellen + permissie onboarding.automation.view.
//
// Query (eerste niet-lege match wint):
//   ?run_id        (uuid) → { ok, run, log }
//                  run-row + run-log (sorted op step_index asc).
//   ?automation_id (uuid) → { ok, runs: [...] }
//                  runs voor die automation (order started_at desc, limit 200).
//   ?onboarding_id (uuid) → { ok, runs: [...] }
//                  runs voor die onboarding (order started_at desc, limit 200).
//   (geen filter)         → { ok, runs: [...] }
//                  alle runs (order started_at desc, limit 200).
//
// Errors:
//   400 ongeldig uuid op een meegegeven filter
//   401 niet geauthenticeerd
//   403 geen rechten
//   405 method
//   500 db

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.automation.view'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.automation.view)' });
  }

  const q = req.query || {};
  const runId        = typeof q.run_id        === 'string' ? q.run_id        : null;
  const automationId = typeof q.automation_id === 'string' ? q.automation_id : null;
  const onboardingId = typeof q.onboarding_id === 'string' ? q.onboarding_id : null;

  try {
    if (runId) {
      if (!UUID_RE.test(runId)) return res.status(400).json({ error: 'run_id ongeldig' });
      const { data: run, error: runErr } = await supabaseAdmin
        .from('onboarding_automation_runs')
        .select('*')
        .eq('id', runId)
        .maybeSingle();
      if (runErr) throw new Error(runErr.message);
      const { data: log, error: logErr } = await supabaseAdmin
        .from('onboarding_automation_run_log')
        .select('*')
        .eq('run_id', runId)
        .order('step_index', { ascending: true });
      if (logErr) throw new Error(logErr.message);
      return res.status(200).json({ ok: true, run: run || null, log: log || [] });
    }

    let query = supabaseAdmin
      .from('onboarding_automation_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(200);
    if (automationId) {
      if (!UUID_RE.test(automationId)) return res.status(400).json({ error: 'automation_id ongeldig' });
      query = query.eq('automation_id', automationId);
    }
    if (onboardingId) {
      if (!UUID_RE.test(onboardingId)) return res.status(400).json({ error: 'onboarding_id ongeldig' });
      query = query.eq('onboarding_id', onboardingId);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, runs: data || [] });
  } catch (e) {
    console.error('[onboarding-automation-runs]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
