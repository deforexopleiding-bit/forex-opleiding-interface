// api/joost-autonomy-evaluate.js
// Joost E2.0 — autonomy decision engine.
//
// Doel:
//   Pure beslissingslaag bovenop een Joost-suggestie. Bepaalt of de suggestie
//   AUTONOMOUS verzonden mag worden, of dat hij doorgeschoven moet worden naar
//   een mens (task / escalatie / draft-flow) op basis van de autonomy_config-
//   blob + per-conversatie runtime-state.
//
// Architectuur:
//   * `evaluateAutonomy({...})` — pure function (geen DB, geen network). Krijgt
//     de volledige beslissingscontext mee en retourneert een gestructureerd
//     decision-object. Daardoor unit-testbaar zonder mocks en herbruikbaar voor
//     (a) de autonomy-cron, (b) de webhook-self-call, (c) een dry-run preview
//     in de admin-UI.
//   * `logAutonomyDecision({...})` — INSERT in audit_log met dezelfde shape als
//     de andere joost.* events (zie joost-suggest.js regel 632-654). Fail-soft.
//   * Default-export handler — POST endpoint dat de evaluator op een opgeslagen
//     suggestion draait (handig voor admin-debug / dry-run). Niet de hot-path:
//     de autonomy-cron roept evaluateAutonomy() rechtstreeks aan.
//
// Volgorde van checks (BELANGRIJK — eerste hit wint):
//   a. Confidence-check         -> BLOCKED_LOW_CONFIDENCE
//   b. Intent-mode-check        -> stop_action=escalation (intent disabled)
//   c. Office-hours-check       -> BLOCKED_OFFICE_HOURS
//   d. Rate-limit-checks        -> BLOCKED_RATE_LIMIT
//   e. Paused-check             -> BLOCKED_PAUSED
//   f. Mandate-check (arrangement_request)
//                                -> stop_action=task_create (te klein/te groot)
//                                   of BLOCKED_OUT_OF_MANDATE (buiten allowed_types)
//   g. Max-messages-per-conv per intent (arrangement_request)
//                                -> stop_action=task_create
//   h. Mode-check (draft vs autonomous)
//                                -> allow_autonomous=true / false
//
// Decision-object shape:
//   {
//     allow_autonomous: boolean,
//     blocked_reason:   string | null,        // BLOCKED_* discriminator
//     stop_action:      null | 'task_create' | 'escalation',
//     stop_task_type:   null | 'MANUAL_PROPOSE_ARRANGEMENT'
//                            | 'MANUAL_VERIFY_PAYMENT'
//                            | 'MANUAL_ESCALATION'
//                            | 'MANUAL_FOLLOWUP',
//     decision_log:     string[],             // human-readable trace
//     intent:           string,
//     confidence:       number,
//     mode:             string,               // intent-mode uit config
//   }
//
// ─────────────────────────────────────────────────────────────────────────────
// KEY-CONTRACT — autonomy_config (juli 2026, na fix/joost-config-key-mismatch)
// ─────────────────────────────────────────────────────────────────────────────
// De UI (modules/shared/finance-instellingen.js), de seed-migraties en
// runtime-migraties GEBRUIKEN EXACT DEZE KEYS. Afwijken (verkorte namen,
// synoniemen) → engine leest 'em niet → wijzigingen hebben geen effect.
// Voeg NIEUWE keys hier toe zodra ze in de engine of andere lezer landen.
//
// autonomy_config.communication_limits (met defaults als key ontbreekt):
//   max_messages_per_conversation_per_day    (int)      default 3      — dagcap; tijdelijk
//   max_messages_per_conversation_total      (int)      default 10     — total-cap; taak bij bereiken (via maybeCreateTotalCapTask)
//   cooldown_after_outbound_seconds          (int, sec) default 3600   — anti-burst tussen outbound
//   office_hours_only                        (bool)     default true
//   office_hours_tz                          (string)   default 'Europe/Amsterdam'
//   office_hours_days                        (int[])    default [1..5] (ma-vr)
//   office_hours_start                       (string)   default '08:30'
//   office_hours_end                         (string)   default '18:00'
//   no_reply_pause_threshold                 (int)      — futures
//   no_reply_pause_duration_hours            (int)      — futures
//
// DEFAULT-NO-DRIFT-REGEL: bovenstaande defaults MOETEN identiek blijven aan
// het pre-#765 gedrag zodat modules zonder expliciete config (bv. 'onboarding'
// dat helemaal geen communication_limits heeft) zich niet stilletjes anders
// gedragen. Alleen modules met een expliciete DB-waarde wijken af (bv.
// finance = 10/10/30s na 2026-07-15-joost-config-keys-canoniseren.sql). Bij
// het toevoegen van nieuwe defaults: check tegen de oude implementatie en
// documenteer expliciet als je een default bewust wijzigt (voor alle modules).
//
// autonomy_config.arrangement_mandate:
//   allowed_types                            (string[]) — UITSTEL/SPLITSING/…
//   min_total_amount_to_negotiate_eur        (number)
//   max_total_amount_to_auto_propose_eur     (number)
//   uitstel.{enabled, max_dagen_zonder_approval, max_dagen_total, auto_approve_if_within}
//   splitsing.{enabled, max_termijnen_zonder_approval, max_termijnen_total,
//              min_eerste_termijn_pct, auto_approve_if_within}
//   abonnement_pauze / abonnement_stop / kwijtschelding: {enabled, requires_human_approval}
//
// autonomy_config.no_reply (Joost fase 2 — gespreks-pauze reminder-cron):
//   reminder_1_hours         (int)      default 20  — uren na klant-inbound → reminder 1
//   reminder_2_hours         (int)      default 24  — uren na reminder 1     → reminder 2
//   resume_after_hours       (int)      default 24  — uren na reminder 2     → hervat run
//   reminder_2_template_name (string|null) — naam van approved Meta-template voor R2
//   Gelezen door: api/cron-dunning-conversation-reminders.js
//
// Legacy-keys die de engine NIET meer leest (blijven fallback in load-paden
// zolang de migratie 2026-07-15-joost-config-keys-canoniseren.sql niet is
// gedraaid): max_per_day, max_total, min_seconds_between,
// min_seconds_between_messages, cooldown_after_outbound_minutes (units-shift),
// max_messages_per_conv_per_day, max_messages_per_conv_total, office_start,
// office_end, min_to_negotiate, max_auto_propose, max_termijnen (top-level),
// max_uitstel_dagen (top-level). Verwijder na migratie.
// ─────────────────────────────────────────────────────────────────────────────

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { createNotification } from './_lib/notify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INTENT_TO_CONFIG_KEY = {
  payment_promise:     'ja_op_uitstel',
  verify_payment:      'al_betaald_claim',
  arrangement_request: 'tegenvoorstel_termijn',
  general_question:    'vraag_om_kopie_factuur',
  escalation_needed:   'boos_of_klacht',
  other:               null,
};

