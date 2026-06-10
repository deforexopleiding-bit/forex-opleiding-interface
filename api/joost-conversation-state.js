// api/joost-conversation-state.js
// Joost E2.3 -- conversation-state endpoint voor pauzeer / hervat per conversatie.
//
// Twee methods op een rij:
//   GET  /api/joost-conversation-state?conversation_id=<uuid>
//        Permission: finance.joost.use OF finance.tasks.view (OR).
//        Returnt joost_conversation_state-rij voor de conversation. Als geen
//        rij bestaat: spec-conforme default-shape (alles 0/null) zodat UI
//        altijd een werkbare baseline heeft (idem patroon als joost-config-get).
//
//   PATCH /api/joost-conversation-state
//        Body: { conversation_id, autonomy_paused_reason?, autonomy_paused_until? }
//        Permission: finance.joost.autonomy_pause (strict -- geen fallback).
//        UPSERT op (conversation_id) met alleen de paused-fields; counters
//        (messages_sent_today / _total / last_message_sent_at / ...) blijven
//        ongewijzigd.
//        Semantiek:
//          - autonomy_paused_reason !== null  -> pauze (joost.autonomy_paused).
//          - autonomy_paused_reason === null  -> hervatten (joost.autonomy_resumed).
//            autonomy_paused_until wordt dan ook automatisch op NULL gezet.
//
// Response shape:
//   { state: { conversation_id, topics_discussed, last_proposal_made,
//              messages_sent_today, messages_sent_today_date,
//              messages_sent_total, last_message_sent_at,
//              last_outbound_template_sent_at, last_outbound_workflow_step,
//              no_reply_streak_count, autonomy_paused_reason,
//              autonomy_paused_until, created_at, updated_at, is_default? } }
//
// Audit (audit_log, fail-soft):
//   action      = 'joost.autonomy_paused' | 'joost.autonomy_resumed'
//   entity_type = 'whatsapp_conversation'
//   entity_id   = conversation_id
//   after_json  = { autonomy_paused_reason, autonomy_paused_until }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LEN = 500;

const STATE_COLUMNS = [
  'conversation_id',
  'topics_discussed',
  'last_proposal_made',
  'messages_sent_today',
  'messages_sent_today_date',
  'messages_sent_total',
  'last_message_sent_at',
  'last_outbound_template_sent_at',
  'last_outbound_workflow_step',
  'no_reply_streak_count',
  'autonomy_paused_reason',
  'autonomy_paused_until',
  'created_at',
  'updated_at',
].join(', ');

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

function buildDefaultState(convId) {
  return {
    conversation_id:                convId,
    topics_discussed:               [],
    last_proposal_made:             null,
    messages_sent_today:            0,
    messages_sent_today_date:       null,
    messages_sent_total:            0,
    last_message_sent_at:           null,
    last_outbound_template_sent_at: null,
    last_outbound_workflow_step:    null,
    no_reply_streak_count:          0,
    autonomy_paused_reason:         null,
    autonomy_paused_until:          null,
    created_at:                     null,
    updated_at:                     null,
    is_default:                     true,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'GET of PATCH only' });
  }

  // ---- Auth ----
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (method === 'GET') return handleGet(req, res);
  return handlePatch(req, res, user);
}

