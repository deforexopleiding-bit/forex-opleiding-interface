// api/mentor-cash-traject-release.js
// POST { id? } → draait de vrijval-motor voor alle actieve trajecten (of één
// specifiek traject wanneer id meegegeven). Permission: mentor.ledger.write.
//
// Voor de admin-testknop op /modules/mentor-cash-trajects-admin.html — geen
// CRON_SECRET vereist, zelfde vrijval-logica als de dagelijkse cron.
//
// Response: summary object van releaseCashTrajectTerms({ trajectId? }).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { releaseCashTrajectTerms } from './_lib/mentor-cash-release-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.ledger.write'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.ledger.write)' });
  }

  const id = req.body?.id;
  if (id && !UUID_RE.test(String(id))) return res.status(400).json({ error: 'id ongeldig' });

  try {
    const summary = await releaseCashTrajectTerms({ trajectId: id || null });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[mentor-cash-traject-release]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
