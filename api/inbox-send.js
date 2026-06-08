// api/inbox-send.js
// POST → verzend een outbound WhatsApp-bericht via Meta Cloud API.
// Permission: finance.inbox.send
//
// Body:
//   conversation_id     uuid  required
//   mode                'text' | 'template'  required
//   body                text  required bij mode='text' (free-form)
//   template_name       text  required bij mode='template'
//   template_language   text  optional (default 'nl')
//   template_variables  object optional — wordt 1-op-1 in audit/DB bewaard;
//                                          voor PR A2 geen automatic component-build
//   template_components array optional — Meta's components-payload (header/body/buttons)
//
// 24h customer-service window:
//   mode='text' vereist een inbound msg binnen 24h. Buiten 24h → 422 met
//   message dat een approved template gebruikt moet worden.
//
// Response: 200 { success: true, message_id, meta_wamid }
//           422 { error: '24h_window_expired'|'validation', ... }
//           502 { error, meta_error } bij Meta-API fout
//           503 { error, missing: [] } bij niet-geconfigureerde Meta

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { sendText, sendTemplate, getConfigStatus, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096; // Meta text limit
const MAX_TEMPLATE_NAME = 200;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.send'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send)' });
  }

  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  const mode = String(body.mode || '').toLowerCase();
  const text = body.body !== undefined ? String(body.body || '').trim() : '';
  const templateName = String(body.template_name || '').trim();
  const templateLanguage = String(body.template_language || 'nl').trim().toLowerCase() || 'nl';
  const templateVariables = body.template_variables && typeof body.template_variables === 'object'
    ? body.template_variables : null;
  const templateComponents = Array.isArray(body.template_components) ? body.template_components : [];

  // Validatie
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  if (mode !== 'text' && mode !== 'template') {
    return res.status(400).json({ error: "mode moet 'text' of 'template' zijn" });
  }
  if (mode === 'text') {
    if (!text) return res.status(400).json({ error: 'body vereist bij mode=text' });
    if (text.length > MAX_BODY) return res.status(400).json({ error: `body max ${MAX_BODY} chars` });
  }
  if (mode === 'template') {
    if (!templateName) return res.status(400).json({ error: 'template_name vereist bij mode=template' });
    if (templateName.length > MAX_TEMPLATE_NAME) return res.status(400).json({ error: `template_name max ${MAX_TEMPLATE_NAME} chars` });
  }

  // Meta-config check
  const cfg = getConfigStatus();
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'Meta WhatsApp niet geconfigureerd',
      missing: cfg.missing,
    });
  }

  try {
    // Conversation ophalen — voor phone_number + 24h check
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, last_inbound_at, last_message_preview')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });
    if (!conv.phone_number) return res.status(400).json({ error: 'Conversation heeft geen phone_number' });

    // 24h-window guard voor free-form text
    if (mode === 'text') {
      const t = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
      const withinWindow = t && (Date.now() - t) <= TWENTY_FOUR_HOURS_MS;
      if (!withinWindow) {
        return res.status(422).json({
          error: '24h_window_expired',
          message: 'Buiten 24-uurs venster sinds laatste inbound bericht. Gebruik een approved template.',
        });
      }
    }

    // Meta API call
    let metaResult;
    try {
      if (mode === 'text') {
        metaResult = await sendText({ to: conv.phone_number, body: text });
      } else {
        metaResult = await sendTemplate({
          to: conv.phone_number,
          templateName,
          languageCode: templateLanguage,
          components: templateComponents,
        });
      }
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd', missing: metaErr.missing });
      }
      console.error('[inbox-send] Meta API fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nowIso = new Date().toISOString();

    // Persist outbound message
    const insertRow = {
      conversation_id:    convId,
      direction:          'out',
      meta_wamid:         wamid,
      body:               mode === 'text' ? text : null,
      template_name:      mode === 'template' ? templateName : null,
      template_variables: mode === 'template' ? (templateVariables || null) : null,
      status:             'queued',
      sent_at:            nowIso,
      sent_by_user_id:    user.id,
    };
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert(insertRow)
      .select('id, meta_wamid, status, sent_at')
      .single();
    if (insErr) throw new Error('message insert: ' + insErr.message);

    // Conversation last_message_at + preview
    const preview = mode === 'text'
      ? text.slice(0, 120)
      : ('[template] ' + templateName).slice(0, 120);
    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nowIso, last_message_preview: preview })
      .eq('id', convId);
    if (updErr) console.error('[inbox-send] conversation update failed:', updErr.message);

    // Audit log (fail-soft)
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      mode === 'text' ? 'whatsapp.outbound_text_sent' : 'whatsapp.outbound_template_sent',
        entity_type: 'whatsapp_message',
        entity_id:   inserted.id,
        after_json:  {
          conversation_id: convId,
          phone_number:    conv.phone_number,
          mode,
          meta_wamid:      wamid,
          template_name:   mode === 'template' ? templateName : null,
        },
        ip_address:  getClientIp(req),
      });
    } catch (auditErr) {
      console.error('[inbox-send] audit insert exception:', auditErr.message);
    }

    return res.status(200).json({
      success: true,
      message_id: inserted.id,
      meta_wamid: wamid,
    });
  } catch (e) {
    console.error('[inbox-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
