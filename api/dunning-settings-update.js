// api/dunning-settings-update.js
// POST { dunning_cooldown_days?: int, dunning_grace_days?: int,
//        dunning_ladder?: { <templatenaam>: <dagen na vervaldatum> } }
//   → upsert in app_settings. Minstens één key is verplicht; ontbrekende
//     keys blijven ongewijzigd (back-compat: de bestaande UI stuurt alleen
//     dunning_cooldown_days).
//
// Waarom een aparte wrapper i.p.v. hergebruik van api/app-settings.js:
// dat endpoint eist super_admin voor PUT. Deze wrapper accepteert
// finance.dunning.execute — passend bij de finance-user die de dunning-
// engine beheert — en beperkt de scope tot precies één key.
//
// Waarde-validatie: cooldown integer 1..90, grace integer 0..90 (0 = geen
// extra respijt; de vervaldag zelf blijft sowieso beschermd), ladder-sporten
// integer 1..365 per templatenaam (1 = de dag ná de vervaldatum; 0 zou de
// vervaldag zelf toestaan en wordt daarom geweigerd). Onvalid → 400.
// Audit-log fail-soft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import {
  GRACE_SETTING_KEY,
  MAX_GRACE_DAYS,
  LADDER_SETTING_KEY,
  MAX_LADDER_DAYS,
  parseLadder,
} from './_lib/dunning-overdue-guard.js';

const KEY = 'dunning_cooldown_days';

// 2-staps upsert (net als app-settings.js) → geen ON CONFLICT nodig op
// partial UNIQUE indexen.
async function upsertSetting(key, value) {
  const { data: existing } = await supabaseAdmin
    .from('app_settings').select('key').eq('key', key).maybeSingle();
  if (existing) {
    const { error } = await supabaseAdmin
      .from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabaseAdmin
      .from('app_settings').insert({ key, value });
    if (error) throw new Error(error.message);
  }
}

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
  const hasCooldown = body?.dunning_cooldown_days !== undefined && body?.dunning_cooldown_days !== null;
  const hasGrace    = body?.dunning_grace_days    !== undefined && body?.dunning_grace_days    !== null;
  const hasLadder   = body?.dunning_ladder        !== undefined && body?.dunning_ladder        !== null;
  if (!hasCooldown && !hasGrace && !hasLadder) {
    return res.status(400).json({
      error: 'dunning_cooldown_days, dunning_grace_days en/of dunning_ladder is verplicht',
    });
  }

  let n = null;
  if (hasCooldown) {
    n = Number(body.dunning_cooldown_days);
    if (!Number.isFinite(n) || n < 1 || n > 90 || Math.trunc(n) !== n) {
      return res.status(400).json({ error: 'dunning_cooldown_days moet integer 1..90 zijn' });
    }
  }

  let g = null;
  if (hasGrace) {
    g = Number(body.dunning_grace_days);
    if (!Number.isFinite(g) || g < 0 || g > MAX_GRACE_DAYS || Math.trunc(g) !== g) {
      return res.status(400).json({ error: `dunning_grace_days moet integer 0..${MAX_GRACE_DAYS} zijn` });
    }
  }

  let rungs = null;
  if (hasLadder) {
    const raw = body.dunning_ladder;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ error: 'dunning_ladder moet een object zijn { templatenaam: dagen }' });
    }
    // Elke opgegeven sport hard valideren; parseLadder vult daarna de
    // ontbrekende sporten aan met de defaults zodat de opgeslagen rij
    // compleet is (geen half-ingevulde ladder in de DB).
    for (const [name, val] of Object.entries(raw)) {
      if (!String(name || '').trim()) {
        return res.status(400).json({ error: 'dunning_ladder: lege templatenaam is niet toegestaan' });
      }
      const d = Number(val);
      if (!Number.isFinite(d) || Math.trunc(d) !== d || d < 1 || d > MAX_LADDER_DAYS) {
        return res.status(400).json({
          error: `dunning_ladder.${name} moet integer 1..${MAX_LADDER_DAYS} zijn (1 = de dag ná de vervaldatum)`,
        });
      }
    }
    rungs = parseLadder(raw);
  }

  const value = hasCooldown ? { days: n } : null;

  try {
    if (hasCooldown) await upsertSetting(KEY, value);
    if (hasGrace)    await upsertSetting(GRACE_SETTING_KEY, { days: g });
    if (hasLadder)   await upsertSetting(LADDER_SETTING_KEY, { rungs });

    // Audit-log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id    : user.id,
        action     : 'dunning_settings.update',
        entity_type: 'app_settings',
        entity_id  : null,
        after_json : {
          ...(hasCooldown ? { [KEY]: value } : {}),
          ...(hasGrace    ? { [GRACE_SETTING_KEY]: { days: g } } : {}),
          ...(hasLadder   ? { [LADDER_SETTING_KEY]: { rungs } } : {}),
        },
        reason_text: [
          hasCooldown ? `Cooldown gezet op ${n} dagen` : null,
          hasGrace    ? `Gratieperiode gezet op ${g} dagen` : null,
          hasLadder   ? `Ladder gezet op ${Object.entries(rungs).map(([k, v]) => `${k}=dag ${v}`).join(', ')}` : null,
        ].filter(Boolean).join(' · '),
        ip_address : getClientIp(req),
      });
    } catch (e) { console.warn('[dunning-settings-update] audit soft-fail', e?.message || e); }

    return res.status(200).json({
      ok: true,
      ...(hasCooldown ? { dunning_cooldown_days: n } : {}),
      ...(hasGrace    ? { dunning_grace_days: g } : {}),
      ...(hasLadder   ? { dunning_ladder: rungs } : {}),
    });
  } catch (e) {
    console.error('[dunning-settings-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
