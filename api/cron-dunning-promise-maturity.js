// api/cron-dunning-promise-maturity.js
// Cron-endpoint: laat verlopen betaaltoezeggingen (MANUAL_CONFIRM_PROMISE)
// "rijpen" zodat ze de dunning-run niet eeuwig blokkeren. Off-by-default via
// joost_config.finance.autonomy_config.promise_maturity.enabled.
// Auth: CRON_SECRET (zelfde patroon als /api/cron-dunning-engine).
//
// Schedule: dagelijks 09:30 (vlak na incasso-auto 09:15). Zie vercel.json.

import { checkCronAuth } from './supabase.js';
import { runPromiseMaturity } from './_lib/promise-maturity.js';

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
    const summary = await runPromiseMaturity({ scope: 'production' });
    console.log('[cron-dunning-promise-maturity]', JSON.stringify({
      enabled: summary.enabled, dry_run: summary.dry_run, mode: summary.config_mode,
      scanned: summary.scanned, matured: summary.matured, fulfilled: summary.fulfilled,
      auto_sent: summary.broken_auto_sent, human: summary.broken_human,
      no_date_human: summary.no_date_human, errors: summary.errors.length,
    }));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[cron-dunning-promise-maturity] fatal', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
