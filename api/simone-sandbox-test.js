// api/simone-sandbox-test.js
// POST -> Test Simone met een fake klantvraag zonder een echte
// conversation/attendee te bevuilen.
//
// Use-case: Jeffrey wil weten welk antwoord Simone genereert op een
// hypothetische vraag, en welk autonomie-besluit er volgt — zonder
// een test-attendee aan te maken of een echte klant te raken.
//
// Ontwerp: transactioneel-tijdelijk.
//   1. INSERT dummy whatsapp_conversations (phone='+99999<rnd>',
//      phone_number_id=events WABA).
//   2. INSERT dummy whatsapp_messages (direction='in', body=text).
//   3. Roep runSimoneSuggest aan → produceert joost_suggestions-rij.
//   4. Lees suggested_reply + detected_intent + confidence + reasoning.
//   5. Roep evaluateSimoneAutonomy aan met minimale convState.
//   6. CLEANUP (try/finally): DELETE joost_suggestions →
//      whatsapp_messages (CASCADE bij conv-delete maar expliciet) →
//      whatsapp_conversations.
//
// RBAC: events.simone.use (zelfde als api/simone-suggest.js).
//
// Body:
//   {
//     message_text: string (verplicht, max 1000 chars),
//     persona_naam?: string (optioneel, momenteel ongebruikt — placeholder
//                            voor toekomstige variant met attendee-context)
//   }
//
// Response 200:
//   {
//     ok: true,
//     suggestion: { suggested_reply, detected_intent, confidence, reasoning },
//     autonomy:   { allow_autonomous, blocked_reason, stop_action,
//                   decision_log, mode, intent, confidence }
//   }
// Response (door-mapped van runSimoneSuggest):
//   429: rate-limit (niet relevant in sandbox-conv die telkens nieuw is, maar zekerheidshalve doorgegeven)
//   422: model-error / parse-fail
//   503: ANTHROPIC_API_KEY ontbreekt / config ontbreekt
//   400: validatie-fout op body
//   500: interne fout

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { runSimoneSuggest } from './_lib/simone-suggest-core.js';
import { evaluateSimoneAutonomy } from './simone-autonomy-evaluate.js';

const MAX_MESSAGE_CHARS = 1000;
// Niet-geroutbare prefix. +99999 valt geen land toe — voorkomt elke kans
// dat een sandbox-rij collide't met een echte E.164-klantnummer.
const SANDBOX_PHONE_PREFIX = '+99999';

