// api/cron-webinar.js
//
// Cron (elke minuut): webinar-planning + berichten.
//   - zorgt dat de komende 6 weken als sessie bestaan (overgeslagen blijft overgeslagen);
//   - stuurt openstaande bevestigingen (endpoint faalde, of na doorschuiven);
//   - stuurt de reminders die nu aan de beurt zijn: dag ervoor, uur ervoor, live.
// Alleen sessies met status 'gepland'. Idempotent per moment via een claim op
// de _op-kolom. Tijdbudget 45 s; de rest volgt de volgende minuut.
// Zie api/_lib/webinar.js.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { cronRonde } from './_lib/webinar.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  try {
    const uit = await cronRonde(supabaseAdmin);
    const iets = uit.sessies_aangemaakt || uit.bevestiging || uit.dag || uit.uur || uit.live || uit.fouten;
    if (iets) console.log('[cron-webinar]', JSON.stringify(uit));
    return res.status(200).json({ ok: true, ...uit });
  } catch (e) {
    console.error('[cron-webinar] fout:', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
