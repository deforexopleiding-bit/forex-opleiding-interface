// api/_lib/event-sync-orchestrator.js
//
// Orchestreert publish-sync van een event naar:
//   1. Webflow CMS (event-detail item LIVE)
//   2. GHL custom-field options (dropdown van upcoming events op formulier)
//
// Beide targets zijn geisoleerd in eigen try/catch zodat 1 faal-target de
// andere niet meeneemt. Voor elke poging wordt een rij weggeschreven in
// event_sync_log. Bij failure wordt next_retry_at berekend volgens spec:
//   retry_count 0 -> +15min
//   retry_count 1 -> +1h
//   retry_count 2 -> +6h
//   retry_count 3 -> +24h
//   retry_count >=4 -> NULL (alarm)
//
// Public API:
//   syncEventToOutbound(eventId)       — voor publish + update flows
//   unpublishEventOutbound(eventId)    — voor delete/cancel/archive flows
//
// Beide calls zijn AWAITED in de orchestrator. Caller (events-publish/-update/
// -delete) await't deze functie op zijn beurt of voert hem fire-and-forget
// uit; dat is een keuze van de caller-endpoint.

import { supabaseAdmin } from '../supabase.js';
import {
  createLiveItem,
  updateItem,
  unpublishItem,
  hardDeleteItem,
  republishItem,
  WebflowError,
} from './webflow-client.js';
import {
  updateOptions as ghlUpdateOptions,
  formatEventLabel,
} from './ghl-custom-field.js';

// ── Retry strategy ────────────────────────────────────────────────────────────

function nextRetryDelayMs(retryCount) {
  if (retryCount <= 0) return 15 * 60 * 1000;          // +15m
  if (retryCount === 1) return 60 * 60 * 1000;         // +1h
  if (retryCount === 2) return 6 * 60 * 60 * 1000;     // +6h
  if (retryCount === 3) return 24 * 60 * 60 * 1000;    // +24h
  return null;                                          // STOP
}

function computeNextRetryAt(retryCount) {
  const delay = nextRetryDelayMs(retryCount);
  if (delay === null) return null;
  return new Date(Date.now() + delay).toISOString();
}

