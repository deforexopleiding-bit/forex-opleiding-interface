// api/simone-autonomy-evaluate.js
// Simone (events-agent) — autonomy decision engine.
//
// Spiegel van api/joost-autonomy-evaluate.js, events-gekleurd:
//   * Events-intents (event_info, date_location, registration_intent,
//     cancel_or_reschedule, logistics, escalation_needed, general_question,
//     other). Geen finance-mandate / arrangement-logica.
//   * cancel_or_reschedule en escalation_needed: ALTIJD stop_action='escalation',
//     ongeacht confidence/mode. Veiligheidsklep — een schrappende of boze
//     deelnemer mag NOOIT autonoom worden afgehandeld.
//
// Architectuur identiek aan Joost:
//   * `evaluateSimoneAutonomy({...})` — pure function (geen DB/IO).
//   * `logSimoneAutonomyDecision({...})` — audit_log insert, fail-soft.
//   * Default-export handler — POST dry-run endpoint (admin debug).
//
// Volgorde van checks (eerste hit wint):
//   a. Confidence-check         -> BLOCKED_LOW_CONFIDENCE
//   b. Intent-mode-check        -> stop_action=escalation (disabled intent
//                                  of cancel_or_reschedule/escalation_needed)
//   c. Office-hours-check       -> BLOCKED_OFFICE_HOURS
//   d. Rate-limit-checks        -> BLOCKED_RATE_LIMIT
//   e. No-reply-pauze           -> BLOCKED_NO_REPLY_PAUSE
//   f. Handmatige pauze         -> BLOCKED_PAUSED
//   g. 24h-window               -> BLOCKED_24H_WINDOW_EXPIRED
//   h. Mode-check               -> allow_autonomous = (mode === 'autonomous')
//
// Decision-object shape (identiek aan Joost):
//   {
//     allow_autonomous: boolean,
//     blocked_reason:   string | null,
//     stop_action:      null | 'task_create' | 'escalation',
//     stop_task_type:   null | string,
//     decision_log:     string[],
//     intent:           string,
//     confidence:       number,
//     mode:             string,   // 'autonomous' | 'draft' | 'disabled'
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const ALLOWED_MODES = new Set(['autonomous', 'draft', 'disabled']);

// Intents die ALTIJD naar een mens moeten — onafhankelijk van confidence/mode.
// cancel_or_reschedule = klant wil annuleren of verzetten → menselijk oordeel.
// escalation_needed    = klant is boos / juridisch / klacht → menselijk oordeel.
const ALWAYS_ESCALATE_INTENTS = new Set([
  'cancel_or_reschedule',
  'escalation_needed',
]);

// Bekende intents — alles wat hier niet in staat valt impliciet onder 'other'
// (= disabled mode by default, escalation_needed).
const KNOWN_EVENT_INTENTS = new Set([
  'event_info',
  'date_location',
  'registration_intent',
  'cancel_or_reschedule',
  'logistics',
  'escalation_needed',
  'general_question',
  'other',
]);

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

