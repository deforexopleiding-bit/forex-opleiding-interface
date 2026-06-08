// api/inbox-send-template.js
// POST → verzend een outbound WhatsApp-template via Meta Cloud API,
// specifiek voor de Inbox template-picker (C3). Skipt 24h-window check
// (templates mogen altijd buiten 24u verzonden worden) en bouwt de Meta
// components-array op uit een simpel { "1": "...", "2": "..." } variables-
// object.
//
// Permission: finance.inbox.send (zelfde als inbox-send.js).
//
// Body:
//   conversation_id   uuid  required
//   meta_template_id  text  optional — Meta-zijde template id (informational)
//   template_name     text  required
//   language          text  optional (default 'nl')
//   variables         object optional — { "1": "Jeffrey", "2": "EUR 80,00" }
//                              body-placeholders {{1}}, {{2}}, ...
//
// Response: 200 { wamid, message_id }
//           404 { error: 'Conversation niet gevonden' }
//           502 { error, meta_error } bij Meta-API fout
//           503 { error, missing: [] } bij niet-geconfigureerde Meta
//
// NB: header- en button-variabelen worden in C3 v1 nog NIET ondersteund.
// Voor C3 v2 kunnen we een rijkere 'components' input accepteren via
// inbox-send.js (die accepteert al template_components 1-op-1 voor Meta).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { sendTemplate, getConfigStatus, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEMPLATE_NAME = 200;
const MAX_LANG = 16;
const MAX_VAR_VALUE = 1024; // per-parameter veiligheidskap

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.send'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send)' });
  }

  // Body parsing
  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  const metaTemplateId = body.meta_template_id != null
    ? String(body.meta_template_id).trim()
    : '';
  const templateName = String(body.template_name || '').trim();
  const language = String(body.language || 'nl').trim().toLowerCase() || 'nl';
  const variablesIn = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
    ? body.variables
    : {};

  // Validatie
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  if (!templateName) return res.status(400).json({ error: 'template_name vereist' });
  if (templateName.length > MAX_TEMPLATE_NAME) {
    return res.status(400).json({ error: `template_name max ${MAX_TEMPLATE_NAME} chars` });
  }
  if (language.length > MAX_LANG) {
    return res.status(400).json({ error: `language max ${MAX_LANG} chars` });
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
    // Conversation ophalen — voor phone_number + outbound-lijn keuze
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, customer_id, last_message_preview')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });
    if (!conv.phone_number) return res.status(400).json({ error: 'Conversation heeft geen phone_number' });

    // Module-config fallback voor afzendlijn — gelijk aan inbox-send.js
    let financePnId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('phone_number_id, business_account_id')
        .eq('module', 'finance')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[inbox-send-template] module-config lookup:', modErr.message);
      } else if (modCfg?.phone_number_id) {
        financePnId = modCfg.phone_number_id;
      }
    } catch (e) {
      console.error('[inbox-send-template] module-config exception:', e.message);
    }

    // Optionele lokale template lookup — alleen voor validatie/warning, geen
    // hard fail (we trusten Meta's template_name+language uniqueness binnen
    // een WABA).
    try {
      const { data: tmplRow, error: tmplErr } = await supabaseAdmin
        .from('whatsapp_meta_templates')
        .select('id, status')
        .eq('name', templateName)
        .eq('language', language)
        .maybeSingle();
      if (tmplErr) {
        console.error('[inbox-send-template] template lookup:', tmplErr.message);
      } else if (!tmplRow) {
        console.warn(`[inbox-send-template] geen lokale template-row voor name=${templateName} language=${language} (continue, Meta is autoritatief)`);
      } else if (tmplRow.status !== 'APPROVED') {
        console.warn(`[inbox-send-template] lokale template status=${tmplRow.status} (verwacht APPROVED) name=${templateName}`);
      }
    } catch (e) {
      console.error('[inbox-send-template] template lookup exception:', e.message);
    }

    // Harde status-guard: als template lokaal bestaat maar NIET APPROVED is,
    // weiger met 409. Dit voorkomt Meta-rejections bij templates die nog in
    // PENDING/REJECTED/DRAFT staan. Lokaal-onbekende templates worden NIET
    // geblokkeerd (Meta blijft autoritatief — zie warn-tak hierboven).
    try {
      const { data: guardRow, error: guardErr } = await supabaseAdmin
        .from('whatsapp_meta_templates')
        .select('status')
        .eq('name', templateName)
        .eq('language', language)
        .maybeSingle();
      if (guardErr) {
        console.error('[inbox-send-template] template status-guard lookup:', guardErr.message);
      } else if (guardRow && guardRow.status && guardRow.status !== 'APPROVED') {
        return res.status(409).json({
          error: 'Template status is niet APPROVED — gebruik admin -> WhatsApp Templates -> Sync met Meta',
          status: guardRow.status,
        });
      }
    } catch (e) {
      console.error('[inbox-send-template] template status-guard exception:', e.message);
    }

    // Build Meta components-array uit variables object.
    // C3 v1: alleen body-placeholders {{1}}, {{2}}, ... worden ondersteund.
    // Sortering op numerieke key zodat parameters in juiste volgorde gaan.
    const sortedKeys = Object.keys(variablesIn)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const components = [];
    if (sortedKeys.length) {
      const parameters = sortedKeys.map(k => ({
        type: 'text',
        text: String(variablesIn[k] ?? '').slice(0, MAX_VAR_VALUE),
      }));
      components.push({ type: 'body', parameters });
    }

    // Afzendlijn-keuze: prefer conversation.phone_number_id; fallback op
    // module-config; uiteindelijk env-var via getConfig default.
    const outboundPnId = conv.phone_number_id || financePnId || undefined;

    // Meta send via shared helper (hergebruikt auth/error-handling).
    let metaResult;
    try {
      metaResult = await sendTemplate({
        to: conv.phone_number,
        templateName,
        languageCode: language,
        components: components.length ? components : null,
        phoneNumberId: outboundPnId,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({
          error: 'Meta WhatsApp niet geconfigureerd',
          missing: metaErr.missing,
        });
      }
      console.error('[inbox-send-template] Meta API fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nowIso = new Date().toISOString();

    // Persist outbound template-message.
    // Schema-realiteit (2026-06-07-whatsapp-inbox-foundation.sql): geen
    // expliciete 'type'-kolom, geen 'meta_payload'. Template-encoding is
    // impliciet via template_name != NULL. status default 'queued'; webhook
    // delivery-events promoten later naar sent/delivered/read.
    const templateVarsForDb = sortedKeys.length
      ? Object.fromEntries(sortedKeys.map(k => [k, String(variablesIn[k] ?? '')]))
      : null;
    const insertRow = {
      conversation_id:    convId,
      direction:          'out',
      meta_wamid:         wamid,
      body:               null,
      template_name:      templateName,
      template_variables: templateVarsForDb,
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

    // Conversation last_message_at + preview (fail-soft).
    const preview = ('[template] ' + templateName).slice(0, 120);
    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nowIso, last_message_preview: preview })
      .eq('id', convId);
    if (updErr) console.error('[inbox-send-template] conversation update failed:', updErr.message);

    // Audit log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'whatsapp.send_template',
        entity_type: 'whatsapp_message',
        entity_id:   inserted.id,
        after_json:  {
          conversation_id:  convId,
          phone_number:     conv.phone_number,
          phone_number_id:  outboundPnId || null,
          template_name:    templateName,
          meta_template_id: metaTemplateId || null,
          language,
          variables:        templateVarsForDb,
          meta_wamid:       wamid,
        },
        ip_address: getClientIp(req),
      });
    } catch (auditErr) {
      console.error('[inbox-send-template] audit insert exception:', auditErr.message);
    }

    return res.status(200).json({
      wamid,
      message_id: inserted.id,
    });
  } catch (e) {
    console.error('[inbox-send-template]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
