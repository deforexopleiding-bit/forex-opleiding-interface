// api/_lib/events-send.js
//
// Herbruikbare verzend-acties voor events. Dezelfde logica voor:
//   - de operator-actie 'Stuur keuze-link' (api/events-attendee-send-invite.js)
//   - de automation-engine (komt in latere PR's: trigger → wait → action)
//
// Drie publieke exports:
//   1. sendEventWhatsAppTemplate({ attendee, event, templateName,
//      languageCode='nl', sentByUserId=null })  — Meta template-send +
//      conv-upsert + persist whatsapp_messages.
//   2. renderEmailParts({ subject, body, event, attendee })  — PURE (geen
//      I/O): named-template-vars resolven en lichte HTML-body produceren
//      (escape + paragraphs + <br> + http(s)-linkify).
//   3. sendEventEmail({ attendee, event, subject, body })  — render +
//      sendMail. Geen e-mailadres → skipped:'no-email'.
//
// Geen breaking changes voor de bestaande operator-flow: de gestylede
// invite-mail (sendInviteMail in events-attendee-send-invite.js) blijft
// daar wonen — dat is bespoke operator-content. Deze lib levert de
// generieke verzend-acties die de automation-engine kan combineren.

import { supabaseAdmin } from '../supabase.js';
import { sendTemplate, MetaNotConfiguredError } from './meta-whatsapp.js';
import { getModuleContextByPhoneNumberId } from './module-context.js';
import { buildMetaVariablesFromMapping, resolveVariables } from './template-variables.js';
import { upsertOutboundConversation } from './conv-upsert.js';
import { sendEventMail, wrapEmailHtml } from '../mailer.js';

const MAX_VAR_VALUE = 1000;

// Eigen footer voor events-automation-mails (vervangt de generieke
// Follow-up-footer uit wrapEmailHtml default). Branded voor events; verwijst
// naar het juiste contactpunt zodat reply-flow naar events@ gaat.
const EVENTS_EMAIL_FOOTER = `<p style="margin:0; color:#6b7280; font-size:12px;">
  De Forex Opleiding<br>
  Vragen? Mail naar <a href="mailto:events@deforexopleiding.nl" style="color:#6b7280;">events@deforexopleiding.nl</a>
</p>`;

function ctaButtonHtml(label, url) {
  return `<p style="text-align:center;margin:28px 0"><a href="${escHtml(url)}" style="display:inline-block;background:#093d54;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">${escHtml(label)}</a></p>`;
}

