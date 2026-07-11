// api/incasso-auto-run.js
// POST → handmatige trigger van runIncassoAuto. Draait ONGEACHT de
// enabled-toggle (expliciete mensactie via finance.incasso.manage).
// Permission: finance.incasso.manage.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { runIncassoAuto } from './_lib/incasso-auto.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }
  try {
    const summary = await runIncassoAuto({ openedBy: user.id, source: 'handmatig' });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[incasso-auto-run]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
