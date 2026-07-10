// api/dunning-settings-update.js
// POST { dunning_cooldown_days: int } → upsert in app_settings.
//
// Waarom een aparte wrapper i.p.v. hergebruik van api/app-settings.js:
// dat endpoint eist super_admin voor PUT. Deze wrapper accepteert
// finance.dunning.execute — passend bij de finance-user die de dunning-
// engine beheert — en beperkt de scope tot precies één key.
//
// Waarde-validatie: integer 1..90. Onvalid → 400. Audit-log fail-soft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const KEY = 'dunning_cooldown_days';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  const raw  = body?.dunning_cooldown_days;
  const n    = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 90 || Math.trunc(n) !== n) {
    return res.status(400).json({ error: 'dunning_cooldown_days moet integer 1..90 zijn' });
  }
  const value = { days: n };

  try {
    // 2-staps upsert (net als app-settings.js) → geen ON CONFLICT nodig
    // op partial UNIQUE indexen.
    const { data: existing } = await supabaseAdmin
      .from('app_settings').select('key').eq('key', KEY).maybeSingle();
    if (existing) {
      const { error: uErr } = await supabaseAdmin
        .from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', KEY);
      if (uErr) throw new Error(uErr.message);
    } else {
      const { error: iErr } = await supabaseAdmin
        .from('app_settings').insert({ key: KEY, value });
      if (iErr) throw new Error(iErr.message);
    }

    // Audit-log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id    : user.id,
        action     : 'dunning_settings.update',
        entity_type: 'app_settings',
        entity_id  : null,
        after_json : { key: KEY, value },
        reason_text: `Cooldown gezet op ${n} dagen`,
        ip_address : getClientIp(req),
      });
    } catch (e) { console.warn('[dunning-settings-update] audit soft-fail', e?.message || e); }

    return res.status(200).json({ ok: true, dunning_cooldown_days: n });
  } catch (e) {
    console.error('[dunning-settings-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
