// api/dunning-settings-get.js
// GET → { dunning_cooldown_days: <int>, dunning_grace_days: <int>,
//         dunning_ladder: { <templatenaam>: <dagen na vervaldatum> },
//         dunning_max_sends_per_day: { whatsapp: <int>, email: <int> } }
// Permission: finance.dunning.view.
//
// dunning_grace_days = extra respijt NA de vervaldag voordat de motor mag
// aanmanen. Default 0: op en vóór de vervaldag gaat er sowieso niets uit.
//
// dunning_ladder = per (Meta-)templatenaam het aantal dagen NA de vervaldatum
// waarop hij mag vertrekken. De namen zijn bij Meta goedgekeurd en zeggen
// niets over het moment: `aanmaning_dag7` vertrekt op dag 1.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  GRACE_SETTING_KEY,
  DEFAULT_GRACE_DAYS,
  MAX_GRACE_DAYS,
  parseGraceDays,
  LADDER_SETTING_KEY,
  DEFAULT_LADDER,
  MAX_LADDER_DAYS,
  parseLadder,
  MAX_SENDS_SETTING_KEY,
  DEFAULT_MAX_SENDS_PER_DAY,
  MAX_MAX_SENDS_PER_DAY,
  parseMaxSendsPerDay,
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

    const { data: ladderRow } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', LADDER_SETTING_KEY)
      .maybeSingle();
    const ladder = ladderRow ? parseLadder(ladderRow?.value) : { ...DEFAULT_LADDER };

    const { data: capRow } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', MAX_SENDS_SETTING_KEY)
      .maybeSingle();
    const maxSendsPerDay = capRow ? parseMaxSendsPerDay(capRow.value) : { ...DEFAULT_MAX_SENDS_PER_DAY };

    return res.status(200).json({
      dunning_cooldown_days: days,
      is_default: !data,
      updated_at: data?.updated_at || null,
      dunning_grace_days: graceDays,
      dunning_grace_days_is_default: !graceRow,
      dunning_grace_days_updated_at: graceRow?.updated_at || null,
      dunning_grace_days_max: MAX_GRACE_DAYS,
      dunning_ladder: ladder,
      dunning_ladder_defaults: { ...DEFAULT_LADDER },
      dunning_ladder_is_default: !ladderRow,
      dunning_ladder_updated_at: ladderRow?.updated_at || null,
      dunning_ladder_max_days: MAX_LADDER_DAYS,
      // Object per kanaal: { whatsapp, email }. Het WhatsApp+e-mail-koppel van
      // dezelfde aanmaanronde moet samen de deur uit kunnen.
      dunning_max_sends_per_day: maxSendsPerDay,
      dunning_max_sends_per_day_is_default: !capRow,
      dunning_max_sends_per_day_updated_at: capRow?.updated_at || null,
      dunning_max_sends_per_day_max: MAX_MAX_SENDS_PER_DAY,
    });
  } catch (e) {
    console.error('[dunning-settings-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
