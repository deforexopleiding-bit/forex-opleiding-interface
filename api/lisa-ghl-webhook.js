// api/lisa-ghl-webhook.js
// Webhook-ontvanger voor GHL Instagram-replies → Lisa genereert + verstuurt (of plant) een antwoord.
//
// Auth: ?secret=LISA_WEBHOOK_SECRET (statisch query-param).
// Geeft ALTIJD 200 terug (met skip/ok/error in body) behalve bij ontbrekend/ongeldig secret,
// zodat GHL niet eindeloos blijft retryen.
//
// Flow: secret → parse → settings → (live? kantooruren?) → conversatie → generateLisaResponse
//       → in kantooruren: direct sturen; daarbuiten: pre-genereren + plannen in lisa_followups.

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { computeResponseDelay, sendTypingIndicator, matchBookingByEmail } from './_lib/lisa-ghl-send.js';
import { generateLisaResponse } from './lisa-respond.js';
import { detectStopSignal, containsAgendaLink, schedulePostLinkFollowups, autoQualifyIfTriggered, pauseFollowupsForDisqualified } from './_lib/lisa-followup.js';
import { isInstagram, resolveContent } from './_lib/lisa-message-type.js';
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

  // 1. Secret — [H-03 fix 2026-08-25] Dual-mode: header X-Lisa-Webhook-Secret
  // (voorkeur, geen URL-leak) + query-fallback voor backwards-compat totdat
  // Jeffrey de GHL-webhook-URL heeft omgezet. Constant-time compare.
  // ACTIE JEFFREY: zet GHL Custom Webhook actions om zodat het secret via
  // header X-Lisa-Webhook-Secret gaat i.p.v. ?secret=… — daarna kan de
  // query-fallback in een vervolg-commit weg.
  const expectedSecret = process.env.LISA_WEBHOOK_SECRET;
  if (!expectedSecret) { console.error('[lisa-ghl-webhook] LISA_WEBHOOK_SECRET niet gezet'); return res.status(500).json({ error: 'Server misconfigured' }); }
  const headerSecret = req.headers['x-lisa-webhook-secret'] || '';
  const querySecret  = req.query?.secret || '';
  const provided = String(headerSecret || querySecret || '');
  let secretOk = false;
  try {
    if (provided.length === expectedSecret.length) {
      secretOk = crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expectedSecret, 'utf8'));
    }
  } catch (_) { secretOk = false; }
  if (!secretOk) { console.warn('[lisa-ghl-webhook] ongeldig secret'); return res.status(401).json({ error: 'Unauthorized' }); }

  try {
    // 2. Payload — GHL nest onze data onder customData; val terug op GHL-standaardvelden
    //    (snake_case / geneste objecten) en dan op flat top-level (test-fetch).
    const body = req.body || {};
    const customData = body.customData || {};
    const payload = {
      contactId: customData.contactId || body.contact_id || body.contactId,
      conversationId: customData.conversationId || body.conversation_id || body.conversationId,
      locationId: customData.locationId || body.location?.id || body.locationId,
      // BP3 (2026-09-02) — GHL Custom Data 'Message Id' + 'Message Attachments'
      // worden nu via customData meegestuurd. Val terug op body.message.id /
      // body.messageId voor backward-compat.
      messageId: customData.messageId || body.message?.id || body.messageId,
      attachments: customData.attachments != null ? customData.attachments
        : (body.message?.attachments != null ? body.message.attachments : body.attachments),
      message: customData.message || body.message?.body || (typeof body.message === 'string' ? body.message : null),
      type: customData.type || body.type,
      direction: customData.direction || body.direction,
      // Naam/IG (GHL standaard-data, niet customData):
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      full_name: body.full_name || null,
      ig_sid: body.contact?.attributionSource?.igSid || body.contact?.lastAttributionSource?.igSid || null,
    };
    const { contactId, conversationId, locationId, message, type, direction, messageId, attachments: rawAttachments } = payload;
    // BP3 (2026-09-01) fix #2 — tolerant type-match via isInstagram(): accepteert
    // 'IG' / 'Instagram' / 'instagram_dm' / numeriek '8' / 'TYPE_IG', etc.
    // Voorheen: strikte type !== 'IG' skipte legitieme varianten.
    if (!isInstagram(payload) || direction !== 'inbound') {
      return res.status(200).json({ skipped: 'not_ig_inbound' });
    }
    // BP3 (2026-09-01) fix #1 — een bericht ZONDER body is nog steeds een
    // bericht (foto, reel, sticker, story-reply, voice). Alleen skippen als
    // er GEEN contactId is (dan kunnen we het bericht nergens aan hangen).
    if (!contactId) return res.status(200).json({ skipped: 'missing_contact_id' });
    // resolveContent() geeft altijd { message_type <whitelist>, content <niet-leeg>,
    // attachment_url <string|null> }. Attachments-input komt uit customData
    // (Message Attachments) én de standaard-body-paden als fallback.
    const { message_type: msgType, content: msgContent, attachment_url: msgAttachmentUrl } = resolveContent({
      type, messageType: type, body: message, attachments: rawAttachments,
    });

    // Meta/UTM-attributie vangen — body.contact bevat de attributionSource +
    // lastAttributionSource al vanuit GHL's webhook, dus geen extra fetch.
    // Best-effort + dynamic import (helper is nog niet overal beschikbaar
    // bij eerste deploy zonder de #820-lead-attribution migratie).
    if (body?.contact) {
      try {
        const { upsertLeadAttribution } = await import('./_lib/lead-attribution.js');
        await upsertLeadAttribution({
          ghl_contact_id: contactId,
          email:          body.contact.email || null,
          phone:          body.contact.phone || null,
          attr:           body.contact,
        });
      } catch (e) {
        console.warn('[lisa-webhook] attribution upsert:', e?.message || e);
      }
    }

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

    // ═══════════════════════════════════════════════════════════════════
    // BP3 v5 (2026-09-02) — INGEST ALTIJD, ONAFHANKELIJK VAN LIVE_MODE.
    //
    // Voorheen zat conv-lookup + insert verspreid over 5 takken (LIVE_MODE_OFF,
    // human_takeover, stop_signal, media, refusal, main) — met silent-error
    // op de upsert (geen { error }-destructure). Ingest kon stil falen
    // terwijl de webhook `ingested: true` returnde.
    //
    // Nieuwe flow:
    //   1. Ensure conversation (aanmaken bij eerste bericht).
    //   2. Insert inbound message met HARDE error-check.
    //   3. Duplicate (23505) → return 'duplicate_delivery' (voorkomt AI-retry).
    //   4. Andere error → return ingest_error (zichtbaar in GHL Event-Details).
    //   5. !live_mode → return 'live_mode_off, ingested: true' (skip AI).
    //   6. live_mode → doorgaan naar takeover/stop/media/AI (geen insert meer).
    //
    // We gebruiken .insert() + 23505-catch i.p.v. .upsert() met onConflict-
    // hint, omdat PostgREST partial UNIQUE-indices niet betrouwbaar als
    // conflict-target accepteert (had silent-failure gegeven).
    // ═══════════════════════════════════════════════════════════════════

    // Ensure conversation. Phase 'intro' als live_mode aan (Lisa gaat straks
    // reageren), 'cold' als live_mode uit (puur-ingest, geen intake).
    const computedName = payload.full_name || [payload.first_name, payload.last_name].filter(Boolean).join(' ').trim() || null;
    let { data: conv, error: convSelErr } = await supabaseAdmin.from('lisa_conversations').select('*')
      .eq('ghl_contact_id', contactId).eq('is_sandbox', false).maybeSingle();
    if (convSelErr) {
      console.error('[lisa-ghl-webhook] conv select faalde:', convSelErr.code, convSelErr.message);
      await logWebhookError('conv_select: ' + convSelErr.message);
      return res.status(200).json({ ok: false, ingest_error: convSelErr.message, phase: 'conv_select' });
    }
    if (!conv) {
      const initialPhase = settings.live_mode_enabled ? 'intro' : 'cold';
      const { data: newConv, error: convErr } = await supabaseAdmin.from('lisa_conversations').insert({
        ghl_contact_id: contactId, ghl_conversation_id: conversationId || null, ghl_location_id: locationId || null,
        first_name: payload.first_name, last_name: payload.last_name, contact_name: computedName, ig_sid: payload.ig_sid,
        source: 'instagram', is_sandbox: false, phase: initialPhase, first_message_at: new Date().toISOString(),
      }).select('*').single();
      if (convErr) {
        console.error('[lisa-ghl-webhook] conv insert faalde:', convErr.code, convErr.message);
        await logWebhookError('conv_insert: ' + convErr.message);
        return res.status(200).json({ ok: false, ingest_error: convErr.message, phase: 'conv_insert' });
      }
      conv = newConv;
    } else if (!conv.contact_name && computedName) {
      // Naam nu pas beschikbaar → invullen (geen overschrijf van bestaande naam).
      await supabaseAdmin.from('lisa_conversations').update({
        first_name: payload.first_name, last_name: payload.last_name, contact_name: computedName, ig_sid: payload.ig_sid || conv.ig_sid,
      }).eq('id', conv.id);
      conv.contact_name = computedName;
    }

    // Persist inbound message met HARDE error-check.
    const { error: msgInsErr } = await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conv.id,
      direction:       'in',
      content:         msgContent,
      message_type:    msgType,
      attachment_url:  msgAttachmentUrl,
      ai_generated:    false,
      ghl_message_id:  messageId || null,
    });
    const wasDuplicate = !!(msgInsErr && msgInsErr.code === '23505');
    if (msgInsErr && !wasDuplicate) {
      console.error('[lisa-ghl-webhook] persist inbound faalde:',
        msgInsErr.code, msgInsErr.message, msgInsErr.details || '', msgInsErr.hint || '');
      await logWebhookError('persist_inbound[' + msgInsErr.code + ']: ' + msgInsErr.message);
      return res.status(200).json({
        ok: false, ingest_error: msgInsErr.message, code: msgInsErr.code,
        conv_id: conv.id, message_type: msgType,
        received_attachments: rawAttachments ?? null, received_messageId: messageId ?? null,
      });
    }

    // Counter tikken (ook bij duplicate — GHL heeft ons alsnog benaderd).
    await supabaseAdmin.from('lisa_settings').update({
      live_messages_received_total: (settings.live_messages_received_total || 0) + 1,
    }).eq('id', 1);

    // Duplicate → skip AI (voorkomt burst bij GHL-retry).
    if (wasDuplicate) {
      console.log('[lisa-ghl-webhook] duplicate delivery — insert skipped', { messageId });
      return res.status(200).json({
        ok: true, skipped: 'duplicate_delivery', ghl_message_id: messageId, conv_id: conv.id,
      });
    }

    // 4. Live mode UIT → geen AI, geen scheduling. Ingest is al gebeurd.
    if (!settings.live_mode_enabled) {
      return res.status(200).json({
        ok: true, skipped: 'live_mode_off', ingested: true,
        conv_id: conv.id, message_type: msgType, attachment_url: msgAttachmentUrl,
        received_attachments: rawAttachments ?? null, received_messageId: messageId ?? null,
      });
    }

    // 5. Kantooruren (in tz, minuut-precisie)
    const tz = settings.office_hours_timezone || 'Europe/Amsterdam';
    const nowTz = dayjs().tz(tz);
    const curMins = nowTz.hour() * 60 + nowTz.minute();
    const [sh, sm] = String(settings.office_hours_start || '07:00').split(':').map((x) => parseInt(x, 10) || 0);
    const [eh, em] = String(settings.office_hours_end || '23:30').split(':').map((x) => parseInt(x, 10) || 0);
    const isInOfficeHours = curMins >= (sh * 60 + sm) && curMins < (eh * 60 + em);

    // 6. Actieve config (voor stop_keywords + AI-generate).
    const { data: config } = await supabaseAdmin.from('lisa_config').select('*')
      .eq('is_active', true).order('version', { ascending: false }).limit(1).maybeSingle();
    if (!config) { await logWebhookError('Geen actieve Lisa-config'); return res.status(200).json({ ok: false, error: 'no_active_config' }); }

    // Conversatie is al opgehaald/aangemaakt bovenaan (BP3 v5 hoisting).
    // De onderstaande takken doen GEEN insert meer — bericht is al opgeslagen.

    // 7b. Mens heeft overgenomen → Lisa zwijgt.
    if (conv.human_takeover) {
      return res.status(200).json({ ok: true, skipped: 'human_takeover', conv_id: conv.id });
    }

    // 7c. Stop-signaal → afmelden: pauzeer follow-ups, geen AI-antwoord.
    const stop = detectStopSignal(message, config.stop_keywords || []);
    if (stop) {
      await supabaseAdmin.from('lisa_conversations').update({
        stop_detected_at: new Date().toISOString(), stop_detected_keyword: stop.keyword,
        followup_paused: true, followup_paused_at: new Date().toISOString(),
        followup_paused_reason: `stop_signal: ${stop.keyword}`,
      }).eq('id', conv.id);
      await supabaseAdmin.from('lisa_followups').update({
        status: 'cancelled', cancelled_reason: `stop_signal: ${stop.keyword}`.slice(0, 300),
      }).eq('conversation_id', conv.id).eq('status', 'scheduled');
      return res.status(200).json({ ok: true, skipped: 'stop_signal_detected', keyword: stop.keyword, conv_id: conv.id });
    }

    // BP3 (2026-09-01) — media-bericht (foto/reel/story/etc) heeft geen
    // tekst-body waar Lisa zinvol op kan reageren. Sla AI-flow over.
    if (msgType !== 'text') {
      return res.status(200).json({
        ok: true, ingested: true, message_type: msgType, ai_skipped: 'media_message',
        conv_id: conv.id, attachment_url: msgAttachmentUrl,
        received_attachments: rawAttachments ?? null,
        received_messageId:   messageId      ?? null,
      });
    }

    // 8. AI genereren (geen persistentie binnen helper) — alleen voor tekst.
    const result = await generateLisaResponse({ config, conversation: conv, userMessage: message });

    // 8b. Refusal-guard: als het model geweigerd heeft, log system-note maar
    // NIET versturen naar klant. Inbound is al opgeslagen bovenaan.
    if (!result.ok && result.error === 'refusal_detected') {
      // System-note (outbound intern, geen ghl_message_id → gewone insert).
      await supabaseAdmin.from('lisa_messages').insert({
        conversation_id: conv.id, direction: 'out', is_system: true, ai_generated: false, message_type: 'text',
        content: `⚠ AI-weigering geblokkeerd (${result.refusal_reason}). Geen bericht verstuurd. Raw: ${(result.raw_response || '').slice(0, 200)}`,
      });
      console.warn('[lisa-ghl-webhook] refusal blocked, no send', { conv_id: conv.id, reason: result.refusal_reason });
      return res.status(200).json({ ok: false, blocked: 'refusal_detected', reason: result.refusal_reason, conv_id: conv.id });
    }

    if (!result.ok) { await logWebhookError('AI: ' + result.error); return res.status(200).json({ ok: false, ai_failed: true, error: result.error }); }

    // 9b. Door de volger opgegeven gegevens opslaan + (fire-and-forget) GHL-contact-match.
    const dd = result.detected_data || {};
    const convUpd = {};
    if (dd.email && !conv.confirmed_email) convUpd.confirmed_email = dd.email;
    if (dd.phone && !conv.confirmed_phone) convUpd.confirmed_phone = dd.phone;
    if (dd.name && dd.name !== conv.contact_name) convUpd.contact_name = dd.name;
    if (Object.keys(convUpd).length) {
      await supabaseAdmin.from('lisa_conversations').update(convUpd).eq('id', conv.id);
      Object.assign(conv, convUpd);
    }
    if (dd.email && conv.booking_match_status !== 'matched') {
      matchBookingByEmail(conv.id, dd.email, conv.ghl_location_id).catch((e) => console.error('[booking-match] bg fail:', e?.message || e));
    }

    // 9c. Agenda-link gedetecteerd in Lisa's antwoord → plan post-link follow-ups (eenmalig).
    if (settings.post_link_followup_enabled !== false && containsAgendaLink(result.response) && !conv.post_link_followups_scheduled) {
      await schedulePostLinkFollowups(conv.id, settings);
      await supabaseAdmin.from('lisa_conversations').update({
        agenda_link_sent_at: new Date().toISOString(), post_link_followups_scheduled: true,
      }).eq('id', conv.id);
      conv.post_link_followups_scheduled = true;
    }

    // 9d. Auto-qualify (F14): agenda-link verstuurd of phase=call → qualified.
    const aq = await autoQualifyIfTriggered({ conv, aiResponseText: result.response, detectedPhase: result.detected_phase });
    if (aq.triggered) { conv.qualified = true; console.log('[auto-qualify] conv', conv.id, aq.reasons.join(',')); }

    // 9e. Auto-disqualify (nieuw aug-2026): als de AI phase='disqualified' teruggeeft
    // OF de user een soft-decline heeft geuit die niet door detectStopSignal is
    // gevangen (kwam nu wél in HARDCODED_STOP_KEYWORDS te staan, maar deze extra
    // hook vangt AI-classificatie op die soms voor het keyword-signaal komt).
    // Pauzeert follow-ups + cancelt alle scheduled zodat de burst niet ontstaat.
    if (result.detected_phase === 'disqualified' && !conv.followup_paused) {
      const dq = await pauseFollowupsForDisqualified(conv.id, 'ai_detected_disqualified');
      if (dq.ok && !dq.already) {
        console.log('[auto-disqualify] conv', conv.id, 'paused +', dq.cancelled_count, 'cancelled');
        conv.followup_paused = true;
      }
    }

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
      return res.status(200).json({
        ok: true, queued: true, scheduled_for: scheduledFor, delay_ms: delayMs, conv_id: conv.id,
        received_attachments: rawAttachments ?? null, received_messageId: messageId ?? null,
      });
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
    return res.status(200).json({
      ok: true, delayed: true, scheduled_for: scheduledFor, conv_id: conv.id,
      received_attachments: rawAttachments ?? null, received_messageId: messageId ?? null,
    });
  } catch (err) {
    console.error('[lisa-ghl-webhook] error:', err?.message || err);
    await logWebhookError(err?.message || 'onbekende fout');
    return res.status(200).json({ ok: false, error: err?.message || 'onbekende fout' });
  }
}
