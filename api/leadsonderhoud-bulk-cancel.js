// api/leadsonderhoud-bulk-cancel.js
//
// FASE 3 — kill-switch. Werkt op approved én running jobs. Zet:
//   - job.status='cancelled' + cancelled_at
//   - recipients.status: pending → cancelled (sending blijft, want die is al
//     door de cron geclaimed en mag geen dubbele-write krijgen; die worden
//     in de volgende cron-tick als 'sent' of 'failed' afgesloten en de job
//     wordt daarna nooit meer opgepikt door de status='cancelled'-guard).
//
// Gate: leads.update.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
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
    const { data: job } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('id, status')
      .eq('id', jobId).maybeSingle();
    if (!job) return res.status(404).json({ error: 'Job niet gevonden' });
    if (!['approved', 'running', 'draft'].includes(job.status)) {
      return res.status(422).json({ error: `Job status '${job.status}' — kan niet annuleren` });
    }

    const now = new Date().toISOString();
    await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .update({ status: 'cancelled', cancelled_at: now })
      .eq('id', jobId);
    // Pending recipients naar cancelled (sending laten we door de cron afronden).
    const { error: rErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_recipients')
      .update({ status: 'cancelled' })
      .eq('job_id', jobId).eq('status', 'pending');
    if (rErr) console.warn('[ls-bulk-cancel] recipients cancel soft-fail:', rErr.message);

    return res.status(200).json({ ok: true, job_id: jobId, status: 'cancelled', cancelled_at: now });
  } catch (e) {
    console.error('[ls-bulk-cancel] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Cancel mislukt' });
  }
}