function toE164Plus(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (!s) return null;
  return s.startsWith('+') ? s : '+' + s.replace(/^00/, '');
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 1. WhatsApp template-send (events phone-line) ───────────────────────────
//
// Verplaatst de volledige logica van sendInviteWhatsApp uit
// api/events-attendee-send-invite.js. Identiek gedrag, maar geparametriseerd
// op templateName / languageCode / sentByUserId zodat de automation-engine
// dezelfde helper kan gebruiken met andere templates en zonder user-id
// (cron-runs).
export async function sendEventWhatsAppTemplate({
  attendee,
  event,
  templateName,
  languageCode = 'nl',
  sentByUserId = null,
} = {}) {
  if (!templateName) {
    return { ok: false, skipped: true, reason: 'no-template-name' };
  }
  const phone = toE164Plus(attendee?.phone);
  if (!phone) return { ok: false, skipped: true, reason: 'no-phone' };

  // 1) Events phone_number_id ophalen.
  const { data: modCfg, error: modErr } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('phone_number_id, business_account_id')
    .eq('module', 'events')
    .eq('is_active', true)
    .maybeSingle();
  if (modErr) {
    console.error('[events-send] module-config:', modErr.message);
    return { ok: false, error: 'module-config lookup failed' };
  }
  const eventsPnId = modCfg?.phone_number_id || null;
  if (!eventsPnId) {
    return { ok: false, skipped: true, reason: 'no-events-module-config' };
  }

  // 2) Template-row ophalen voor body_text + meta_param_mapping.
  const { data: templateRow, error: tplErr } = await supabaseAdmin
    .from('whatsapp_meta_templates')
    .select('id, status, body_text, meta_param_mapping, header_type, header_content')
    .eq('name', templateName)
    .maybeSingle();
  if (tplErr) {
    console.error('[events-send] template fetch:', tplErr.message);
    return { ok: false, error: 'template lookup failed' };
  }
  if (!templateRow) {
    return {
      ok: false, skipped: true,
      reason: `template '${templateName}' niet gevonden in whatsapp_meta_templates`,
    };
  }
  if (templateRow.status && templateRow.status !== 'APPROVED' && templateRow.status !== 'approved') {
    return {
      ok: false, skipped: true,
      reason: `template '${templateName}' status=${templateRow.status} (verwacht APPROVED)`,
    };
  }

  // 3) Module-context (afdeling-vars).
  let moduleContext = null;
  try {
    moduleContext = await getModuleContextByPhoneNumberId(supabaseAdmin, eventsPnId);
  } catch (e) {
    console.error('[events-send] module-context:', e?.message || e);
  }

  // 4) Conv-upsert (outbound).
  let convId;
  let convCreated = false;
  try {
    const upsert = await upsertOutboundConversation({
      phoneE164Plus : phone,
      phoneNumberId : eventsPnId,
      displayName   : [attendee.first_name, attendee.last_name].filter(Boolean).join(' ').trim() || null,
      customerId    : attendee.customer_id || null,
    });
    convId = upsert.id;
    convCreated = upsert.created;
  } catch (e) {
    console.error('[events-send] conv-upsert:', e?.message || e);
    return { ok: false, error: 'conv upsert failed: ' + (e?.message || 'unknown') };
  }

  // 5) Variabelen resolven via meta_param_mapping.body (of legacy flat).
  const bodyMapping = (templateRow.meta_param_mapping && typeof templateRow.meta_param_mapping === 'object')
    ? (templateRow.meta_param_mapping.body || templateRow.meta_param_mapping)
    : null;

  const ctx = { event, attendee, moduleContext };

  let resolvedVariables = {};
  if (bodyMapping && typeof bodyMapping === 'object' && Object.keys(bodyMapping).length > 0) {
    try {
      resolvedVariables = buildMetaVariablesFromMapping(bodyMapping, ctx) || {};
    } catch (e) {
      console.error('[events-send] resolve:', e?.message || e);
      return { ok: false, error: 'variable resolve failed' };
    }
  }
  const sortedKeys = Object.keys(resolvedVariables)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  const variables = sortedKeys.map((k) => String(resolvedVariables[k] ?? '').slice(0, MAX_VAR_VALUE));

  // 6) Send via Meta.
  let metaResult;
  try {
    metaResult = await sendTemplate({
      to            : phone.replace(/^\+/, ''),
      templateName,
      languageCode,
      variables,
      phoneNumberId : eventsPnId,
    });
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      return {
        ok: false, skipped: true,
        reason: 'Meta-config ontbreekt: ' + (e.missing || []).join(', '),
      };
    }
    console.error('[events-send] Meta send:', e?.message || e);
    return { ok: false, error: 'Meta send failed: ' + (e?.message || 'unknown') };
  }
  const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;

  // 7) Persist outbound whatsapp_messages.
  const templateVarsForDb = sortedKeys.length
    ? Object.fromEntries(sortedKeys.map((k) => [k, String(resolvedVariables[k] ?? '')]))
    : null;

  let previewBody = null;
  if (templateRow.body_text && sortedKeys.length) {
    let rendered = String(templateRow.body_text);
    for (const k of sortedKeys) {
      const re = new RegExp(`\\{\\{${k}\\}\\}`, 'g');
      rendered = rendered.replace(re, String(resolvedVariables[k] ?? ''));
    }
    previewBody = rendered;
  } else if (templateRow.body_text) {
    previewBody = String(templateRow.body_text);
  }

  const nowIso = new Date().toISOString();
  const insertRow = {
    conversation_id   : convId,
    direction         : 'out',
    meta_wamid        : wamid,
    body              : previewBody,
    template_name     : templateName,
    template_variables: templateVarsForDb,
    status            : 'queued',
    sent_at           : nowIso,
    sent_by_user_id   : sentByUserId,
  };
  let insertedId = null;
  try {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert(insertRow)
      .select('id')
      .single();
    if (insErr) {
      console.error('[events-send] message persist:', insErr.message);
    } else {
      insertedId = inserted?.id || null;
    }
  } catch (e) {
    console.error('[events-send] message persist exception:', e?.message || e);
  }

  // Update conv.last_message_at + preview (best-effort).
  try {
    await supabaseAdmin
      .from('whatsapp_conversations')
      .update({
        last_message_at     : nowIso,
        last_message_preview: previewBody ? String(previewBody).slice(0, 120) : null,
      })
      .eq('id', convId);
  } catch (e) {
    console.error('[events-send] conv update:', e?.message || e);
  }

  return {
    ok          : true,
    message_id  : insertedId,
    meta_wamid  : wamid,
    conv_id     : convId,
    conv_created: convCreated,
  };
}

