// api/incasso-auto-preview.js
// GET → { settings, candidates: [...] }. Read-only, geen side effects.
// Permission: finance.incasso.manage.
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { evaluateIncassoCandidates } from './_lib/incasso-auto.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }
  try {
    const result = await evaluateIncassoCandidates();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[incasso-auto-preview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
