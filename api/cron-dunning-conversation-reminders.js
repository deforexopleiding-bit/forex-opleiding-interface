// api/cron-dunning-conversation-reminders.js
//
// Joost fase 2 — no-reply reminder-cron voor dunning_workflow_runs die
// pauzeerd zijn door een gesprek (paused_by_conversation_id != NULL).
//
// Doel:
//   Wanneer een klant reageert op een aanmaan-flow pauzeert de run (via
//   webhook hook pauseRunsForConversation). Deze cron detecteert stilte
//   van de klant en stuurt maximaal 2 reminders. Als de klant daarna nog
//   steeds niet reageert, wordt de aanmaan-flow hervat (mits geen actief
//   arrangement — die pauze-reden blijft leidend).
//
// Timing (canonical config in joost_config.autonomy_config.no_reply):
//   reminder_1_hours     (default 20) — uren stil na klant-inbound  → reminder 1
//   reminder_2_hours     (default 24) — uren stil na reminder 1     → reminder 2
//   resume_after_hours   (default 24) — uren stil na reminder 2     → hervat run
//
// Reminder 1: vrij tekst-bericht (voorspelbaar, geen LLM). Vereist dat het
//             24u-venster van Meta nog open is (conv.last_inbound_at <= 24u
//             geleden). Als dicht → skip naar reminder 2 (template).
// Reminder 2: Meta-approved template (naam in no_reply.reminder_2_template_name).
//             Zonder goedgekeurde template → skip met duidelijke reden.
//
// Guardrails (allemaal DAADWERKELIJK geïmplementeerd — niet alleen belofte):
//   - Office-hours: hergebruikt `isWithinOfficeHours` uit joost-autonomy-evaluate.js
//     (exact zelfde config: office_hours_tz/days/start/end). Buiten venster:
//     skip zonder teller-mutatie zodat de VOLGENDE tick binnen kantooruren
//     'em alsnog stuurt (gemiste ticks laten niets vallen).
//   - Caps: max_messages_per_conversation_per_day + _total lezen uit
//     joost_config.autonomy_config.communication_limits, tellers uit
//     joost_conversation_state. Bij total-cap: aanroep van
//     `maybeCreateTotalCapTask` (bestaande #764-flow) zodat de badge/taak
//     opduikt zoals bij reactive autonomy. Bij day-cap: skip (tijdelijk).
//   - Cooldown: cooldown_after_outbound_seconds t.o.v.
//     joost_conversation_state.last_message_sent_at (elke outbound telt mee,
//     ook reminders én workflow-sends). Skip als binnen cooldown.
//   - Teller-update na succesvolle send: joost_conversation_state
//     messages_sent_today + messages_sent_total + last_message_sent_at,
//     zelfde patroon als joost-outbound-send r510-568. Zonder deze update
//     zouden de caps uit de pas lopen.
//   - Dry-run (dunning-dry-run.js): overslaat Meta-call + persist, maar
//     hoogt reminder-teller wél op zodat test-runs de stage-progressie
//     kunnen doorlopen. Update joost_conversation_state NIET in dry-run
//     (anders zou een dry-run test de echte caps opeten).
//   - Sandbox-guard voor is_test-klanten (assertRecipientMatchesSandbox).
//   - Fail-soft per run: try/catch — 1 fout laat de andere runs door.
//
// Bewuste keuze pad (b) i.p.v. pad (a) evaluateAutonomy():
//   evaluateAutonomy heeft een intent-mode-check (r232-238) die vóór de
//   office-hours- en rate-limit-checks een early-return doet als intent geen
//   INTENT_TO_CONFIG_KEY-mapping heeft. Voor een REMINDER hebben we geen
//   natuurlijke intent (dit is geen klant-suggestion) — een synthetic
//   'other' zou de gate falen, en semi-echte intents zoals 'payment_promise'
//   toewijzen zou het audit-log misleiden. Beter: expliciet de bestaande
//   helpers (`isWithinOfficeHours` + config lezen + joost_conversation_state
//   teller) hergebruiken. Bij total-cap: dezelfde `maybeCreateTotalCapTask`
//   aanroepen als reactive autonomy dat doet, zodat de #764-taak-flow
//   consistent blijft.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Schedule: */15 * * * * (elke 15 min; ruim binnen 20u/24u nauwkeurigheid).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { unpauseRunsForConversation } from './_lib/dunning-arrangement-hooks.js';
import {
  isWithinOfficeHours,
  maybeCreateTotalCapTask,
} from './joost-autonomy-evaluate.js';