const ARRANGEMENT_INTENT_KEYS = new Set([
  'tegenvoorstel_termijn',
  'gespreid_betalen',
]);

const ALLOWED_MODES = new Set(['draft', 'autonomous', 'disabled']);

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

function num(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function nowMs() { return Date.now(); }

// ---------------------------------------------------------------------------
// Helper: office-hours check (TZ-aware via Intl.DateTimeFormat)
// ---------------------------------------------------------------------------
// Vercel-cron draait UTC; voor NL-office-hours (Europe/Amsterdam) doen we de
// venster-check in-code i.p.v. via cron-syntax. Voordeel: één schedule werkt
// zomer + winter zonder DST-shifts in vercel.json.
export function isWithinOfficeHours({ tz, days, startHHMM, endHHMM }, when = new Date()) {
  if (!tz || !startHHMM || !endHHMM) return true; // mis-config -> niet blokkeren
  try {
    // Lokale dag-of-week + lokale tijd in TZ.
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      hour:    '2-digit',
      minute:  '2-digit',
      hour12:  false,
    });
    const parts = fmt.formatToParts(when);
    const map = {};
    for (const p of parts) map[p.type] = p.value;

    // Map weekday -> ISO (1=ma .. 7=zo); fallback: zondag=0 (legacy).
    const wdMap = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
    const dow = wdMap[map.weekday] || 0;

    const allowedDays = Array.isArray(days) && days.length > 0 ? days : [1,2,3,4,5];
    if (!allowedDays.includes(dow)) return false;

    const hh = parseInt(map.hour || '0', 10);
    const mm = parseInt(map.minute || '0', 10);
    const cur = hh * 60 + mm;

    const [sh, sm] = String(startHHMM).split(':').map(s => parseInt(s, 10));
    const [eh, em] = String(endHHMM).split(':').map(s => parseInt(s, 10));
    const start = (Number.isFinite(sh) ? sh : 0) * 60 + (Number.isFinite(sm) ? sm : 0);
    const end   = (Number.isFinite(eh) ? eh : 23) * 60 + (Number.isFinite(em) ? em : 59);

    return cur >= start && cur <= end;
  } catch (_e) {
    // TZ-onbekend in Intl: niet blokkeren (fail-open).
    return true;
  }
}

// ---------------------------------------------------------------------------
// Core: evaluateAutonomy
// ---------------------------------------------------------------------------
/**
 * Pure beslissings-functie. Geen IO. Geeft een gestructureerd decision-object.
 *
 * @param {Object} args
 * @param {Object} args.suggestion         Joost-suggestie ({ detected_intent, confidence, ... })
 * @param {Object} args.conv_state         joost_conversation_state-rij (mag null/leeg zijn)
 * @param {Object} args.joost_config       joost_config-rij incl. autonomy_config + feature_flags
 * @param {Object} args.customer_context   { open_amount } voor arrangement-mandate
 * @param {Date}   [args.now]              Override voor tests (default new Date())
 * @returns {{
 *   allow_autonomous: boolean,
 *   blocked_reason:   string | null,
 *   stop_action:      null | 'task_create' | 'escalation',
 *   stop_task_type:   null | string,
 *   decision_log:     string[],
 *   intent:           string,
 *   confidence:       number,
 *   mode:             string,
 * }}
 */
