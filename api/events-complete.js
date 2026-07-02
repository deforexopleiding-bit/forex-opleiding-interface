// api/events-complete.js
//
// F5.1 — Event afronden in 1 endpoint. Sinds Fase 2b-2 is de motor
// geëxtraheerd naar api/_lib/events-complete-core.js. Dit bestand blijft de
// permission-gate + JWT-user-resolve; de mutation-logic (attendance,
// followups, mentors, expenses, ledger-entries, notifications) staat 1x in
// de core en wordt hergebruikt door api/admin/historical-event-commit.js.
//
// Body-shape + response-shape ongewijzigd t.o.v. F5.1 — zie
// events-complete-core.js voor de volledige veld-documentatie.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { runEventsCompleteCore } from './_lib/events-complete-core.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.complete'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.complete)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  const { statusCode, response } = await runEventsCompleteCore({ userId: user.id, body });
  return res.status(statusCode).json(response);
}