const ABORT_MS = 50_000;
const MAX_RUNS_PER_TICK = 100;

function elapsed(startedAt) { return Date.now() - startedAt; }
function nowIso() { return new Date().toISOString(); }

/**
 * Reminder-1 tekst (vast, met bestaande variabelen). Geen LLM — voorspelbaar
 * eerste-contact-bericht.
 */
export function buildReminder1Text({ naam, factuur_nr, totaal_bedrag, dagen_overdue }) {
  const lines = [
    `Hoi ${naam || 'daar'},`,
    ``,
    `Ik heb je bericht ontvangen maar nog geen reactie van mij gekregen. Kun je me nog laten weten hoe je het wilt oplossen met factuur ${factuur_nr || ''} (${totaal_bedrag || ''}, ${dagen_overdue || 0} dagen te laat)?`,
    ``,
    `Groet,`,
    `Joost — De Forex Opleiding`,
  ];
  return lines.join('\n');
}

export async function isWithin24hWindow(supabase, convId) {
  try {
    const { data } = await supabase
      .from('whatsapp_conversations')
      .select('last_inbound_at')
      .eq('id', convId)
      .maybeSingle();
    if (!data?.last_inbound_at) return false;
    const ageMs = Date.now() - new Date(data.last_inbound_at).getTime();
    return ageMs < 24 * 60 * 60 * 1000;
  } catch (_e) {
    return false;
  }
}

/**
 * Bepaal stage per run:
 *   stage 'r1'  → reminder 1 moet gestuurd (nooit gestuurd + stil >= reminder_1_hours)
 *   stage 'r2'  → reminder 2 moet gestuurd (1 gestuurd + stil-na-r1 >= reminder_2_hours)
 *   stage 'rz'  → resume (2 gestuurd + stil-na-r2 >= resume_after_hours)
 *   stage null  → niets doen (nog te vroeg of al voltooid)
 */
export function determineStage({ run, convLastInboundAt, noReplyCfg, nowMs }) {
  const count = Number(run.paused_conversation_reminder_count || 0);
  const lastReminderAt = run.paused_conversation_last_reminder_at
    ? new Date(run.paused_conversation_last_reminder_at).getTime()
    : null;
  const lastInboundMs = convLastInboundAt
    ? new Date(convLastInboundAt).getTime()
    : null;

  const r1h = Number(noReplyCfg?.reminder_1_hours ?? 20);
  const r2h = Number(noReplyCfg?.reminder_2_hours ?? 24);
  const rzh = Number(noReplyCfg?.resume_after_hours ?? 24);

  const HOUR = 60 * 60 * 1000;

  if (count === 0) {
    if (!lastInboundMs) return null; // zonder inbound-ankerpunt niet zinnig
    if (nowMs - lastInboundMs >= r1h * HOUR) return 'r1';
    return null;
  }
  if (count === 1) {
    if (!lastReminderAt) return null;
    if (nowMs - lastReminderAt >= r2h * HOUR) return 'r2';
    return null;
  }
  if (count >= 2) {
    if (!lastReminderAt) return null;
    if (nowMs - lastReminderAt >= rzh * HOUR) return 'rz';
    return null;
  }
  return null;
}

/**
 * Laadt render-context (customer + openInvoices) voor de reminder-tekst.
 * Fail-soft: bij fout returnt lege waarden zodat de reminder een minimale
 * bericht kan sturen ("Hoi daar, ...").
 */
