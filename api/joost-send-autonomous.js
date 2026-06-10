// api/joost-send-autonomous.js
// POST -> verzend (of weiger) een Joost-suggestie AUTONOMOUS namens de
// medewerker (E2 reactive autonomy). Combineert:
//   1) feature-flag gate (joost_config.feature_flags.e2_reactive_autonomy)
//   2) decision-engine (evaluateAutonomy) op suggestion + conv-state + cfg
//   3) Indien allow_autonomous -> Meta WhatsApp text-send via inbox-send pad
//      + UPDATE joost_suggestions.status='SENT_AUTONOMOUSLY' + sent_autonomously=true
//      + sent_message_id=<whatsapp_messages.id>
//   4) Indien NIET allow_autonomous -> UPDATE joost_suggestions.status=<BLOCKED_*>
//      (gemapt naar de DB-CHECK-enum) + autonomy_decision.
//   5) Altijd audit-log (joost.autonomy_decision + joost.message_sent_autonomously
//      bij echte send).
//
// Auth:
//   * X-Internal-Token == INTERNAL_API_TOKEN          -> system call (webhook self-call)
//     skip user-JWT + RBAC, user.id = NULL in audit + insert.
//   * Anders Bearer-JWT + finance.joost.use perm-check.
//
// Body:
//   { suggestion_id: uuid (verplicht) }
//
// Response 200:
//   {
//     sent: boolean,                  // true = autonoom verzonden, false = geblokkeerd
//     suggestion_id: uuid,
//     decision: { ...evaluateAutonomy-output... },
//     message_id?: uuid,              // alleen bij sent=true
//     meta_wamid?: string,            // alleen bij sent=true
//     blocked_reason?: string,        // alleen bij sent=false (DB-status)
//   }
// Error responses:
//   400  body/validatie-fout (incl. orphan suggestion, klant niet gekoppeld)
//   401  geen sessie (alleen bij user-call)
//   403  feature-flag uit OF geen rechten OF 24h-window expired (out-of-band block)
//   404  suggestion / conversation niet gevonden
//   409  suggestion niet in PROPOSED state (al geconsumeerd)
//   500  database-fout
//   502  Meta API-fout
//   503  Meta WhatsApp niet geconfigureerd
//
// Pattern: hergebruikt evaluateAutonomy() uit joost-autonomy-evaluate.js +
// sendText() uit _lib/meta-whatsapp.js (geen HTTP-self-call naar inbox-send,
// scheelt RBAC-roundtrip + audit-namespace blijft schoon).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import {
  sendText,
  getConfigStatus,
  MetaNotConfiguredError,
} from './_lib/meta-whatsapp.js';
import { evaluateAutonomy, logAutonomyDecision } from './joost-autonomy-evaluate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// ---------------------------------------------------------------------------
// Helper: map evaluateAutonomy().blocked_reason -> joost_suggestions.status
// ---------------------------------------------------------------------------
// De decision-engine produceert (zie joost-autonomy-evaluate.js regel 22-30):
//   BLOCKED_NO_SUGGESTION, BLOCKED_LOW_CONFIDENCE, BLOCKED_OFFICE_HOURS,
//   BLOCKED_RATE_LIMIT, BLOCKED_PAUSED, BLOCKED_OUT_OF_MANDATE.
// De DB-CHECK op joost_suggestions.status accepteert (zie migratie
// 2026-06-09-joost-e2-autonomy-full.sql regel 241-247):
//   BLOCKED_LOW_CONFIDENCE, BLOCKED_INTENT_DISABLED,
//   BLOCKED_COMMUNICATION_LIMIT, BLOCKED_MANDATE_EXCEEDED,
//   BLOCKED_AUTONOMY_PAUSED.
// Mapping (eval-naam -> DB-status):
const BLOCKED_REASON_TO_DB_STATUS = {
  BLOCKED_LOW_CONFIDENCE:   'BLOCKED_LOW_CONFIDENCE',
  BLOCKED_OFFICE_HOURS:     'BLOCKED_COMMUNICATION_LIMIT',
  BLOCKED_RATE_LIMIT:       'BLOCKED_COMMUNICATION_LIMIT',
  BLOCKED_PAUSED:           'BLOCKED_AUTONOMY_PAUSED',
  BLOCKED_OUT_OF_MANDATE:   'BLOCKED_MANDATE_EXCEEDED',
  BLOCKED_NO_SUGGESTION:    'BLOCKED_LOW_CONFIDENCE', // defensive fallback
};