// ---------------------------------------------------------------------------
// GET -- read state (default-shape als geen rij bestaat)
// ---------------------------------------------------------------------------
async function handleGet(req, res) {
  // Permission: finance.joost.use OF finance.tasks.view (OR, short-circuit).
  const canUse = await requirePermission(req, 'finance.joost.use');
  const canView = canUse ? true : await requirePermission(req, 'finance.tasks.view');
  if (!canUse && !canView) {
    return res.status(403).json({ error: 'Geen rechten (finance.joost.use of finance.tasks.view)' });
  }

  const convRaw = (req.query?.conversation_id ?? '').toString().trim();
  if (!convRaw) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!isUuid(convRaw)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }

  try {
    const { data: row, error } = await supabaseAdmin
      .from('joost_conversation_state')
      .select(STATE_COLUMNS)
      .eq('conversation_id', convRaw)
      .maybeSingle();
    if (error) {
      console.error('[joost-conversation-state GET] select error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (row) {
      return res.status(200).json({ state: { ...row, is_default: false } });
    }
    return res.status(200).json({ state: buildDefaultState(convRaw) });
  } catch (e) {
    console.error('[joost-conversation-state GET] exception:', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}

// ---------------------------------------------------------------------------
// PATCH -- pauzeer / hervat (UPSERT alleen paused-fields)
// ---------------------------------------------------------------------------
async function handlePatch(req, res, user) {
  if (!(await requirePermission(req, 'finance.joost.autonomy_pause'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.joost.autonomy_pause)' });
  }

  const body = req.body || {};

  const convRaw = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
  if (!convRaw) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!isUuid(convRaw)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }

  // ---- autonomy_paused_reason: null => hervatten, anders pauze ----
  let pausedReason = null;
  let reasonProvided = false;
  if (Object.prototype.hasOwnProperty.call(body, 'autonomy_paused_reason')) {
    reasonProvided = true;
    const r = body.autonomy_paused_reason;
    if (r === null) {
      pausedReason = null;
    } else if (typeof r === 'string') {
      const s = r.trim();
      if (s.length > MAX_REASON_LEN) {
        return res.status(400).json({ error: `autonomy_paused_reason: max ${MAX_REASON_LEN} chars` });
      }
      pausedReason = s.length > 0 ? s : null;
    } else {
      return res.status(400).json({ error: 'autonomy_paused_reason: string of null vereist' });
    }
  }

  // ---- autonomy_paused_until: ISO-timestamp of null ----
  let pausedUntil = null;
  let untilProvided = false;
  if (Object.prototype.hasOwnProperty.call(body, 'autonomy_paused_until')) {
    untilProvided = true;
    const u = body.autonomy_paused_until;
    if (u === null) {
      pausedUntil = null;
    } else if (typeof u === 'string') {
      const s = u.trim();
      if (s.length === 0) {
        pausedUntil = null;
      } else {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: 'autonomy_paused_until moet ISO-timestamp of null zijn' });
        }
        pausedUntil = d.toISOString();
      }
    } else {
      return res.status(400).json({ error: 'autonomy_paused_until: string (ISO) of null vereist' });
    }
  }

  if (!reasonProvided && !untilProvided) {
    return res.status(400).json({ error: 'Minimaal autonomy_paused_reason of autonomy_paused_until vereist' });
  }

  // Hervatten = reason expliciet null -> ook until automatisch op null zetten
  // (anders blijft een oude pauze-eind-datum in DB hangen).
  const isResume = reasonProvided && pausedReason === null;
  if (isResume) pausedUntil = null;

  try {
    // ------------------------------------------------------------------------
    // STAP 1: check of rij bestaat -- bepaalt INSERT-vs-UPDATE pad.
    // ------------------------------------------------------------------------
    const { data: existing, error: selErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .select('conversation_id')
      .eq('conversation_id', convRaw)
      .maybeSingle();
    if (selErr) {
      console.error('[joost-conversation-state PATCH] select error:', selErr.message);
      return res.status(500).json({ error: selErr.message });
    }

    let updatedRow = null;

    if (existing) {
      // UPDATE: alleen de meegegeven paused-velden aanraken; counters
      // (messages_sent_today / _total / last_message_sent_at) blijven ongemoeid.
      const patch = {};
      if (reasonProvided) patch.autonomy_paused_reason = pausedReason;
      if (untilProvided || isResume) patch.autonomy_paused_until = pausedUntil;

      const { data: upd, error: updErr } = await supabaseAdmin
        .from('joost_conversation_state')
        .update(patch)
        .eq('conversation_id', convRaw)
        .select(STATE_COLUMNS)
        .single();
      if (updErr) {
        console.error('[joost-conversation-state PATCH] update error:', updErr.message);
        return res.status(500).json({ error: updErr.message });
      }
      updatedRow = upd;
    } else {
      // INSERT: row bestaat nog niet -- maak hem aan met paused-fields, alle
      // counters op default (0 / null). NOT NULL kolommen hebben DB-defaults.
      const insertPayload = {
        conversation_id:        convRaw,
        autonomy_paused_reason: pausedReason,
        autonomy_paused_until:  pausedUntil,
      };
      const { data: ins, error: insErr } = await supabaseAdmin
        .from('joost_conversation_state')
        .insert(insertPayload)
        .select(STATE_COLUMNS)
        .single();
      if (insErr) {
        // Race: andere call insertte intussen -> retry als UPDATE.
        if (insErr.code === '23505') {
          const patch = {
            autonomy_paused_reason: pausedReason,
            autonomy_paused_until:  pausedUntil,
          };
          const { data: upd2, error: upd2Err } = await supabaseAdmin
            .from('joost_conversation_state')
            .update(patch)
            .eq('conversation_id', convRaw)
            .select(STATE_COLUMNS)
            .single();
          if (upd2Err) {
            console.error('[joost-conversation-state PATCH] race-update error:', upd2Err.message);
            return res.status(500).json({ error: upd2Err.message });
          }
          updatedRow = upd2;
        } else {
          console.error('[joost-conversation-state PATCH] insert error:', insErr.message);
          return res.status(500).json({ error: insErr.message });
        }
      } else {
        updatedRow = ins;
      }
    }

    // ------------------------------------------------------------------------
    // STAP 2: audit-log (fail-soft).
    // ------------------------------------------------------------------------
    try {
      const action = isResume ? 'joost.autonomy_resumed' : 'joost.autonomy_paused';
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action,
        entity_type: 'whatsapp_conversation',
        entity_id:   convRaw,
        after_json:  {
          autonomy_paused_reason: pausedReason,
          autonomy_paused_until:  pausedUntil,
        },
        reason_text: pausedReason ? pausedReason.slice(0, 500) : null,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[joost-conversation-state audit]', e && e.message);
    }

    return res.status(200).json({ state: { ...updatedRow, is_default: false } });
  } catch (e) {
    console.error('[joost-conversation-state PATCH] exception:', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
