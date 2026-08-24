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
//   evaluateAutonomy heeft een intent-mode-check die vóór de office-hours-
//   en rate-limit-checks een early-return doet als intent geen intent-config
//   heeft. Voor een REMINDER hebben we geen natuurlijke intent (dit is geen
//   klant-suggestion) — een synthetic 'other' zou de gate falen, en semi-
//   echte intents zoals 'payment_promise' toewijzen zou het audit-log
//   misleiden. Beter: expliciet de bestaande
//   helpers (`isWithinOfficeHours` + config lezen + joost_conversation_state
//   teller) hergebruiken. Bij total-cap: dezelfde `maybeCreateTotalCapTask`
//   aanroepen als reactive autonomy dat doet, zodat de #764-taak-flow
//   consistent blijft.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Schedule: */15 * * * * (elke 15 min; ruim binnen 20u/24u nauwkeurigheid).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { unpauseRunsForConversation } from './_lib/dunning-arrangement-hooks.js';
import {
  isWithinOfficeHours,
  maybeCreateTotalCapTask,
} from './joost-autonomy-evaluate.js';
import {
  hasOpenBlockingAction,
  loadOpenActionsByCustomer,
} from './_lib/pending-actions-guard.js';
import { determineStage as _determineStageHelper } from './_lib/conv-reminder-stage.js';
import { buildReminderTemplatePayload } from './_lib/conv-reminder-template.js';
import { renderTemplatePreview } from './_lib/render-template-preview.js';

// Re-export voor backward-compat met tests die deze helpers vanuit deze
// file importeerden (pre-#888 opsplitsing). Nieuwe callers importeren
// rechtstreeks uit `_lib/pending-actions-guard.js`.
export { hasOpenBlockingAction, loadOpenActionsByCustomer };

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
    `Ik heb je eerder een bericht gestuurd, maar nog geen reactie van jou gekregen. Kun je me nog laten weten hoe je het wilt oplossen met factuur ${factuur_nr || ''} (${totaal_bedrag || ''}, ${dagen_overdue || 0} dagen te laat)?`,
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
 *   stage 'r1'  → reminder 1 moet gestuurd (nooit gestuurd + stil >= reminder_1_hours
 *                  + WIJ hebben niet al recenter geantwoord dan de klant)
 *   stage 'r2'  → reminder 2 moet gestuurd (1 gestuurd + stil-na-r1 >= reminder_2_hours)
 *   stage 'rz'  → resume (2 gestuurd + stil-na-r2 >= resume_after_hours)
 *   stage null  → niets doen (nog te vroeg, al voltooid, of wij hebben al geantwoord)
 *
 * `convLastOutboundAt` (optioneel — FIX B no-reply-bug): tijdstip van laatste
 * outbound-bericht van ons in deze conv. Op count=0: als lastOutboundMs >
 * lastInboundMs → wij hebben al geantwoord op de klant → geen r1-reminder
 * (die zou onterecht zijn — de reminder-tekst zegt "nog geen reactie van jou"
 * terwijl er WEL gereageerd is). Fix A ontpauzeert de run bij een succesvolle
 * outbound-send al, deze check is het vangnet voor:
 *   - runs die vóór fix A gepauzeerd waren (backlog)
 *   - outbound via kanalen die (nog) niet unpauseRunsForConversation aanroepen
 *   - race-condities tussen outbound-persist en cron-tick
 * Bij count=1: bestaande r2-guard (lastInboundMs > lastReminderAt) blijft de
 * relevante check — nadat wij r1 stuurden en de klant reageert, is r2 al
 * geblokkeerd door die bestaande guard.
 */
// determineStage geëxtraheerd naar _lib/conv-reminder-stage.js zodat de pure
// helper zonder supabase-init getest kan worden. Backward-compat re-export
// zodat oudere tests die 'em vanuit deze file importeren blijven werken.
export const determineStage = _determineStageHelper;

/**
 * Laadt render-context (customer + openInvoices) voor de reminder-tekst.
 * Fail-soft: bij fout returnt lege waarden zodat de reminder een minimale
 * bericht kan sturen ("Hoi daar, ...").
 */
/**
 * Dedup runs op paused_by_conversation_id: hou 1 winnaar per conversatie aan
 * (de oudste updated_at, want de handler-query ordent al ascending). De rest
 * gaat als `duplicates` terug voor observability-log.
 *
 * Rationale: een klant kan meerdere gepauzeerde runs hebben op dezelfde
 * conversation-id (bulk-start-workflow enrolde 'em meerdere keren, of een
 * handmatige run bovenop een automatische). Zonder dedup krijgt elke run z'n
 * eigen reminder -> N identieke berichten (bewijs Benny Veys: 2 runs op
 * dezelfde conv, beide teller 1, reminders op 07:15+07:30 UTC).
 *
 * De atomic claim op paused_conversation_reminder_count werkt per RUN en
 * beschermt hier niet tegen. Deze functie is de conv-level guard; de
 * run-claim blijft cross-tick vangnet.
 */
