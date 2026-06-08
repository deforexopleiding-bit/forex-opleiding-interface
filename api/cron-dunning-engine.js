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
// Schedule: dagelijks 09:00 (zie vercel.json crons-entry).

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
