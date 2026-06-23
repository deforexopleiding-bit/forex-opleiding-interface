// api/events-settings-auto-close-get.js
//
// GET → huidige instelling voor signup-auto-close hours-before.
// Leest app_settings.key='events_signups_auto_close_hours_before' (jsonb).
//
// Permission: events.event.edit (zelfde key als andere events-admin-acties).
//
// Response 200:
//   { hours: <int>, updated_at: <iso|null>, updated_by_user_id: <uuid|null> }
//
// Fallback: ontbrekende rij → { hours: 24, updated_at: null,
//                               updated_by_user_id: null }.
//
// Errors:
//   401  geen sessie
//   403  geen events.event.edit
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SETTING_KEY = 'events_signups_auto_close_hours_before';
const DEFAULT_HOURS = 24;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at, updated_by_user_id')
      .eq('key', SETTING_KEY)
      .maybeSingle();
    if (error) throw new Error('app_settings fetch: ' + error.message);

    // Fail-safe parse: value moet { hours: int } zijn. Bij ongeldige inhoud
    // valt 'ie netjes terug op de default (cron doet hetzelfde).
    let hours = DEFAULT_HOURS;
    const raw = data?.value;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const n = Number(raw.hours);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) hours = n;
    }

    return res.status(200).json({
      hours,
      updated_at         : data?.updated_at || null,
      updated_by_user_id : data?.updated_by_user_id || null,
    });
  } catch (e) {
    console.error('[events-settings-auto-close-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
