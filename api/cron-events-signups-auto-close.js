// api/cron-events-signups-auto-close.js
//
// F2 Blok 1 - hourly auto-close van events waarvan de signup-deadline
// gepasseerd is.
//
// Deadline-definitie (sinds 2026-06-22 — vereenvoudigde semantiek):
//   now >= starts_at - N hours
//
// Waarbij N komt uit app_settings.key='events_signups_auto_close_hours_before'
// (jsonb { hours: <int> }, default 24). Operator past N aan via Events →
// Instellingen → Signup-deadline.
//
// Voorbeeld bij N=24:
//   - Event op 13 juni 19:00 starts_at → cutoff = 12 juni 19:00.
//   - now >= 12 juni 19:00 → event MOET sluiten.
//
// EXACT, niet meer midnight-NL semantiek. Het oude model "00:00 NL de
// dag VOOR het event" was lastig te communiceren en gevoelig voor
// DST/midnight-edge-cases; deze versie is een rechttoe-rechtaan
// timestamp-vergelijking.
//
// Implementatie:
//   1. Lees hoursBefore uit app_settings (fail-soft → default 24).
//   2. Pre-filter SQL: status='published' AND signups_closed=false AND
//      starts_at < now() + (hoursBefore + 24)h. Buffer van +24h zodat we
//      events die net binnen het venster vallen niet missen.
//   3. JS-filter per event: nowMs >= startsAtMs - hoursBefore * 3600_000.
//   4. Per match:
//        a. UPDATE events SET signups_closed=true, signups_closed_at=now(),
//             signups_closed_reason='auto_time',
//             signups_closed_by_user_id=NULL
//           (lock OQ1: 3-veld model, NULL voor cron-write).
//        b. AWAIT closeSignupsOutbound(event.id)
//           - Webflow: PATCH item naar isDraft=true (staged record blijft)
//           - GHL: recompute upcoming-labels (event valt uit de set)
//        c. Logging in summary; orchestrator zelf schrijft event_sync_log.
//
// Per-event try/catch (lesson learned 3 - nooit early-return op 1 faal-item).
//
// Idempotent: door signups_closed=false WHERE-filter en race-guard op
// UPDATE raken we elk event hooguit 1x.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: 0 * * * * (hourly UTC).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { closeSignupsOutbound } from './_lib/event-sync-orchestrator.js';

const BATCH_LIMIT       = 50;
const ABORT_MS          = 50_000;
const DEFAULT_HOURS     = 24;
const SETTING_KEY       = 'events_signups_auto_close_hours_before';

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
    hours_before: DEFAULT_HOURS,
    pre_filter_rows: 0,
    processed: 0,
    closed: 0,
    sync_errors: 0,
    db_errors: 0,
    errors: [],
    duration_ms: 0,
  };

  try {
    // Globale setting lezen (fail-soft → default).
    let hoursBefore = DEFAULT_HOURS;
    try {
      const { data: settingRow, error: setErr } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', SETTING_KEY)
        .maybeSingle();
      if (setErr) {
        console.warn('[cron-events-signups-auto-close] app_settings fetch:', setErr.message);
      } else {
        const raw = Number(settingRow?.value?.hours);
        if (Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0) {
          hoursBefore = raw;
        } else if (settingRow) {
          console.warn('[cron-events-signups-auto-close] invalid hours setting, fallback to 24');
        }
      }
    } catch (e) {
      console.warn('[cron-events-signups-auto-close] app_settings exception:', e?.message || e);
    }
    summary.hours_before = hoursBefore;

    // Pre-filter: alle events die binnen (hoursBefore + 24)h starten. Buffer
    // van +24h zodat we events die kortelings ingepland zijn niet missen.
    const bufferMs = (hoursBefore + 24) * 3_600_000;
    const future = new Date(Date.now() + bufferMs).toISOString();

    const { data: rows, error: selErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, status, signups_closed')
      .eq('status', 'published')
      .eq('signups_closed', false)
      .lte('starts_at', future)
      .order('starts_at', { ascending: true })
      .limit(500);
    if (selErr) throw new Error('select events: ' + selErr.message);

    summary.pre_filter_rows = (rows || []).length;

    // Per-event deadline-check: cutoff = starts_at - hoursBefore * 3600_000.
    const nowMs = Date.now();
    const cutoffOffsetMs = hoursBefore * 3_600_000;
    const candidates = (rows || []).filter((r) => {
      if (!r.starts_at) return false;
      const startsAtMs = new Date(r.starts_at).getTime();
      if (!Number.isFinite(startsAtMs)) return false;
      const deadlineMs = startsAtMs - cutoffOffsetMs;
      return nowMs >= deadlineMs;
    });

    const batch = candidates.slice(0, BATCH_LIMIT);
    summary.processed = batch.length;

    for (const ev of batch) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'aborted before completion' });
        break;
      }

      try {
        // Stap 1: DB-write (signups_closed=true + audit-velden).
        const { data: updated, error: updErr } = await supabaseAdmin
          .from('events')
          .update({
            signups_closed: true,
            signups_closed_at: new Date().toISOString(),
            signups_closed_reason: 'auto_time',
            signups_closed_by_user_id: null,
          })
          .eq('id', ev.id)
          .eq('signups_closed', false) // race-guard tegen parallelle runs
          .select('id')
          .maybeSingle();
        if (updErr) {
          summary.db_errors++;
          summary.errors.push({ event_id: ev.id, phase: 'db_update', error: updErr.message });
          console.error('[cron-events-signups-auto-close] db_update failed', ev.id, updErr.message);
          continue;
        }
        if (!updated) {
          // Race: andere run heeft hem al gesloten. Skip outbound sync.
          continue;
        }

        summary.closed++;

        // Stap 2: outbound sync (Webflow unpublish + GHL recompute) AWAITED.
        try {
          await closeSignupsOutbound(ev.id);
        } catch (syncErr) {
          summary.sync_errors++;
          summary.errors.push({
            event_id: ev.id,
            phase: 'sync',
            error: syncErr?.message || String(syncErr),
          });
          console.error('[cron-events-signups-auto-close] sync failed', ev.id, syncErr?.message);
          // DB-state is al consistent (signups_closed=true). Retry-cron pakt
          // de Webflow/GHL-faal op via event_sync_log (orchestrator logt zelf).
        }
      } catch (e) {
        summary.errors.push({ event_id: ev.id, phase: 'outer', error: e?.message || String(e) });
        console.error('[cron-events-signups-auto-close] outer fail', ev.id, e?.message);
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log('[cron-events-signups-auto-close]', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    summary.errors.push({ phase: 'fatal', error: e?.message || String(e) });
    console.error('[cron-events-signups-auto-close] fatal', e);
    return res.status(500).json(summary);
  }
}