export function evaluateAutonomy({
  suggestion,
  conv_state,
  joost_config,
  customer_context,
  now,
} = {}) {
  const log = [];
  const decision = {
    allow_autonomous: false,
    blocked_reason:   null,
    stop_action:      null,
    stop_task_type:   null,
    decision_log:     log,
    intent:           '',
    confidence:       0,
    mode:             'draft',
  };

  const nowDate = now instanceof Date ? now : new Date();

  // ---- 0. Basisvalidatie ----
  if (!suggestion || typeof suggestion !== 'object') {
    log.push('Geen suggestion meegegeven -> blokkeer.');
    decision.blocked_reason = 'BLOCKED_NO_SUGGESTION';
    return decision;
  }
  const autonomyCfg =
    (joost_config && joost_config.autonomy_config && typeof joost_config.autonomy_config === 'object')
      ? joost_config.autonomy_config
      : {};
  const intents          = autonomyCfg.intents          || {};
  const mandate          = autonomyCfg.arrangement_mandate || {};
  const commLimits       = autonomyCfg.communication_limits || {};
  const featureFlags     = (joost_config && joost_config.feature_flags) || {};

  const intent     = String(suggestion.detected_intent || 'other');
  const confidence = num(suggestion.confidence, 0);
  decision.intent     = intent;
  decision.confidence = confidence;

  log.push(`Start evaluatie: intent="${intent}" confidence=${confidence.toFixed(2)}`);

  const intentKey = INTENT_TO_CONFIG_KEY[intent] || null;
  const intentCfg = intentKey && intents[intentKey] ? intents[intentKey] : null;
  if (intentCfg) {
    log.push(`Intent mapt naar config-key "${intentKey}".`);
  } else {
    log.push(`Intent "${intent}" heeft geen autonomy-config -> escalation default.`);
  }

  // Bepaal effectieve mode. Volgorde: intentCfg.mode -> 'draft' default.
  // Een intent zonder enabled=true wordt behandeld als 'disabled'.
  let mode = 'draft';
  if (intentCfg) {
    if (intentCfg.enabled === false) {
      mode = 'disabled';
    } else if (typeof intentCfg.mode === 'string' && ALLOWED_MODES.has(intentCfg.mode)) {
      mode = intentCfg.mode;
    } else {
      // Geen expliciete mode in seed (E2.0). Default = draft tenzij de globale
      // feature-flag e2_auto_send_text aan staat EN intent enabled is.
      mode = featureFlags.e2_auto_send_text === true ? 'autonomous' : 'draft';
    }
  } else {
    mode = 'draft';
  }
  decision.mode = mode;
  log.push(`Effectieve mode: ${mode}`);

  // ---- a. Confidence-check ----
  const minConfidence = num(
    intentCfg && intentCfg.min_confidence != null ? intentCfg.min_confidence : 0.85,
    0.85
  );
  if (confidence < minConfidence) {
    log.push(`Confidence ${confidence.toFixed(2)} < drempel ${minConfidence.toFixed(2)} -> BLOCKED_LOW_CONFIDENCE.`);
    decision.blocked_reason = 'BLOCKED_LOW_CONFIDENCE';
    return decision;
  }
  log.push(`Confidence-check ok (>= ${minConfidence.toFixed(2)}).`);

  // ---- b. Intent-mode-check ----
  if (mode === 'disabled' || !intentCfg) {
    log.push('Intent is disabled of niet geconfigureerd -> escaleer naar mens.');
    decision.stop_action    = 'escalation';
    decision.stop_task_type = 'MANUAL_ESCALATION';
    return decision;
  }

  // ---- c. Office-hours-check ----
  const officeHoursOnly = commLimits.office_hours_only !== false;
  if (officeHoursOnly) {
    const within = isWithinOfficeHours(
      {
        tz:        commLimits.office_hours_tz   || 'Europe/Amsterdam',
        days:      commLimits.office_hours_days || [1, 2, 3, 4, 5],
        startHHMM: commLimits.office_hours_start || '08:30',
        endHHMM:   commLimits.office_hours_end   || '18:00',
      },
      nowDate,
    );
    if (!within) {
      log.push('Buiten office-hours -> BLOCKED_OFFICE_HOURS.');
      decision.blocked_reason = 'BLOCKED_OFFICE_HOURS';
      return decision;
    }
    log.push('Office-hours-check ok.');
  } else {
    log.push('Office-hours-check uit (24/7).');
  }

  // ---- d. Rate-limit-checks ----
  // NOTE: max_messages_per_conversation_total default verlaagd van 20 -> 10
  // (Joost-integratie fase 1). Bestaande joost_config-rijen in productie
  // krijgen 10 via migratie 2026-07-15-joost-fase1-cap-verlagen.sql. Deze
  // code-default vangt alleen NIEUWE rijen zonder deze key af.
  const maxPerDay = num(commLimits.max_messages_per_conversation_per_day, 3);
  const maxTotal  = num(commLimits.max_messages_per_conversation_total, 10);
  // Cooldown: canonical eenheid is SECONDEN. Fallback-ladder voor rijen die
  // nog niet door migratie 2026-07-15-joost-config-keys-canoniseren zijn:
  //   1) cooldown_after_outbound_seconds   (canonical)
  //   2) cooldown_after_outbound_minutes   (interim, *60)
  //   3) min_seconds_between               (UI-legacy, seconden)
  //   4) min_seconds_between_messages      (seed-legacy, seconden)
  //   5) default 3600 seconden (= 60 minuten, matcht pre-#765 gedrag)
  // Default DEFAULT_COOLDOWN_SECONDS = 3600: modules zonder expliciete cooldown-
  // key gedragen zich EXACT als voorheen (was cooldown_after_outbound_minutes
  // default 60 -> 3600 sec). Alleen modules met een expliciete waarde in DB
  // wijken af (finance = 30s na migratie — bewuste keuze Jeffrey).
  let cooldownSec = null;
  if (commLimits.cooldown_after_outbound_seconds != null) {
    cooldownSec = num(commLimits.cooldown_after_outbound_seconds, null);
  } else if (commLimits.cooldown_after_outbound_minutes != null) {
    const cooldownMin = num(commLimits.cooldown_after_outbound_minutes, null);
    if (cooldownMin != null) cooldownSec = cooldownMin * 60;
  } else if (commLimits.min_seconds_between != null) {
    cooldownSec = num(commLimits.min_seconds_between, null);
  } else if (commLimits.min_seconds_between_messages != null) {
    cooldownSec = num(commLimits.min_seconds_between_messages, null);
  }
  if (cooldownSec == null) cooldownSec = 3600;
  const cooldownMs = cooldownSec * 1000;

  const state = conv_state || {};
  const sentToday = num(state.messages_sent_today, 0);
  const sentTotal = num(state.messages_sent_total, 0);
  const lastSentAt = state.last_message_sent_at
    ? new Date(state.last_message_sent_at).getTime()
    : 0;

  // rate_limit_reason (additive, backwards-compatible): sub-discriminator zodat
  // callers (logAutonomyDecision) kunnen onderscheiden waarom er geblokkeerd
  // wordt — total-cap = permanent (menselijke overname nodig), day-cap +
  // cooldown = tijdelijk (morgen weer). Bestaande callers negeren dit veld.
  if (sentToday >= maxPerDay) {
    log.push(`messages_sent_today (${sentToday}) >= max_per_day (${maxPerDay}) -> BLOCKED_RATE_LIMIT.`);
    decision.blocked_reason = 'BLOCKED_RATE_LIMIT';
    decision.rate_limit_reason = 'day';
    return decision;
  }
  if (sentTotal >= maxTotal) {
    log.push(`messages_sent_total (${sentTotal}) >= max_total (${maxTotal}) -> BLOCKED_RATE_LIMIT.`);
    decision.blocked_reason = 'BLOCKED_RATE_LIMIT';
    decision.rate_limit_reason = 'total';
    return decision;
  }
  if (lastSentAt && cooldownMs > 0) {
    const elapsed = nowDate.getTime() - lastSentAt;
    if (elapsed < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - elapsed) / 1000);
      log.push(`Cooldown actief (nog ${waitSec}s te wachten) -> BLOCKED_RATE_LIMIT.`);
      decision.blocked_reason = 'BLOCKED_RATE_LIMIT';
      decision.rate_limit_reason = 'cooldown';
      return decision;
    }
  }
  log.push(`Rate-limit ok (today=${sentToday}/${maxPerDay}, total=${sentTotal}/${maxTotal}, cooldown=${cooldownSec}s).`);

  // ---- e. Paused-check ----
  const pausedUntil = state.autonomy_paused_until
    ? new Date(state.autonomy_paused_until).getTime()
    : 0;
  if (pausedUntil && pausedUntil >= nowDate.getTime()) {
    const remainingMin = Math.ceil((pausedUntil - nowDate.getTime()) / 60000);
    log.push(`Autonomy gepauzeerd tot ${state.autonomy_paused_until} (nog ${remainingMin}m, reden=${state.autonomy_paused_reason || 'unspecified'}) -> BLOCKED_PAUSED.`);
    decision.blocked_reason = 'BLOCKED_PAUSED';
    return decision;
  }
  log.push('Paused-check ok.');

  // ---- f. Mandate-check (alleen arrangement-intents) ----
  const isArrangementIntent = ARRANGEMENT_INTENT_KEYS.has(intentKey);
  if (isArrangementIntent) {
    const openAmount = num(customer_context && customer_context.open_amount, 0);
    const minNegotiate = num(mandate.min_total_amount_to_negotiate_eur, 0);
    const maxAutoPropose = num(
      mandate.max_total_amount_to_auto_propose_eur != null
        ? mandate.max_total_amount_to_auto_propose_eur
        : Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );

    if (minNegotiate > 0 && openAmount < minNegotiate) {
      log.push(`open_amount (EUR ${openAmount.toFixed(2)}) < min_total_amount_to_negotiate (EUR ${minNegotiate.toFixed(2)}) -> task_create MANUAL_PROPOSE_ARRANGEMENT.`);
      decision.stop_action    = 'task_create';
      decision.stop_task_type = 'MANUAL_PROPOSE_ARRANGEMENT';
      return decision;
    }
    if (Number.isFinite(maxAutoPropose) && openAmount > maxAutoPropose) {
      log.push(`open_amount (EUR ${openAmount.toFixed(2)}) > max_total_amount_to_auto_propose (EUR ${maxAutoPropose.toFixed(2)}) -> task_create MANUAL_PROPOSE_ARRANGEMENT.`);
      decision.stop_action    = 'task_create';
      decision.stop_task_type = 'MANUAL_PROPOSE_ARRANGEMENT';
      return decision;
    }

    // Allowed-types / sub-mandate. Voor gespreid_betalen: max_termijnen-cap.
    const allowedTypes = Array.isArray(mandate.allowed_types) ? mandate.allowed_types : null;
    if (allowedTypes && allowedTypes.length > 0) {
      const proposalType = intentKey === 'gespreid_betalen' ? 'SPLITSING' : 'UITSTEL';
      if (!allowedTypes.includes(proposalType)) {
        log.push(`Voorstel-type ${proposalType} niet in allowed_types (${allowedTypes.join(', ')}) -> BLOCKED_OUT_OF_MANDATE.`);
        decision.blocked_reason = 'BLOCKED_OUT_OF_MANDATE';
        decision.stop_action    = 'task_create';
        decision.stop_task_type = 'MANUAL_PROPOSE_ARRANGEMENT';
        return decision;
      }
    }

    if (intentKey === 'tegenvoorstel_termijn') {
      const requestedDagen = num(suggestion.proposal_uitstel_dagen, 0);
      const maxUitstelDagen = num(
        intentCfg.max_termijn_dagen
        || (mandate.uitstel && mandate.uitstel.max_dagen_zonder_approval)
        || (mandate.uitstel && mandate.uitstel.max_dagen_total),
        0,
      );
      if (requestedDagen > 0 && maxUitstelDagen > 0 && requestedDagen > maxUitstelDagen) {
        log.push(`Voorgesteld uitstel (${requestedDagen}d) > max_uitstel_dagen (${maxUitstelDagen}d) -> BLOCKED_OUT_OF_MANDATE.`);
        decision.blocked_reason = 'BLOCKED_OUT_OF_MANDATE';
        decision.stop_action    = 'task_create';
        decision.stop_task_type = 'MANUAL_PROPOSE_ARRANGEMENT';
        return decision;
      }
    }
    if (intentKey === 'gespreid_betalen') {
      const requestedTermijnen = num(suggestion.proposal_termijnen, 0);
      const maxTermijnen = num(
        intentCfg.max_termijnen
        || (mandate.splitsing && mandate.splitsing.max_termijnen_zonder_approval)
        || (mandate.splitsing && mandate.splitsing.max_termijnen_total),
        0,
      );
      if (requestedTermijnen > 0 && maxTermijnen > 0 && requestedTermijnen > maxTermijnen) {
        log.push(`Voorgestelde termijnen (${requestedTermijnen}) > max_termijnen (${maxTermijnen}) -> BLOCKED_OUT_OF_MANDATE.`);
        decision.blocked_reason = 'BLOCKED_OUT_OF_MANDATE';
        decision.stop_action    = 'task_create';
        decision.stop_task_type = 'MANUAL_PROPOSE_ARRANGEMENT';
        return decision;
      }
    }
    log.push('Mandate-check ok (binnen bedrags- + type- + sub-cap-grenzen).');
  }

  // ---- g. Max-messages-per-conv per intent (arrangement-intents) ----
  if (isArrangementIntent) {
    const intentMaxPerConv = num(intentCfg.max_messages_per_conv, 0);
    if (intentMaxPerConv > 0 && sentTotal >= intentMaxPerConv) {
      log.push(`messages_sent_total (${sentTotal}) >= intent.max_messages_per_conv (${intentMaxPerConv}) -> task_create MANUAL_PROPOSE_ARRANGEMENT.`);
      decision.stop_action    = 'task_create';
      decision.stop_task_type = 'MANUAL_PROPOSE_ARRANGEMENT';
      return decision;
    }
  }

  // ---- h. Mode-check (draft vs autonomous) ----
  if (mode === 'autonomous') {
    decision.allow_autonomous = true;
    log.push('Alle checks gepasseerd + mode=autonomous -> allow_autonomous=true.');
  } else {
    decision.allow_autonomous = false;
    log.push('Alle checks gepasseerd maar mode=draft -> allow_autonomous=false (mens beslist).');
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Audit-log helper
// ---------------------------------------------------------------------------
/**
 * Schrijft een audit_log-rij voor een autonomy-decision. Fail-soft.
 *
 * @param {Object} args
 * @param {Object} args.supabaseAdmin       Service-role client.
 * @param {string} args.conv_id             whatsapp_conversations.id (uuid).
 * @param {string|null} args.suggestion_id  joost_suggestions.id.
 * @param {Object} args.decision            evaluateAutonomy()-output.
 * @param {string|null} [args.user_id]      Triggering user (null bij cron).
 * @param {string|null} [args.ip_address]   Client-IP (null bij cron).
 * @param {string|null} [args.triggered_by] Vrije tekst: 'autonomy_cron' | 'admin_dryrun' | 'webhook'.
 */
export async function logAutonomyDecision({
  supabaseAdmin: admin,
  conv_id,
  suggestion_id,
  decision,
  user_id,
  ip_address,
  triggered_by,
} = {}) {
  if (!admin || !decision) return;
  try {
    await admin.from('audit_log').insert({
      user_id:     user_id || null,
      action:      'joost.autonomy_decision',
      entity_type: 'whatsapp_conversation',
      entity_id:   conv_id || null,
      after_json: {
        suggestion_id:    suggestion_id || null,
        intent:           decision.intent || null,
        confidence:       decision.confidence,
        mode:             decision.mode || null,
        allow_autonomous: !!decision.allow_autonomous,
        blocked_reason:   decision.blocked_reason || null,
        stop_action:      decision.stop_action || null,
        stop_task_type:   decision.stop_task_type || null,
        decision_log:     Array.isArray(decision.decision_log) ? decision.decision_log : [],
        triggered_by:     triggered_by || 'joost-autonomy-eval',
      },
      reason_text: decision.blocked_reason
        || (decision.stop_action ? `stop_action=${decision.stop_action}` : null)
        || (decision.allow_autonomous ? 'autonomous_send_allowed' : 'draft_only'),
      ip_address: ip_address || null,
    });
  } catch (e) {
    console.error('[joost-autonomy-eval audit]', e && e.message);
  }
  // Fail-soft dual-write: bij een echte escalatie (stop_action='escalation')
  // in een PRODUCTIE-run (niet admin_dryrun) → notify management. Throttle
  // 10 min per conversatie tegen back-to-back berichten.
  try {
    if (decision.stop_action === 'escalation' && triggered_by && triggered_by !== 'admin_dryrun' && conv_id) {
      let convLabel = null;
      try {
        const { data: conv } = await admin
          .from('whatsapp_conversations')
          .select('display_name, phone_number')
          .eq('id', conv_id)
          .maybeSingle();
        convLabel = conv?.display_name || conv?.phone_number || null;
      } catch (_) { /* fail-soft */ }
      createNotification({
        toRole:        ['manager', 'super_admin'],
        type:          'agent.escalation',
        title:         'Agent-escalatie · ' + (convLabel || 'onbekende conversatie'),
        body:          'Menselijke actie nodig',
        linkUrl:       '/modules/finance.html',
        entityType:    'conversation',
        entityId:      conv_id,
        dedupWithinMs: 10 * 60 * 1000,
      }).catch(() => {});
    }
  } catch (_) { /* fail-soft */ }

  // ─── Fase 1: TOTAL-CAP → maak een MANUAL_FOLLOWUP-taak aan ─────────
  // Bij BLOCKED_RATE_LIMIT met rate_limit_reason='total' heeft Joost de
  // permanente cap bereikt zonder resultaat → mens moet overnemen. We
  // maken één taak per conversatie per cap-bereik (idempotent: check
  // bestaande PENDING/APPROVED taak met payload.source='joost_total_cap'
  // voor dezelfde conversation_id — als er al eentje ligt, geen nieuwe).
  //
  // NIET voor rate_limit_reason='day' of 'cooldown' (die zijn tijdelijk),
  // en niet voor admin_dryrun (dan alleen loggen).
  //
  // Fail-soft: bij lookup- of insert-fout logt de helper een warning en
  // gaat door — autonomy-evaluatie mag nooit klappen door taak-creatie.
  try {
    if (decision.blocked_reason === 'BLOCKED_RATE_LIMIT'
        && decision.rate_limit_reason === 'total'
        && triggered_by
        && triggered_by !== 'admin_dryrun'
        && conv_id) {
      await maybeCreateTotalCapTask({
        supabaseAdmin: admin,
        conv_id,
        decision,
        triggered_by,
      });
    }
  } catch (_) { /* fail-soft */ }
}

/**
 * Idempotente cap-taak-creator. Maakt maximaal één MANUAL_FOLLOWUP-taak per
 * conversatie zolang de vorige nog PENDING/APPROVED is. Fail-soft.
 *
 * De taak verschijnt automatisch in Open Acties (Finance > Wanbetalers) en
 * telt mee in navFinanceTasksBadge (sidebar.js updateFinanceTasksBadge, via
 * /api/tasks-list?status=PENDING,APPROVED). Geen tweede meldingssysteem.
 */
export async function maybeCreateTotalCapTask({ supabaseAdmin: admin, conv_id, decision, triggered_by }) {
  // Conversation + klant ophalen (voor customer_id + label in taak-titel).
  let conv = null;
  try {
    const { data, error } = await admin
      .from('whatsapp_conversations')
      .select('id, customer_id, phone_number, display_name')
      .eq('id', conv_id)
      .maybeSingle();
    if (error) {
      console.warn('[joost-autonomy total-cap] conv lookup fail:', error.message);
      return;
    }
    conv = data;
  } catch (e) {
    console.warn('[joost-autonomy total-cap] conv exception:', e?.message);
    return;
  }
  if (!conv) return;

  const customerId = conv.customer_id || null;
  if (!customerId) {
    // Zonder customer_id kan pending_actions niet inserten (customer_id NOT NULL).
    console.warn('[joost-autonomy total-cap] conv zonder customer_id → skip taak', conv_id);
    return;
  }

  // Idempotency: bestaat er al een open cap-taak voor deze conv?
  // Check via payload->>'source' + payload->>'conversation_id'.
  try {
    const { data: existing, error: exErr } = await admin
      .from('pending_actions')
      .select('id')
      .eq('customer_id', customerId)
      .eq('action_type', 'MANUAL_FOLLOWUP')
      .in('status', ['PENDING', 'APPROVED'])
      .filter('payload->>source', 'eq', 'joost_total_cap')
      .filter('payload->>conversation_id', 'eq', conv_id)
      .limit(1);
    if (exErr) {
      console.warn('[joost-autonomy total-cap] idempotency check fail:', exErr.message);
      // Geen return: bij twijfel liever niet inserten om duplicates te
      // voorkomen. Alternatief zou zijn wél inserten en op unique-index
      // vertrouwen, maar die bestaat niet — dus veiliger om te stoppen.
      return;
    }
    if (Array.isArray(existing) && existing.length > 0) {
      // Al een open cap-taak → skip.
      return;
    }
  } catch (e) {
    console.warn('[joost-autonomy total-cap] idempotency exception:', e?.message);
    return;
  }

  // Bepaal klant-label voor de titel.
  const convLabel = conv.display_name || conv.phone_number || 'klant';
  const capLine = Array.isArray(decision?.decision_log)
    ? decision.decision_log.find((l) => typeof l === 'string' && l.includes('max_total'))
    : null;

  const title = `Joost heeft cap van berichten bereikt bij ${convLabel} - neem handmatig over`;
  const description = [
    `Joost heeft het maximum aantal WhatsApp-berichten in deze conversatie bereikt zonder respons van de klant.`,
    ``,
    `Klant: ${convLabel}`,
    conv.phone_number ? `Telefoon: ${conv.phone_number}` : null,
    ``,
    `Overweeg:`,
    `- Bellen (misschien is WhatsApp niet het juiste kanaal)`,
    `- Aangetekende brief (dag 21 in workflow)`,
    `- Overdragen naar incasso`,
    ``,
    capLine ? `Trigger: ${capLine}` : null,
    `Getriggerd door: ${triggered_by}`,
  ].filter(Boolean).join('\n');

  const insertRow = {
    customer_id:         customerId,
    arrangement_id:      null,
    invoice_id:          null,
    action_type:         'MANUAL_FOLLOWUP',
    status:              'PENDING',
    proposed_by_user_id: null,
    payload: {
      title,
      description,
      assignee_role:   'manager',
      source:          'joost_total_cap',
      conversation_id: conv_id,
      customer_id:     customerId,
      triggered_by,
      rate_limit_reason: 'total',
      rationale:       'Joost bereikte max_messages_per_conversation_total zonder klant-respons',
    },
  };

  try {
    const { error: insErr } = await admin
      .from('pending_actions')
      .insert(insertRow);
    if (insErr) {
      console.warn('[joost-autonomy total-cap] insert fail:', insErr.message);
    }
  } catch (e) {
    console.warn('[joost-autonomy total-cap] insert exception:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler: POST /api/joost-autonomy-evaluate
// ---------------------------------------------------------------------------
// Body: { suggestion_id: uuid, dry_run?: boolean (default true) }
//
// Dry-run pad: leest de suggestion + conv_state + joost_config + customer-
// context uit DB, draait evaluateAutonomy(), retourneert het beslissings-
// object. Schrijft GEEN suggestion-status; schrijft WEL audit_log
// (triggered_by='admin_dryrun') zodat admins beslissingen achteraf kunnen
// inspecteren via decisions-list.
//
// Voor de hot-path (autonomy-cron / webhook) wordt evaluateAutonomy() direct
// uit deze module geimporteerd zonder via HTTP te gaan.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Permission: finance.joost.use of admin.joost_autonomy (OR).
  const canUse = await requirePermission(req, 'finance.joost.use');
  const canAdmin = canUse ? true : await requirePermission(req, 'admin.joost_autonomy');
  if (!canUse && !canAdmin) {
    return res.status(403).json({ error: 'Geen rechten (finance.joost.use of admin.joost_autonomy)' });
  }

  const body = req.body || {};
  const suggestionId = typeof body.suggestion_id === 'string' ? body.suggestion_id.trim() : '';
  if (!suggestionId) return res.status(400).json({ error: 'suggestion_id vereist' });
  if (!isUuid(suggestionId)) return res.status(400).json({ error: 'suggestion_id moet geldige uuid zijn' });

  try {
    // ---- Suggestion ophalen ----
    const { data: sugg, error: suggErr } = await supabaseAdmin
      .from('joost_suggestions')
      .select(
        'id, conversation_id, module, suggested_reply, detected_intent, ' +
        'confidence, reasoning, status, context_snapshot, created_at',
      )
      .eq('id', suggestionId)
      .maybeSingle();
    if (suggErr) throw new Error('joost_suggestions lookup: ' + suggErr.message);
    if (!sugg) return res.status(404).json({ error: 'Suggestion niet gevonden' });

    const convId = sugg.conversation_id;
    if (!convId) return res.status(400).json({ error: 'Suggestion heeft geen conversation_id (orphan)' });

    // ---- Conversation + customer ----
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, phone_number_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('whatsapp_conversations lookup: ' + convErr.message);

    // ---- Conversation-state (mag leeg zijn — dan defaults) ----
    const { data: convState, error: stateErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .select(
        'messages_sent_today, messages_sent_today_date, messages_sent_total, ' +
        'last_message_sent_at, autonomy_paused_until, autonomy_paused_reason, ' +
        'no_reply_streak_count',
      )
      .eq('conversation_id', convId)
      .maybeSingle();
    if (stateErr) throw new Error('joost_conversation_state lookup: ' + stateErr.message);

    // ---- joost_config (autonomy_config + feature_flags) ----
    const moduleKey = sugg.module || 'finance';
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, autonomy_config, feature_flags, is_enabled')
      .eq('module', moduleKey)
      .maybeSingle();
    if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);
    if (!cfg) return res.status(503).json({ error: `joost_config ontbreekt voor module=${moduleKey}` });

    // ---- Customer-context (open_amount) ----
    // Som van openstaande facturen van de klant. Indien geen klant -> 0.
    let openAmount = 0;
    if (conv && conv.customer_id) {
      const { data: invs, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('amount_total, amount_paid, credited_amount, status')
        .eq('customer_id', conv.customer_id)
        .in('status', ['open', 'partially_paid', 'overdue']);
      if (invErr) {
        console.error('[joost-autonomy-evaluate] invoices lookup:', invErr.message);
      } else if (Array.isArray(invs)) {
        for (const inv of invs) {
          // Openstaand = amount_total − amount_paid − credited_amount
          // (kolom amount_open bestaat niet in de invoices-tabel).
          const total = Number(inv.amount_total) || 0;
          const paid  = Number(inv.amount_paid)  || 0;
          const cred  = Number(inv.credited_amount) || 0;
          const v = Math.round(Math.max(0, total - paid - cred) * 100) / 100;
          if (Number.isFinite(v)) openAmount += v;
        }
      }
    }

    // ---- Evaluatie ----
    const decision = evaluateAutonomy({
      suggestion:       sugg,
      conv_state:       convState || null,
      joost_config:     cfg,
      customer_context: { open_amount: openAmount },
      now:              new Date(),
    });

    // ---- Audit (fail-soft) ----
    await logAutonomyDecision({
      supabaseAdmin,
      conv_id:       convId,
      suggestion_id: suggestionId,
      decision,
      user_id:       user.id,
      ip_address:    getClientIp(req),
      triggered_by:  'admin_dryrun',
    });

    return res.status(200).json({
      decision,
      suggestion: {
        id:              sugg.id,
        conversation_id: sugg.conversation_id,
        detected_intent: sugg.detected_intent,
        confidence:      sugg.confidence,
        status:          sugg.status,
      },
      customer_context: { open_amount: openAmount },
    });
  } catch (e) {
    console.error('[joost-autonomy-evaluate]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
