// api/cron-dunning-conv-less-resume.js
// Cron-endpoint: geeft conv-loze dunning-pauzes een hervat-pad en trekt de
// bestaande berg gestaffeld leeg. Off-by-default via
// joost_config.finance.autonomy_config.conv_less_resume.enabled.
// Auth: CRON_SECRET (zelfde patroon als /api/cron-dunning-engine).
//
// Schedule: dagelijks 09:45 (na promise-maturity 09:30). Zie vercel.json.

import { checkCronAuth } from './supabase.js';
import { runConvLessResume } from './_lib/conv-less-resume.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  try {
    const summary = await runConvLessResume({ scope: 'production' });
    console.log('[cron-dunning-conv-less-resume]', JSON.stringify({
      enabled: summary.enabled, dry_run: summary.dry_run, mode: summary.config_mode,
      scanned: summary.scanned, paid: summary.paid_completed, resumed: summary.resumed,
      recent_human: summary.recent_contact_human, duplicate_skipped: summary.duplicate_skipped,
      needs_attention_skipped: summary.needs_attention_skipped, errors: summary.errors.length,
    }));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[cron-dunning-conv-less-resume] fatal', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
