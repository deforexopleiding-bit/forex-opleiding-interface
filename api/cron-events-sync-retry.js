// api/cron-events-sync-retry.js
//
// F2 — Retry-cron voor gefaalde outbound event-sync attempts.
//
// Selecteert tot 50 rijen uit event_sync_log waar status='failure' en
// next_retry_at <= now() (events die klaar staan voor een nieuwe poging
// volgens de retry-strategy in event-sync-orchestrator).
//
// Per kandidaat-event roepen we syncEventToOutbound() AWAITED aan. De
// orchestrator regelt zelf het bijhouden van event_sync_log:
//   - bij success: nieuwe rij met status='success' wordt automatisch
//     geinsert, en events.<target>_sync_status wordt op 'success' gezet.
//     De oude failure-rij blijft staan als historie (correct - we tellen
//     retries op basis van failures sinds laatste success).
//   - bij failure: nieuwe rij met opgehoogde retry_count + nieuwe
//     next_retry_at, of NULL (alarm) als retry_count >= 4.
//
// We deduplicaten per event_id binnen 1 cron-run zodat we niet 2x dezelfde
// sync triggeren als zowel webflow als ghl klaar staan voor retry. De
// orchestrator probeert beide targets sowieso in 1 call.
//
// Per-rij try/catch (lesson #3 - nooit early-return op 1 faal-item).
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth, zelfde patroon
// als andere cron-* endpoints).
//
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: */15 * * * * (zie vercel.json).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { syncEventToOutbound } from './_lib/event-sync-orchestrator.js';

const BATCH_LIMIT = 50;
const ABORT_MS    = 50_000;

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
    candidates: 0,
    unique_events_retried: 0,
    success: 0,
    failure: 0,
    skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  try {
    const nowIso = new Date().toISOString();
    const { data: rows, error: selErr } = await supabaseAdmin
      .from('event_sync_log')
      .select('id, event_id, target, retry_count, next_retry_at, attempted_at')
      .eq('status', 'failure')
      .not('next_retry_at', 'is', null)
      .lte('next_retry_at', nowIso)
      .order('attempted_at', { ascending: true })
      .limit(BATCH_LIMIT);
    if (selErr) throw new Error('select event_sync_log: ' + selErr.message);

    summary.candidates = (rows || []).length;

    // Dedup per event_id: orchestrator syncEventToOutbound triggert beide
    // targets in 1 call. Geen zin om dezelfde event 2x te retryen binnen 1 run.
    const seenEventIds = new Set();

    for (const row of rows || []) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'aborted before completion' });
        break;
      }

      if (seenEventIds.has(row.event_id)) {
        summary.skipped++;
        continue;
      }
      seenEventIds.add(row.event_id);
      summary.unique_events_retried++;

      try {
        const result = await syncEventToOutbound(row.event_id);
        const wfOk  = result?.webflow?.ok === true || result?.webflow?.status === 'success';
        const ghlOk = result?.ghl?.ok === true     || result?.ghl?.status     === 'success';
        if (wfOk && ghlOk) {
          summary.success++;
        } else {
          summary.failure++;
        }
      } catch (e) {
        summary.failure++;
        summary.errors.push({
          event_id: row.event_id,
          error: e?.message || String(e),
        });
        console.error('[cron-events-sync-retry] sync failed', row.event_id, e?.message);
      }
    }

    summary.duration_ms = Date.now() - startedAt;

    console.log('[cron-events-sync-retry]', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    summary.errors.push({ phase: 'fatal', error: e?.message || String(e) });
    console.error('[cron-events-sync-retry] fatal', e);
    return res.status(500).json(summary);
  }
}
