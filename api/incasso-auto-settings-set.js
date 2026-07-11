// api/incasso-auto-settings-set.js
// POST { enabled, min_days_overdue, min_amount_open_eur,
//        require_broken_arrangement, require_no_response_after_aanmaning,
//        require_refusal_signal }
// Permission: finance.incasso.manage.
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { setIncassoAutoSettings } from './_lib/incasso-auto.js';

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
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    const settings = await setIncassoAutoSettings(body);
    return res.status(200).json({ ok: true, settings });
  } catch (e) {
    console.error('[incasso-auto-settings-set]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
