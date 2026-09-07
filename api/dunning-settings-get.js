// api/dunning-settings-get.js
// GET → { dunning_cooldown_days: <int>, dunning_grace_days: <int> }
// Permission: finance.dunning.view.
//
// dunning_grace_days = extra respijt NA de vervaldag voordat de motor mag
// aanmanen. Default 0: op en vóór de vervaldag gaat er sowieso niets uit.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  GRACE_SETTING_KEY,
  DEFAULT_GRACE_DAYS,
  MAX_GRACE_DAYS,
  parseGraceDays,
} from './_lib/dunning-overdue-guard.js';

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

    const { data: graceRow } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', GRACE_SETTING_KEY)
      .maybeSingle();
    const graceDays = graceRow ? parseGraceDays(graceRow?.value?.days) : DEFAULT_GRACE_DAYS;

    return res.status(200).json({
      dunning_cooldown_days: days,
      is_default: !data,
      updated_at: data?.updated_at || null,
      dunning_grace_days: graceDays,
      dunning_grace_days_is_default: !graceRow,
      dunning_grace_days_updated_at: graceRow?.updated_at || null,
      dunning_grace_days_max: MAX_GRACE_DAYS,
    });
  } catch (e) {
    console.error('[dunning-settings-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
