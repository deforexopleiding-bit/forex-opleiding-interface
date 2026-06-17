// api/simone-send-autonomous.js
// POST -> verzend (of weiger) een Simone-suggestie AUTONOMOUS voor module=events.
//
// Spiegel van api/joost-send-autonomous.js, events-gekleurd:
//   * Feature-flag = joost_config(module='events').feature_flags.events_reactive_autonomy
//   * RBAC user-pad = events.simone.use (i.p.v. finance.joost.use)
//   * Geen invoices / customer-context.open_amount (niet relevant voor events)
//   * Audit-action = 'simone.message_sent_autonomously'
//
// Auth:
//   * X-Internal-Token == INTERNAL_API_TOKEN  -> system call (webhook self-call)
//   * Anders Bearer-JWT + events.simone.use
//
// Body: { suggestion_id: uuid }
//
// Response 200:
//   { sent: boolean, suggestion_id, decision, message_id?, meta_wamid?, blocked_reason? }
// 401/403/404/409/500/502/503 — zie code.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import {
  sendText,
  getConfigStatus,
  MetaNotConfiguredError,
} from './_lib/meta-whatsapp.js';
import { evaluateSimoneAutonomy, logSimoneAutonomyDecision } from './simone-autonomy-evaluate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// Map decision.blocked_reason -> joost_suggestions.status (DB-CHECK enum).
const BLOCKED_REASON_TO_DB_STATUS = {
  BLOCKED_LOW_CONFIDENCE:        'BLOCKED_LOW_CONFIDENCE',
  BLOCKED_OFFICE_HOURS:          'BLOCKED_COMMUNICATION_LIMIT',
  BLOCKED_RATE_LIMIT:            'BLOCKED_COMMUNICATION_LIMIT',
  BLOCKED_NO_REPLY_PAUSE:        'BLOCKED_COMMUNICATION_LIMIT',
  BLOCKED_PAUSED:                'BLOCKED_AUTONOMY_PAUSED',
  BLOCKED_24H_WINDOW_EXPIRED:    'BLOCKED_COMMUNICATION_LIMIT',
  BLOCKED_NO_SUGGESTION:         'BLOCKED_LOW_CONFIDENCE',
};

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
  if (decision.mode === 'draft' && !decision.allow_autonomous) {
    return { dbStatus: 'BLOCKED_COMMUNICATION_LIMIT', reasonForResponse: 'MODE_DRAFT' };
  }
  return { dbStatus: 'BLOCKED_LOW_CONFIDENCE', reasonForResponse: 'unmapped' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
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
    if (!(await requirePermission(req, 'events.simone.use'))) {
      return res.status(403).json({ error: 'Geen rechten (events.simone.use)' });
    }
  }

  // ---- Body ----
  const body = req.body || {};
  const suggestionId = typeof body.suggestion_id === 'string' ? body.suggestion_id.trim() : '';
  if (!suggestionId) return res.status(400).json({ error: 'suggestion_id vereist' });
  if (!isUuid(suggestionId)) return res.status(400).json({ error: 'suggestion_id moet geldige uuid zijn' });

  try {
    // ---- 1. Suggestion ophalen ----
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
    if (sugg.module !== 'events') {
      return res.status(400).json({ error: `Suggestion module is "${sugg.module}", verwacht "events"` });
    }
    if (sugg.status !== 'PROPOSED') {
      return res.status(409).json({
        error: 'Suggestion is niet in PROPOSED state (al geconsumeerd)',
        current_status: sugg.status,
      });
    }

    const convId = sugg.conversation_id;
    if (!convId) return res.status(400).json({ error: 'Suggestion heeft geen conversation_id (orphan)' });

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

    // ---- 2. Feature-flag gate ----
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, autonomy_config, feature_flags, is_enabled')
      .eq('module', 'events')
      .maybeSingle();
    if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);
    if (!cfg) {
      return res.status(503).json({ error: 'joost_config ontbreekt voor module=events' });
    }
    const featureFlags = (cfg && cfg.feature_flags && typeof cfg.feature_flags === 'object')
      ? cfg.feature_flags : {};
    if (featureFlags.events_reactive_autonomy !== true) {
      return res.status(403).json({
        error: 'Reactive autonomy is uitgeschakeld voor Simone',
        feature_flag: 'events_reactive_autonomy',
      });
    }

    // ---- 3. Conversation-state ----
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

    const stateForEval = {
      ...(convStateRaw || {}),
      last_inbound_at: conv.last_inbound_at || null,
    };

    // ---- 4. evaluateSimoneAutonomy ----
    const decision = evaluateSimoneAutonomy({
      suggestion: sugg,
      convState:  stateForEval,
      cfg,
      now:        new Date(),
    });

    const triggeredBy = isInternalCall ? 'webhook' : 'user_click';

    await logSimoneAutonomyDecision({
      supabaseAdmin,
      conv_id:       convId,
      suggestion_id: suggestionId,
      decision,
      user_id:       user ? user.id : null,
      ip_address:    getClientIp(req),
      triggered_by:  triggeredBy,
    });

    // ---- 5a. NIET allow_autonomous -> markeer suggestion + return ----
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
        .eq('status', 'PROPOSED');
      if (updErr) {
        console.error('[simone-send-autonomous] suggestion-update (blocked):', updErr.message);
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

    // ---- 5b. 24h-window guard (Meta non-negotiable) ----
    const lastInboundMs = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
    const withinWindow = lastInboundMs && (Date.now() - lastInboundMs) <= TWENTY_FOUR_HOURS_MS;
    if (!withinWindow) {
      const blockedDecision = {
        ...decision,
        allow_autonomous: false,
        blocked_reason:   'BLOCKED_24H_WINDOW_EXPIRED',
        decision_log:     [...(decision.decision_log || []), '24h-window expired → kan geen free-form text autonoom sturen.'],
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

    // ---- Meta-config ----
    const cfgStatus = getConfigStatus();
    if (!cfgStatus.configured) {
      return res.status(503).json({
        error:   'Meta WhatsApp niet geconfigureerd',
        missing: cfgStatus.missing,
      });
    }

    // Module-config: outbound phone_number_id voor events.
    let eventsPnId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('phone_number_id')
        .eq('module', 'events')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[simone-send-autonomous] module-config lookup:', modErr.message);
      } else if (modCfg?.phone_number_id) {
        eventsPnId = modCfg.phone_number_id;
      }
    } catch (e) {
      console.error('[simone-send-autonomous] module-config exception:', e.message);
    }
    const outboundPnId = conv.phone_number_id || eventsPnId || undefined;

    const text = String(sugg.suggested_reply || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Suggestion heeft lege suggested_reply' });
    }

    // ---- Meta send ----
    let metaResult;
    try {
      metaResult = await sendText({
        to:            conv.phone_number,
        body:          text,
        phoneNumberId: outboundPnId,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({
          error:   'Meta WhatsApp niet geconfigureerd',
          missing: metaErr.missing,
        });
      }
      console.error('[simone-send-autonomous] Meta API fout:', metaErr.message);
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
        console.error('[simone-send-autonomous] conversation update failed:', convUpdErr.message);
      }
    }

    // ---- Update suggestion ----
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
        .eq('status', 'PROPOSED');
      if (updErr) {
        console.error('[simone-send-autonomous] suggestion-update (sent):', updErr.message);
      }
    }

    // ---- Update joost_conversation_state ----
    try {
      const today = nowIso.slice(0, 10);
      if (!convStateRaw) {
        const insertPayload = {
          conversation_id:          convId,
          messages_sent_today:      1,
          messages_sent_today_date: today,
          messages_sent_total:      1,
          last_message_sent_at:     nowIso,
          no_reply_streak_count:    1,
        };
        const { error: stateInsErr } = await supabaseAdmin
          .from('joost_conversation_state')
          .insert(insertPayload);
        if (stateInsErr) {
          if (stateInsErr.code === '23505') {
            const { data: stateAgain } = await supabaseAdmin
              .from('joost_conversation_state')
              .select('messages_sent_today, messages_sent_today_date, messages_sent_total, no_reply_streak_count')
              .eq('conversation_id', convId)
              .maybeSingle();
            if (stateAgain) {
              const sameDay = stateAgain.messages_sent_today_date === today;
              const newToday = (sameDay ? Number(stateAgain.messages_sent_today || 0) : 0) + 1;
              const newTotal = Number(stateAgain.messages_sent_total || 0) + 1;
              const newStreak = Number(stateAgain.no_reply_streak_count || 0) + 1;
              await supabaseAdmin
                .from('joost_conversation_state')
                .update({
                  messages_sent_today:      newToday,
                  messages_sent_today_date: today,
                  messages_sent_total:      newTotal,
                  last_message_sent_at:     nowIso,
                  no_reply_streak_count:    newStreak,
                })
                .eq('conversation_id', convId);
            }
          } else {
            console.error('[simone-send-autonomous] conv_state insert:', stateInsErr.message);
          }
        }
      } else {
        const sameDay = convStateRaw.messages_sent_today_date === today;
        const newToday = (sameDay ? Number(convStateRaw.messages_sent_today || 0) : 0) + 1;
        const newTotal = Number(convStateRaw.messages_sent_total || 0) + 1;
        const newStreak = Number(convStateRaw.no_reply_streak_count || 0) + 1;
        const { error: stateUpdErr } = await supabaseAdmin
          .from('joost_conversation_state')
          .update({
            messages_sent_today:      newToday,
            messages_sent_today_date: today,
            messages_sent_total:      newTotal,
            last_message_sent_at:     nowIso,
            no_reply_streak_count:    newStreak,
          })
          .eq('conversation_id', convId);
        if (stateUpdErr) {
          console.error('[simone-send-autonomous] conv_state update:', stateUpdErr.message);
        }
      }
    } catch (eState) {
      console.error('[simone-send-autonomous] conv_state exception:', eState && eState.message);
    }

    // ---- Audit: simone.message_sent_autonomously ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user ? user.id : null,
        action:      'simone.message_sent_autonomously',
        entity_type: 'whatsapp_message',
        entity_id:   sentMessageId,
        after_json:  {
          conversation_id:  convId,
          suggestion_id:    suggestionId,
          module:           'events',
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
      console.error('[simone-send-autonomous] audit insert exception:', eAudit && eAudit.message);
    }

    return res.status(200).json({
      sent:           true,
      suggestion_id:  suggestionId,
      message_id:     sentMessageId,
      meta_wamid:     wamid,
      decision,
    });
  } catch (e) {
    console.error('[simone-send-autonomous]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
