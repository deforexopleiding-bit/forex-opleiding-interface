// api/cron-dunning-engine.js
// Cron-endpoint: draait de dunning-engine (detecteert wanbetalers + advanced
// actieve runs). Idempotent + time-budget-aware (50s abort) zodat Vercel 60s
// hard timeout niet halverwege een mutatie knipt.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth uit ./supabase.js,
// zelfde patroon als /api/cron-finance-sync).
//
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger via dezelfde
// CRON_SECRET — handig voor curl-tests buiten de schedule om).
//
// Schedule: elk uur (`0 * * * *`, zie vercel.json crons-entry).
// De engine draait 24/7, maar SEND-stappen (email/whatsapp) worden binnen
// dunning-engine.js zelf gegate door de kantooruren-guard (default 08:00-20:00
// Europe/Amsterdam, elke dag — configureerbaar via app_settings.
// dunning_office_hours). Wait/task/stop/resume mogen buiten het venster
// gewoon doorlopen zodat de workflow-pointer niet stilstaat. Zie
// api/_lib/dunning-office-hours.js voor de logica en officeHoursLabel.

import { checkCronAuth } from './supabase.js';
import { runEngine } from './_lib/dunning-engine.js';

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
    const result = await runEngine({ mode: 'cron' });
    console.log('[cron-dunning-engine]', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cron-dunning-engine] fatal', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
