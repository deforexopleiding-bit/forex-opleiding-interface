// api/cron-events-cms-cleanup.js
//
// F2 Blok 1 - daily cleanup van Webflow CMS items voor:
//   1. Events die >7 dagen geleden gestart zijn (starts_at < now() - 7d).
//   2. Events met status='cancelled' waarvan updated_at >7 dagen oud is.
//
// Doel: lege CMS-collection (max ~30 events) bij Webflow. Items die zo lang
// passed/cancelled zijn hebben geen functionele waarde meer op de website
// en moeten weg uit de collection om de "60 items max op Webflow basic"-
// drempel niet onnodig op te eten.
//
// Implementatie:
//   - Pre-filter SQL: webflow_item_id NOT NULL EN (
//       starts_at < (now - 7d)
//       OR (status='cancelled' AND updated_at < (now - 7d))
//     )
//     Via PostgREST .or() syntax.
//   - Per kandidaat: AWAIT hardDeleteEventOutbound(event.id) (orchestrator)
//   - hardDeleteEventOutbound returnt { eventId, webflow: {ok, status, ...}, ghl: {...} }
//     waar webflow.status ∈ {'noop'|'deleted'|'already_gone'|'failure'}.
//   - Summary-counts: hard_deleted (status='deleted'), already_gone
//     (status='already_gone'), noop, errors.
//
// hardDeleteEventOutbound zorgt zelf voor:
//   - Webflow DELETE /items/{id} (404=success/already_gone)
//   - events.webflow_item_id=NULL + webflow_sync_status='archived'
//   - event_sync_log rij voor audit-spoor
//   - GHL recompute (event valt eruit door starts_at<now of status='cancelled')
//
// Per-event try/catch (lesson learned 3 - nooit early-return op 1 faal-item).
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: 5 1 * * * (UTC ~02:05 NL winter / 03:05 zomer - bewust na de
// hourly close-cron zodat eventuele close-flow voor laatste dag al doorlopen is).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { hardDeleteEventOutbound } from './_lib/event-sync-orchestrator.js';

const BATCH_LIMIT = 100;
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
    hard_deleted: 0,
    already_gone: 0,
    noop: 0,
    errors: 0,
    error_details: [],
    duration_ms: 0,
  };

  try {
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // PostgREST OR-syntax: events met webflow_item_id NOT NULL waar
    //   starts_at < 7d-ago  OF  (status='cancelled' AND updated_at < 7d-ago)
    // De buiten-filter not.is.null staat als aparte eq-call; .or() handelt
    // alleen de twee criteria-takken af.
    const orExpr = `starts_at.lt.${sevenDaysAgoIso},and(status.eq.cancelled,updated_at.lt.${sevenDaysAgoIso})`;

    const { data: rows, error: selErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, status, updated_at, webflow_item_id')
      .not('webflow_item_id', 'is', null)
      .or(orExpr)
      .order('starts_at', { ascending: true })
      .limit(BATCH_LIMIT);
    if (selErr) throw new Error('select events: ' + selErr.message);

    summary.candidates = (rows || []).length;

    for (const ev of rows || []) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.error_details.push({ phase: 'time_budget', message: 'aborted before completion' });
        break;
      }

      try {
        const result = await hardDeleteEventOutbound(ev.id);
        const wfStatus = result?.webflow?.status || null;

        if (wfStatus === 'deleted') {
          summary.hard_deleted++;
        } else if (wfStatus === 'already_gone') {
          summary.already_gone++;
        } else if (wfStatus === 'noop') {
          // webflow_item_id was NULL bij hardDeleteWebflow (edge-case: tussen
          // SELECT en orchestrator-fetch heeft een andere flow hem leeggemaakt).
          summary.noop++;
        } else if (wfStatus === 'failure') {
          summary.errors++;
          summary.error_details.push({
            event_id: ev.id,
            phase: 'webflow_hard_delete',
            error_code: result?.webflow?.error_code || null,
            message: result?.webflow?.message || null,
          });
          console.error('[cron-events-cms-cleanup] webflow failure', ev.id, result?.webflow?.message);
        } else {
          // Onverwachte status - log defensief
          summary.errors++;
          summary.error_details.push({
            event_id: ev.id,
            phase: 'unexpected_status',
            webflow_status: wfStatus,
          });
          console.error('[cron-events-cms-cleanup] unexpected webflow status', ev.id, wfStatus);
        }
      } catch (e) {
        summary.errors++;
        summary.error_details.push({
          event_id: ev.id,
          phase: 'outer',
          error: e?.message || String(e),
        });
        console.error('[cron-events-cms-cleanup] outer fail', ev.id, e?.message);
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log('[cron-events-cms-cleanup]', JSON.stringify({
      candidates: summary.candidates,
      hard_deleted: summary.hard_deleted,
      already_gone: summary.already_gone,
      noop: summary.noop,
      errors: summary.errors,
      duration_ms: summary.duration_ms,
    }));
    return res.status(200).json(summary);
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    summary.error_details.push({ phase: 'fatal', error: e?.message || String(e) });
    summary.errors++;
    console.error('[cron-events-cms-cleanup] fatal', e);
    return res.status(500).json(summary);
  }
}