// ── Markdown -> HTML (minimal, no external dep) ───────────────────────────────
//
// We renderen description_md naar HTML met een kleine subset (paragrafen,
// **bold**, *italic*, lijstjes, links). Volledig markdown-engine is overkill
// voor MVP en zou een nieuwe dependency vereisen.
function mdToHtmlSimple(md) {
  if (!md || typeof md !== 'string') return '';
  // Escape ruwe HTML eerst
  const esc = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = md.split(/\r?\n/);
  const out   = [];
  let inUl    = false;
  let para    = [];

  const flushPara = () => {
    if (para.length === 0) return;
    let html = esc(para.join(' '));
    // bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    // links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`);
    out.push(`<p>${html}</p>`);
    para = [];
  };

  const closeUl = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      closeUl();
      continue;
    }
    const liMatch = line.match(/^[-*]\s+(.+)$/);
    if (liMatch) {
      flushPara();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      let li = esc(liMatch[1])
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`);
      out.push(`<li>${li}</li>`);
      continue;
    }
    para.push(line);
  }
  flushPara();
  closeUl();
  return out.join('\n');
}

// ── Sync log helper ───────────────────────────────────────────────────────────

async function logSyncAttempt({
  event_id, target, action,
  request_payload, response_payload,
  status, error_code = null, error_message = null,
  retry_count = 0, next_retry_at = null,
}) {
  try {
    const { error } = await supabaseAdmin
      .from('event_sync_log')
      .insert({
        event_id,
        target,
        action,
        request_payload : request_payload  || null,
        response_payload: response_payload || null,
        status,
        error_code,
        error_message,
        retry_count,
        next_retry_at,
      });
    if (error) {
      console.error('[event-sync-orchestrator] event_sync_log insert error:', error.message);
    }
  } catch (e) {
    console.error('[event-sync-orchestrator] event_sync_log insert exception:', e?.message);
  }
}

// Tel huidige retry_count voor (event, target) sinds laatste success
async function getCurrentRetryCount(event_id, target) {
  try {
    // Aantal failures sinds laatste success voor dit target
    const { data: lastSuccess } = await supabaseAdmin
      .from('event_sync_log')
      .select('attempted_at')
      .eq('event_id', event_id)
      .eq('target',   target)
      .eq('status',   'success')
      .order('attempted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let q = supabaseAdmin
      .from('event_sync_log')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event_id)
      .eq('target',   target)
      .eq('status',   'failure');
    if (lastSuccess?.attempted_at) {
      q = q.gt('attempted_at', lastSuccess.attempted_at);
    }
    const { count } = await q;
    return count || 0;
  } catch {
    return 0;
  }
}

// ── Webflow target ────────────────────────────────────────────────────────────

async function syncWebflow(event) {
  const action = event.webflow_item_id ? 'update' : 'create';
  let result;
  try {
    const descriptionHtml = mdToHtmlSimple(event.description_md || '');
    if (action === 'create') {
      result = await createLiveItem({ event, descriptionHtml });
    } else {
      result = await updateItem({
        webflowItemId  : event.webflow_item_id,
        event,
        descriptionHtml,
      });
    }
    // Success
    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action,
      request_payload : result.requestPayload,
      response_payload: { itemId: result.itemId },
      status          : 'success',
    });

    // Patch events-row
    const patch = {
      webflow_sync_status   : 'success',
      webflow_last_synced_at: new Date().toISOString(),
    };
    if (action === 'create' && result.itemId) {
      patch.webflow_item_id = result.itemId;
    }
    await supabaseAdmin.from('events').update(patch).eq('id', event.id);

    return { ok: true, action, itemId: result.itemId, status: 'success' };
  } catch (e) {
    const isWfErr = e instanceof WebflowError;
    const code    = isWfErr ? e.code : 'UNKNOWN';
    const message = e?.message || 'unknown error';

    const retry_count   = await getCurrentRetryCount(event.id, 'webflow');
    const next_retry_at = computeNextRetryAt(retry_count);

    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action,
      request_payload : null,
      response_payload: isWfErr ? e.detail : null,
      status          : 'failure',
      error_code      : code,
      error_message   : message,
      retry_count,
      next_retry_at,
    });

    await supabaseAdmin
      .from('events')
      .update({
        webflow_sync_status   : 'failure',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);

    return { ok: false, action, status: 'failure', error_code: code, message };
  }
}

async function unpublishWebflow(event) {
  if (!event.webflow_item_id) {
    // Niets om te unpublishen - log no-op success
    return { ok: true, action: 'unpublish', status: 'noop' };
  }
  try {
    const result = await unpublishItem({ webflowItemId: event.webflow_item_id });
    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action          : 'unpublish',
      request_payload : result.requestPayload,
      response_payload: { itemId: result.itemId },
      status          : 'success',
    });
    await supabaseAdmin
      .from('events')
      .update({
        webflow_sync_status   : 'unpublished',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return { ok: true, action: 'unpublish', status: 'unpublished' };
  } catch (e) {
    const isWfErr = e instanceof WebflowError;
    const code    = isWfErr ? e.code : 'UNKNOWN';
    const message = e?.message || 'unknown error';

    const retry_count   = await getCurrentRetryCount(event.id, 'webflow');
    const next_retry_at = computeNextRetryAt(retry_count);

    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action          : 'unpublish',
      request_payload : null,
      response_payload: isWfErr ? e.detail : null,
      status          : 'failure',
      error_code      : code,
      error_message   : message,
      retry_count,
      next_retry_at,
    });
    await supabaseAdmin
      .from('events')
      .update({
        webflow_sync_status   : 'failure',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return { ok: false, action: 'unpublish', status: 'failure', error_code: code, message };
  }
}

// ── GHL target ────────────────────────────────────────────────────────────────

// Bereken upcoming-events labels uit DB:
//   events WHERE status='published' AND signups_closed=false AND starts_at > now()
//   ORDER BY starts_at ASC
//
// SINGLE SOURCE voor zowel publish/update/cancel-triggers (via syncGhl in
// deze file) als de daily refresh-cron (api/cron-events-ghl-next-update.js
// importeert deze export). Voorkomt query-drift tussen trigger en cron.
//
// Filter signups_closed=false (Blok 1): events waarvan inschrijvingen handmatig
// of automatisch (auto-close cron) gesloten zijn vallen direct uit de GHL
// upcoming-set. Reopen-flow zet signups_closed=false en triggert recompute,
// waardoor het event weer terugkomt in de dropdown.
//
// Empty-result-pad: bij 0 events returnt deze gewoon []; de GUARD in
// ghl-custom-field.js updateOptions() vangt empty array af en SKIPT de PUT
// om de bestaande GHL-dropdown niet te legen. Dat is bewust geen "fail"
// state - bij een leeg DB-resultaat hoort de GHL-dropdown onaangetast.
export async function computeUpcomingLabels() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('events')
    .select('id, title, starts_at, ends_at, niveau, status, signups_closed')
    .eq('status', 'published')
    .eq('signups_closed', false)
    .gt('starts_at', nowIso)
    .order('starts_at', { ascending: true });

  if (error) {
    // Defensieve log: bij missing-column-error (migratie nog niet gerund)
    // krijgen we hier een PostgREST error. computeUpcomingLabels returnt
    // dan [] zodat de GHL_GUARD_EMPTY_LABELS verhindert dat we de dropdown
    // legen. Belangrijk: deze foutmelding wijst dan ook naar migratie-status.
    console.error('[event-sync-orchestrator] computeUpcomingLabels error:', error.message);
    return [];
  }

  const labels = (data || []).map(formatEventLabel).filter(Boolean);

  // Observability voor Blok 1 smoke: log de filter-uitkomst zodat we in
  // Vercel logs direct kunnen verifieren dat signups_closed=true events
  // worden uitgesloten. Format: count + ids voor cross-check met DB-state.
  console.log(
    `[event-sync-orchestrator] computeUpcomingLabels: ${labels.length} labels ` +
    `(filter status=published, signups_closed=false, starts_at>${nowIso}). ` +
    `event_ids=[${(data || []).map((r) => r.id?.slice(0, 8)).join(',')}]`
  );

  return labels;
}

async function syncGhl(event) {
  const action = 'update';
  try {
    const labels = await computeUpcomingLabels();
    const result = await ghlUpdateOptions({ labels });

    // Graceful skip pad
    if (result?.skipped) {
      const retry_count   = await getCurrentRetryCount(event.id, 'ghl');
      const next_retry_at = computeNextRetryAt(retry_count);

      await logSyncAttempt({
        event_id        : event.id,
        target          : 'ghl',
        action,
        request_payload : { labelsCount: labels.length },
        response_payload: {
          skipped     : true,
          reason      : result.reason || null,
          tried_shapes: result.tried_shapes || null,
        },
        status          : 'failure',
        error_code      : result.reason || 'SKIPPED_GRACEFUL',
        error_message   : result.message || result.reason || 'graceful skip',
        retry_count,
        next_retry_at,
      });
      await supabaseAdmin
        .from('events')
        .update({
          ghl_sync_status   : 'skipped_graceful',
          ghl_last_synced_at: new Date().toISOString(),
        })
        .eq('id', event.id);
      return { ok: false, status: 'skipped_graceful', reason: result.reason };
    }

    if (!result?.ok) {
      const retry_count   = await getCurrentRetryCount(event.id, 'ghl');
      const next_retry_at = computeNextRetryAt(retry_count);
      await logSyncAttempt({
        event_id        : event.id,
        target          : 'ghl',
        action,
        request_payload : { labelsCount: labels.length },
        response_payload: null,
        status          : 'failure',
        error_code      : result?.error_code || 'UNKNOWN',
        error_message   : result?.message || 'unknown error',
        retry_count,
        next_retry_at,
      });
      await supabaseAdmin
        .from('events')
        .update({
          ghl_sync_status   : 'failure',
          ghl_last_synced_at: new Date().toISOString(),
        })
        .eq('id', event.id);
      return { ok: false, status: 'failure', error_code: result?.error_code, message: result?.message };
    }

    // Success
    await logSyncAttempt({
      event_id        : event.id,
      target          : 'ghl',
      action,
      request_payload : { labelsCount: labels.length },
      response_payload: {
        optionsKey   : result.optionsKey,       // backward-compat alias = put_options_key
        put_options_key: result.put_options_key,
        used_shape   : result.used_shape,
        tried_shapes : result.tried_shapes,
        optionsCount : result.optionsCount,
      },
      status          : 'success',
    });
    await supabaseAdmin
      .from('events')
      .update({
        ghl_sync_status   : 'success',
        ghl_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return { ok: true, status: 'success', optionsCount: result.optionsCount };
  } catch (e) {
    const code    = 'UNKNOWN';
    const message = e?.message || 'exception in ghl sync';

    const retry_count   = await getCurrentRetryCount(event.id, 'ghl');
    const next_retry_at = computeNextRetryAt(retry_count);

    await logSyncAttempt({
      event_id        : event.id,
      target          : 'ghl',
      action,
      request_payload : null,
      response_payload: null,
      status          : 'failure',
      error_code      : code,
      error_message   : message,
      retry_count,
      next_retry_at,
    });
    await supabaseAdmin
      .from('events')
      .update({
        ghl_sync_status   : 'failure',
        ghl_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return { ok: false, status: 'failure', error_code: code, message };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchEvent(eventId) {
  const { data, error } = await supabaseAdmin
    .from('events')
    .select('id, title, starts_at, ends_at, location, status, niveau, description_md, webflow_item_id, webflow_sync_status, ghl_sync_status, signups_closed, signups_closed_reason')
    .eq('id', eventId)
    .single();
  if (error) throw new Error(`fetchEvent: ${error.message}`);
  if (!data)  throw new Error(`fetchEvent: event ${eventId} niet gevonden`);
  return data;
}

/**
 * Sync een event naar Webflow + GHL.
 * - Webflow: create (als webflow_item_id NULL) of update (PATCH bestaand item)
 * - GHL: herbereken upcoming labels + PUT options
 *
 * Beide targets geisoleerd. Returnt aggregated result.
 */
export async function syncEventToOutbound(eventId) {
  if (!eventId) throw new Error('eventId vereist');
  const event = await fetchEvent(eventId);

  // Webflow eerst (primair kanaal), dan GHL (secundair)
  const webflow = await syncWebflow(event);

  // Refetch event om bijgewerkte webflow_item_id mee te nemen (niet strikt nodig
  // voor GHL, maar consistent voor return-payload)
  let eventAfter = event;
  try { eventAfter = await fetchEvent(eventId); } catch {}

  const ghl = await syncGhl(eventAfter);

  return {
    eventId,
    webflow,
    ghl,
  };
}

/**
 * Unpublish een event op outbound kanalen.
 * - Webflow: PATCH item naar isDraft=true (per spec G, geen delete)
 * - GHL: herbereken labels (event valt nu uit upcoming-set) + PUT
 */
export async function unpublishEventOutbound(eventId) {
  if (!eventId) throw new Error('eventId vereist');
  const event = await fetchEvent(eventId);

  const webflow = await unpublishWebflow(event);

  // GHL: list zonder dit event (status != published OR starts_at <= now will be filtered).
  // Caller heeft normaal al status='cancelled'/'archived' gezet voordat hij ons aanroept,
  // dus computeUpcomingLabels filtert dit event er vanzelf uit.
  const ghl = await syncGhl(event);

  return {
    eventId,
    webflow,
    ghl,
  };
}

// ── Hard-delete pad (archive + cleanup-cron) ─────────────────────────────────
//
// Verschil met unpublishWebflow: hard-delete verwijdert het item PERMANENT uit
// de Webflow CMS (zowel live-publicatie als staged record). 404 = success
// (item al weg, idempotent). Daarna wordt webflow_item_id genuld zodat een
// eventuele heropvoer een vers item produceert.
//
// 2-staps cleanup (events-delete robustness):
//   Stap A: unpublish-live (DELETE /items/{id}/live) - best-effort. 404 = al
//           niet meer live, prima. Andere fouten: log warn + ga door naar
//           delete-item (de delete-stap bepaalt success/deferred).
//   Stap B: delete-item (DELETE /items/{id}) - definitieve verwijdering.
//           success/404 -> NULL webflow_item_id + sync_status='deleted' +
//           cleanup_status='done'.
//           retryable (429/5xx/network) -> link BLIJFT + sync_status='failure'
//           + cleanup_status='deferred' (herdraai pakt het op via retry-cron
//           of admin-trigger).
//
// cleanup_status discriminator zit in return-object zodat events-delete
// een schone response-shape ({ webflow_cleanup: 'done'|'deferred'|'none' })
// kan produceren zonder zelf orchestrator-internals te kennen.
async function hardDeleteWebflow(event) {
  if (!event.webflow_item_id) {
    return {
      ok: true, action: 'hard_delete', status: 'noop',
      cleanup_status: 'none',
    };
  }

  // ── Stap A: unpublish-live (best-effort, defensive pre-step) ─────────────
  try {
    await unpublishItem({ webflowItemId: event.webflow_item_id });
  } catch (e) {
    // Niet fataal - delete-item kan het item alsnog opruimen, en als delete
    // hierna ook faalt rapporteren we via die catch-tak.
    const code = (e instanceof WebflowError) ? e.code : 'UNKNOWN';
    console.warn(
      `[event-sync-orchestrator] hardDeleteWebflow unpublish-live pre-step faalde ` +
      `(${code}: ${e?.message?.slice(0, 120) || ''}) - doorgaan naar delete-item`
    );
  }

  // ── Stap B: delete-item (canonical) ─────────────────────────────────────
  try {
    const result = await hardDeleteItem({ webflowItemId: event.webflow_item_id });
    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action          : 'hard_delete',
      request_payload : null,
      response_payload: {
        itemId : result.itemId,
        deleted: result.deleted,
        reason : result.reason || null,
      },
      status          : 'success',
    });
    await supabaseAdmin
      .from('events')
      .update({
        webflow_item_id       : null,
        webflow_sync_status   : 'deleted',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return {
      ok: true, action: 'hard_delete',
      status: result.deleted ? 'deleted' : 'already_gone',
      cleanup_status: 'done',
    };
  } catch (e) {
    const isWfErr = e instanceof WebflowError;
    const code    = isWfErr ? e.code : 'UNKNOWN';
    const message = e?.message || 'unknown error';
    const retryable = ['RATE_LIMIT', 'WEBFLOW_DOWN'].includes(code);

    const retry_count   = await getCurrentRetryCount(event.id, 'webflow');
    const next_retry_at = computeNextRetryAt(retry_count);

    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action          : 'hard_delete',
      request_payload : null,
      response_payload: isWfErr ? e.detail : null,
      status          : 'failure',
      error_code      : code,
      error_message   : message,
      retry_count,
      next_retry_at,
    });
    // CRITISCH: webflow_item_id BLIJFT staan zodat herdraai het opnieuw kan
    // proberen. Alleen webflow_sync_status='failure' + last_synced_at
    // bijwerken.
    await supabaseAdmin
      .from('events')
      .update({
        webflow_sync_status   : 'failure',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return {
      ok: false, action: 'hard_delete', status: 'failure',
      error_code: code, message,
      cleanup_status: 'deferred',
      retryable,
    };
  }
}

/**
 * Hard-delete een event uit outbound kanalen.
 * - Webflow: DELETE /items/{id} (permanente verwijdering, 404=success)
 * - GHL: herbereken labels (event valt uit upcoming-set door status='archived')
 *
 * Gebruikt door events-delete (archive-pad) en de cleanup-cron (>7d na event).
 * Eén code-path, geen drift tussen admin-trigger en cron-trigger.
 */
export async function hardDeleteEventOutbound(eventId) {
  if (!eventId) throw new Error('eventId vereist');
  const event = await fetchEvent(eventId);

  const webflow = await hardDeleteWebflow(event);

  // GHL: caller heeft status='archived' al gezet voor we hier zijn; computeUpcomingLabels
  // filtert dit event er vanzelf uit.
  const ghl = await syncGhl(event);

  return {
    eventId,
    webflow,
    ghl,
  };
}

// ── Signups close / reopen pad (Blok 1) ──────────────────────────────────────
//
// closeSignupsOutbound:
//   1. Webflow: PATCH item naar isDraft=true (hergebruik unpublishItem helper).
//      Het Webflow-record blijft staan (staged), zodat reopen-flow het terug
//      kan promoten via republishItem zonder veld-data te verliezen.
//   2. GHL: recompute upcoming-labels - event valt uit de set door
//      signups_closed=true filter in computeUpcomingLabels (Blok 1).
//
// reopenSignupsOutbound:
//   1. Webflow: PATCH /items/{id}/live met isDraft=false + fieldData
//      (republishItem helper; PATCH /live primair, POST /publish fallback).
//   2. GHL: recompute upcoming-labels - event komt terug in de set.
//
// event_sync_log.action CHECK is uitgebreid naar
// ('create'|'update'|'unpublish'|'hard_delete') via migratie
// 2026-06-12-event-sync-log-hard-delete-action.sql. Mapping per flow:
//   - close-flow Webflow  -> action='unpublish'   (staged record blijft)
//   - reopen-flow Webflow -> action='update'      (item terug live)
//   - close/reopen GHL    -> action='update'      (recompute + PUT options)
//   - delete-flow Webflow -> action='hard_delete' (item permanent weg)
// Specifieke close/reopen-context wordt vastgelegd in response_payload.strategy
// + response_payload.flow zodat downstream tooling (sync-retry, dashboards)
// kan onderscheiden zonder schema-wijziging.

async function republishWebflow(event) {
  if (!event.webflow_item_id) {
    // Geen staged Webflow-record - dit kan gebeuren als het event nooit eerder
    // gepubliceerd is. Reopen wordt dan een no-op op Webflow-niveau; de GHL-
    // recompute zorgt dat het event in de dropdown verschijnt zodra het
    // status='published' + signups_closed=false heeft.
    return { ok: true, action: 'update', status: 'noop', flow: 'reopen' };
  }
  try {
    const descriptionHtml = mdToHtmlSimple(event.description_md || '');
    const result = await republishItem({
      webflowItemId: event.webflow_item_id,
      event,
      descriptionHtml,
    });
    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action          : 'update',
      request_payload : { flow: 'reopen', strategy: result.strategy, payload: result.requestPayload },
      response_payload: { itemId: result.itemId, strategy: result.strategy, flow: 'reopen' },
      status          : 'success',
    });
    await supabaseAdmin
      .from('events')
      .update({
        webflow_sync_status   : 'success',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return { ok: true, action: 'update', status: 'success', strategy: result.strategy, flow: 'reopen' };
  } catch (e) {
    const isWfErr = e instanceof WebflowError;
    const code    = isWfErr ? e.code : 'UNKNOWN';
    const message = e?.message || 'unknown error';

    const retry_count   = await getCurrentRetryCount(event.id, 'webflow');
    const next_retry_at = computeNextRetryAt(retry_count);

    await logSyncAttempt({
      event_id        : event.id,
      target          : 'webflow',
      action          : 'update',
      request_payload : { flow: 'reopen' },
      response_payload: isWfErr ? { ...e.detail, flow: 'reopen' } : { flow: 'reopen' },
      status          : 'failure',
      error_code      : code,
      error_message   : message,
      retry_count,
      next_retry_at,
    });
    await supabaseAdmin
      .from('events')
      .update({
        webflow_sync_status   : 'failure',
        webflow_last_synced_at: new Date().toISOString(),
      })
      .eq('id', event.id);
    return { ok: false, action: 'update', status: 'failure', error_code: code, message, flow: 'reopen' };
  }
}

/**
 * Sluit inschrijvingen voor een event op outbound kanalen.
 * - Webflow: PATCH item naar isDraft=true (staged record blijft staan)
 * - GHL: herbereken upcoming-labels (event valt uit door signups_closed=true filter)
 *
 * Caller (events-close-signups) heeft signups_closed=true en
 * signups_closed_at/_reason/_by_user_id al gezet voordat hij ons aanroept.
 */
export async function closeSignupsOutbound(eventId) {
  if (!eventId) throw new Error('eventId vereist');
  const event = await fetchEvent(eventId);

  // Defense-in-depth: bevestig dat caller daadwerkelijk signups_closed=true
  // heeft gezet voordat wij de side-effects triggeren. Bij smoke 2026-06-12
  // bleek het mogelijk dat de DB-flip niet door was gegaan (oude
  // ALLOWED_REASONS bug) maar de outbound-sync wel werd geroepen - dat gaf
  // de illusie van een gefaalde GHL-filter terwijl het in feite een
  // DB-flip-fail was. Door dit hier expliciet te checken + loggen krijgen
  // we duidelijke signal in Vercel logs.
  if (event?.signups_closed !== true) {
    console.warn(
      `[event-sync-orchestrator] closeSignupsOutbound(${eventId}) ` +
      `ontving event met signups_closed=${event?.signups_closed} ` +
      `(verwacht true). DB-flip mogelijk niet doorgekomen.`
    );
  } else {
    console.log(
      `[event-sync-orchestrator] closeSignupsOutbound(${eventId}) ` +
      `bevestigt signups_closed=true (reason=${event?.signups_closed_reason || 'n/a'})`
    );
  }

  const webflow = await unpublishWebflow(event);

  // GHL: recompute. Het event is door de caller op signups_closed=true gezet,
  // dus computeUpcomingLabels filtert het er vanzelf uit.
  const ghl = await syncGhl(event);

  return {
    eventId,
    webflow,
    ghl,
  };
}

/**
 * Heropen inschrijvingen voor een event op outbound kanalen.
 * - Webflow: PATCH /items/{id}/live met isDraft=false + fieldData (republish)
 *            Primair PATCH /live, fallback POST /publish.
 * - GHL: herbereken upcoming-labels (event komt terug in de set).
 *
 * Caller (events-reopen-signups) heeft signups_closed=false en de bijbehorende
 * audit-velden al genuld voordat hij ons aanroept.
 */
export async function reopenSignupsOutbound(eventId) {
  if (!eventId) throw new Error('eventId vereist');
  const event = await fetchEvent(eventId);

  const webflow = await republishWebflow(event);

  // GHL: recompute. Het event is door de caller op signups_closed=false gezet,
  // dus computeUpcomingLabels neemt het weer mee in de upcoming-set.
  const ghl = await syncGhl(event);

  return {
    eventId,
    webflow,
    ghl,
  };
}
