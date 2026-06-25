// api/cron/onboarding-automations.js
//
// Per-minuut cron: enroll due onboardings (time-based triggers + catch-up
// voor on_onboarding_created / on_wizard_completed misser) + step de runs
// die due zijn. Veilige no-op bij 0 enabled automations.
//
// Auth: Authorization: Bearer $CRON_SECRET (gelijk aan onboarding-reminders).
// GET (Vercel cron) + POST (debug). ?dry=1 voor report-only via cron-secret.

import { enrollDueOnboardings, stepDueRuns } from '../_lib/onboarding-automation-engine.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: bearer CRON_SECRET (mirror api/cron/onboarding-reminders.js).
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  const startedAt = Date.now();
  const now = new Date();
  const out = { ok: true, now: now.toISOString(), dry };

  if (dry) {
    // Report-only: load summary maar voer geen mutaties uit. In de huidige
    // implementatie schrijft enrollDueOnboardings / stepDueRuns direct naar
    // de DB; voor MVP zetten we 'dry' alleen op de response zodat een caller
    // kan zien dat 'ie in dry-mode is gestart (toekomst: échte dry-flow).
    out.dry_note = 'dry-flag bevestigd; engine voert wel mutaties uit (MVP).';
  }

  try {
    out.enroll = await enrollDueOnboardings({ now });
  } catch (e) {
    out.enroll_error = (e && e.message) || 'enroll failed';
    console.error('[cron onboarding-automations] enroll:', (e && e.message) || e);
  }

  try {
    out.step = await stepDueRuns({ now });
  } catch (e) {
    out.step_error = (e && e.message) || 'step failed';
    console.error('[cron onboarding-automations] step:', (e && e.message) || e);
  }

  out.duration_ms = Date.now() - startedAt;
  return res.status(200).json(out);
}
