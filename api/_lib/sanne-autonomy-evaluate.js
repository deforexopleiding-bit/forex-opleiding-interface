// api/_lib/sanne-autonomy-evaluate.js
//
// Pure helper: evalueert autonomy-decision voor een Sanne-suggestie.
// Zelfde filosofie als joost-autonomy-evaluate (Lesson 24 — gemandateerde
// scope-checks in code, NIET in prompt): checks lopen in vaste volgorde,
// eerste die faalt geeft een BLOCKED_* + reden. Alleen als alles slaagt
// EN mode=autonomous EN alle flags aan staan, mag Sanne zelf versturen.
//
// In Fase 2.0 draait de engine in shadow-mode: elke suggestie wordt hier
// doorheen gehaald en het resultaat gaat naar sanne_suggestions.autonomy_decision.
// Jeffrey kan zo 24-48u meekijken zonder dat er iets verstuurd wordt.
//
// EXPORT: evaluateSanneAutonomy({ config, suggestion, email, customer, sendsToday })
//   returns { mode, allowed, block_reason, block_detail, checks: [...] }
//     mode          = 'shadow' | 'reactive_suggest' | 'auto_draft_save' | 'autonomous_send'
//     allowed       = boolean — mag Sanne die mode uitvoeren?
//     block_reason  = 'CONFIDENCE'|'INTENT'|'MANDATE'|'OFFICE_HOURS'|'RATE_LIMIT'|'NO_CUSTOMER'|'MODE'|null
//     block_detail  = { key: value, ... } — machine-leesbaar detail voor UI/logs
//     checks        = [{ name, passed, note }] — geordende audit-trail
//
// Determinatie mode op basis van feature_flags in joost_config:
//   sanne_autonomous_send=true  + confidence>=min_conf_auton + geen blocks -> 'autonomous_send'
//   sanne_auto_draft_save=true  + confidence>=min_conf_draft + geen blocks -> 'auto_draft_save'
//   sanne_reactive_suggest=true + confidence>=min_conf_react + geen blocks -> 'reactive_suggest'
//   anders                                                                 -> 'shadow'

const DEFAULT_MANDATE = {
  max_amount_mentioned_eur:   500,
  office_hours_only:          true,
  office_hours_start:         9,
  office_hours_end:           17,
  office_days:                [1, 2, 3, 4, 5], // ma-vr (0=zo, 6=za)
  max_sends_per_day:          20,
  require_customer_link:      true,
  min_confidence_reactive:    0.60,
  min_confidence_auto_draft:  0.70,
  min_confidence_autonomous:  0.85,
  anti_loop_cooldown_seconds: 60,
};

// Regex voor grote bedragen in body: "€ 1.234", "1234 euro", "eur 500", enz.
// Match cijfers (met optionele duizend-separators) direct naast euro-marker.
const AMOUNT_RX =
  /(?:€\s*|eur\s*|\beuro\s+)([\d]{1,3}(?:[.\s][\d]{3})*(?:[,.][\d]{1,2})?)|(\d{2,6})\s*(?:eur|euro|€)/gi;

