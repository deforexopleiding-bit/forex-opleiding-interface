// api/cron-events-ghl-next-update.js
//
// F2 — Dagelijkse herberekening van GHL custom-field options voor upcoming
// published events.
//
// Achtergrond: het GHL formulier toont een dropdown met komende events. De
// orchestrator updatet die lijst bij elke publish/update/delete. Maar zodra
// een event in het verleden valt (starts_at < now) zou hij uit de dropdown
// moeten verdwijnen zonder dat iemand handmatig publish/update triggert.
//
// Deze cron draait 1x per dag om 06:00 NL-tijd, pakt alle published events
// met starts_at > now, formatteert de labels, en doet PUT naar het GHL
// custom-field. Idempotent: zelfde labels = zelfde body; GHL accepteert
// dezelfde body zonder side-effects.
//
// We loggen NIET per event in event_sync_log (zou per dag 1 rij per upcoming
// event geven zonder informatieve waarde). De cron-run zelf logt 1 audit
// summary-regel via console.log.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
//
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: 0 6 * * * (zie vercel.json).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { updateOptions, formatEventLabel } from './_lib/ghl-custom-field.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const summary = {
    upcoming_events: 0,
    labels_count: 0,
    ghl_status: null,
    ghl_options_key: null,
    skipped: false,
    skip_reason: null,
    errors: [],
    duration_ms: 0,
  };

  try {
    const nowIso = new Date().toISOString();
    const { data: events, error: selErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, status')
      .eq('status', 'published')
      .gt('starts_at', nowIso)
      .order('starts_at', { ascending: true });
    if (selErr) throw new Error('select events: ' + selErr.message);

    summary.upcoming_events = (events || []).length;

    const labels = (events || [])
      .map(formatEventLabel)
      .filter(Boolean);
    summary.labels_count = labels.length;

    const result = await updateOptions({ labels });

    if (result?.skipped) {
      summary.skipped     = true;
      summary.skip_reason = result.reason || 'graceful skip';
      summary.ghl_status  = 'skipped_graceful';
    } else if (result?.ok) {
      summary.ghl_status      = 'success';
      summary.ghl_options_key = result.optionsKey || null;
    } else {
      summary.ghl_status = 'failure';
      summary.errors.push({
        error_code: result?.error_code || 'UNKNOWN',
        message   : result?.message    || 'unknown error',
      });
    }

    summary.duration_ms = Date.now() - startedAt;

    console.log('[cron-events-ghl-next-update]', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    summary.errors.push({ phase: 'fatal', error: e?.message || String(e) });
    console.error('[cron-events-ghl-next-update] fatal', e);
    return res.status(500).json(summary);
  }
}