function num(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

// ---------------------------------------------------------------------------
// Office-hours check (TZ-aware via Intl.DateTimeFormat). 1-op-1 zoals Joost.
// ---------------------------------------------------------------------------
function isWithinOfficeHours({ tz, days, startHHMM, endHHMM }, when = new Date()) {
  if (!tz || !startHHMM || !endHHMM) return true; // mis-config → niet blokkeren
  try {
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

    const wdMap = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
    const dow = wdMap[map.weekday] || 0;

    const allowedDays = Array.isArray(days) && days.length > 0 ? days : [1,2,3,4,5];
    if (!allowedDays.includes(dow)) return false;

    const hh = parseInt(map.hour || '0', 10);
    const mm = parseInt(map.minute || '0', 10);
    const cur = hh * 60 + mm;

    const [sh, sm] = String(startHHMM).split(':').map((s) => parseInt(s, 10));
    const [eh, em] = String(endHHMM).split(':').map((s) => parseInt(s, 10));
    const start = (Number.isFinite(sh) ? sh : 0) * 60 + (Number.isFinite(sm) ? sm : 0);
    const end   = (Number.isFinite(eh) ? eh : 23) * 60 + (Number.isFinite(em) ? em : 59);

    return cur >= start && cur <= end;
  } catch (_e) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Core: evaluateSimoneAutonomy
// ---------------------------------------------------------------------------
/**
 * Pure beslissings-functie voor Simone (events-agent). Geen IO. Geeft een
 * gestructureerd decision-object.
 *
 * @param {Object} args
 * @param {Object} args.suggestion   { detected_intent, confidence, ... }
 * @param {Object} args.convState    joost_conversation_state-rij (mag null/leeg zijn)
 * @param {Object} args.cfg          joost_config-rij voor module='events' (incl.
 *                                    autonomy_config + feature_flags)
 * @param {Date}   [args.now]
 */
export function evaluateSimoneAutonomy({
  suggestion,
  convState,
  cfg,
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

  if (!suggestion || typeof suggestion !== 'object') {
    log.push('Geen suggestion meegegeven → blokkeer.');
    decision.blocked_reason = 'BLOCKED_NO_SUGGESTION';
    return decision;
  }

  const autonomyCfg =
    (cfg && cfg.autonomy_config && typeof cfg.autonomy_config === 'object')
      ? cfg.autonomy_config
      : {};
  const intents    = (autonomyCfg.intents && typeof autonomyCfg.intents === 'object')
    ? autonomyCfg.intents : {};
  const commLimits = (autonomyCfg.communication_limits && typeof autonomyCfg.communication_limits === 'object')
    ? autonomyCfg.communication_limits : {};

  const intentRaw  = String(suggestion.detected_intent || 'other');
  const intent     = KNOWN_EVENT_INTENTS.has(intentRaw) ? intentRaw : 'other';
  const confidence = num(suggestion.confidence, 0);
  decision.intent     = intent;
  decision.confidence = confidence;

  log.push(`Start evaluatie: intent="${intent}" confidence=${confidence.toFixed(2)}`);

  // ---- Hard escalate voor cancel_or_reschedule + escalation_needed ----
  // BEWUST vóór alle andere checks: ongeacht confidence/mode/office-hours.
  if (ALWAYS_ESCALATE_INTENTS.has(intent)) {
    log.push(`Intent "${intent}" is altijd-mens (hard escalate).`);
    decision.mode           = 'disabled';
    decision.stop_action    = 'escalation';
    decision.stop_task_type = 'MANUAL_ESCALATION';
    return decision;
  }

  // ---- Intent-config + effectieve mode ----
  const intentCfg = intents[intent] || null;
  let mode = 'draft';
  if (intentCfg) {
    if (intentCfg.enabled === false) {
      mode = 'disabled';
    } else if (typeof intentCfg.mode === 'string' && ALLOWED_MODES.has(intentCfg.mode)) {
      mode = intentCfg.mode;
    } else {
      mode = 'draft';
    }
  } else {
    log.push(`Intent "${intent}" heeft geen autonomy-config → draft default.`);
  }
  decision.mode = mode;
  log.push(`Effectieve mode: ${mode}`);

  // ---- a. Confidence-check ----
  const minConfidence = num(
    intentCfg && intentCfg.min_confidence != null ? intentCfg.min_confidence : 0.85,
    0.85,
  );
  if (confidence < minConfidence) {
    log.push(`Confidence ${confidence.toFixed(2)} < drempel ${minConfidence.toFixed(2)} → BLOCKED_LOW_CONFIDENCE.`);
    decision.blocked_reason = 'BLOCKED_LOW_CONFIDENCE';
    return decision;
  }
  log.push(`Confidence-check ok (>= ${minConfidence.toFixed(2)}).`);

  // ---- b. Intent-mode-check ----
  if (mode === 'disabled' || !intentCfg) {
    log.push('Intent is disabled of niet geconfigureerd → escaleer naar mens.');
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
        endHHMM:   commLimits.office_hours_end   || '21:00',
      },
      nowDate,
    );
    if (!within) {
      log.push('Buiten office-hours → BLOCKED_OFFICE_HOURS.');
      decision.blocked_reason = 'BLOCKED_OFFICE_HOURS';
      return decision;
    }
    log.push('Office-hours-check ok.');
  } else {
    log.push('Office-hours-check uit (24/7).');
  }

  // ---- d. Rate-limit-checks ----
  const maxPerDay   = num(commLimits.max_messages_per_conversation_per_day, 3);
  const maxTotal    = num(commLimits.max_messages_per_conversation_total, 20);
  const cooldownMin = num(commLimits.cooldown_after_outbound_minutes, 30);
  const cooldownMs  = cooldownMin * 60 * 1000;

  const state = convState || {};
  const sentToday = num(state.messages_sent_today, 0);
  const sentTotal = num(state.messages_sent_total, 0);
  const lastSentAt = state.last_message_sent_at
    ? new Date(state.last_message_sent_at).getTime()
    : 0;

  if (sentToday >= maxPerDay) {
    log.push(`messages_sent_today (${sentToday}) >= max_per_day (${maxPerDay}) → BLOCKED_RATE_LIMIT.`);
    decision.blocked_reason = 'BLOCKED_RATE_LIMIT';
    return decision;
  }
  if (sentTotal >= maxTotal) {
    log.push(`messages_sent_total (${sentTotal}) >= max_total (${maxTotal}) → BLOCKED_RATE_LIMIT.`);
    decision.blocked_reason = 'BLOCKED_RATE_LIMIT';
    return decision;
  }
  if (lastSentAt && cooldownMs > 0) {
    const elapsed = nowDate.getTime() - lastSentAt;
    if (elapsed < cooldownMs) {
      const waitMin = Math.ceil((cooldownMs - elapsed) / 60000);
      log.push(`Cooldown actief (nog ${waitMin}m te wachten) → BLOCKED_RATE_LIMIT.`);
      decision.blocked_reason = 'BLOCKED_RATE_LIMIT';
      return decision;
    }
  }
  log.push(`Rate-limit ok (today=${sentToday}/${maxPerDay}, total=${sentTotal}/${maxTotal}, cooldown=${cooldownMin}m).`);

  // ---- e. No-reply-pauze ----
  // Als deelnemer X keer niet heeft geantwoord op Simone's autonome berichten,
  // pauzeren we tijdelijk om niet door te zaniken.
  const noReplyThreshold = num(commLimits.no_reply_pause_threshold, 3);
  const noReplyStreak    = num(state.no_reply_streak_count, 0);
  if (noReplyThreshold > 0 && noReplyStreak >= noReplyThreshold) {
    log.push(`no_reply_streak (${noReplyStreak}) >= threshold (${noReplyThreshold}) → BLOCKED_NO_REPLY_PAUSE.`);
    decision.blocked_reason = 'BLOCKED_NO_REPLY_PAUSE';
    return decision;
  }
  log.push(`No-reply streak ok (${noReplyStreak}/${noReplyThreshold}).`);

  // ---- f. Handmatige pauze ----
  const pausedUntil = state.autonomy_paused_until
    ? new Date(state.autonomy_paused_until).getTime()
    : 0;
  if (pausedUntil && pausedUntil >= nowDate.getTime()) {
    const remainingMin = Math.ceil((pausedUntil - nowDate.getTime()) / 60000);
    log.push(`Autonomy handmatig gepauzeerd tot ${state.autonomy_paused_until} (nog ${remainingMin}m, reden=${state.autonomy_paused_reason || 'unspecified'}) → BLOCKED_PAUSED.`);
    decision.blocked_reason = 'BLOCKED_PAUSED';
    return decision;
  }
  log.push('Paused-check ok.');

  // ---- g. 24h-window guard ----
  // Meta non-negotiable voor free-form text. Conv-laatste-inbound nodig.
  const lastInboundMs = state.last_inbound_at
    ? new Date(state.last_inbound_at).getTime()
    : (suggestion.context_last_inbound_at
        ? new Date(suggestion.context_last_inbound_at).getTime()
        : 0);
  if (lastInboundMs) {
    const inWindow = (nowDate.getTime() - lastInboundMs) <= TWENTY_FOUR_HOURS_MS;
    if (!inWindow) {
      log.push('24h-window expired → BLOCKED_24H_WINDOW_EXPIRED.');
      decision.blocked_reason = 'BLOCKED_24H_WINDOW_EXPIRED';
      return decision;
    }
  }
  // (Geen last_inbound_at info beschikbaar in state? Laat de send-endpoint
  // de definitieve check doen tegen whatsapp_conversations.last_inbound_at.)

  // ---- h. Mode-check ----
  if (mode === 'autonomous') {
    decision.allow_autonomous = true;
    log.push('Alle checks gepasseerd + mode=autonomous → allow_autonomous=true.');
  } else {
    decision.allow_autonomous = false;
    log.push('Alle checks gepasseerd maar mode=draft → allow_autonomous=false (mens beslist).');
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Audit-log helper
// ---------------------------------------------------------------------------
export async function logSimoneAutonomyDecision({
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
      action:      'simone.autonomy_decision',
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
        triggered_by:     triggered_by || 'simone-autonomy-eval',
      },
      reason_text: decision.blocked_reason
        || (decision.stop_action ? `stop_action=${decision.stop_action}` : null)
        || (decision.allow_autonomous ? 'autonomous_send_allowed' : 'draft_only'),
      ip_address: ip_address || null,
    });
  } catch (e) {
    console.error('[simone-autonomy-eval audit]', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler: POST /api/simone-autonomy-evaluate (admin dry-run)
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const canUse   = await requirePermission(req, 'events.simone.use');
  const canAdmin = canUse ? true : await requirePermission(req, 'admin.simone_config');
  if (!canUse && !canAdmin) {
    return res.status(403).json({ error: 'Geen rechten (events.simone.use of admin.simone_config)' });
  }

  const body = req.body || {};
  const suggestionId = typeof body.suggestion_id === 'string' ? body.suggestion_id.trim() : '';
  if (!suggestionId) return res.status(400).json({ error: 'suggestion_id vereist' });
  if (!isUuid(suggestionId)) return res.status(400).json({ error: 'suggestion_id moet geldige uuid zijn' });

  try {
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
    if (sugg.module !== 'events') {
      return res.status(400).json({ error: `Suggestion module is "${sugg.module}", verwacht "events"` });
    }

    const convId = sugg.conversation_id;
    if (!convId) return res.status(400).json({ error: 'Suggestion heeft geen conversation_id (orphan)' });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, last_inbound_at')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('whatsapp_conversations lookup: ' + convErr.message);

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

    const stateForEval = {
      ...(convState || {}),
      last_inbound_at: conv ? conv.last_inbound_at : null,
    };

    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, autonomy_config, feature_flags, is_enabled')
      .eq('module', 'events')
      .maybeSingle();
    if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);
    if (!cfg) return res.status(503).json({ error: 'joost_config ontbreekt voor module=events' });

    const decision = evaluateSimoneAutonomy({
      suggestion: sugg,
      convState:  stateForEval,
      cfg,
      now:        new Date(),
    });

    await logSimoneAutonomyDecision({
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
    });
  } catch (e) {
    console.error('[simone-autonomy-evaluate]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
