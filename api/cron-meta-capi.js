// api/cron-meta-capi.js
//
// Cron (uurlijks op :20). Stuurt server-side het CUSTOM event 'CRMCustomer'
// naar Meta Conversions API voor deals die nog geen CAPI-event hadden. Env-
// gated + defensief pre-migratie. Read-only voor onze DB (schrijft alleen
// naar meta_capi_events log-tabel; deals blijft ongemuteerd).
//
// Guards in volgorde:
//   1) checkCronAuth             — Bearer CRON_SECRET
//   2) env-gate                  — getMetaCapiConfigStatus().configured?
//   3) tabellen-gate             — isMissingRelationError → 200 skip
//
// Idempotentie: UNIQUE (deal_id) op meta_capi_events + deterministic
// event_id = 'crm_customer_<deal.id>' (Meta dedupt binnen 7-dagen-window).
//
// PER-RUN LIMIT: 50 deals. Voorkomt Meta rate-limits + Vercel 60s-timeout.
//
// SKIP-CONDITIE: geen bruikbare match-key (geen em/ph/fbc) → status='skipped'
// met skip_reason='no_usable_match_key'. Wel geloggd zodat monitoring
// duidelijk maakt hoeveel deals attributie missen.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import {
  getMetaCapiConfigStatus,
  getMetaCapiConfig,
  buildCapiEvent,
  hasUsableMatchKey,
  isWithinCapiWindow,
  postCapiEvents,
  CAPI_MAX_AGE_MS,
  DEFAULT_EVENT_NAME,
} from './_lib/meta-capi.js';

const PER_RUN_LIMIT = 50;

function isMissingRelationError(err) {
  if (!err) return false;
  if (err.code === '42P01' || err.code === '42703') return true;
  if (err.code === 'PGRST204' || err.code === 'PGRST205') return true;
  const msg = String(err.message || '') + ' ' + String(err.details || '') + ' ' + String(err.hint || '');
  return /relation .* does not exist/i.test(msg)
      || /column .* does not exist/i.test(msg)
      || /could not find the/i.test(msg)
      || /schema cache/i.test(msg);
}

async function touchSyncState(key, summary) {
  try {
    await supabaseAdmin.from('sync_state').upsert({
      key,
      last_run_at: new Date().toISOString(),
      state:       summary,
    }, { onConflict: 'key' });
  } catch (e) {
    if (!isMissingRelationError(e)) {
      console.warn('[cron-meta-capi] sync_state touch:', e?.message || e);
    }
  }
}

/**
 * Sla het resultaat (sent/failed/skipped) op in meta_capi_events. Idempotent
 * via UNIQUE(deal_id): 23505-conflict = al eerder geregistreerd (race), safe
 * genegeerd.
 */