export async function loadRenderContext(customerId) {
  const ctx = { customer: null, openInvoices: [] };
  try {
    const { data: cust } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, is_test')
      .eq('id', customerId)
      .maybeSingle();
    ctx.customer = cust || null;
    if (cust) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, status')
        .eq('customer_id', customerId)
        .in('status', ['open', 'partially_paid', 'overdue'])
        .order('due_date', { ascending: true });
      ctx.openInvoices = Array.isArray(invs) ? invs : [];
    }
  } catch (e) {
    console.warn('[conv-reminder-cron] loadRenderContext fail:', e?.message);
  }
  return ctx;
}

/**
 * Laadt de finance-module joost_config (no_reply-cirkel + comm_limits).
 * Returned { ok, cfg, autonomyCfg, noReplyCfg } of { ok:false, reason }.
 * Zowel de cron als de sandbox-variant gebruiken dit — één centrale
 * config-shape voor beide.
 */
export async function loadConversationReminderConfig() {
  const { data: cfg, error: cfgErr } = await supabaseAdmin
    .from('joost_config')
    .select('module, autonomy_config, feature_flags, is_enabled')
    .eq('module', 'finance')
    .maybeSingle();
  if (cfgErr) return { ok: false, reason: 'CONFIG_LOOKUP_FAIL', error: cfgErr.message };
  if (!cfg)   return { ok: false, reason: 'JOOST_CONFIG_MISSING' };
  const autonomyCfg = (cfg.autonomy_config && typeof cfg.autonomy_config === 'object') ? cfg.autonomy_config : {};
  const noReplyCfg  = (autonomyCfg.no_reply  && typeof autonomyCfg.no_reply  === 'object') ? autonomyCfg.no_reply : {};
  return { ok: true, cfg, autonomyCfg, noReplyCfg };
}

/**
 * Laadt de externe modules (dry-run, meta-whatsapp, template-render) fail-safe.
 * Returned { isDryRunEnabled, assertRecipientMatchesSandbox, sendText,
 * sendTemplate, MetaNotConfiguredError, getConfigStatus, computeVariables }.
 * Elk veld kan null zijn als de import faalt — de per-run processor
 * degradeert dan naar dry-run of skip-scenario's.
 */
