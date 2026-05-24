// api/cron-lisa-delayed.js
// Cron: verstuurt pre-gegenereerde "delayed" antwoorden (buiten kantooruren gemaakt) zodra
// het binnen kantooruren is. Draait elke 5 min (vercel.json). Auth: CRON_SECRET (checkCronAuth).
//
// Stappen: auth → settings (live + kantooruren) → queue (lisa_followups, is_delayed_response,
// scheduled_for <= nu) → per item via GHL versturen → lisa_messages + followup-status bijwerken
// → tellers. Geen retry (MVP): mislukte send → status 'cancelled' met reden.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendToGhl } from './_lib/lisa-ghl-send.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);

const BATCH_LIMIT = 20;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  try {
    // 1. Settings
    const { data: settings } = await supabaseAdmin.from('lisa_settings')
      .select('live_mode_enabled, office_hours_start, office_hours_end, office_hours_timezone, live_messages_sent_total, delayed_messages_pending')
      .eq('id', 1).maybeSingle();
    if (!settings) return res.status(200).json({ skipped: 'no_settings' });

    // 2. Live mode
    if (!settings.live_mode_enabled) {
      return res.status(200).json({ skipped: 'live_mode_off', pending: settings.delayed_messages_pending });
    }

    // 3. Kantooruren (tz, minuut-precisie — consistent met webhook)
    const tz = settings.office_hours_timezone || 'Europe/Amsterdam';
    const now = dayjs().tz(tz);
    const curMins = now.hour() * 60 + now.minute();
    const [sh, sm] = String(settings.office_hours_start || '07:00').split(':').map((x) => parseInt(x, 10) || 0);
    const [eh, em] = String(settings.office_hours_end || '23:30').split(':').map((x) => parseInt(x, 10) || 0);
    if (!(curMins >= sh * 60 + sm && curMins < eh * 60 + em)) {
      return res.status(200).json({
        skipped: 'outside_office_hours', now: now.format('HH:mm'),
        window: `${settings.office_hours_start}-${settings.office_hours_end}`, pending: settings.delayed_messages_pending,
      });
    }

    // 4. Queue ophalen (scheduled + verlopen)
    const { data: followups, error: fuErr } = await supabaseAdmin.from('lisa_followups')
      .select('id, conversation_id, scheduled_for, pre_generated_response, lisa_conversations!inner(id, ghl_contact_id, ghl_conversation_id, ghl_location_id)')
      .eq('is_delayed_response', true).eq('status', 'scheduled')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH_LIMIT);
    if (fuErr) { console.error('[cron-lisa-delayed] query error:', fuErr.message); return res.status(500).json({ error: fuErr.message }); }
    if (!followups || followups.length === 0) return res.status(200).json({ ok: true, sent: 0, message: 'Geen delayed messages klaar' });

    // 5. Verwerken
    const results = [];
    let sentCount = 0, failedCount = 0, cancelledCount = 0;

    for (const fu of followups) {
      const conv = fu.lisa_conversations;
      if (!conv?.ghl_contact_id || !fu.pre_generated_response) {
        await supabaseAdmin.from('lisa_followups').update({ status: 'cancelled', cancelled_reason: 'missing_contact_or_response' }).eq('id', fu.id);
        cancelledCount++; results.push({ id: fu.id, status: 'cancelled', reason: 'missing_data' });
        continue;
      }

      const sendResult = await sendToGhl(conv.ghl_contact_id, fu.pre_generated_response, {
        conversationId: conv.ghl_conversation_id, locationId: conv.ghl_location_id,
      });

      if (sendResult.ok) {
        await supabaseAdmin.from('lisa_messages').insert({
          conversation_id: conv.id, direction: 'out', content: fu.pre_generated_response,
          ai_generated: true, is_followup: false, ghl_message_id: sendResult.message_id || null,
          sent_at: new Date().toISOString(),
        });
        await supabaseAdmin.from('lisa_followups').update({
          status: 'sent', sent_at: new Date().toISOString(), template_used: 'delayed_pre_generated', message_id: null,
        }).eq('id', fu.id);
        sentCount++; results.push({ id: fu.id, status: 'sent', ghl_message_id: sendResult.message_id });
      } else {
        await supabaseAdmin.from('lisa_followups').update({ status: 'cancelled', cancelled_reason: `send_failed: ${sendResult.error}`.slice(0, 300) }).eq('id', fu.id);
        failedCount++; results.push({ id: fu.id, status: 'failed', error: sendResult.error });
      }
    }

    // 6. Tellers (read-then-write) — elk verwerkt item verlaat de queue
    const resolved = sentCount + failedCount + cancelledCount;
    if (resolved > 0) {
      const { data: cur } = await supabaseAdmin.from('lisa_settings')
        .select('live_messages_sent_total, delayed_messages_pending').eq('id', 1).maybeSingle();
      await supabaseAdmin.from('lisa_settings').update({
        live_messages_sent_total: (cur?.live_messages_sent_total || 0) + sentCount,
        delayed_messages_pending: Math.max(0, (cur?.delayed_messages_pending || 0) - resolved),
      }).eq('id', 1);
    }

    return res.status(200).json({ ok: true, processed: followups.length, sent: sentCount, failed: failedCount, cancelled: cancelledCount, results });
  } catch (err) {
    console.error('[cron-lisa-delayed] error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'onbekende fout' });
  }
}
