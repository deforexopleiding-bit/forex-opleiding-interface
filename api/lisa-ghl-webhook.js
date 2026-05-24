// api/lisa-ghl-webhook.js
// Webhook-ontvanger voor GHL Instagram-replies → Lisa genereert + verstuurt (of plant) een antwoord.
//
// Auth: ?secret=LISA_WEBHOOK_SECRET (statisch query-param).
// Geeft ALTIJD 200 terug (met skip/ok/error in body) behalve bij ontbrekend/ongeldig secret,
// zodat GHL niet eindeloos blijft retryen.
//
// Flow: secret → parse → settings → (live? kantooruren?) → conversatie → generateLisaResponse
//       → in kantooruren: direct sturen; daarbuiten: pre-genereren + plannen in lisa_followups.

import { supabaseAdmin } from './supabase.js';
import { computeResponseDelay, sendTypingIndicator } from './_lib/lisa-ghl-send.js';
import { generateLisaResponse } from './lisa-respond.js';
import { detectStopSignal } from './_lib/lisa-followup.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);

function computeNextOfficeStart(startTime, tz) {
  const zone = tz || 'Europe/Amsterdam';
  const [h, m] = String(startTime || '07:00').split(':').map((x) => parseInt(x, 10) || 0);
  const now = dayjs().tz(zone);
  let target = now.hour(h).minute(m).second(0).millisecond(0);
  if (!target.isAfter(now)) target = target.add(1, 'day');
  return target.utc().toISOString();
}