export function dedupRunsByConversation(runs) {
  const winners = [];
  const duplicates = [];
  const seen = new Set();
  for (const r of Array.isArray(runs) ? runs : []) {
    const convId = r?.paused_by_conversation_id || null;
    if (!convId) { winners.push(r); continue; }
    if (seen.has(convId)) { duplicates.push(r); continue; }
    seen.add(convId);
    winners.push(r);
  }
  return { winners, duplicates };
}

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
      // Send-time open-filter: status blijft soms nog 'open' terwijl amount_paid
      // al gelijk aan amount_total is (TL-sync-race). Filter dat er hier uit
      // zodat de guardrail hieronder (openInvoices.length===0 → skip) triggert.
      ctx.openInvoices = (Array.isArray(invs) ? invs : []).filter((inv) => {
        const tot  = Number(inv?.amount_total)    || 0;
        const paid = Number(inv?.amount_paid)     || 0;
        const cred = Number(inv?.credited_amount) || 0;
        return Math.max(0, tot - paid - cred) > 0;
      });
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

  // ── Scope (BLOK 1 · PR-scope) ────────────────────────────────────────────
  // Default 'production': productie-cron gedraagt zich exact zoals vóór deze
  // PR. Cockpit-triggers geven scope='test' mee (via query of body).
  const rawScope = String(req.query?.scope || req.body?.scope || 'production').toLowerCase();
  const scope = (rawScope === 'test') ? 'test' : 'production';

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Productie-scope: alleen CRON_SECRET (identiek aan vóór deze PR).
  // Test-scope: CRON_SECRET OF super_admin (cockpit heeft geen cron-secret).
  if (scope === 'test') {
    const cronOk = checkCronAuth(req).ok;
    if (!cronOk) {
      const admin = await requireSuperAdmin(req, res);
      if (!admin) return; // 401/403 al verzonden
    }
  } else {
    const cronAuth = checkCronAuth(req);
    if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);
  }

  const startedAt = Date.now();
  const summary = {
    scope,
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
    // Scope-filter (BLOK 1 · PR-scope): inner-join op customers om
    // is_test-vlag te lezen.
    //
    // - scope='production' (default) → IS NOT TRUE (matcht false én NULL).
    //   Schema garandeert NOT NULL + default false, dus in de huidige DB is
    //   dit equivalent aan '= false'. IS NOT TRUE is defensiever tegen
    //   toekomstige schema-drift (bv. DROP NOT NULL) — voorkomt dat
    //   productie-klanten stil uitgesloten worden.
    // - scope='test' → strict '= true'. NULL en false tellen niet als test.
    //
    // Fix voor onderweg gevonden gat: tot nu toe was assertRecipientMatches-
    // Sandbox op r522 de laatste vangnet voor test-runs die in productie-
    // scope kwamen. Nu worden ze überhaupt niet meer opgehaald.
    let runsQ = supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, paused_by_conversation_id, paused_conversation_reminder_count, paused_conversation_last_reminder_at, updated_at, customers!inner(is_test)')
      .eq('status', 'paused')
      .not('paused_by_conversation_id', 'is', null);
    if (scope === 'test') runsQ = runsQ.eq('customers.is_test', true);
    else                  runsQ = runsQ.not('customers.is_test', 'is', true);
    const { data: runs, error: runsErr } = await runsQ
      .order('updated_at', { ascending: true })
      .limit(MAX_RUNS_PER_TICK);
    if (runsErr) throw new Error('runs query: ' + runsErr.message);
    const runList = Array.isArray(runs) ? runs : [];
    if (runList.length === 0) {
      summary.duration_ms = elapsed(startedAt);
      return res.status(200).json(summary);
    }

    // ── Dedup op conversatie-niveau ────────────────────────────────────────
    // Meerdere runs op dezelfde conv -> hooguit 1 reminder per gesprek per
    // tick. De atomic run-claim in processReminderRun blijft cross-tick
    // vangnet, maar per-tick moeten we het conv-niveau bewaken want die
    // claim werkt per RUN.
    const { winners: dedupedRuns, duplicates: dupRuns } =
      dedupRunsByConversation(runList);
    for (const dup of dupRuns) {
      summary.skipped.push({ run_id: dup.id, reason: 'DUPLICATE_CONV_RUN' });
    }

    // ── Actie-guard: batch-lookup pending_actions per klant ────────────────
    // Als een mens al bezig is met de klant (pending/approved/executed/failed
    // action op klant-niveau) -> bot zwijgt. rejected/cancelled tellen niet.
    const winnerCustIds = Array.from(new Set(
      dedupedRuns.map(r => r.customer_id).filter(Boolean)
    ));
    const openActionsByCustomer = await loadOpenActionsByCustomer(winnerCustIds);

    // ── Deps + dry-run laden via shared loader ────────────────────────────
    const deps = await loadConversationReminderDeps();
    const dryRunOn = deps.isDryRunEnabled ? await deps.isDryRunEnabled() : true; // fail-safe: dry-run AAN

    // ── Per-run afwerken via shared processor ─────────────────────────────
    const nowMs = Date.now();
    for (const run of dedupedRuns) {
      if (elapsed(startedAt) > ABORT_MS) {
        console.warn('[conv-reminder-cron] abort budget overschreden');
        break;
      }

      // Actie-guard: klant heeft open handmatige actie -> geen reminder.
      const custActions = run.customer_id
        ? openActionsByCustomer.get(run.customer_id)
        : null;
      if (hasOpenBlockingAction(custActions || [])) {
        summary.processed_count++;
        summary.skipped.push({
          run_id: run.id,
          reason: 'BLOCKED_BY_OPEN_ACTION',
        });
        continue;
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

        // FIX B no-reply-bug: laatste OUTBOUND van ons in deze conv ophalen.
        // determineStage gebruikt dit om te checken of wij al gereageerd
        // hebben — dan géén r1/r2. Fail-soft: bij DB-fout lastOutboundMs=null
        // → gedrag valt terug op oud (alleen last_inbound-check), fix A geeft
        // dan alsnog dekking.
        let lastOutboundAt = null;
        try {
          const { data: outMsg } = await supabaseAdmin
            .from('whatsapp_messages')
            .select('created_at')
            .eq('conversation_id', conv.id)
            .eq('direction', 'out')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          lastOutboundAt = outMsg?.created_at || null;
        } catch (outErr) {
          console.warn(`[conv-reminder-cron] last-outbound lookup fail-soft:`, outErr?.message || outErr);
        }

        const stage = determineStage({
          run,
          convLastInboundAt: conv.last_inbound_at,
          convLastOutboundAt: lastOutboundAt,
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
        // Send-time hercheck: geen open bedrag meer → geen reminder. Klant kan
        // hebben betaald na de laatste engine-send. Verstuur niets; markeer
        // via summary. De reminder-run zelf blijft in dezelfde staat — de
        // dunning-engine ruimt hem bij de eerstvolgende tick op (regel ~940
        // → status='completed', reason='paid').
        if (!openInvoices || openInvoices.length === 0) {
          summary.skipped.push({ run_id: run.id, reason: 'NO_OPEN_AMOUNT' });
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

        // ── ATOMIC CLAIM (spoedfix Ayoub/David bug) ──────────────────
        // Verhoog paused_conversation_reminder_count met een conditie op
        // de CURRENT waarde. 0 rijen terug -> andere tick was ons voor
        // -> SKIP. Claim ALTIJD vóór de send zodat 2 gelijktijdige
        // invocaties niet allebei sturen. Bij een send die daarna faalt:
        // claim blijft staan (spec: liever gemiste reminder dan dubbele).
        // Zelfde patroon als cron-dunning-bulk-send.js:154-166.
        const expectedCount = stage === 'r1' ? 0 : 1;
        const newCount      = stage === 'r1' ? 1 : 2;
        const claimAtIso    = nowIso();
        const { data: claimed, error: claimErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .update({
            paused_conversation_reminder_count:  newCount,
            paused_conversation_last_reminder_at: claimAtIso,
            updated_at:                           claimAtIso,
          })
          .eq('id', run.id)
          .eq('paused_conversation_reminder_count', expectedCount)
          .select('id');
        if (claimErr) {
          summary.errors.push({ run_id: run.id, stage, error: 'claim: ' + claimErr.message });
          return;
        }
        if (!claimed || claimed.length === 0) {
          // Andere tick was ons voor -> geen dubbele send.
          summary.skipped.push({ run_id: run.id, reason: `CLAIM_LOST: expected count=${expectedCount}` });
          return;
        }

        // ── Template-payload bouwen (Bug 2 fix — 3 aug 2026) ────────────
        // Voor template-sends laten we het aantal params + de variabele-
        // waarden LEIDEN DOOR whatsapp_meta_templates.meta_param_mapping.body,
        // exact zoals cron-dunning-bulk-send en inbox-send-template al doen.
        // Zonder deze laag stuurde de cron altijd 5 hardcoded positional
        // params, wat 132000/132001 gaf bij templates met minder placeholders
        // en dubbele-EUR-drift bij templates met "EUR {{n}}" hardcoded.
        //
        // Fallback naar oude 5-positional als template niet in DB of geen
        // mapping — dan behoudt de send het legacy-gedrag.
        //
        // r1 als vrij-tekst (venster open) gebruikt dit pad NIET; die zit in
        // buildReminder1Text hierna. Alleen r2 en r1-fallback-bij-dicht-venster
        // gaan door de mapping-resolver.
        let tplPayload = null;
        if (willSendAs === 'template') {
          tplPayload = await buildReminderTemplatePayload({
            templateName,
            ctx: {
              customer,
              openInvoices,
              // Oudste openstaande = openInvoices[0] (loadRenderContext ordent
              // op due_date asc). Voor factuur.* single-keys in de mapping.
              invoice: openInvoices[0] || null,
            },
            legacyVars: variables,
            supabase:   supabaseAdmin,
          });
          if (tplPayload.warnings && tplPayload.warnings.length) {
            console.log('[conv-reminder-cron] template-payload warnings run=' + run.id + ':',
              tplPayload.warnings.join(' | '));
          }
        }

        // ── DRY-RUN pad: log intent, geen Meta-call, geen extra state-mutatie ──
        // De claim hierboven heeft de reminder-teller al opgehoogd (was voorheen
        // een aparte post-log update); dry-run gedraagt zich verder identiek.
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
            // computeVariables-output (5 hardcoded keys) blijft in de log voor
            // debug-context; tpl_used_variables toont wat er ECHT verstuurd zou
            // worden op basis van de template-mapping (of legacy fallback).
            variables,
            tpl_mode:            tplPayload ? tplPayload.mode          : null,
            tpl_used_variables:  tplPayload ? tplPayload.usedVariables : null,
            tpl_language:        tplPayload ? tplPayload.templateLanguage : null,
            dry_run: true,
          });
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
            // Template-send: tplPayload is gegarandeerd niet-null in deze branch
            // (hij wordt gebouwd wanneer willSendAs === 'template'). Bij mapping-
            // mode → components; bij legacy-fallback → positional variables.
            const sendArgs = {
              to:            sendTo,
              templateName,
              languageCode:  tplPayload.templateLanguage || 'nl',
              phoneNumberId: outboundPnId,
            };
            if (tplPayload.mode === 'mapping' && tplPayload.components) {
              sendArgs.components = tplPayload.components;
            } else {
              sendArgs.variables = tplPayload.variables;
            }
            const r = await sendTemplate(sendArgs);
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
        // Voor r1-vrije-tekst: buildReminder1Text is de bron van waarheid.
        // Voor template-sends: gebruik render-template-preview zodat de body
        // in de inbox de ECHTE tekst toont die de klant kreeg, niet het
        // '[template] naam'-label. Fail-soft: bij helper-fout returnt de
        // helper zelf al het legacy-label — send-flow breekt nooit.
        const sentAt = nowIso();
        let previewBody;
        if (willSendAs === 'text') {
          previewBody = buildReminder1Text({
            naam: variables.NAAM,
            factuur_nr: variables.FACTUUR_NR,
            totaal_bedrag: variables.TOTAAL_BEDRAG,
            dagen_overdue: variables.DAGEN_OVERDUE,
          });
        } else {
          const preview = await renderTemplatePreview({
            templateName,
            templateVariables: tplPayload?.usedVariables || null,
            supabase: supabaseAdmin,
          });
          previewBody = preview.body;
        }
        try {
          const insertRow = {
            conversation_id: conv.id,
            direction: 'out',
            meta_wamid: wamid,
            body: previewBody.slice(0, 1000),
            template_name: willSendAs === 'template' ? templateName : null,
            // template_variables reflecteert wat er ECHT naar Meta is gestuurd:
            // in mapping-mode 4 keys, in legacy-mode 5. usedVariables uit de
            // tpl-payload-helper heeft altijd de shape { '1': v, '2': v, ... }.
            template_variables: willSendAs === 'template' && tplPayload
              ? tplPayload.usedVariables
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

        // ── State-update dunning_workflow_runs: teller is al door de
        // atomic claim gezet met last_reminder_at=claimAtIso. Geen extra
        // update meer nodig; dat zou het risico op idempotentie-issues
        // introduceren als sentAt/claimAtIso microseconden verschillen.

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
