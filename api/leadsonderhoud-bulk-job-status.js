// api/leadsonderhoud-bulk-job-status.js
// GET ?job_id=X → één job + recipients-tellers per status. Gate: leads.view.

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
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const jobId = String(req.query.job_id || '').trim();
  if (!UUID_RE.test(jobId)) return res.status(400).json({ error: 'job_id vereist' });

  try {
    const { data: job, error: jErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('*')
      .eq('id', jobId).maybeSingle();
    if (jErr) throw jErr;
    if (!job) return res.status(404).json({ error: 'Job niet gevonden' });

    // Recipients counts per status via aparte queries (parallel).
    const statuses = ['pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled'];
    const countsArr = await Promise.all(statuses.map(async s => {
      const { count } = await supabaseAdmin
        .from('leadsonderhoud_bulk_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId).eq('status', s);
      return [s, count || 0];
    }));
    const counts = Object.fromEntries(countsArr);

    return res.status(200).json({ job, counts });
  } catch (e) {
    console.error('[ls-bulk-job-status] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Job-status laden mislukt' });
  }
}
