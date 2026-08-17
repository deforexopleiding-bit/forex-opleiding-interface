// api/leadsonderhoud-bulk-approve.js
//
// FASE 3 — draft → approved (cron pikt approved+is_test=false op). Enforcement:
// job.test_sent_at MOET gezet zijn (422 anders — 'test-send verplicht').
//
// Gate: leads.update.
//
// Body: { job_id }
// Response 200: { ok:true, job_id, status:'approved', approved_at }
// Response 422: { error:'test-send verplicht' } als test_sent_at NULL.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try { return await _handleImpl(req, res); }
  catch (e) {
    console.error('[ls-bulk-approve] TOP-LEVEL CRASH:', e && e.stack || e?.message || e);
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: 'Approve kon niet worden uitgevoerd.', detail: e?.message || String(e) });
    }
  }
}
async function _handleImpl(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const jobId = String((req.body && req.body.job_id) || '').trim();
  if (!UUID_RE.test(jobId)) return res.status(400).json({ error: 'job_id ontbreekt of ongeldig' });

  try {
    const { data: job, error: jErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('id, status, test_sent_at, total_recipients')
      .eq('id', jobId).maybeSingle();
    if (jErr) throw jErr;
    if (!job) return res.status(404).json({ error: 'Job niet gevonden' });
    if (job.status !== 'draft') return res.status(422).json({ error: `Job status is '${job.status}' — approve alleen op draft` });
    if (!job.test_sent_at) {
      return res.status(422).json({ error: 'test-send verplicht', message: 'Stuur eerst een test-bericht (leadsonderhoud-bulk-test-send) voordat je kunt approven.' });
    }

    const now = new Date().toISOString();
    const { error: upErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .update({ status: 'approved', approved_at: now, approved_by_user_id: user.id })
      .eq('id', jobId).eq('status', 'draft'); // idempotent guard
    if (upErr) throw upErr;

    return res.status(200).json({ ok: true, job_id: jobId, status: 'approved', approved_at: now });
  } catch (e) {
    console.error('[ls-bulk-approve] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Approve mislukt' });
  }
}
