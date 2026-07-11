// api/cron-incasso-auto.js
// Cron-endpoint: draait de auto-incasso routine (off-by-default via
// app_settings.incasso_auto.enabled). Auth: CRON_SECRET (zelfde patroon
// als /api/cron-dunning-engine).
//
// Schedule: dagelijks 09:15 (vlak na dunning-engine). Zie vercel.json.

import { checkCronAuth } from './supabase.js';
import { getIncassoAutoSettings, runIncassoAuto } from './_lib/incasso-auto.js';

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
    const settings = await getIncassoAutoSettings();
    if (!settings.enabled) {
      return res.status(200).json({ ok: true, skipped: 'auto-route uit' });
    }
    const summary = await runIncassoAuto({ openedBy: null, source: 'auto' });
    console.log('[cron-incasso-auto]', JSON.stringify({
      total: summary.total_candidates,
      created: summary.created.length,
      skipped_wik: summary.skipped_wik.length,
      skipped_other: summary.skipped_other.length,
      errors: summary.errors.length,
    }));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[cron-incasso-auto] fatal', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
