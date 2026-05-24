// api/lisa-ghl-appointment-webhook.js
// Webhook-ontvanger voor GHL appointment-events → Lisa werkt de conversatie automatisch bij.
//
// Auth: ?secret=LISA_WEBHOOK_SECRET (zelfde secret als de IG-webhook).
// Geeft ALTIJD 200 terug (behalve ontbrekend/ongeldig secret) → geen GHL-retry-storm.
// Stuurt GEEN bericht naar de volger (die krijgt al een GHL-bevestiging); logt alleen een
// systeem-event in de thread (is_system) en past de conversatie-status aan.

import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.LISA_WEBHOOK_SECRET;
  if (!expectedSecret) { console.error('[appointment-webhook] LISA_WEBHOOK_SECRET niet gezet'); return res.status(500).json({ error: 'Server misconfigured' }); }
  if (req.query.secret !== expectedSecret) { console.warn('[appointment-webhook] ongeldig secret'); return res.status(401).json({ error: 'Unauthorized' }); }

  try {
    const body = req.body || {};
    const customData = body.customData || {};
    const payload = {
      contactId: customData.contactId || body.contact_id || body.contactId,
      appointmentId: customData.appointmentId || body.appointment?.id || body.appointmentId,
      appointmentStatus: customData.appointmentStatus || body.appointment?.status || body.appointmentStatus || 'booked',
      startTime: customData.startTime || body.appointment?.startTime || body.startTime,
      eventType: customData.eventType || body.eventType || 'created',
    };

    if (!payload.contactId) return res.status(200).json({ skipped: 'no_contact_id', payload_keys: Object.keys(body) });

    const { data: conv } = await supabaseAdmin.from('lisa_conversations').select('*')
      .eq('ghl_contact_id', payload.contactId).eq('is_sandbox', false).maybeSingle();
    if (!conv) {
      console.log('[appointment-webhook] geen conversatie voor', payload.contactId);
      return res.status(200).json({ skipped: 'no_conversation', contactId: payload.contactId });
    }

    const status = String(payload.appointmentStatus || '').toLowerCase();
    const now = new Date().toISOString();
    let updates = {};
    let logMessage = '';

    if (status === 'booked' || status === 'confirmed' || status === 'new' || payload.eventType === 'created') {
      updates = {
        call_booked: true, call_booked_at: now,
        phase: 'qualified', qualified: true, qualified_at: now,
        followup_paused: true, followup_paused_at: now, followup_paused_reason: 'appointment_booked',
      };
      logMessage = `📅 Afspraak geboekt (${payload.startTime || 'tijd onbekend'})`;
      await supabaseAdmin.from('lisa_followups')
        .update({ status: 'cancelled', cancelled_reason: 'appointment_booked' })
        .eq('conversation_id', conv.id).eq('status', 'scheduled');
    } else if (status === 'cancelled' || status === 'canceled' || status === 'no_show' || status === 'noshow') {
      updates = {
        call_booked: false, followup_paused: false, followup_paused_at: null, followup_paused_reason: null, phase: 'band',
      };
      logMessage = `❌ Afspraak ${status.startsWith('no') ? 'no-show' : 'geannuleerd'}`;
    } else if (status === 'completed' || status === 'showed') {
      updates = { phase: 'done' };
      logMessage = '✅ Afspraak afgerond';
    } else if (status === 'rescheduled') {
      updates = { call_booked_at: now };
      logMessage = `🔄 Afspraak verplaatst${payload.startTime ? ' naar ' + payload.startTime : ''}`;
    } else {
      console.log('[appointment-webhook] onbekende status:', status);
      return res.status(200).json({ ok: true, skipped: 'unknown_status', status });
    }

    if (Object.keys(updates).length) {
      await supabaseAdmin.from('lisa_conversations').update(updates).eq('id', conv.id);
    }

    await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conv.id, direction: 'out', content: logMessage,
      ai_generated: false, is_system: true, sent_at: now,
    });

    return res.status(200).json({ ok: true, conv_id: conv.id, action: status, updates_applied: Object.keys(updates) });
  } catch (err) {
    console.error('[appointment-webhook] error:', err?.message || err);
    return res.status(200).json({ ok: false, error: err?.message || 'onbekende fout' });
  }
}
