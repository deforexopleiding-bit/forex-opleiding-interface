// api/wanbetalers-bulk-approve.js
//
// POST { job_id } → zet dunning_bulk_jobs.status van 'draft' naar 'approved'
// + approved_at=now(). Fase 2's cron pakt approved jobs op en verstuurt.
//
// FASE 1: dit endpoint doet ALLEEN de status-flip + audit-log. NIETS gaat
// naar klanten. Response bevat een expliciete phase_note zodat de UI dat
// kan tonen ("Verzending nog niet actief").
//
// Auth: finance.dunning.execute.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  const jobId = body && typeof body.job_id === 'string' ? body.job_id.trim() : null;
  if (!jobId || !UUID_RE.test(jobId)) return res.status(400).json({ error: 'job_id (uuid) vereist' });

  try {
    const { data: job, error: jErr } = await supabaseAdmin
      .from('dunning_bulk_jobs')
      .select('id, status, channel, template_name, total_recipients, skipped_count')
      .eq('id', jobId)
      .maybeSingle();
    if (jErr) throw new Error('job fetch: ' + jErr.message);
    if (!job) return res.status(404).json({ error: 'Job niet gevonden' });
    if (job.status !== 'draft') {
      return res.status(409).json({
        error: `Job kan alleen vanaf status 'draft' worden goedgekeurd (huidige status: ${job.status})`,
        code : 'INVALID_STATUS',
      });
    }

    // Race-guard: alleen updaten als 'ie nog draft is.
    const { error: uErr } = await supabaseAdmin
      .from('dunning_bulk_jobs')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'draft');
    if (uErr) throw new Error('job approve: ' + uErr.message);

    // Audit — best-effort.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id    : user.id,
        action     : 'dunning_bulk.approve',
        entity_type: 'dunning_bulk_job',
        entity_id  : jobId,
        after_json : {
          channel         : job.channel,
          template_name   : job.template_name,
          total_recipients: job.total_recipients,
          skipped_count   : job.skipped_count,
        },
        reason_text: `Bulk aanmaan-job goedgekeurd (${job.total_recipients} recipients, ${job.skipped_count} skipped)`,
        ip_address : getClientIp(req),
      });
    } catch (e) {
      console.error('[wanbetalers-bulk-approve] audit', e.message);
    }

    return res.status(200).json({
      ok        : true,
      job_id    : jobId,
      status    : 'approved',
      phase_note: 'FASE 1: job is goedgekeurd. Verzending gebeurt pas in Fase 2 (cron pikt approved jobs op).',
    });
  } catch (e) {
    console.error('[wanbetalers-bulk-approve]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
