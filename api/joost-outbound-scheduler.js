// api/joost-outbound-scheduler.js
// Joost E2.2 — outbound template-send scheduler (cron-driven).
//
// ─────────────────────────────────────────────────────────────────────────────
// KRITIEK — CONFLICT MET DUNNING-ENGINE (PR #761 / #763):
// ─────────────────────────────────────────────────────────────────────────────
// Deze scheduler is ORIGINEEL gebouwd toen executeWhatsappStep in
// api/_lib/dunning-step-executors.js nog een stub was ("altijd skipped_no_meta"
// — zie joost-outbound-send.js r9-12). Sinds PR #761 verstuurt die executor
// ECHT via dezelfde workflow-runs (status=active, next_action_at<=now,
// step_type=whatsapp). Beide paden actief = klant krijgt elk bericht 2x.
//
// BESLISSING: pad A (dunning-engine executeWhatsappStep) is leidend. Deze
// scheduler blijft UIT.
//
// GUARD (defense-in-depth): als iemand `e2_outbound_cron` ooit AAN zet, wordt
// hier een HARDE conflict-error geretourneerd — geen stille dubbele-send. Zie
// r108-121 hieronder. Verwijder de cron uit vercel.json OF fix eerst de
// dubbele-send-vraag voordat je 'em aanzet.
// ─────────────────────────────────────────────────────────────────────────────
//
// Doel (origineel, nu gepauzeerd):
//   Vercel cron-endpoint dat per office-hours-tick pending dunning workflow-
//   events ophaalt (dunning_workflow_runs.status='active' + next_action_at <=
//   now() + step_type='whatsapp') en per event INTERN /api/joost-outbound-send
//   aanroept. Throttle 200ms tussen calls om Meta rate-limit (80 msg/sec/WABA)
//   ruim onder de drempel te houden.
//
// Auth:
//   * Vercel cron triggert via Authorization: Bearer $CRON_SECRET.
//   * checkCronAuth() (zelfde patroon als /api/cron-dunning-engine).
//
// Schedule (vercel.json):
//   30 8,11,14,17 * * 1-5  -> 4x/dag op werkdagen.
//   Vercel cron draait UTC; office-hours-check in joost-outbound-send doet
//   de feitelijke Europe/Amsterdam-venster controle via evaluateAutonomy.
//
// Methodes: POST (Vercel cron triggert intern GET; we accepteren beide voor
// handmatige debug via curl).
//
// Feature-flag: joost_config.feature_flags.e2_outbound_cron moet aan zijn.
// Defense-in-depth: joost-outbound-send heeft daarnaast eigen flag-check op
// e2_outbound_executor, zodat scheduler en send-pad onafhankelijk geschakeld
// kunnen worden.
//
// Time budget: 50s abort om Vercel 60s hard timeout veilig te halen. Bij
// time-out wordt netjes gestopt; volgende cron-tick pakt resterende events
// op (next_action_at blijft staan want we mutmuat dat veld in joost-
// outbound-send niet — alleen joost-outbound-send.dunning_log + audit logs
// het gebeurde).
//
// Response 200:
//   {
//     processed_count: int,
//     sent_count:      int,
//     blocked_count:   int,
//     skipped_count:   int,
//     errors:          [{ run_id?, step_id?, error }],
//     duration_ms:     int,
//   }

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const MAX_EVENTS_PER_RUN_DEFAULT = 50;
const THROTTLE_MS = 200;
const ABORT_MS = 50_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function buildSelfBaseUrl() {
  // VERCEL_URL is automatisch beschikbaar in alle Vercel deploys (preview +
  // production). Anders fallback op APP_BASE_URL of localhost voor lokale
  // ontwikkeling. Identiek aan patroon in inbox-webhook.js regel 368-370.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  return 'http://localhost:3000';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- Auth: CRON_SECRET ----
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const summary = {
    processed_count: 0,
    sent_count:      0,
    blocked_count:   0,
    skipped_count:   0,
    errors:          [],
    duration_ms:     0,
  };

  try {
    // ====================================================================
    // Feature-flag gate: e2_outbound_cron moet aan voor 'finance'-module
    // ====================================================================
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, feature_flags, is_enabled')
      .eq('module', 'finance')
      .maybeSingle();
    if (cfgErr) {
      console.error('[joost-outbound-scheduler] joost_config lookup:', cfgErr.message);
      return res.status(500).json({ error: 'joost_config lookup: ' + cfgErr.message });
    }
    if (!cfg) {
      return res.status(503).json({ error: 'joost_config ontbreekt voor module=finance' });
    }
    const featureFlags = (cfg.feature_flags && typeof cfg.feature_flags === 'object')
      ? cfg.feature_flags : {};
    if (featureFlags.e2_outbound_cron !== true) {
      summary.duration_ms = Date.now() - startedAt;
      return res.status(200).json({
        ...summary,
        skipped_reason: 'FEATURE_FLAG_DISABLED',
        feature_flag:   'e2_outbound_cron',
      });
    }

    // ====================================================================
    // HARDE CONFLICT-GUARD (PR #761/#763):
    //   Sinds executeWhatsappStep in dunning-step-executors.js daadwerkelijk
    //   verstuurt, zou deze scheduler dezelfde dunning_workflow_runs een
    //   TWEEDE keer oppikken -> klant krijgt elk bericht dubbel. We laten
    //   e2_outbound_cron dus NIET meer per-flag "gewoon aan"; wie 'em toch
    //   aan zet krijgt een luidruchtige 409 (audit + log) i.p.v. stille
    //   dubbele verzending. Om deze scheduler te reactiveren:
    //     1) zet expliciet feature_flags.e2_outbound_cron_override_dunning_conflict = true
    //        in joost_config (finance) — bewust omslachtige naam zodat je
    //        niet per ongeluk aanzet;
    //     2) OF verwijder de dunning-executor whatsapp-send + verwijder
    //        deze guard.
    // ====================================================================
    if (featureFlags.e2_outbound_cron_override_dunning_conflict !== true) {
      const conflictMsg = 'DUNNING_ENGINE_CONFLICT: executeWhatsappStep verstuurt sinds PR #761 dezelfde workflow-runs. Aan zetten van e2_outbound_cron zonder e2_outbound_cron_override_dunning_conflict zou dubbele sends veroorzaken.';
      console.error('[joost-outbound-scheduler] REFUSED', conflictMsg);
      // Fail-soft audit (best-effort, geen throw).
      try {
        await supabaseAdmin.from('audit_log').insert({
          user_id:     null,
          action:      'joost.outbound_scheduler_refused',
          entity_type: null,
          entity_id:   null,
          after_json:  {
            reason: 'DUNNING_ENGINE_CONFLICT',
            explanation: conflictMsg,
            feature_flag_e2_outbound_cron: true,
            override_flag_missing: 'e2_outbound_cron_override_dunning_conflict',
          },
          reason_text: 'scheduler_refused_conflict',
          ip_address:  null,
        });
      } catch (eAudit) {
        console.error('[joost-outbound-scheduler] audit refused exception:', eAudit && eAudit.message);
      }
      summary.duration_ms = Date.now() - startedAt;
      return res.status(409).json({
        ...summary,
        error: conflictMsg,
        error_code: 'DUNNING_ENGINE_CONFLICT',
        remediation: 'Zet e2_outbound_cron uit in joost_config, OF verwijder de cron uit vercel.json, OF (als je weet wat je doet) zet e2_outbound_cron_override_dunning_conflict=true.',
      });
    }

    // INTERNAL_API_TOKEN nodig voor de send-call.
    const internalToken = process.env.INTERNAL_API_TOKEN || null;
    if (!internalToken) {
      console.error('[joost-outbound-scheduler] INTERNAL_API_TOKEN ontbreekt');
      return res.status(503).json({
        error: 'INTERNAL_API_TOKEN niet geconfigureerd',
      });
    }

    // ====================================================================
    // Pending workflow-events ophalen.
    // ====================================================================
    // Recon Module B: er bestaat geen scheduled_at/status='scheduled' kolom
    // op dunning_workflow_runs. De juiste "pending event"-query is:
    //   status='active' AND next_action_at <= now()
    //   AND current_step heeft step_type='whatsapp'.
    // We doen dat in 2 stappen (geen rich JOIN via PostgREST):
    //   1. SELECT runs WHERE status='active' AND next_action_at<=now() LIMIT 50.
    //   2. SELECT step WHERE id IN (run.current_step_id) AND step_type='whatsapp'.
    const nowIso = new Date().toISOString();
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, workflow_id, customer_id, current_step_id, next_action_at, status')
      .eq('status', 'active')
      .or(`next_action_at.is.null,next_action_at.lte.${nowIso}`)
      .order('next_action_at', { ascending: true, nullsFirst: true })
      .limit(MAX_EVENTS_PER_RUN_DEFAULT);
    if (runsErr) {
      console.error('[joost-outbound-scheduler] runs query fail:', runsErr.message);
      return res.status(500).json({ error: 'runs query: ' + runsErr.message });
    }
    const runList = Array.isArray(runs) ? runs : [];
    if (runList.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      return res.status(200).json(summary);
    }

    // Filter op step_type='whatsapp'. We laden de bijbehorende steps in 1 query.
    const stepIds = runList
      .map((r) => r.current_step_id)
      .filter((id) => !!id);
    let stepMap = new Map();
    if (stepIds.length > 0) {
      const { data: steps, error: stepsErr } = await supabaseAdmin
        .from('dunning_workflow_steps')
        .select('id, workflow_id, step_order, step_type, config')
        .in('id', stepIds);
      if (stepsErr) {
        console.error('[joost-outbound-scheduler] steps query fail:', stepsErr.message);
        return res.status(500).json({ error: 'steps query: ' + stepsErr.message });
      }
      for (const s of (steps || [])) stepMap.set(s.id, s);
    }

    const candidates = runList.filter((r) => {
      const step = stepMap.get(r.current_step_id);
      return step && step.step_type === 'whatsapp';
    });

    // ====================================================================
    // Per event INTERN aanroepen, throttled.
    // ====================================================================
    const baseUrl = buildSelfBaseUrl();
    const sendUrl = `${baseUrl}/api/joost-outbound-send`;

    for (let i = 0; i < candidates.length; i++) {
      if (elapsed(startedAt) > ABORT_MS) {
        console.warn('[joost-outbound-scheduler] abort budget overschreden, stop loop');
        break;
      }

      const run = candidates[i];
      summary.processed_count++;

      try {
        const resp = await fetch(sendUrl, {
          method:  'POST',
          headers: {
            'content-type':     'application/json',
            'x-internal-token': internalToken,
          },
          body: JSON.stringify({
            run_id:  run.id,
            step_id: run.current_step_id,
          }),
        });
        const respText = await resp.text();
        let payload = null;
        try { payload = respText ? JSON.parse(respText) : null; } catch (_e) { /* ignore */ }

        if (!resp.ok) {
          summary.errors.push({
            run_id:  run.id,
            step_id: run.current_step_id,
            http_status: resp.status,
            error:   (payload && payload.error) ? payload.error : respText.slice(0, 200),
          });
          console.warn('[joost-outbound-scheduler] send HTTP error', resp.status, run.id);
        } else if (payload && payload.sent === true) {
          summary.sent_count++;
        } else if (payload && payload.blocked_reason) {
          summary.blocked_count++;
        } else if (payload && payload.skipped_reason) {
          summary.skipped_count++;
        } else {
          // Onbekend resultaat — log als skipped voor zichtbaarheid.
          summary.skipped_count++;
        }
      } catch (eFetch) {
        summary.errors.push({
          run_id:  run.id,
          step_id: run.current_step_id,
          error:   eFetch && eFetch.message ? eFetch.message : String(eFetch),
        });
        console.error('[joost-outbound-scheduler] fetch exception:', eFetch && eFetch.message);
      }

      // Throttle tussen calls om Meta rate-limit (80/sec) ruim te ontwijken
      // en backend-DB-load te spreiden.
      if (i < candidates.length - 1) {
        await sleep(THROTTLE_MS);
      }
    }

    summary.duration_ms = Date.now() - startedAt;

    // ====================================================================
    // Audit: joost.outbound_scheduler_run (fail-soft).
    // ====================================================================
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     null,
        action:      'joost.outbound_scheduler_run',
        entity_type: null,
        entity_id:   null,
        after_json:  {
          processed_count: summary.processed_count,
          sent_count:      summary.sent_count,
          blocked_count:   summary.blocked_count,
          skipped_count:   summary.skipped_count,
          errors_count:    summary.errors.length,
          first_errors:    summary.errors.slice(0, 3),
          duration_ms:     summary.duration_ms,
          candidates_total: candidates.length,
          runs_loaded:      runList.length,
        },
        reason_text: `scheduler: sent=${summary.sent_count} blocked=${summary.blocked_count} skipped=${summary.skipped_count} errors=${summary.errors.length}`,
        ip_address:  null,
      });
    } catch (eAudit) {
      console.error('[joost-outbound-scheduler] audit exception:', eAudit && eAudit.message);
    }

    console.log('[joost-outbound-scheduler]', JSON.stringify({
      processed_count: summary.processed_count,
      sent_count:      summary.sent_count,
      blocked_count:   summary.blocked_count,
      skipped_count:   summary.skipped_count,
      errors_count:    summary.errors.length,
      duration_ms:     summary.duration_ms,
    }));

    return res.status(200).json(summary);
  } catch (e) {
    console.error('[joost-outbound-scheduler] fatal', e);
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({
      ...summary,
      error: e && e.message ? e.message : String(e),
    });
  }
}
