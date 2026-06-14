// api/events-attendee-send-invite.js
//
// POST → stuur een deelnemer z'n persoonlijke keuze-link via WhatsApp
// (Simone-lijn) + e-mail. Operator-actie vanuit events-detail Aanwezigen-tab.
// Beide kanalen onafhankelijk: één faal-tak blokkeert de andere niet.
//
// Permission: events.attendee.edit (bestaande key; operatie op bestaande rij).
//
// Body (JSON):
//   { attendee_id: uuid }
//
// Response 200 — beide kanalen los gerapporteerd:
//   {
//     mail     : { ok, skipped?, reason?, error? },
//     whatsapp : { ok, skipped?, reason?, message_id?, meta_wamid?, error? }
//   }
//
// Errors:
//   400  attendee_id ontbreekt / ongeldige uuid
//   401  geen sessie
//   403  geen events.attendee.edit rechten
//   404  attendee niet gevonden / event niet gevonden
//   500  database-fout (totale flow; per-kanaal-fouten worden in body gerapporteerd)
//
// CONFIGURATIE:
//   - PUBLIC_BASE_URL  (env, fallback https://forex-opleiding-interface.vercel.app)
//                      bron voor de keuze-link; zelfde patroon als
//                      api/_lib/template-variables.js getAttendeeValue.
//   - EVENTS_KEUZE_LINK_TEMPLATE_NAME (env, fallback 'events_keuze_link')
//                      naam van de goedgekeurde WhatsApp-template die we
//                      versturen. Admin moet deze template aanmaken +
//                      indienen voor Meta-approval in /modules/admin.html
//                      Templates-tab; body kan {{event.titel}} +
//                      {{attendee.keuze_link}} + ... bevatten via
//                      meta_param_mapping. Niet hardcoden in body_text.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { getModuleContextByPhoneNumberId } from './_lib/module-context.js';
import {
  buildMetaVariablesFromMapping,
  resolveVariables,
} from './_lib/template-variables.js';
import { upsertOutboundConversation } from './_lib/conv-upsert.js';
import { sendMail, wrapEmailHtml } from './mailer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';
const TEMPLATE_NAME   = process.env.EVENTS_KEUZE_LINK_TEMPLATE_NAME || 'events_keuze_link';
const TEMPLATE_LANG   = 'nl';
const MAX_VAR_VALUE   = 1000;

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toE164Plus(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (!s) return null;
  return s.startsWith('+') ? s : '+' + s.replace(/^00/, '');
}

// ── Mail-helper ─────────────────────────────────────────────────────────────
async function sendInviteMail({ firstName, keuzeLink, toEmail }) {
  if (!toEmail) return { ok: false, skipped: true, reason: 'no-email' };

  const subject = 'Kies de datum voor je Forex Masterclass';
  const naam = firstName || 'jij';

  const html = wrapEmailHtml(subject, `
    <p>Hoi ${escHtml(naam)},</p>
    <p>Leuk dat je erbij wilt zijn! Kies hieronder de datum die jou het beste past — je ziet meteen welke data nog plek hebben.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${escHtml(keuzeLink)}" style="display:inline-block;background:#093d54;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">Kies je datum</a>
    </p>
    <p>Heb je de korte vragenlijst nog niet ingevuld? Dat doe je in dezelfde stap; zo krijg je meteen het advies dat bij jouw niveau past.</p>
    <p style="margin-top:32px">Tot snel!<br>— Simone, De Forex Opleiding</p>
  `);

  const text = `Hoi ${naam}, kies de datum voor je Forex Masterclass: ${keuzeLink} — Simone, De Forex Opleiding`;

  try {
    await sendMail({ to: toEmail, subject, text, html });
    return { ok: true };
  } catch (e) {
    console.error('[events-attendee-send-invite] mail:', e?.message || e);
    return { ok: false, error: e?.message || 'mail send failed' };
  }
}

