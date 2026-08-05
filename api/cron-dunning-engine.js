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
// Schedule: elk uur binnen NL kantoortijd — `0 7-18 * * *` (UTC) = 12 ticks/dag.
// In UTC dekt dat 08:00-19:00 NL (winter/CET) en 09:00-20:00 NL (zomer/CEST).
// Doel: wachtstappen die overdag aflopen worden binnen 1u opgepakt i.p.v. tot
// de volgende ochtend te blijven liggen (concreet: klanten met next_action_at
// om 11:39 UTC gingen bij dagelijkse 07:00-cron een dag vertraging op).
//
// Waarom kantoortijd-venster? De engine zelf heeft (nog) geen office-hours
// gate; kantoortijd afdwingen via de cron-expressie voorkomt dat er 's nachts
// aanmaningen uitgaan. Wanneer de engine ooit eigen office-hours-logica
// krijgt (spiegel cron-dunning-conversation-reminders.js), mag deze schedule
// weer breder (`0 * * * *`).
//
// Idempotentie: veilig bij uurlijkse frequentie omdat wait-steps
// next_action_at op nu+dagen zetten (zie advanceActiveRuns); binnen 1 dag
// pikt geen enkele tick dezelfde run twee keer op. Cooldown-check in
// detectAndStartRuns (app_settings.dunning_cooldown_days, default 7) blokkeert
// het opnieuw starten van een run voor een klant met recente engine-send.

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