function makeSandboxPhone() {
  const rnd = crypto.randomBytes(4).toString('hex');
  return SANDBOX_PHONE_PREFIX + rnd;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.simone.use'))) {
    return res.status(403).json({ error: 'Geen rechten (events.simone.use)' });
  }

  const body = req.body || {};
  const messageText = typeof body.message_text === 'string' ? body.message_text.trim() : '';
  if (!messageText) return res.status(400).json({ error: 'message_text vereist' });
  if (messageText.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: `message_text mag max ${MAX_MESSAGE_CHARS} chars zijn` });
  }

  // Resolve events-WABA phone_number_id (zelfde patroon als events-send.js).
  let eventsPnId = null;
  try {
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'events')
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) throw new Error(modErr.message);
    eventsPnId = modCfg?.phone_number_id || null;
  } catch (e) {
    console.error('[simone-sandbox-test] module-config:', e?.message || e);
    return res.status(503).json({ error: 'Events-WABA module-config lookup faalde' });
  }
  if (!eventsPnId) {
    return res.status(503).json({
      error: 'Geen actieve events-lijn geconfigureerd in whatsapp_module_config (module=events).',
    });
  }

  let convId = null;
  let msgId  = null;
  const sandboxPhone = makeSandboxPhone();
  const nowIso = new Date().toISOString();

  try {
    // STAP 1: dummy whatsapp_conversations.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .insert({
        phone_number:    sandboxPhone,
        phone_number_id: eventsPnId,
        customer_id:     null,
        display_name:    'Simone sandbox',
        status:          'open',
        last_inbound_at: nowIso,
      })
      .select('id')
      .single();
    if (convErr) throw new Error('conv insert: ' + convErr.message);
    convId = conv.id;

    // STAP 2: dummy inbound message.
    const { data: msg, error: msgErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id: convId,
        direction:       'in',
        body:            messageText,
        status:          'delivered',
        sent_at:         nowIso,
      })
      .select('id')
      .single();
    if (msgErr) throw new Error('message insert: ' + msgErr.message);
    msgId = msg.id;

    // Gebruik supabaseAdmin (service-role): de dummy-conv is via admin
    // INSERT'd en is niet zichtbaar voor de user-client door RLS. RBAC is
    // al op endpoint-niveau gecheckt (events.simone.use).
    const result = await runSimoneSuggest({
      supabase:             supabaseAdmin,
      conversationId:       convId,
      triggeredByMessageId: msgId,
      autoTriggered:        false,
      requestedByUserId:    user.id,
      clientIp:             null,
    });

    if (result.status !== 200) {
      // 429 / 422 / 503 / 404: gewoon doorgeven (zonder details die de UI
      // niet verwacht). Cleanup loopt via finally.
      return res.status(result.status).json(result.body || { error: 'Simone-fout' });
    }

    const suggestion = result.body?.suggestion || null;
    if (!suggestion || !suggestion.id) {
      return res.status(500).json({ error: 'Simone suggestion ontbreekt in respons' });
    }

    // STAP 4: lees autonomy_config + evalueer.
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, autonomy_config, feature_flags, is_enabled')
      .eq('module', 'events')
      .maybeSingle();
    if (cfgErr) {
      console.error('[simone-sandbox-test] cfg lookup:', cfgErr.message);
    }

    // Minimale convState: leeg gesprek, niet gepauzeerd, binnen 24h-window
    // (last_inbound_at = nowIso). assistant_messages_count_24h en
    // last_assistant_at NULL omdat dit een vers gesprek is.
    const convState = {
      messages_sent_today:        0,
      messages_sent_today_date:   null,
      messages_sent_total:        0,
      last_message_sent_at:       null,
      autonomy_paused_until:      null,
      autonomy_paused_reason:     null,
      no_reply_streak_count:      0,
      last_inbound_at:            nowIso,
    };
    const decision = evaluateSimoneAutonomy({
      suggestion,
      convState,
      cfg: cfg || {},
      now: new Date(),
    });

    return res.status(200).json({
      ok: true,
      suggestion: {
        suggested_reply: suggestion.suggested_reply || '',
        detected_intent: suggestion.detected_intent || null,
        confidence:      typeof suggestion.confidence === 'number' ? suggestion.confidence : null,
        reasoning:       suggestion.reasoning || '',
      },
      autonomy: {
        allow_autonomous: !!decision.allow_autonomous,
        blocked_reason:   decision.blocked_reason || null,
        stop_action:      decision.stop_action || null,
        decision_log:     Array.isArray(decision.decision_log) ? decision.decision_log : [],
        mode:             decision.mode || null,
        intent:           decision.intent || null,
        confidence:       decision.confidence,
      },
    });
  } catch (e) {
    console.error('[simone-sandbox-test]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  } finally {
    if (convId) {
      // Expliciet logging per stap zodat een silent fout VOORTAAN zichtbaar
      // is in Vercel logs. CASCADE op whatsapp_conversations zou messages +
      // suggestions + conversation_state automatisch meenemen; we doen ze
      // toch expliciet (idempotent) om aparte fout-paden te isoleren.
      try {
        const r1 = await supabaseAdmin.from('joost_suggestions').delete().eq('conversation_id', convId).select('id');
        console.log('[simone-sandbox cleanup] joost_suggestions deleted:', r1?.data?.length ?? 0, 'err=', r1?.error?.message || 'none');
      } catch (e) { console.error('[simone-sandbox cleanup] joost_suggestions THREW:', e?.message || e); }
      try {
        const r2 = await supabaseAdmin.from('whatsapp_messages').delete().eq('conversation_id', convId).select('id');
        console.log('[simone-sandbox cleanup] whatsapp_messages deleted:', r2?.data?.length ?? 0, 'err=', r2?.error?.message || 'none');
      } catch (e) { console.error('[simone-sandbox cleanup] whatsapp_messages THREW:', e?.message || e); }
      try {
        const r3 = await supabaseAdmin.from('whatsapp_conversations').delete().eq('id', convId).select('id');
        console.log('[simone-sandbox cleanup] whatsapp_conversations deleted:', r3?.data?.length ?? 0, 'err=', r3?.error?.message || 'none');
      } catch (e) { console.error('[simone-sandbox cleanup] whatsapp_conversations THREW:', e?.message || e); }
    }
  }
}
