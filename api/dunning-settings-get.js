// api/dunning-settings-get.js
// GET → { dunning_cooldown_days: <int> }
// Permission: finance.dunning.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const DEFAULT_COOLDOWN_DAYS = 7;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', 'dunning_cooldown_days')
      .maybeSingle();
    const raw = data?.value?.days;
    const n = Number(raw);
    const days = (Number.isFinite(n) && n >= 1 && n <= 90) ? Math.trunc(n) : DEFAULT_COOLDOWN_DAYS;
    return res.status(200).json({
      dunning_cooldown_days: days,
      is_default: !data,
      updated_at: data?.updated_at || null,
    });
  } catch (e) {
    console.error('[dunning-settings-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
