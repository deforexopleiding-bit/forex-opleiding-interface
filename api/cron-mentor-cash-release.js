// api/cron-mentor-cash-release.js
//
// Dagelijkse cron voor handmatige trajecten (schedule: 0 6 * * *).
// Sinds 3 nov 2026 GEEN datumvrijval meer: voor elk omgezet traject draait de
// factuurmotor (enkel betaalde facturen geven commissie vrij, te veel
// vrijgegeven wordt verrekend). Niet omgezette trajecten krijgen niets.
//
// Kern-logica zit in api/_lib/mentor-cash-release-core.js zodat de admin-
// testknop (api/mentor-cash-traject-release.js) dezelfde flow kan
// aanroepen zonder CRON_SECRET.
//
// Auth: Authorization: Bearer $CRON_SECRET.

import { checkCronAuth } from './supabase.js';
import { releaseCashTrajectTerms } from './_lib/mentor-cash-release-core.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const summary = await releaseCashTrajectTerms({}); // factuurmotor per omgezet traject
    return res.status(200).json(summary);
  } catch (e) {
    console.error('[cron-mentor-cash-release]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