function _parseAmountDigits(str) {
  if (!str) return NaN;
  // Nederlandse notatie: "1.234,56" of "1234,56"; strip dots als thousand-sep
  // en vervang komma door punt voor JS-parse.
  const cleaned = String(str).replace(/[\s.]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function maxAmountInText(text) {
  if (!text) return 0;
  let max = 0;
  let m;
  const rx = new RegExp(AMOUNT_RX.source, 'gi');
  while ((m = rx.exec(text)) !== null) {
    const raw = m[1] || m[2] || '';
    const n = _parseAmountDigits(raw);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function nowInOfficeHours(mandate, nowDate = new Date()) {
  const day = nowDate.getDay(); // 0=zo, 6=za
  const hour = nowDate.getHours();
  if (!Array.isArray(mandate.office_days) || !mandate.office_days.includes(day)) return false;
  if (hour < mandate.office_hours_start) return false;
  if (hour >= mandate.office_hours_end) return false;
  return true;
}

export function evaluateSanneAutonomy(input = {}) {
  const config      = input.config      || {};
  const suggestion  = input.suggestion  || {};
  const email       = input.email       || {};
  const customer    = input.customer    || null;
  const sendsToday  = Number(input.sendsToday || 0);
  const now         = input.now instanceof Date ? input.now : new Date();

  const flags       = config.feature_flags || {};
  const autonomy    = config.autonomy_config || {};
  const mandate     = Object.assign({}, DEFAULT_MANDATE, autonomy.mandate || {});
  const blockedIntents = Array.isArray(autonomy.blocked_intents) ? autonomy.blocked_intents : [];
  const mailboxScope   = Array.isArray(autonomy.mailbox_scope)   ? autonomy.mailbox_scope   : [];

  const checks = [];
  let blockReason = null;
  let blockDetail = null;

  // ── 1. Mailbox in scope ─────────────────────────────────────────────
  const mailboxOk = mailboxScope.includes(email.mailbox);
  checks.push({ name: 'mailbox_scope', passed: mailboxOk,
    note: mailboxOk ? `${email.mailbox} in scope` : `${email.mailbox} niet in scope (${mailboxScope.join(',') || 'leeg'})` });
  if (!mailboxOk) { blockReason = 'MODE'; blockDetail = { reason: 'mailbox_not_in_scope', mailbox: email.mailbox, scope: mailboxScope }; }

  // ── 2. Blocked intent ────────────────────────────────────────────────
  const intent = String(suggestion.detected_intent || '').toLowerCase();
  const intentBlocked = blockedIntents.map(String).map((s) => s.toLowerCase()).includes(intent);
  checks.push({ name: 'blocked_intents', passed: !intentBlocked,
    note: intentBlocked ? `intent "${intent}" is geblokkeerd` : `intent "${intent}" ok` });
  if (!blockReason && intentBlocked) { blockReason = 'INTENT'; blockDetail = { intent, blocked_list: blockedIntents }; }

  // ── 3. Grote bedragen in body ────────────────────────────────────────
  const bodyForScan = [email.body_text, suggestion.draft_body_text, suggestion.draft_body_html]
    .filter(Boolean).join('\n');
  const detectedAmount = maxAmountInText(bodyForScan);
  const amountOk = detectedAmount <= Number(mandate.max_amount_mentioned_eur);
  checks.push({ name: 'max_amount_mentioned_eur', passed: amountOk,
    note: amountOk ? `€${detectedAmount} <= €${mandate.max_amount_mentioned_eur}` : `€${detectedAmount} > cap €${mandate.max_amount_mentioned_eur}` });
  if (!blockReason && !amountOk) { blockReason = 'MANDATE'; blockDetail = { detected_amount: detectedAmount, cap: mandate.max_amount_mentioned_eur }; }

  // ── 4. Office-hours (alleen relevant voor autonomous send) ──────────
  const withinOfficeHours = nowInOfficeHours(mandate, now);
  checks.push({ name: 'office_hours', passed: withinOfficeHours,
    note: withinOfficeHours ? `binnen ${mandate.office_hours_start}-${mandate.office_hours_end}` : `buiten kantooruren` });

  // ── 5. Customer-link vereist? ────────────────────────────────────────
  const hasCustomer = !!(customer && customer.id);
  checks.push({ name: 'require_customer_link', passed: hasCustomer || !mandate.require_customer_link,
    note: hasCustomer ? `customer_id=${customer.id}` : (mandate.require_customer_link ? 'geen customer_id — required' : 'geen customer_id (optioneel)') });
  if (!blockReason && mandate.require_customer_link && !hasCustomer) {
    blockReason = 'NO_CUSTOMER'; blockDetail = { reason: 'no_customer_id' };
  }

  // ── 6. Rate-limit (max_sends_per_day) ───────────────────────────────
  const rateLimitOk = sendsToday < Number(mandate.max_sends_per_day);
  checks.push({ name: 'rate_limit', passed: rateLimitOk,
    note: `${sendsToday}/${mandate.max_sends_per_day} verstuurd vandaag` });
  if (!blockReason && !rateLimitOk) {
    blockReason = 'RATE_LIMIT'; blockDetail = { sends_today: sendsToday, cap: mandate.max_sends_per_day };
  }

  // ── 7. Confidence-drempels per mode ─────────────────────────────────
  const conf = Number(suggestion.confidence || 0);
  const canAutonomous = conf >= Number(mandate.min_confidence_autonomous);
  const canAutoDraft  = conf >= Number(mandate.min_confidence_auto_draft);
  const canReactive   = conf >= Number(mandate.min_confidence_reactive);
  checks.push({ name: 'confidence_reactive',   passed: canReactive,   note: `${conf} >= ${mandate.min_confidence_reactive}` });
  checks.push({ name: 'confidence_auto_draft', passed: canAutoDraft,  note: `${conf} >= ${mandate.min_confidence_auto_draft}` });
  checks.push({ name: 'confidence_autonomous', passed: canAutonomous, note: `${conf} >= ${mandate.min_confidence_autonomous}` });

  // ── Bepaal mode obv flags + confidence + blocks ─────────────────────
  const flagAutonomous = flags.sanne_autonomous_send === true;
  const flagAutoDraft  = flags.sanne_auto_draft_save === true;
  const flagReactive   = flags.sanne_reactive_suggest === true;

  let mode = 'shadow';
  let allowed = false;

  // ── 8. Autonomous-mailbox armed? (aparte lijst naast mailbox_scope) ─
  // autonomous_mailboxes is bewust een strikte SUB-set van mailbox_scope.
  // Default leeg = geen mailbox verstuurt autonoom, ook al staat de flag aan.
  const autonomousMailboxes = Array.isArray(autonomy.autonomous_mailboxes) ? autonomy.autonomous_mailboxes : [];
  const mailboxArmed = autonomousMailboxes.includes(email.mailbox);
  checks.push({ name: 'autonomous_mailbox_armed', passed: mailboxArmed,
    note: mailboxArmed ? `${email.mailbox} armed` : `${email.mailbox} niet armed (armed: ${autonomousMailboxes.join(',') || 'geen'})` });

  if (!blockReason) {
    if (flagAutonomous && canAutonomous && withinOfficeHours && mailboxArmed) {
      mode = 'autonomous_send'; allowed = true;
    } else if (flagAutoDraft && canAutoDraft) {
      mode = 'auto_draft_save'; allowed = true;
    } else if (flagReactive && canReactive) {
      mode = 'reactive_suggest'; allowed = true;
    } else if (flagAutonomous && !mailboxArmed) {
      // Autonoom-flag aan maar deze mailbox is niet armed → downgrade naar draft/suggest.
      if (flagAutoDraft && canAutoDraft) { mode = 'auto_draft_save'; allowed = true; }
      else if (flagReactive && canReactive) { mode = 'reactive_suggest'; allowed = true; }
      else { mode = 'shadow'; allowed = false; blockReason = 'MODE'; blockDetail = { reason: 'mailbox_not_autonomous_armed', mailbox: email.mailbox, armed_mailboxes: autonomousMailboxes }; }
    } else if (flagAutonomous && !withinOfficeHours) {
      // Autonoom aan maar buiten office-hours → downgrade naar draft indien mogelijk.
      if (flagAutoDraft && canAutoDraft) { mode = 'auto_draft_save'; allowed = true; }
      else { mode = 'shadow'; allowed = false; blockReason = 'OFFICE_HOURS';
        blockDetail = { hour: now.getHours(), day: now.getDay(),
          office_hours: `${mandate.office_hours_start}-${mandate.office_hours_end}` }; }
    } else if (!flagReactive && !flagAutoDraft && !flagAutonomous) {
      // Alle flags uit -> pure shadow mode (Fase 2.0 default).
      mode = 'shadow'; allowed = false;
    } else {
      // Flags aan maar confidence te laag.
      mode = 'shadow'; allowed = false;
      blockReason = 'CONFIDENCE';
      blockDetail = { confidence: conf, min_reactive: mandate.min_confidence_reactive };
    }
  }

  return {
    mode,
    allowed,
    block_reason: blockReason,
    block_detail: blockDetail,
    detected_amount_eur: detectedAmount,
    within_office_hours: withinOfficeHours,
    has_customer_link:   hasCustomer,
    confidence:          conf,
    checks,
    evaluated_at: now.toISOString(),
  };
}

// Test-utility exports (unit-tests / debugging)
export const _internals = { maxAmountInText, nowInOfficeHours, DEFAULT_MANDATE };
