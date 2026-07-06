// api/cron-mentor-cash-release.js
//
// Dagelijkse cron voor handmatige-traject-vrijval (schedule: 0 6 * * *).
// Per traject wordt max 1 termijn per run vrijgegeven zodra de vrijval-
// datum bereikt is (release_day per traject; helper: mentor-cash-release-
// core.js). Zo lopen achterstallige termijnen 1-per-dag in en veroorzaakt
// een gemiste cron-dag geen piekvrijval.
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
    const summary = await releaseCashTrajectTerms({}); // asOfDate = nu, alle actieve
    return res.status(200).json(summary);
  } catch (e) {
    console.error('[cron-mentor-cash-release]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