// ── 2. PUUR: render named-template-vars naar { subject, text, html } ────────
//
// Geen I/O: dit is een testbare helper voor zowel sendEventEmail als voor
// preview-flows in de admin-UI (later). Volgorde van html-bouw is bewust:
//   1) HTML-escape (zo blijft '<klant @ test>' veilig in plain text)
//   2) URL-linkify (https?://... -> <a href="URL">URL</a>) — vóór newline-
//      substitutie zodat we niet per ongeluk een '<br>' binnen een URL-match
//      vangen.
//   3) Newlines: '\n\n' -> '</p><p>'; daarna resterende '\n' -> '<br>';
//      tenslotte alles inwikkelen in één buiten-<p>.
export function renderEmailParts({ subject, body, event, attendee, button } = {}) {
  const ctx = { event, attendee };
  const renderedSubject = resolveVariables(subject || '', null, ctx).text;
  const renderedBody    = resolveVariables(body    || '', null, ctx).text;

  let s = escHtml(renderedBody);
  s = s.replace(/(https?:\/\/[^\s]+)/g, (url) => `<a href="${url}">${url}</a>`);
  s = s.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
  let bodyHtml = `<p>${s}</p>`;

  let buttonUrl = null;
  if (button && button.label && button.url) {
    buttonUrl = resolveVariables(String(button.url), null, ctx).text.trim();
    if (buttonUrl) bodyHtml += ctaButtonHtml(button.label, buttonUrl);
  }

  const html = wrapEmailHtml(renderedSubject, bodyHtml, { footerHtml: EVENTS_EMAIL_FOOTER });

  let text = renderedBody;
  if (buttonUrl) text += `\n\n${button.label}: ${buttonUrl}`;

  return { subject: renderedSubject, text, html };
}

// ── 3. sendEventEmail — render + sendEventMail (events@-afzender, fallback info@) ──
export async function sendEventEmail({ attendee, event, subject, body, button } = {}) {
  if (!attendee?.email) {
    return { ok: false, skipped: true, reason: 'no-email' };
  }
  const parts = renderEmailParts({ subject, body, event, attendee, button });
  try {
    const r = await sendEventMail({ to: attendee.email, subject: parts.subject, text: parts.text, html: parts.html });
    if (r && r.success) return { ok: true, from: r.from, fallback: r.fallback };
    return { ok: false, error: (r && r.error) || 'mail send failed', from: r && r.from };
  } catch (e) {
    console.error('[events-send] sendEventEmail:', e?.message || e);
    return { ok: false, error: e?.message || 'mail send failed' };
  }
}