// ── WhatsApp-helper ─────────────────────────────────────────────────────────
async function sendInviteWhatsApp({ attendee, event, user }) {
  const phone = toE164Plus(attendee.phone);
  if (!phone) return { ok: false, skipped: true, reason: 'no-phone' };

  // 1) Events phone_number_id ophalen.
  const { data: modCfg, error: modErr } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('phone_number_id, business_account_id')
    .eq('module', 'events')
    .eq('is_active', true)
    .maybeSingle();
  if (modErr) {
    console.error('[events-attendee-send-invite] module-config:', modErr.message);
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
    .eq('name', TEMPLATE_NAME)
    .maybeSingle();
  if (tplErr) {
    console.error('[events-attendee-send-invite] template fetch:', tplErr.message);
    return { ok: false, error: 'template lookup failed' };
  }
  if (!templateRow) {
    return {
      ok: false, skipped: true,
      reason: `template '${TEMPLATE_NAME}' niet gevonden in whatsapp_meta_templates`,
    };
  }
  if (templateRow.status && templateRow.status !== 'APPROVED' && templateRow.status !== 'approved') {
    // Defensive: stuur alleen als status APPROVED. Andere statussen → Meta
    // zal sowieso 400 geven; geef die info hier al terug.
    return {
      ok: false, skipped: true,
      reason: `template '${TEMPLATE_NAME}' status=${templateRow.status} (verwacht APPROVED)`,
    };
  }

  // 3) Module-context (afdeling-vars).
  let moduleContext = null;
  try {
    moduleContext = await getModuleContextByPhoneNumberId(supabaseAdmin, eventsPnId);
  } catch (e) {
    console.error('[events-attendee-send-invite] module-context:', e?.message || e);
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
    console.error('[events-attendee-send-invite] conv-upsert:', e?.message || e);
    return { ok: false, error: 'conv upsert failed: ' + (e?.message || 'unknown') };
  }

  // 5) Variabelen resolven via meta_param_mapping.
  const bodyMapping = (templateRow.meta_param_mapping && typeof templateRow.meta_param_mapping === 'object')
    ? (templateRow.meta_param_mapping.body || templateRow.meta_param_mapping)
    : null;

  const ctx = {
    event,
    attendee,
    moduleContext,
  };

  let resolvedVariables = {};
  if (bodyMapping && typeof bodyMapping === 'object' && Object.keys(bodyMapping).length > 0) {
    try {
      resolvedVariables = buildMetaVariablesFromMapping(bodyMapping, ctx) || {};
    } catch (e) {
      console.error('[events-attendee-send-invite] resolve:', e?.message || e);
      return { ok: false, error: 'variable resolve failed' };
    }
  }
  // Truncate elke waarde defensief.
  const sortedKeys = Object.keys(resolvedVariables)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  const variables = sortedKeys.map((k) => String(resolvedVariables[k] ?? '').slice(0, MAX_VAR_VALUE));

  // 6) Send via Meta.
  let metaResult;
  try {
    metaResult = await sendTemplate({
      to            : phone.replace(/^\+/, ''),
      templateName  : TEMPLATE_NAME,
      languageCode  : TEMPLATE_LANG,
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
    console.error('[events-attendee-send-invite] Meta send:', e?.message || e);
    return { ok: false, error: 'Meta send failed: ' + (e?.message || 'unknown') };
  }
  const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;

  // 7) Persist outbound whatsapp_messages.
  const templateVarsForDb = sortedKeys.length
    ? Object.fromEntries(sortedKeys.map((k) => [k, String(resolvedVariables[k] ?? '')]))
    : null;

  // Build preview-body voor chat-history.
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
    template_name     : TEMPLATE_NAME,
    template_variables: templateVarsForDb,
    status            : 'queued',
    sent_at           : nowIso,
    sent_by_user_id   : user.id,
  };
  let insertedId = null;
  try {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert(insertRow)
      .select('id')
      .single();
    if (insErr) {
      console.error('[events-attendee-send-invite] message persist:', insErr.message);
    } else {
      insertedId = inserted?.id || null;
    }
  } catch (e) {
    console.error('[events-attendee-send-invite] message persist exception:', e?.message || e);
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
    console.error('[events-attendee-send-invite] conv update:', e?.message || e);
  }

  return {
    ok          : true,
    message_id  : insertedId,
    meta_wamid  : wamid,
    conv_id     : convId,
    conv_created: convCreated,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth + RBAC.
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.edit)' });
  }

  // Body parse.
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });
  const attendeeId = typeof body.attendee_id === 'string' ? body.attendee_id.trim() : '';
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist.' });
  }

  try {
    // Load attendee.
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return res.status(404).json({ error: 'Deelnemer niet gevonden.' });
    if (!attendee.choice_token) {
      // Mag in productie niet voorkomen (NOT NULL DEFAULT in migratie),
      // maar defensief: zonder token kan de link niet werken.
      return res.status(500).json({ error: 'Deelnemer mist choice_token (data-anomalie).' });
    }

    // Load event.
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, niveau, capacity, status')
      .eq('id', attendee.event_id)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return res.status(404).json({ error: 'Event niet gevonden.' });

    // Build keuze-link (zelfde patroon als attendee.keuze_link template-var).
    const keuzeLink = `${PUBLIC_BASE_URL}/modules/event-keuze.html?t=${encodeURIComponent(attendee.choice_token)}`;

    // Parallel: WhatsApp + Mail. Beide independent.
    const [waResult, mailResult] = await Promise.all([
      sendInviteWhatsApp({ attendee, event, user }),
      sendInviteMail({
        firstName: attendee.first_name,
        keuzeLink,
        toEmail  : attendee.email,
      }),
    ]);

    return res.status(200).json({
      attendee_id : attendee.id,
      event_id    : event.id,
      keuze_link  : keuzeLink,
      mail        : mailResult,
      whatsapp    : waResult,
    });
  } catch (e) {
    console.error('[events-attendee-send-invite] fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
