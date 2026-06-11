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
import { updateOptions } from './_lib/ghl-custom-field.js';
import { computeUpcomingLabels } from './_lib/event-sync-orchestrator.js';

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
    labels_count: 0,
    ghl_status: null,
    ghl_options_key: null,
    ghl_used_shape: null,
    ghl_tried_shapes: null,
    skipped: false,
    skip_reason: null,
    errors: [],
    duration_ms: 0,
  };

  try {
    // Use the SAME helper as the orchestrator-triggers (publish/update/cancel)
    // so cron and triggers can never drift apart in event-selection logic.
    const labels = await computeUpcomingLabels();
    summary.labels_count = labels.length;

    const result = await updateOptions({ labels });

    if (result?.skipped) {
      // GHL_GUARD_EMPTY_LABELS (0 labels) komt hier ook door - bewust een
      // skip, niet een failure. Dropdown blijft in zijn vorige goede staat.
      summary.skipped         = true;
      summary.skip_reason     = result.reason || 'graceful skip';
      summary.ghl_status      = 'skipped_graceful';
      summary.ghl_tried_shapes = result.tried_shapes || null;
    } else if (result?.ok) {
      summary.ghl_status      = 'success';
      summary.ghl_options_key = result.put_options_key || result.optionsKey || null;
      summary.ghl_used_shape  = result.used_shape || null;
      summary.ghl_tried_shapes = result.tried_shapes || null;
    } else {
      summary.ghl_status = 'failure';
      summary.ghl_tried_shapes = result?.tried_shapes || null;
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
