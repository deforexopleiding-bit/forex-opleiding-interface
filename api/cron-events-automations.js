// api/cron-events-automations.js
// Per-minuut cron: enroll nieuwe attendees in actieve automations + step de
// runs die due zijn. Veilige no-op bij 0 enabled automations.
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth). GET (Vercel cron) + POST (debug).

import { checkCronAuth } from './supabase.js';
import { enrollDueAttendees, stepDueRuns } from './_lib/events-automation-engine.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const now = new Date();
  const out = { ok: true, now: now.toISOString() };

  try {
    out.enroll = await enrollDueAttendees({ now });
  } catch (e) {
    out.enroll_error = (e && e.message) || 'enroll failed';
    console.error('[cron-events-automations] enroll:', (e && e.message) || e);
  }

  try {
    out.step = await stepDueRuns({ now });
  } catch (e) {
    out.step_error = (e && e.message) || 'step failed';
    console.error('[cron-events-automations] step:', (e && e.message) || e);
  }

  out.duration_ms = Date.now() - startedAt;
  return res.status(200).json(out);
}