async function logWebhookError(message) {
  try { await supabaseAdmin.from('lisa_settings').update({ ghl_webhook_last_error: String(message).slice(0, 500) }).eq('id', 1); } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Secret
  const expectedSecret = process.env.LISA_WEBHOOK_SECRET;
  if (!expectedSecret) { console.error('[lisa-ghl-webhook] LISA_WEBHOOK_SECRET niet gezet'); return res.status(500).json({ error: 'Server misconfigured' }); }
  if (req.query.secret !== expectedSecret) { console.warn('[lisa-ghl-webhook] ongeldig secret'); return res.status(401).json({ error: 'Unauthorized' }); }

  try {
    // 2. Payload — GHL nest onze data onder customData; val terug op GHL-standaardvelden
    //    (snake_case / geneste objecten) en dan op flat top-level (test-fetch).
    const body = req.body || {};
    const customData = body.customData || {};
    const payload = {
      contactId: customData.contactId || body.contact_id || body.contactId,
      conversationId: customData.conversationId || body.conversation_id || body.conversationId,
      locationId: customData.locationId || body.location?.id || body.locationId,
      messageId: customData.messageId || body.message?.id || body.messageId,
      message: customData.message || body.message?.body || (typeof body.message === 'string' ? body.message : null),
      type: customData.type || body.type,
      direction: customData.direction || body.direction,
      // Naam/IG (GHL standaard-data, niet customData):
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      full_name: body.full_name || null,
      ig_sid: body.contact?.attributionSource?.igSid || body.contact?.lastAttributionSource?.igSid || null,
    };
    const { contactId, conversationId, locationId, message, type, direction, messageId } = payload;
    if (type !== 'IG' || direction !== 'inbound') return res.status(200).json({ skipped: 'not_ig_inbound' });
    if (!contactId || !message) return res.status(200).json({ skipped: 'missing_fields' });

    // 3. Settings + webhook-tracking
    const { data: settings } = await supabaseAdmin.from('lisa_settings')
      .select('*')
      .eq('id', 1).maybeSingle();
    if (!settings) { await logWebhookError('lisa_settings ontbreekt (migratie 005?)'); return res.status(200).json({ ok: false, error: 'no_settings' }); }

    await supabaseAdmin.from('lisa_settings').update({
      ghl_webhook_active: true,
      ghl_webhook_last_received_at: new Date().toISOString(),
      ghl_webhook_total_received: (settings.ghl_webhook_total_received || 0) + 1,
      ghl_webhook_last_error: null,
    }).eq('id', 1);

    // 4. Live mode?
    if (!settings.live_mode_enabled) return res.status(200).json({ skipped: 'live_mode_off' });

    // 5. Kantooruren (in tz, minuut-precisie)
    const tz = settings.office_hours_timezone || 'Europe/Amsterdam';
    const nowTz = dayjs().tz(tz);
    const curMins = nowTz.hour() * 60 + nowTz.minute();
    const [sh, sm] = String(settings.office_hours_start || '07:00').split(':').map((x) => parseInt(x, 10) || 0);
    const [eh, em] = String(settings.office_hours_end || '23:30').split(':').map((x) => parseInt(x, 10) || 0);
    const isInOfficeHours = curMins >= (sh * 60 + sm) && curMins < (eh * 60 + em);

    // 6. Actieve config
    const { data: config } = await supabaseAdmin.from('lisa_config').select('*')
      .eq('is_active', true).order('version', { ascending: false }).limit(1).maybeSingle();
    if (!config) { await logWebhookError('Geen actieve Lisa-config'); return res.status(200).json({ ok: false, error: 'no_active_config' }); }

    // 7. Conversatie (per ghl_contact_id, live)
    const computedName = payload.full_name || [payload.first_name, payload.last_name].filter(Boolean).join(' ').trim() || null;
    let { data: conv } = await supabaseAdmin.from('lisa_conversations').select('*')
      .eq('ghl_contact_id', contactId).eq('is_sandbox', false).maybeSingle();
    if (!conv) {
      const { data: newConv, error: convErr } = await supabaseAdmin.from('lisa_conversations').insert({
        ghl_contact_id: contactId, ghl_conversation_id: conversationId || null, ghl_location_id: locationId || null,
        first_name: payload.first_name, last_name: payload.last_name, contact_name: computedName, ig_sid: payload.ig_sid,
        source: 'instagram', is_sandbox: false, phase: 'intro', first_message_at: new Date().toISOString(),
      }).select('*').single();
      if (convErr) { await logWebhookError('Conversatie aanmaken: ' + convErr.message); return res.status(200).json({ ok: false, error: convErr.message }); }
      conv = newConv;
    } else if (!conv.contact_name && computedName) {
      // Naam nu pas beschikbaar → invullen (geen overschrijf van bestaande naam).
      await supabaseAdmin.from('lisa_conversations').update({
        first_name: payload.first_name, last_name: payload.last_name, contact_name: computedName, ig_sid: payload.ig_sid || conv.ig_sid,
      }).eq('id', conv.id);
      conv.contact_name = computedName;
    }

    // 7b. Mens heeft overgenomen → Lisa zwijgt; bericht wel loggen.
    if (conv.human_takeover) {
      await supabaseAdmin.from('lisa_messages').insert({
        conversation_id: conv.id, direction: 'in', content: message, ai_generated: false, ghl_message_id: messageId || null,
      });
      await supabaseAdmin.from('lisa_settings').update({
        live_messages_received_total: (settings.live_messages_received_total || 0) + 1,
      }).eq('id', 1);
      return res.status(200).json({ ok: true, skipped: 'human_takeover', conv_id: conv.id });
    }

    // 7c. Stop-signaal → afmelden: pauzeer follow-ups, geen AI-antwoord.
    const stop = detectStopSignal(message, config.stop_keywords || []);
    if (stop) {
      await supabaseAdmin.from('lisa_messages').insert({
        conversation_id: conv.id, direction: 'in', content: message, ai_generated: false, ghl_message_id: messageId || null,
      });
      await supabaseAdmin.from('lisa_conversations').update({
        stop_detected_at: new Date().toISOString(), stop_detected_keyword: stop.keyword,
        followup_paused: true, followup_paused_at: new Date().toISOString(),
        followup_paused_reason: `stop_signal: ${stop.keyword}`,
      }).eq('id', conv.id);
      await supabaseAdmin.from('lisa_followups').update({
        status: 'cancelled', cancelled_reason: `stop_signal: ${stop.keyword}`.slice(0, 300),
      }).eq('conversation_id', conv.id).eq('status', 'scheduled');
      await supabaseAdmin.from('lisa_settings').update({
        live_messages_received_total: (settings.live_messages_received_total || 0) + 1,
      }).eq('id', 1);
      return res.status(200).json({ ok: true, skipped: 'stop_signal_detected', keyword: stop.keyword, conv_id: conv.id });
    }

    // 8. AI genereren (geen persistentie binnen helper)
    const result = await generateLisaResponse({ config, conversation: conv, userMessage: message });
    if (!result.ok) { await logWebhookError('AI: ' + result.error); return res.status(200).json({ ok: false, ai_failed: true, error: result.error }); }

    // 9. Inkomend bericht opslaan
    await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conv.id, direction: 'in', content: message, ai_generated: false, ghl_message_id: messageId || null,
    });

    // 10. Versturen: binnen kantooruren → response-delay QUEUE (geen blocking sleep; cron verstuurt).
    if (isInOfficeHours) {
      const delayMs = computeResponseDelay(settings, result.detected_phase);
      const scheduledFor = new Date(Date.now() + delayMs).toISOString();
      console.log(`[Lisa] response queued, delay ${delayMs}ms (mode=${settings.response_delay_mode}, phase=${result.detected_phase})`);

      // Fase bijwerken (detected_phase is alleen hier bekend; het bericht wordt later door de cron verstuurd).
      if (result.detected_phase && result.detected_phase !== conv.phase) {
        const patch = { phase: result.detected_phase };
        if (result.detected_phase === 'qualified') { patch.qualified = true; patch.qualified_at = new Date().toISOString(); }
        await supabaseAdmin.from('lisa_conversations').update(patch).eq('id', conv.id);
      }

      await supabaseAdmin.from('lisa_followups').insert({
        conversation_id: conv.id, followup_step: 0, scheduled_for: scheduledFor, status: 'scheduled',
        is_response_delay: true, is_delayed_response: false, is_regular_followup: false,
        pre_generated_response: result.response, pre_generated_at: new Date().toISOString(), template_used: 'response_delay',
      });

      // Typing-indicator (fire-and-forget) zodat de volger Lisa ziet "typen" tijdens de delay.
      if (settings.typing_indicator_enabled && delayMs >= 2000) {
        sendTypingIndicator(contactId, { conversationId, locationId }).catch((e) => console.log('[lisa-typing] bg fail:', e?.message || e));
      }

      await supabaseAdmin.from('lisa_settings').update({
        live_messages_received_total: (settings.live_messages_received_total || 0) + 1,
      }).eq('id', 1);
      return res.status(200).json({ ok: true, queued: true, scheduled_for: scheduledFor, delay_ms: delayMs, conv_id: conv.id });
    }

    // Buiten kantooruren → plannen voor eerstvolgende start
    const scheduledFor = computeNextOfficeStart(settings.office_hours_start, tz);
    await supabaseAdmin.from('lisa_followups').insert({
      conversation_id: conv.id, followup_step: 0, scheduled_for: scheduledFor, status: 'scheduled',
      is_delayed_response: true, pre_generated_response: result.response, pre_generated_at: new Date().toISOString(),
    });
    await supabaseAdmin.from('lisa_settings').update({
      live_messages_received_total: (settings.live_messages_received_total || 0) + 1,
      delayed_messages_pending: (settings.delayed_messages_pending || 0) + 1,
    }).eq('id', 1);
    return res.status(200).json({ ok: true, delayed: true, scheduled_for: scheduledFor, conv_id: conv.id });
  } catch (err) {
    console.error('[lisa-ghl-webhook] error:', err?.message || err);
    await logWebhookError(err?.message || 'onbekende fout');
    return res.status(200).json({ ok: false, error: err?.message || 'onbekende fout' });
  }
}
