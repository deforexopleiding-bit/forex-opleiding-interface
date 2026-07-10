// api/wanbetalers-bulk-job-status.js
// GET ?job_id=<uuid> → job-summary + recipients (per-klant status).
// Permission: finance.dunning.execute.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const jobId = req.query?.job_id ? String(req.query.job_id).trim() : null;
  if (!jobId || !UUID_RE.test(jobId)) return res.status(400).json({ error: 'job_id (uuid) vereist' });

  try {
    const { data: job, error: jErr } = await supabaseAdmin
      .from('dunning_bulk_jobs')
      .select('id, channel, template_name, email_template_id, status, total_recipients, sent_count, failed_count, skipped_count, batch_size, created_at, approved_at, completed_at')
      .eq('id', jobId).maybeSingle();
    if (jErr) throw new Error('job: ' + jErr.message);
    if (!job) return res.status(404).json({ error: 'Job niet gevonden' });

    const { data: recips, error: rErr } = await supabaseAdmin
      .from('dunning_bulk_recipients')
      .select('id, customer_id, customer_name, customer_email, customer_phone, channel_whatsapp, channel_email, total_open_cents, open_invoice_count, status, skip_reason, wamid, email_message_id, error, sent_at, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    if (rErr) throw new Error('recipients: ' + rErr.message);

    return res.status(200).json({ job, recipients: recips || [] });
  } catch (e) {
    console.error('[wanbetalers-bulk-job-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