export async function loadConversationReminderDeps() {
  const deps = {
    isDryRunEnabled: null, assertRecipientMatchesSandbox: null,
    sendText: null, sendTemplate: null,
    MetaNotConfiguredError: null, getConfigStatus: null,
    computeVariables: null,
  };
  try {
    const dry = await import('./_lib/dunning-dry-run.js');
    deps.isDryRunEnabled = dry.isDryRunEnabled;
    deps.assertRecipientMatchesSandbox = dry.assertRecipientMatchesSandbox;
  } catch (e) { console.warn('[conv-reminder] dunning-dry-run module load fail:', e?.message); }
  try {
    const meta = await import('./_lib/meta-whatsapp.js');
    deps.sendText = meta.sendText;
    deps.sendTemplate = meta.sendTemplate;
    deps.MetaNotConfiguredError = meta.MetaNotConfiguredError;
    deps.getConfigStatus = meta.getConfigStatus;
  } catch (e) { console.warn('[conv-reminder] meta-whatsapp module load fail:', e?.message); }
  try {
    const rt = await import('./_lib/dunning-template-render.js');
    deps.computeVariables = rt.computeVariables;
  } catch (e) { console.warn('[conv-reminder] template-render module load fail:', e?.message); }
  return deps;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const summary = {
    processed_count: 0,
    r1_sent: 0,
    r2_sent: 0,
    resumed: 0,
    skipped: [],  // [{ run_id, reason }]
    errors: [],
    duration_ms: 0,
  };

  try {
    // ── Config ophalen (finance-module: no_reply-blok + comm_limits) ──────
    const cfgRes = await loadConversationReminderConfig();
    if (!cfgRes.ok) {
      if (cfgRes.reason === 'CONFIG_LOOKUP_FAIL') {
        console.error('[conv-reminder-cron] joost_config lookup:', cfgRes.error);
        summary.duration_ms = elapsed(startedAt);
        return res.status(500).json({ ...summary, error: 'joost_config lookup: ' + cfgRes.error });
      }
      summary.duration_ms = elapsed(startedAt);
      return res.status(200).json({ ...summary, skipped_reason: cfgRes.reason });
    }
    const { autonomyCfg, noReplyCfg } = cfgRes;

    // ── Pending gespreks-pauze runs ophalen ────────────────────────────────
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, paused_by_conversation_id, paused_conversation_reminder_count, paused_conversation_last_reminder_at, updated_at')
      .eq('status', 'paused')
      .not('paused_by_conversation_id', 'is', null)
      .order('updated_at', { ascending: true })
      .limit(MAX_RUNS_PER_TICK);
    if (runsErr) throw new Error('runs query: ' + runsErr.message);
    const runList = Array.isArray(runs) ? runs : [];
    if (runList.length === 0) {
      summary.duration_ms = elapsed(startedAt);
      return res.status(200).json(summary);
    }

    // ── Deps + dry-run laden via shared loader ────────────────────────────
    const deps = await loadConversationReminderDeps();
    const dryRunOn = deps.isDryRunEnabled ? await deps.isDryRunEnabled() : true; // fail-safe: dry-run AAN

    // ── Per-run afwerken via shared processor ─────────────────────────────
    const nowMs = Date.now();
    for (const run of runList) {
      if (elapsed(startedAt) > ABORT_MS) {
        console.warn('[conv-reminder-cron] abort budget overschreden');
        break;
      }
      await processReminderRun({
        run,
        autonomyCfg,
        noReplyCfg,
        deps,
        dryRunOn,
        nowMs,
        summary,
        logPrefix: 'conv-reminder-cron',
      });
    }

    summary.duration_ms = elapsed(startedAt);

    // Audit (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: null,
        action: 'joost.conv_reminder_cron_run',
        entity_type: null,
        entity_id: null,
        after_json: {
          processed_count: summary.processed_count,
          r1_sent: summary.r1_sent,
          r2_sent: summary.r2_sent,
          resumed: summary.resumed,
          skipped_count: summary.skipped.length,
          errors_count: summary.errors.length,
          first_skips: summary.skipped.slice(0, 5),
          first_errors: summary.errors.slice(0, 3),
          duration_ms: summary.duration_ms,
          dry_run: dryRunOn,
        },
        reason_text: `conv_reminders: r1=${summary.r1_sent} r2=${summary.r2_sent} resumed=${summary.resumed} skipped=${summary.skipped.length}`,
        ip_address: null,
      });
    } catch (_) { /* fail-soft */ }

    return res.status(200).json(summary);
  } catch (e) {
    console.error('[conv-reminder-cron] fatal:', e?.message || e);
    summary.duration_ms = elapsed(startedAt);
    return res.status(500).json({ ...summary, error: e?.message || String(e) });
  }
}

/**
 * Verwerk één run door de reminder-cirkel (stage bepalen, guardrails,
 * send/skip/resume). Mutates `summary` in-place. Fail-soft per run.
 *
 * @param {object} args
 * @param {object} args.run                            dunning_workflow_runs-rij (id, customer_id, paused_by_conversation_id, paused_conversation_reminder_count, paused_conversation_last_reminder_at)
 * @param {object} args.autonomyCfg                    joost_config.autonomy_config
 * @param {object} args.noReplyCfg                     autonomyCfg.no_reply
 * @param {object} args.deps                           result van loadConversationReminderDeps()
 * @param {boolean} args.dryRunOn                      globale dry-run
 * @param {number} args.nowMs                          Date.now() gebonden aan de tick
 * @param {object} args.summary                        aggregate object (processed_count, r1_sent, r2_sent, resumed, skipped, errors)
 * @param {string} args.logPrefix                      log-tag (bv. 'conv-reminder-cron' of 'sandbox-conv-reminders')
 */
