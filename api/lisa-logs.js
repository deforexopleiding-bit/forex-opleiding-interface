// api/lisa-logs.js
// Logs & audit voor Lisa — leidt alles af uit bestaande tabellen (geen audit_log-tabel).
//   GET ?action=config_history → lisa_config versies
//   GET ?action=webhook_log    → recente inkomende (live) berichten
//   GET ?action=cron_log       → recente followup-verwerkingen (sent/cancelled)
//   GET ?action=errors         → webhook-error + verzendfouten
//   GET ?action=summary (default) → versies + webhook + cron + settings in één call
// Auth: verifyAdmin (read).

import { supabaseAdmin, verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const action = req.query.action || 'summary';

  try {
    if (action === 'config_history') {
      const { data } = await supabaseAdmin.from('lisa_config')
        .select('version, is_active, persona_name, persona_age, notes, created_at, created_by')
        .order('version', { ascending: false }).limit(50);
      return res.status(200).json({ versions: data || [] });
    }

    if (action === 'webhook_log') {
      const { data } = await supabaseAdmin.from('lisa_messages')
        .select('id, sent_at, content, conversation_id, lisa_conversations!inner(id, ghl_contact_id, source, is_sandbox, phase)')
        .eq('direction', 'in').eq('lisa_conversations.is_sandbox', false)
        .order('sent_at', { ascending: false }).limit(50);
      return res.status(200).json({ events: data || [] });
    }

    if (action === 'cron_log') {
      const { data } = await supabaseAdmin.from('lisa_followups')
        .select('id, status, is_delayed_response, is_regular_followup, scheduled_for, sent_at, cancelled_reason, template_used')
        .in('status', ['sent', 'cancelled'])
        .order('sent_at', { ascending: false, nullsFirst: false }).limit(50);
      return res.status(200).json({ events: data || [] });
    }

    if (action === 'errors') {
      const { data: settings } = await supabaseAdmin.from('lisa_settings')
        .select('ghl_webhook_last_error, updated_at').eq('id', 1).maybeSingle();
      const { data: sendFailures } = await supabaseAdmin.from('lisa_followups')
        .select('id, cancelled_reason, sent_at, scheduled_for, conversation_id')
        .eq('status', 'cancelled').like('cancelled_reason', 'send_failed%')
        .order('scheduled_for', { ascending: false }).limit(20);
      return res.status(200).json({
        webhook_error: settings?.ghl_webhook_last_error || null,
        webhook_error_at: settings?.updated_at || null,
        send_failures: sendFailures || [],
      });
    }

    if (action === 'summary' || action === 'all') {
      const [versions, webhooks, crons, settings] = await Promise.all([
        supabaseAdmin.from('lisa_config').select('version, is_active, persona_name, notes, created_at').order('version', { ascending: false }).limit(10),
        supabaseAdmin.from('lisa_messages').select('id, sent_at, content, conversation_id, lisa_conversations!inner(ghl_contact_id, source, is_sandbox)').eq('direction', 'in').eq('lisa_conversations.is_sandbox', false).order('sent_at', { ascending: false }).limit(20),
        supabaseAdmin.from('lisa_followups').select('id, status, is_delayed_response, is_regular_followup, sent_at, cancelled_reason').in('status', ['sent', 'cancelled']).order('sent_at', { ascending: false, nullsFirst: false }).limit(20),
        supabaseAdmin.from('lisa_settings').select('*').eq('id', 1).maybeSingle(),
      ]);
      return res.status(200).json({
        versions: versions.data || [],
        webhook_events: webhooks.data || [],
        cron_events: crons.data || [],
        settings: settings.data || {},
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('lisa-logs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