/**
 * Vertaal decision -> { dbStatus, reasonForResponse }.
 *
 * Volgorde:
 *   - decision.blocked_reason -> direct gemapt
 *   - stop_action='escalation' (intent disabled) -> BLOCKED_INTENT_DISABLED
 *   - stop_action='task_create' (mandate-cap of max-msgs) -> BLOCKED_MANDATE_EXCEEDED
 *   - fallback -> BLOCKED_LOW_CONFIDENCE (defensief; mag niet voorkomen)
 */
function mapDecisionToDbStatus(decision) {
  if (!decision || typeof decision !== 'object') {
    return { dbStatus: 'BLOCKED_LOW_CONFIDENCE', reasonForResponse: 'no_decision' };
  }
  if (decision.blocked_reason && BLOCKED_REASON_TO_DB_STATUS[decision.blocked_reason]) {
    return {
      dbStatus: BLOCKED_REASON_TO_DB_STATUS[decision.blocked_reason],
      reasonForResponse: decision.blocked_reason,
    };
  }
  if (decision.stop_action === 'escalation') {
    return { dbStatus: 'BLOCKED_INTENT_DISABLED', reasonForResponse: 'INTENT_DISABLED' };
  }
  if (decision.stop_action === 'task_create') {
    return { dbStatus: 'BLOCKED_MANDATE_EXCEEDED', reasonForResponse: 'MANDATE_EXCEEDED' };
  }
  // mode='draft' zonder block -> ook geen send. Behandel als communication-limit
  // (mens-beslist) zodat het in de UI als 'niet autonoom verzonden' verschijnt.
  if (decision.mode === 'draft' && !decision.allow_autonomous) {
    return { dbStatus: 'BLOCKED_COMMUNICATION_LIMIT', reasonForResponse: 'MODE_DRAFT' };
  }
  return { dbStatus: 'BLOCKED_LOW_CONFIDENCE', reasonForResponse: 'unmapped' };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  // Twee paden, identiek aan joost-suggest.js regel 156-180:
  //   (a) X-Internal-Token == INTERNAL_API_TOKEN -> system-call (webhook).
  //   (b) Anders Bearer-JWT + RBAC.
  const internalTokenHeader = req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || null;
  const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
  const isInternalCall = !!(
    internalTokenHeader
    && expectedInternalToken
    && typeof internalTokenHeader === 'string'
    && internalTokenHeader === expectedInternalToken
  );

  let user = null;
  if (!isInternalCall) {
    const userClient = createUserClient(req);
    const { data: { user: u }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !u) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    user = u;
    if (!(await requirePermission(req, 'finance.joost.use'))) {
      return res.status(403).json({ error: 'Geen rechten (finance.joost.use)' });
    }
  }

  // ---- Body parsen ----
  const body = req.body || {};
  const suggestionId = typeof body.suggestion_id === 'string' ? body.suggestion_id.trim() : '';
  if (!suggestionId) return res.status(400).json({ error: 'suggestion_id vereist' });
  if (!isUuid(suggestionId)) return res.status(400).json({ error: 'suggestion_id moet geldige uuid zijn' });

  try {
    // ========================================================================
    // STAP 1: suggestion + conv + cfg + state ophalen
    // ========================================================================
    const { data: sugg, error: suggErr } = await supabaseAdmin
      .from('joost_suggestions')
      .select(
        'id, conversation_id, module, suggested_reply, detected_intent, ' +
        'confidence, reasoning, status, context_snapshot, triggered_by_message_id, ' +
        'auto_triggered, created_at',
      )
      .eq('id', suggestionId)
      .maybeSingle();
    if (suggErr) throw new Error('joost_suggestions lookup: ' + suggErr.message);
    if (!sugg) return res.status(404).json({ error: 'Suggestion niet gevonden' });
    if (sugg.status !== 'PROPOSED') {
      return res.status(409).json({
        error: 'Suggestion is niet in PROPOSED state (al geconsumeerd)',
        current_status: sugg.status,
      });
    }

    const convId = sugg.conversation_id;
    if (!convId) {
      return res.status(400).json({ error: 'Suggestion heeft geen conversation_id (orphan)' });
    }

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, phone_number, phone_number_id, last_inbound_at')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('whatsapp_conversations lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'WhatsApp-conversatie niet gevonden' });
    if (!conv.phone_number) {
      return res.status(400).json({ error: 'Conversation heeft geen phone_number' });
    }

    const moduleKey = sugg.module || 'finance';
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, autonomy_config, feature_flags, is_enabled')
      .eq('module', moduleKey)
      .maybeSingle();
    if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);
    if (!cfg) {
      return res.status(503).json({ error: `joost_config ontbreekt voor module=${moduleKey}` });
    }

    // ========================================================================
    // STAP 2: Feature-flag gate (e2_reactive_autonomy)
    // ========================================================================
    // Reactive autonomy = webhook of admin triggert direct na suggestie.
    // Aparte flag van e2_auto_send_text (= mode-default in evaluator) zodat
    // we de send-pad veilig kunnen uitschakelen zonder de mode-config te
    // hoeven veranderen.
    const featureFlags = (cfg && cfg.feature_flags && typeof cfg.feature_flags === 'object')
      ? cfg.feature_flags : {};
    if (featureFlags.e2_reactive_autonomy !== true) {
      return res.status(403).json({
        error: 'Reactive autonomy is uitgeschakeld',
        feature_flag: 'e2_reactive_autonomy',
      });
    }

    // ========================================================================
    // STAP 3: conversation-state ophalen + customer-context (open_amount)
    // ========================================================================
    const { data: convStateRaw, error: stateErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .select(
        'conversation_id, messages_sent_today, messages_sent_today_date, ' +
        'messages_sent_total, last_message_sent_at, autonomy_paused_until, ' +
        'autonomy_paused_reason, no_reply_streak_count',
      )
      .eq('conversation_id', convId)
      .maybeSingle();
    if (stateErr) throw new Error('joost_conversation_state lookup: ' + stateErr.message);

    let openAmount = 0;
    if (conv.customer_id) {
      const { data: invs, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('amount_open, status')
        .eq('customer_id', conv.customer_id)
        .in('status', ['open', 'partially_paid', 'overdue']);
      if (invErr) {
        console.error('[joost-send-autonomous] invoices lookup:', invErr.message);
      } else if (Array.isArray(invs)) {
        for (const inv of invs) {
          const v = Number(inv.amount_open);
          if (Number.isFinite(v)) openAmount += v;
        }
      }
    }

    // ========================================================================
    // STAP 4: evaluateAutonomy
    // ========================================================================
    const decision = evaluateAutonomy({
      suggestion:       sugg,
      conv_state:       convStateRaw || null,
      joost_config:     cfg,
      customer_context: { open_amount: openAmount },
      now:              new Date(),
    });

    const triggeredBy = isInternalCall ? 'webhook' : 'user_click';

    // Audit-log decision ALTIJD (ook bij allow=false).
    await logAutonomyDecision({
      supabaseAdmin,
      conv_id:       convId,
      suggestion_id: suggestionId,
      decision,
      user_id:       user ? user.id : null,
      ip_address:    getClientIp(req),
      triggered_by:  triggeredBy,
    });

    // ========================================================================
    // STAP 5a: NIET allow_autonomous -> markeer suggestion + return
    // ========================================================================
    if (!decision.allow_autonomous) {
      const { dbStatus, reasonForResponse } = mapDecisionToDbStatus(decision);
      const nowIso = new Date().toISOString();
      const { error: updErr } = await supabaseAdmin
        .from('joost_suggestions')
        .update({
          status:            dbStatus,
          autonomy_decision: decision,
          used_at:           nowIso,
          used_by_user_id:   user ? user.id : null,
        })
        .eq('id', suggestionId)
        .eq('status', 'PROPOSED'); // race-guard
      if (updErr) {
        console.error('[joost-send-autonomous] suggestion-update (blocked) error:', updErr.message);
        return res.status(500).json({ error: 'suggestion-update: ' + updErr.message });
      }
      return res.status(200).json({
        sent:           false,
        suggestion_id:  suggestionId,
        decision,
        blocked_reason: reasonForResponse,
        db_status:      dbStatus,
      });
    }

    // ========================================================================
    // STAP 5b: allow_autonomous -> Meta send + DB updates
    // ========================================================================
    // 24h-window guard (Meta non-negotiable voor free-form text).
    const lastInboundMs = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
    const withinWindow = lastInboundMs && (Date.now() - lastInboundMs) <= TWENTY_FOUR_HOURS_MS;
    if (!withinWindow) {
      // Markeer als communication-limit (out-of-window) zodat dit niet als
      // 'gewoon mislukt' wegloopt — admin ziet 'm in decisions-list.
      const blockedDecision = {
        ...decision,
        allow_autonomous: false,
        blocked_reason:   'BLOCKED_24H_WINDOW_EXPIRED',
        decision_log:     [...(decision.decision_log || []), '24h-window expired -> kan geen free-form text autonoom sturen.'],
      };
      const nowIso = new Date().toISOString();
      await supabaseAdmin
        .from('joost_suggestions')
        .update({
          status:            'BLOCKED_COMMUNICATION_LIMIT',
          autonomy_decision: blockedDecision,
          used_at:           nowIso,
          used_by_user_id:   user ? user.id : null,
        })
        .eq('id', suggestionId)
        .eq('status', 'PROPOSED');
      return res.status(403).json({
        sent:           false,
        suggestion_id:  suggestionId,
        decision:       blockedDecision,
        blocked_reason: 'BLOCKED_24H_WINDOW_EXPIRED',
      });
    }

    // Meta-config check.
    const cfgStatus = getConfigStatus();
    if (!cfgStatus.configured) {
      return res.status(503).json({
        error:   'Meta WhatsApp niet geconfigureerd',
        missing: cfgStatus.missing,
      });
    }

    // Module-config: outbound phone_number_id (fallback op env).
    let financePnId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('phone_number_id')
        .eq('module', moduleKey)
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[joost-send-autonomous] module-config lookup:', modErr.message);
      } else if (modCfg?.phone_number_id) {
        financePnId = modCfg.phone_number_id;
      }
    } catch (e) {
      console.error('[joost-send-autonomous] module-config exception:', e.message);
    }
    const outboundPnId = conv.phone_number_id || financePnId || undefined;

    const text = String(sugg.suggested_reply || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Suggestion heeft lege suggested_reply' });
    }

    // ---- Meta API call ----
    let metaResult;
    try {
      metaResult = await sendText({
        to:             conv.phone_number,
        body:           text,
        phoneNumberId:  outboundPnId,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({
          error:   'Meta WhatsApp niet geconfigureerd',
          missing: metaErr.missing,
        });
      }
      console.error('[joost-send-autonomous] Meta API fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }
    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nowIso = new Date().toISOString();

    // ---- Persist outbound message ----
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id:    convId,
        direction:          'out',
        meta_wamid:         wamid,
        body:               text,
        template_name:      null,
        template_variables: null,
        status:             'queued',
        sent_at:            nowIso,
        sent_by_user_id:    user ? user.id : null,
      })
      .select('id, meta_wamid, status, sent_at')
      .single();
    if (insErr) throw new Error('whatsapp_messages insert: ' + insErr.message);

    const sentMessageId = inserted.id;

    // ---- Conversation last_message_at + preview ----
    const preview = text.slice(0, 120);
    {
      const { error: convUpdErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ last_message_at: nowIso, last_message_preview: preview })
        .eq('id', convId);
      if (convUpdErr) {
        console.error('[joost-send-autonomous] conversation update failed:', convUpdErr.message);
      }
    }

    // ---- Update suggestion (status + sent_autonomously + sent_message_id + decision) ----
    {
      const { error: updErr } = await supabaseAdmin
        .from('joost_suggestions')
        .update({
          status:            'SENT_AUTONOMOUSLY',
          sent_autonomously: true,
          sent_message_id:   sentMessageId,
          autonomy_decision: decision,
          used_at:           nowIso,
          used_by_user_id:   user ? user.id : null,
        })
        .eq('id', suggestionId)
        .eq('status', 'PROPOSED'); // race-guard
      if (updErr) {
        console.error('[joost-send-autonomous] suggestion-update (sent) error:', updErr.message);
        // Geen rollback — bericht is al verstuurd. Audit-log dekt discrepantie.
      }
    }

    // ---- Update joost_conversation_state (counters + last_message_sent_at) ----
    // Reset messages_sent_today als datum gewijzigd is.
    try {
      const today = nowIso.slice(0, 10); // YYYY-MM-DD (UTC) — voldoende voor day-cap
      if (!convStateRaw) {
        // INSERT (race-veilig via ON CONFLICT DO NOTHING idee niet beschikbaar
        // omdat we ook willen UPDATE'en als gelijktijdig is aangemaakt; doe
        // dus 2-step: insert -> bij 23505 fall through naar update).
        const insertPayload = {
          conversation_id:          convId,
          messages_sent_today:      1,
          messages_sent_today_date: today,
          messages_sent_total:      1,
          last_message_sent_at:     nowIso,
        };
        const { error: stateInsErr } = await supabaseAdmin
          .from('joost_conversation_state')
          .insert(insertPayload);
        if (stateInsErr) {
          if (stateInsErr.code === '23505') {
            // Race: andere call insertte intussen. Reload + update.
            const { data: stateAgain } = await supabaseAdmin
              .from('joost_conversation_state')
              .select('messages_sent_today, messages_sent_today_date, messages_sent_total')
              .eq('conversation_id', convId)
              .maybeSingle();
            if (stateAgain) {
              const sameDay = stateAgain.messages_sent_today_date === today;
              const newToday = (sameDay ? Number(stateAgain.messages_sent_today || 0) : 0) + 1;
              const newTotal = Number(stateAgain.messages_sent_total || 0) + 1;
              await supabaseAdmin
                .from('joost_conversation_state')
                .update({
                  messages_sent_today:      newToday,
                  messages_sent_today_date: today,
                  messages_sent_total:      newTotal,
                  last_message_sent_at:     nowIso,
                })
                .eq('conversation_id', convId);
            }
          } else {
            console.error('[joost-send-autonomous] conv_state insert fail:', stateInsErr.message);
          }
        }
      } else {
        const sameDay = convStateRaw.messages_sent_today_date === today;
        const newToday = (sameDay ? Number(convStateRaw.messages_sent_today || 0) : 0) + 1;
        const newTotal = Number(convStateRaw.messages_sent_total || 0) + 1;
        const { error: stateUpdErr } = await supabaseAdmin
          .from('joost_conversation_state')
          .update({
            messages_sent_today:      newToday,
            messages_sent_today_date: today,
            messages_sent_total:      newTotal,
            last_message_sent_at:     nowIso,
          })
          .eq('conversation_id', convId);
        if (stateUpdErr) {
          console.error('[joost-send-autonomous] conv_state update fail:', stateUpdErr.message);
        }
      }
    } catch (eState) {
      console.error('[joost-send-autonomous] conv_state exception:', eState && eState.message);
    }

    // ---- Audit: joost.message_sent_autonomously ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user ? user.id : null,
        action:      'joost.message_sent_autonomously',
        entity_type: 'whatsapp_message',
        entity_id:   sentMessageId,
        after_json:  {
          conversation_id:  convId,
          suggestion_id:    suggestionId,
          module:           moduleKey,
          phone_number:     conv.phone_number,
          phone_number_id:  outboundPnId || null,
          meta_wamid:       wamid,
          detected_intent:  decision.intent,
          confidence:       decision.confidence,
          mode:             decision.mode,
          triggered_by:     triggeredBy,
        },
        reason_text: text.slice(0, 500),
        ip_address:  getClientIp(req),
      });
    } catch (eAudit) {
      console.error('[joost-send-autonomous] audit insert exception:', eAudit && eAudit.message);
    }

    return res.status(200).json({
      sent:           true,
      suggestion_id:  suggestionId,
      message_id:     sentMessageId,
      meta_wamid:     wamid,
      decision,
    });
  } catch (e) {
    console.error('[joost-send-autonomous]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
