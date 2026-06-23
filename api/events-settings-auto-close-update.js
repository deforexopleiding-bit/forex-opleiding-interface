// api/events-settings-auto-close-update.js
//
// POST/PUT → update de signup-auto-close hours-before instelling.
// UPSERT op app_settings.key='events_signups_auto_close_hours_before'.
//
// Permission: events.event.edit (zelfde key als andere events-admin-acties).
//
// Body:
//   { hours: <int> }   // 0..720 (1 maand cap als sanity)
//
// Response 200:
//   { ok:true, hours: <int>, updated_at: <iso>, updated_by_user_id: <uuid> }
//
// Errors:
//   400  hours ontbreekt / niet integer / buiten 0..720
//   401  geen sessie
//   403  geen events.event.edit
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const SETTING_KEY = 'events_signups_auto_close_hours_before';
const HOURS_MIN   = 0;
const HOURS_MAX   = 720;     // 30 dagen sanity-cap

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'PUT') {
    res.setHeader('Allow', 'POST, PUT');
    return res.status(405).json({ error: 'POST or PUT only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });

  const hoursNum = Number(body.hours);
  if (!Number.isFinite(hoursNum) || !Number.isInteger(hoursNum)) {
    return res.status(400).json({ error: 'hours moet een geheel getal zijn.' });
  }
  if (hoursNum < HOURS_MIN || hoursNum > HOURS_MAX) {
    return res.status(400).json({
      error: `hours moet tussen ${HOURS_MIN} en ${HOURS_MAX} liggen (kreeg ${hoursNum}).`,
    });
  }

  try {
    // UPSERT: 2-staps SELECT → UPDATE/INSERT — zelfde patroon als
    // generieke api/app-settings.js, robuust tegen partial-index races.
    const value = { hours: hoursNum };
    const nowIso = new Date().toISOString();

    const { data: existing, error: selErr } = await supabaseAdmin
      .from('app_settings').select('key').eq('key', SETTING_KEY).maybeSingle();
    if (selErr) throw new Error('app_settings lookup: ' + selErr.message);

    if (existing) {
      const { error: updErr } = await supabaseAdmin
        .from('app_settings')
        .update({
          value,
          updated_by_user_id: user.id,
          updated_at        : nowIso,
        })
        .eq('key', SETTING_KEY);
      if (updErr) throw new Error('app_settings update: ' + updErr.message);
    } else {
      const { error: insErr } = await supabaseAdmin
        .from('app_settings')
        .insert({
          key: SETTING_KEY,
          value,
          updated_by_user_id: user.id,
        });
      if (insErr) throw new Error('app_settings insert: ' + insErr.message);
    }

    // Audit-log (fail-soft, zelfde patroon als generieke app-settings.js).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'events.signups_auto_close_hours.update',
        entity_type: 'app_setting',
        entity_id:   null,
        after_json:  { key: SETTING_KEY, value },
        reason_text: `Signup-auto-close ingesteld op ${hoursNum} uur voor event-start`,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[events-settings-auto-close-update audit]', e?.message || e);
    }

    return res.status(200).json({
      ok                 : true,
      hours              : hoursNum,
      updated_at         : nowIso,
      updated_by_user_id : user.id,
    });
  } catch (e) {
    console.error('[events-settings-auto-close-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