async function logCapiRow(row) {
  const { error } = await supabaseAdmin.from('meta_capi_events').insert(row);
  if (error) {
    if (error.code === '23505') return { ok: true, duplicate: true };  // race: al eerder geregistreerd
    if (isMissingRelationError(error)) return { ok: false, skipped: 'migration_required', error: error.message };
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const summary = {
    started_at:    new Date().toISOString(),
    deals_scanned: 0,
    sent:          0,
    failed:        0,
    skipped:       0,
    test_mode:     false,
    errors:        [],
  };

  // Env-gate.
  const cfgStatus = getMetaCapiConfigStatus();
  if (!cfgStatus.configured) {
    summary.skipped_run = 'not_configured';
    summary.missing = cfgStatus.missing;
    return res.status(200).json({ ok: true, summary });
  }
  summary.test_mode      = cfgStatus.test_mode;
  summary.appsecret_proof = cfgStatus.appsecret_proof;

  const cfg = getMetaCapiConfig();

  // Fetch deals die nog geen CAPI-event hadden (LEFT JOIN via subquery-emulatie:
  // haal eerst verstuurde deal-ids op, filter dan met .not('id','in',(...))).
  let deals;
  try {
    // 1) Reeds verzonden ids ophalen.
    let sentIds = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('meta_capi_events')
        .select('deal_id');
      if (error) {
        if (isMissingRelationError(error)) {
          summary.skipped_run = 'table_missing';
          return res.status(200).json({ ok: true, summary });
        }
        throw error;
      }
      sentIds = (data || []).map((r) => r.deal_id).filter(Boolean);
    } catch (e) {
      if (isMissingRelationError(e)) {
        summary.skipped_run = 'table_missing';
        return res.status(200).json({ ok: true, summary });
      }
      throw e;
    }

    // 2) Deals binnen het CAPI-venster (6.5d, marge onder Meta's 7d-limiet),
    //    NOT IN sentIds. Newest-first: als er ooit >50 in een uur zijn krijgen
    //    de meest recente conversies voorrang (oudere binnen venster komen
    //    volgende run vanzelf, nog steeds tijdig).
    const windowStartIso = new Date(Date.now() - CAPI_MAX_AGE_MS).toISOString();
    summary.window_start = windowStartIso;
    let q = supabaseAdmin
      .from('deals')
      .select('id, customer_id, total_amount, created_at, archived_at')
      .is('archived_at', null)
      .gte('created_at', windowStartIso)
      .order('created_at', { ascending: false })
      .limit(PER_RUN_LIMIT);
    if (sentIds.length) {
      // PostgREST accepteert alleen simpele lijsten in .not('id','in','(...)').
      // Voor grote lijsten sneden we in stukken maar met een limit van 50
      // per run + oude sync-batches is dit in de praktijk klein.
      q = q.not('id', 'in', '(' + sentIds.map((id) => '"' + id + '"').join(',') + ')');
    }
    const { data, error } = await q;
    if (error) throw error;
    deals = data || [];
  } catch (e) {
    console.error('[cron-meta-capi] deals fetch:', e?.message || e);
    summary.errors.push({ phase: 'deals_fetch', error: e?.message || String(e) });
    return res.status(500).json({ ok: false, summary });
  }

  summary.deals_scanned = deals.length;
  if (!deals.length) {
    summary.finished_at = new Date().toISOString();
    await touchSyncState('meta_capi', summary);
    return res.status(200).json({ ok: true, summary });
  }

  // Per-deal: haal customer + lead_attribution → bouw event → POST → log.
  const nowMs = Date.now();
  for (const deal of deals) {
    try {
      // Boundary-guard (vangnet): een deal die bij de query nog binnen 6.5d
      // viel maar tijdens processing over de 7d-grens tikt, willen we niet
      // alsnog naar Meta sturen (dat geeft een failure). Log 'skipped'.
      if (!isWithinCapiWindow(deal.created_at, nowMs)) {
        const r = await logCapiRow({
          deal_id:     deal.id,
          event_name:  DEFAULT_EVENT_NAME,
          event_id:    'crm_customer_' + deal.id,
          status:      'skipped',
          value:       Number(deal.total_amount || 0),
          currency:    'EUR',
          match_keys:  null,
          skip_reason: 'too_old',
          test_mode:   summary.test_mode,
        });
        if (r.ok) summary.skipped += 1;
        else summary.errors.push({ phase: 'log_skip_old', deal_id: deal.id, error: r.error || r.skipped });
        continue;
      }

      // Customer (email + phone + ghl_contact_id).
      let customer = null;
      try {
        const { data, error } = await supabaseAdmin
          .from('customers')
          .select('id, email, phone, ghl_contact_id')
          .eq('id', deal.customer_id)
          .maybeSingle();
        if (error && !isMissingRelationError(error)) throw error;
        customer = data || null;
      } catch (e) {
        if (!isMissingRelationError(e)) throw new Error('customer fetch: ' + (e?.message || e));
      }

      // Attribution raw (voor fbc/fbp/ip/ua).
      let attrRaw = null;
      if (customer?.ghl_contact_id) {
        try {
          const { data, error } = await supabaseAdmin
            .from('lead_attribution')
            .select('raw')
            .eq('ghl_contact_id', customer.ghl_contact_id)
            .maybeSingle();
          if (error && !isMissingRelationError(error)) throw error;
          attrRaw = data?.raw || null;
        } catch (e) {
          if (!isMissingRelationError(e)) console.warn('[cron-meta-capi] attribution fetch:', e?.message || e);
        }
      }

      const { event, matchKeys } = buildCapiEvent({
        dealId:        deal.id,
        dealCreatedAt: deal.created_at,
        value:         deal.total_amount,
        customer:      customer || {},
        attrRaw,
      });

      if (!hasUsableMatchKey(event.user_data)) {
        // Log skip — géén Meta-call.
        const r = await logCapiRow({
          deal_id:     deal.id,
          event_name:  DEFAULT_EVENT_NAME,
          event_id:    event.event_id,
          status:      'skipped',
          value:       Number(deal.total_amount || 0),
          currency:    'EUR',
          match_keys:  matchKeys,
          skip_reason: 'no_usable_match_key',
          test_mode:   summary.test_mode,
        });
        if (r.ok) summary.skipped += 1;
        else summary.errors.push({ phase: 'log_skip', deal_id: deal.id, error: r.error || r.skipped });
        continue;
      }

      // POST naar Meta.
      let resp;
      try {
        resp = await postCapiEvents({ event, testCode: cfg.testCode });
      } catch (postErr) {
        summary.failed += 1;
        summary.errors.push({ phase: 'meta_post', deal_id: deal.id, error: postErr?.message || String(postErr) });
        await logCapiRow({
          deal_id:      deal.id,
          event_name:   DEFAULT_EVENT_NAME,
          event_id:     event.event_id,
          status:       'failed',
          value:        Number(deal.total_amount || 0),
          currency:     'EUR',
          match_keys:   matchKeys,
          meta_response: { error: postErr?.message || String(postErr) },
          test_mode:    summary.test_mode,
        });
        continue;
      }

      const status = resp.ok ? 'sent' : 'failed';
      const logResult = await logCapiRow({
        deal_id:       deal.id,
        event_name:    DEFAULT_EVENT_NAME,
        event_id:      event.event_id,
        status,
        value:         Number(deal.total_amount || 0),
        currency:      'EUR',
        match_keys:    matchKeys,
        meta_response: resp.body || null,
        test_mode:     summary.test_mode,
      });
      if (status === 'sent') summary.sent += 1;
      else                   summary.failed += 1;
      if (!logResult.ok && !logResult.duplicate) {
        summary.errors.push({ phase: 'log_' + status, deal_id: deal.id, error: logResult.error || logResult.skipped });
      }
    } catch (e) {
      console.warn('[cron-meta-capi] deal-loop error:', deal.id, e?.message || e);
      summary.errors.push({ phase: 'deal_loop', deal_id: deal.id, error: e?.message || String(e) });
    }
  }

  summary.finished_at = new Date().toISOString();
  await touchSyncState('meta_capi', summary);
  return res.status(200).json({ ok: true, summary });
}
