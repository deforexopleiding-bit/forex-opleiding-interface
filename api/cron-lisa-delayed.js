// api/cron-lisa-delayed.js
// Cron (elke 5 min, vercel.json). Auth: CRON_SECRET (checkCronAuth). Draait alleen bij
// live_mode + binnen kantooruren. Verwerkt TWEE typen lisa_followups in één run:
//
//   1) is_delayed_response  → vooraf gegenereerd antwoord (buiten kantooruren) nu versturen
//                              + daarna de eerste reguliere follow-up plannen.
//   2) is_regular_followup   → sequence follow-up, met guards (volger geantwoord? fase/qualified
//                              veranderd? gepauzeerd/stop?) + AI of letterlijk (use_ai),
//                              daarna de volgende stap plannen.
//
// Geen retry (MVP): mislukte/ongeldige items → status 'cancelled' met reden. Guards = fail-safe.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendToGhl } from './_lib/lisa-ghl-send.js';
import { scheduleNextFollowup, generateFollowupResponse, evaluateConditions } from './_lib/lisa-followup.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);

const BATCH_LIMIT = 20;

async function cancelFollowup(id, reason) {
  await supabaseAdmin.from('lisa_followups').update({ status: 'cancelled', cancelled_reason: String(reason).slice(0, 300) }).eq('id', id);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  try {
    // 1. Settings
    const { data: settings } = await supabaseAdmin.from('lisa_settings')
      .select('live_mode_enabled, office_hours_start, office_hours_end, office_hours_timezone')
      .eq('id', 1).maybeSingle();
    if (!settings) return res.status(200).json({ skipped: 'no_settings' });
    if (!settings.live_mode_enabled) return res.status(200).json({ skipped: 'live_mode_off' });

    // 2. Kantooruren (tz, minuut-precisie)
    const tz = settings.office_hours_timezone || 'Europe/Amsterdam';
    const now = dayjs().tz(tz);
    const curMins = now.hour() * 60 + now.minute();
    const [sh, sm] = String(settings.office_hours_start || '07:00').split(':').map((x) => parseInt(x, 10) || 0);
    const [eh, em] = String(settings.office_hours_end || '23:30').split(':').map((x) => parseInt(x, 10) || 0);
    if (!(curMins >= sh * 60 + sm && curMins < eh * 60 + em)) {
      return res.status(200).json({ skipped: 'outside_office_hours', now: now.format('HH:mm') });
    }

    // 3. Actieve config (voor AI-follow-ups + volgende stap plannen)
    const { data: config } = await supabaseAdmin.from('lisa_config').select('*')
      .eq('is_active', true).order('version', { ascending: false }).limit(1).maybeSingle();

    // 4. Queue: delayed + regular, scheduled + verlopen
    const { data: followups, error: fuErr } = await supabaseAdmin.from('lisa_followups')
      .select('id, conversation_id, followup_step, scheduled_for, pre_generated_response, is_delayed_response, is_regular_followup, template_at_schedule, conditions_snapshot, used_ai, lisa_conversations!inner(id, ghl_contact_id, ghl_conversation_id, ghl_location_id, phase, qualified, call_booked, stop_detected_at, followup_paused)')
      .eq('status', 'scheduled')
      .or('is_delayed_response.eq.true,is_regular_followup.eq.true')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH_LIMIT);
    if (fuErr) { console.error('[cron-lisa-delayed] query error:', fuErr.message); return res.status(500).json({ error: fuErr.message }); }
    if (!followups || followups.length === 0) return res.status(200).json({ ok: true, sent: 0, message: 'Geen follow-ups klaar' });

    const results = [];
    let sentCount = 0, delayedResolved = 0;

    for (const fu of followups) {
      const conv = fu.lisa_conversations;
      if (!conv?.ghl_contact_id) {
        await cancelFollowup(fu.id, 'missing_contact');
        if (fu.is_delayed_response) delayedResolved++;
        results.push({ id: fu.id, status: 'cancelled', reason: 'missing_contact' });
        continue;
      }

      // ── Delayed response ────────────────────────────────────────────────────
      if (fu.is_delayed_response) {
        if (!fu.pre_generated_response) { await cancelFollowup(fu.id, 'missing_response'); delayedResolved++; results.push({ id: fu.id, status: 'cancelled', reason: 'missing_response' }); continue; }
        const sr = await sendToGhl(conv.ghl_contact_id, fu.pre_generated_response, { conversationId: conv.ghl_conversation_id, locationId: conv.ghl_location_id });
        if (sr.ok) {
          await supabaseAdmin.from('lisa_messages').insert({
            conversation_id: conv.id, direction: 'out', content: fu.pre_generated_response,
            ai_generated: true, is_followup: false, ghl_message_id: sr.message_id || null, sent_at: new Date().toISOString(),
          });
          await supabaseAdmin.from('lisa_followups').update({ status: 'sent', sent_at: new Date().toISOString(), template_used: 'delayed_pre_generated' }).eq('id', fu.id);
          // Eerste reguliere follow-up plannen na de delayed-respons.
          await scheduleNextFollowup({ conversationId: conv.id, currentStep: 0, config, conversation: conv });
          sentCount++; delayedResolved++; results.push({ id: fu.id, status: 'sent', type: 'delayed' });
        } else {
          await cancelFollowup(fu.id, `send_failed: ${sr.error}`); delayedResolved++; results.push({ id: fu.id, status: 'failed', error: sr.error });
        }
        continue;
      }

      // ── Regular follow-up ────────────────────────────────────────────────────
      // Guard A: volger heeft geantwoord (laatste bericht = inkomend) → annuleren.
      const { data: lastMsg } = await supabaseAdmin.from('lisa_messages')
        .select('direction').eq('conversation_id', conv.id).order('sent_at', { ascending: false }).limit(1).maybeSingle();
      if (lastMsg?.direction === 'in') { await cancelFollowup(fu.id, 'user_responded'); results.push({ id: fu.id, status: 'cancelled', reason: 'user_responded' }); continue; }

      // Guard B: state veranderd.
      if (conv.followup_paused || conv.stop_detected_at) { await cancelFollowup(fu.id, 'paused_or_stopped'); results.push({ id: fu.id, status: 'cancelled', reason: 'paused_or_stopped' }); continue; }
      if (conv.qualified || conv.call_booked) { await cancelFollowup(fu.id, 'qualified_or_booked'); results.push({ id: fu.id, status: 'cancelled', reason: 'qualified_or_booked' }); continue; }

      // Guard C: condities her-evalueren tegen huidige fase.
      if (!evaluateConditions(fu.conditions_snapshot, conv)) { await cancelFollowup(fu.id, 'conditions_not_met'); results.push({ id: fu.id, status: 'cancelled', reason: 'conditions_not_met' }); continue; }

      // Router: AI of letterlijk.
      let content = fu.template_at_schedule || '';
      if (fu.used_ai && fu.template_at_schedule) {
        const ai = await generateFollowupResponse({ conversation: conv, template: fu.template_at_schedule, followupStep: fu.followup_step });
        if (ai.ok) content = ai.response; // anders: fallback naar letterlijke template
      }
      if (!content) { await cancelFollowup(fu.id, 'empty_template'); results.push({ id: fu.id, status: 'cancelled', reason: 'empty_template' }); continue; }

      const sr = await sendToGhl(conv.ghl_contact_id, content, { conversationId: conv.ghl_conversation_id, locationId: conv.ghl_location_id });
      if (sr.ok) {
        await supabaseAdmin.from('lisa_messages').insert({
          conversation_id: conv.id, direction: 'out', content, ai_generated: !!fu.used_ai, is_followup: true,
          followup_step: fu.followup_step, ghl_message_id: sr.message_id || null, sent_at: new Date().toISOString(),
        });
        await supabaseAdmin.from('lisa_followups').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', fu.id);
        await supabaseAdmin.from('lisa_conversations').update({ last_followup_at: new Date().toISOString() }).eq('id', conv.id);
        // Volgende stap plannen (currentStep = zojuist verstuurde stap → index van de volgende).
        await scheduleNextFollowup({ conversationId: conv.id, currentStep: fu.followup_step, config, conversation: conv });
        sentCount++; results.push({ id: fu.id, status: 'sent', type: 'regular', used_ai: !!fu.used_ai });
      } else {
        await cancelFollowup(fu.id, `send_failed: ${sr.error}`); results.push({ id: fu.id, status: 'failed', error: sr.error });
      }
    }

    // Tellers (read-then-write): sent_total += alle sends; delayed_pending -= verwerkte delayed-items.
    if (sentCount > 0 || delayedResolved > 0) {
      const { data: cur } = await supabaseAdmin.from('lisa_settings')
        .select('live_messages_sent_total, delayed_messages_pending').eq('id', 1).maybeSingle();
      await supabaseAdmin.from('lisa_settings').update({
        live_messages_sent_total: (cur?.live_messages_sent_total || 0) + sentCount,
        delayed_messages_pending: Math.max(0, (cur?.delayed_messages_pending || 0) - delayedResolved),
      }).eq('id', 1);
    }

    return res.status(200).json({ ok: true, processed: followups.length, sent: sentCount, delayed_resolved: delayedResolved, results });
  } catch (err) {
    console.error('[cron-lisa-delayed] error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'onbekende fout' });
  }
}