export async function processReminderRun({
  run, autonomyCfg, noReplyCfg, deps, dryRunOn, nowMs, summary, logPrefix,
}) {
  const {
    assertRecipientMatchesSandbox, sendText, sendTemplate,
    MetaNotConfiguredError, getConfigStatus, computeVariables,
  } = deps || {};
  summary.processed_count++;

      try {
        // Conv-info + laatste inbound (voor stage-bepaling en 24u-venster).
        const { data: conv } = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('id, phone_number, phone_number_id, last_inbound_at, customer_id')
          .eq('id', run.paused_by_conversation_id)
          .maybeSingle();
        if (!conv) {
          summary.skipped.push({ run_id: run.id, reason: 'CONV_NOT_FOUND' });
          return;
        }

        const stage = determineStage({
          run,
          convLastInboundAt: conv.last_inbound_at,
          noReplyCfg,
          nowMs,
        });
        if (!stage) {
          summary.skipped.push({ run_id: run.id, reason: 'NOT_DUE_YET' });
          return;
        }

        // ── Stage 'rz': hervat de run (geen send) ──
        if (stage === 'rz') {
          const rz = await unpauseRunsForConversation(conv.id);
          if (rz.ok && rz.resumed_count > 0) summary.resumed += rz.resumed_count;
          return;
        }

        // ─── GUARDRAIL 1: office-hours ─────────────────────────────────
        // Buiten kantooruren: skip zonder teller-mutatie zodat de volgende
        // tick binnen het venster 'em alsnog stuurt (gemiste ticks laten
        // niets vallen — determineStage kijkt naar de tijd sinds
        // last_inbound_at / last_reminder_at, niet naar aantal ticks).
        const commLimits = (autonomyCfg.communication_limits && typeof autonomyCfg.communication_limits === 'object')
          ? autonomyCfg.communication_limits : {};
        const officeHoursOnly = commLimits.office_hours_only !== false;
        if (officeHoursOnly) {
          const within = isWithinOfficeHours(
            {
              tz:        commLimits.office_hours_tz   || 'Europe/Amsterdam',
              days:      commLimits.office_hours_days || [1, 2, 3, 4, 5],
              startHHMM: commLimits.office_hours_start || '08:30',
              endHHMM:   commLimits.office_hours_end   || '18:00',
            },
            new Date(nowMs),
          );
          if (!within) {
            summary.skipped.push({ run_id: run.id, reason: 'OFFICE_HOURS_CLOSED' });
            return;
          }
        }

        // ── Stage 'r1' of 'r2': render + send ──
        const { customer, openInvoices } = await loadRenderContext(run.customer_id);
        if (!customer) {
          summary.skipped.push({ run_id: run.id, reason: 'CUSTOMER_NOT_FOUND' });
          return;
        }
        const sendTo = conv.phone_number || customer.phone;
        if (!sendTo) {
          summary.skipped.push({ run_id: run.id, reason: 'NO_PHONE' });
          return;
        }

        // Sandbox-guard voor is_test-klanten: nummer moet matchen sandbox.
        if (customer.is_test && assertRecipientMatchesSandbox) {
          try {
            await assertRecipientMatchesSandbox({ isTest: true, actual: sendTo, channel: 'whatsapp' });
          } catch (guardErr) {
            summary.skipped.push({ run_id: run.id, reason: 'SANDBOX_GUARD:' + guardErr.message });
            return;
          }
        }

        // ─── GUARDRAIL 2 + 3: caps + cooldown (op joost_conversation_state) ──
        // Lees per-conversatie state om beide te evalueren. Zelfde velden als
        // joost-outbound-send r280-286 leest.
        let convState = null;
        try {
          const { data } = await supabaseAdmin
            .from('joost_conversation_state')
            .select('conversation_id, messages_sent_today, messages_sent_today_date, messages_sent_total, last_message_sent_at')
            .eq('conversation_id', conv.id)
            .maybeSingle();
          convState = data || null;
        } catch (e) {
          console.warn('[conv-reminder-cron] state lookup fail:', e?.message);
        }
        const todayStr = new Date(nowMs).toISOString().slice(0, 10);
        const sameDay  = convState && convState.messages_sent_today_date === todayStr;
        const sentToday = sameDay ? Number(convState?.messages_sent_today || 0) : 0;
        const sentTotal = Number(convState?.messages_sent_total || 0);
        const lastSentMs = convState?.last_message_sent_at
          ? new Date(convState.last_message_sent_at).getTime()
          : 0;

        const maxPerDay = Number(commLimits.max_messages_per_conversation_per_day ?? 3);
        const maxTotal  = Number(commLimits.max_messages_per_conversation_total   ?? 10);
        const cooldownSec = (commLimits.cooldown_after_outbound_seconds != null)
          ? Number(commLimits.cooldown_after_outbound_seconds)
          : (commLimits.cooldown_after_outbound_minutes != null
              ? Number(commLimits.cooldown_after_outbound_minutes) * 60
              : 3600);

        // Total-cap: zelfde signaal als reactive autonomy — cap-taak vuren
        // via #764-helper (maybeCreateTotalCapTask). Idempotent per conv.
        if (sentTotal >= maxTotal) {
          try {
            await maybeCreateTotalCapTask({
              supabaseAdmin,
              conv_id: conv.id,
              decision: {
                intent: 'reminder',
                blocked_reason: 'BLOCKED_RATE_LIMIT',
                rate_limit_reason: 'total',
                decision_log: [`messages_sent_total (${sentTotal}) >= max_total (${maxTotal}) via conv-reminder-cron`],
              },
              triggered_by: 'conv_reminder_cron',
            });
          } catch (e) {
            console.warn('[conv-reminder-cron] cap-taak fail-soft:', e?.message);
          }
          summary.skipped.push({ run_id: run.id, reason: `CAP_TOTAL: ${sentTotal}/${maxTotal}` });
          return;
        }
        // Day-cap: skip (tijdelijk — morgen weer, geen taak nodig).
        if (sentToday >= maxPerDay) {
          summary.skipped.push({ run_id: run.id, reason: `CAP_DAY: ${sentToday}/${maxPerDay}` });
          return;
        }
        // Cooldown: elke outbound telt mee. Skip zonder teller-mutatie zodat
        // de volgende tick 'em alsnog stuurt zodra cooldown voorbij is.
        if (lastSentMs > 0 && cooldownSec > 0) {
          const elapsedSec = Math.floor((nowMs - lastSentMs) / 1000);
          if (elapsedSec < cooldownSec) {
            summary.skipped.push({ run_id: run.id, reason: `COOLDOWN: ${elapsedSec}/${cooldownSec}s` });
            return;
          }
        }

        // Variabelen renderen (NAAM, FACTUUR_NR, TOTAAL_BEDRAG, DAGEN_OVERDUE, VERVAL_DATUM).
        const variables = computeVariables
          ? computeVariables({ customer, openInvoices })
          : { NAAM: '', FACTUUR_NR: '', TOTAAL_BEDRAG: '', DAGEN_OVERDUE: '0', VERVAL_DATUM: '' };

        // Determine actual send-method:
        //   r1: vrij tekst IF venster open; anders skip naar r2-flow
        //   r2: template altijd
        let willSendAs = null; // 'text' | 'template'
        if (stage === 'r1') {
          const windowOpen = await isWithin24hWindow(supabaseAdmin, conv.id);
          willSendAs = windowOpen ? 'text' : 'template';
        } else {
          willSendAs = 'template';
        }

        // Template-naam check (voor r2 en voor r1-when-window-dicht).
        const templateName = noReplyCfg.reminder_2_template_name;
        if (willSendAs === 'template' && !templateName) {
          summary.skipped.push({
            run_id: run.id,
            reason: 'NO_TEMPLATE_CONFIGURED: no_reply.reminder_2_template_name is null in joost_config. Zie PR-body voor template-spec.',
          });
          return;
        }

        // ── DRY-RUN pad: log intent, geen Meta-call, geen state-mutatie ──
        if (dryRunOn) {
          console.log('[conv-reminder-cron DRY-RUN]', {
            run_id: run.id,
            stage,
            send_as: willSendAs,
            to: sendTo,
            template_name: willSendAs === 'template' ? templateName : null,
            preview_text: willSendAs === 'text'
              ? buildReminder1Text({
                  naam: variables.NAAM,
                  factuur_nr: variables.FACTUUR_NR,
                  totaal_bedrag: variables.TOTAAL_BEDRAG,
                  dagen_overdue: variables.DAGEN_OVERDUE,
                }).slice(0, 200)
              : null,
            variables,
            dry_run: true,
          });
          // Toch de reminder-teller ophogen op dunning_workflow_runs zodat
          // de volgende tick de VOLGENDE stage ziet — anders blijft dry-run
          // in dezelfde stage hangen en zie je geen r2/rz progressie in
          // test-runs. joost_conversation_state wordt in dry-run BEWUST NIET
          // bijgewerkt — anders zou een test-run de echte caps opeten en
          // zou live-verkeer daarna vroegtijdig geblokkeerd worden.
          await supabaseAdmin
            .from('dunning_workflow_runs')
            .update({
              paused_conversation_reminder_count: stage === 'r1' ? 1 : 2,
              paused_conversation_last_reminder_at: nowIso(),
              updated_at: nowIso(),
            })
            .eq('id', run.id);
          if (stage === 'r1') summary.r1_sent++;
          if (stage === 'r2') summary.r2_sent++;
          return;
        }

        // ── LIVE pad: Meta-config check ──
        if (!getConfigStatus) {
          summary.skipped.push({ run_id: run.id, reason: 'META_MODULE_UNAVAILABLE' });
          return;
        }
        const cfgStatus = getConfigStatus();
        if (!cfgStatus.configured) {
          summary.skipped.push({ run_id: run.id, reason: 'META_NOT_CONFIGURED: ' + (cfgStatus.missing || []).join(',') });
          return;
        }

        // Outbound phone_number_id: conv.phone_number_id (autoritatief) →
        // fallback module-config finance.
        let outboundPnId = conv.phone_number_id || null;
        if (!outboundPnId) {
          try {
            const { data: modCfg } = await supabaseAdmin
              .from('whatsapp_module_config')
              .select('phone_number_id')
              .eq('module', 'finance')
              .eq('is_active', true)
              .maybeSingle();
            outboundPnId = modCfg?.phone_number_id || null;
          } catch (_) { /* fail-soft */ }
        }

        // ── Meta-send ──
        let wamid = null;
        try {
          if (willSendAs === 'text') {
            const body = buildReminder1Text({
              naam: variables.NAAM,
              factuur_nr: variables.FACTUUR_NR,
              totaal_bedrag: variables.TOTAAL_BEDRAG,
              dagen_overdue: variables.DAGEN_OVERDUE,
            });
            const r = await sendText({ to: sendTo, body, phoneNumberId: outboundPnId });
            wamid = r?.wamid || null;
          } else {
            // Positional variables volgens KEY-CONTRACT vaste volgorde.
            const orderedKeys = ['NAAM', 'FACTUUR_NR', 'TOTAAL_BEDRAG', 'DAGEN_OVERDUE', 'VERVAL_DATUM'];
            const positional = orderedKeys.map(k => String(variables[k] || ''));
            const r = await sendTemplate({
              to: sendTo,
              templateName,
              languageCode: 'nl',
              variables: positional,
              phoneNumberId: outboundPnId,
            });
            wamid = r?.wamid || null;
          }
        } catch (metaErr) {
          if (metaErr instanceof MetaNotConfiguredError) {
            summary.skipped.push({ run_id: run.id, reason: 'META_NOT_CONFIGURED_RUNTIME' });
            return;
          }
          summary.errors.push({
            run_id: run.id,
            stage,
            error: metaErr?.message || String(metaErr),
            meta_code: metaErr?.metaCode ?? null,
          });
          return;
        }

        // ── Persist whatsapp_messages + conv-preview ──
        const sentAt = nowIso();
        const previewBody = willSendAs === 'text'
          ? buildReminder1Text({
              naam: variables.NAAM,
              factuur_nr: variables.FACTUUR_NR,
              totaal_bedrag: variables.TOTAAL_BEDRAG,
              dagen_overdue: variables.DAGEN_OVERDUE,
            })
          : ('[template] ' + templateName);
        try {
          const insertRow = {
            conversation_id: conv.id,
            direction: 'out',
            meta_wamid: wamid,
            body: previewBody.slice(0, 1000),
            template_name: willSendAs === 'template' ? templateName : null,
            template_variables: willSendAs === 'template'
              ? Object.fromEntries(['NAAM', 'FACTUUR_NR', 'TOTAAL_BEDRAG', 'DAGEN_OVERDUE', 'VERVAL_DATUM']
                  .map((k, i) => [String(i + 1), String(variables[k] || '')]))
              : null,
            status: 'queued',
            sent_at: sentAt,
            sent_by_user_id: null,
          };
          await supabaseAdmin.from('whatsapp_messages').insert(insertRow);
        } catch (e) {
          console.warn('[conv-reminder-cron] whatsapp_messages insert fail:', e?.message);
        }
        try {
          await supabaseAdmin
            .from('whatsapp_conversations')
            .update({ last_message_at: sentAt, last_message_preview: previewBody.slice(0, 120) })
            .eq('id', conv.id);
        } catch (_) { /* fail-soft */ }

        // ── State-update dunning_workflow_runs: reminder-teller ──
        await supabaseAdmin
          .from('dunning_workflow_runs')
          .update({
            paused_conversation_reminder_count: stage === 'r1' ? 1 : 2,
            paused_conversation_last_reminder_at: sentAt,
            updated_at: sentAt,
          })
          .eq('id', run.id);

        // ── State-update joost_conversation_state: caps + cooldown tellers ──
        // Zonder deze update zouden de caps uit de pas lopen met wat andere
        // outbound-paden (joost-outbound-send, reactive autonomy) doen. Zelfde
        // patroon als joost-outbound-send r510-568 (race-safe insert+update).
        try {
          if (!convState) {
            const { error: stateInsErr } = await supabaseAdmin
              .from('joost_conversation_state')
              .insert({
                conversation_id:          conv.id,
                messages_sent_today:      1,
                messages_sent_today_date: todayStr,
                messages_sent_total:      1,
                last_message_sent_at:     sentAt,
              });
            if (stateInsErr && stateInsErr.code === '23505') {
              // Race: andere caller insertte intussen → reload + update.
              const { data: again } = await supabaseAdmin
                .from('joost_conversation_state')
                .select('messages_sent_today, messages_sent_today_date, messages_sent_total')
                .eq('conversation_id', conv.id)
                .maybeSingle();
              if (again) {
                const raceSameDay = again.messages_sent_today_date === todayStr;
                const raceToday   = (raceSameDay ? Number(again.messages_sent_today || 0) : 0) + 1;
                const raceTotal   = Number(again.messages_sent_total || 0) + 1;
                await supabaseAdmin
                  .from('joost_conversation_state')
                  .update({
                    messages_sent_today:      raceToday,
                    messages_sent_today_date: todayStr,
                    messages_sent_total:      raceTotal,
                    last_message_sent_at:     sentAt,
                  })
                  .eq('conversation_id', conv.id);
              }
            } else if (stateInsErr) {
              console.warn('[conv-reminder-cron] conv_state insert fail:', stateInsErr.message);
            }
          } else {
            const newToday = (sameDay ? sentToday : 0) + 1;
            const newTotal = sentTotal + 1;
            await supabaseAdmin
              .from('joost_conversation_state')
              .update({
                messages_sent_today:      newToday,
                messages_sent_today_date: todayStr,
                messages_sent_total:      newTotal,
                last_message_sent_at:     sentAt,
              })
              .eq('conversation_id', conv.id);
          }
        } catch (e) {
          console.warn('[conv-reminder-cron] conv_state update exception:', e?.message);
        }

        if (stage === 'r1') summary.r1_sent++;
        if (stage === 'r2') summary.r2_sent++;
      } catch (perRunErr) {
        summary.errors.push({
          run_id: run.id,
          error: perRunErr?.message || String(perRunErr),
        });
      }
}
