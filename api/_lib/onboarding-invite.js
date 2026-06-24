// api/_lib/onboarding-invite.js
//
// Herbruikbare onboarding-invite-flow:
//   - bouwt wizard-link op basis van onboardings.token
//   - stuurt WhatsApp-template via de onboarding-lijn (whatsapp_module_config
//     WHERE module='onboarding')
//   - rapporteert resultaat; fail-soft (gooit nooit naar de caller)
//
// Gedeeld door:
//   - api/onboarding-invite-send.js (operator-knop + system-pad)
//   - api/onboarding-create.js      (auto-trigger ná provisioning)
//
// CONFIGURATIE-BRON:
//   - whatsapp_module_config WHERE module='onboarding' AND is_active=true
//     levert de afzendlijn (phone_number_id) + afdeling-context.
//   - joost_config WHERE module='onboarding' → knowledge_base.invite:
//       { template_name: '<meta-template>', language?: 'nl', enabled?: true }
//     Ontbreekt template_name → return { sent:false, reason:'geen-template-config' }.
//
// IDEMPOTENTIE:
//   - onboardings.invite_sent_at: ts laatste succesvolle verzending.
//   - bij sentAt aanwezig + force=false → return { sent:false, reason:'already-sent' }.
//   - bij force=true wordt sent_at overschreven met een nieuwe ts.
//
// VARIABELEN-RESOLUTIE:
//   meta_param_mapping.body uit whatsapp_meta_templates wordt geresolved via
//   buildMetaVariablesFromMapping met context = { customer, onboarding,
//   moduleContext }. Onboarding-context bevat token + traject_label + status,
//   zodat {{onboarding.wizard_link}} / {{klant.voornaam}} etc. werken.
//
// PUBLIC_BASE_URL (env) bepaalt de https-host voor de wizard-link. Wordt
// gelezen door template-variables.js getOnboardingValue.

import { supabaseAdmin } from '../supabase.js';
import { sendTemplate, MetaNotConfiguredError } from './meta-whatsapp.js';
import { buildMetaVariablesFromMapping } from './template-variables.js';
import { upsertOutboundConversation } from './conv-upsert.js';
import { getModuleContextByPhoneNumberId } from './module-context.js';

const MAX_VAR_VALUE = 1000;

// Normaliseer een telefoonnummer naar E.164-plus-formaat (+316...).
// Identiek aan events-send.js toE164Plus (intentioneel niet ge-import om de
// helper-graph plat te houden).
function toE164Plus(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 8) return null;
  return '+' + digits;
}

/**
 * Stuur een onboarding-invite (WhatsApp-template) voor één onboarding.
 *
 * @param {object} opts
 * @param {string} opts.onboardingId        - uuid van de onboarding-rij
 * @param {boolean} [opts.force=false]      - overschrijf invite_sent_at + opnieuw sturen
 * @param {string|null} [opts.sentByUserId] - operator-id (audit), null voor system
 * @param {string} [opts.source='manual']   - 'auto-after-provision' / 'manual'
 * @returns {Promise<{
 *   sent: boolean,
 *   reason?: string,
 *   error?: string,
 *   wizard_link?: string,
 *   template_name?: string,
 *   message_id?: string,
 *   meta_wamid?: string,
 *   conv_id?: string,
 *   already_sent_at?: string
 * }>}
 */
export async function sendOnboardingInvite({
  onboardingId,
  force = false,
  sentByUserId = null,
  source = 'manual',
} = {}) {
  if (!onboardingId) return { sent: false, reason: 'no-onboarding-id' };

  try {
    // 1) Onboarding-row + traject ophalen.
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select(
        'id, customer_id, traject_id, status, token, archived_at, invite_sent_at, ' +
        'traject:onboarding_trajecten(label, type)'
      )
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) return { sent: false, reason: 'db-error', error: 'onboarding lookup: ' + obErr.message };
    if (!ob) return { sent: false, reason: 'not-found' };
    if (ob.archived_at) return { sent: false, reason: 'archived' };
    if (!ob.token) return { sent: false, reason: 'no-token' };

    // Idempotentie-gate.
    if (ob.invite_sent_at && !force) {
      return { sent: false, reason: 'already-sent', already_sent_at: ob.invite_sent_at };
    }

    // 2) Customer (phone + naam).
    if (!ob.customer_id) return { sent: false, reason: 'no-customer' };
    const { data: customer, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone')
      .eq('id', ob.customer_id)
      .maybeSingle();
    if (custErr) return { sent: false, reason: 'db-error', error: 'customer lookup: ' + custErr.message };
    if (!customer) return { sent: false, reason: 'customer-not-found' };
    const phone = toE164Plus(customer.phone);
    if (!phone) return { sent: false, reason: 'geen-telefoon' };

    // 3) Onboarding-module-config (afzendlijn + invite-config).
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id, business_account_id, is_active')
      .eq('module', 'onboarding')
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) return { sent: false, reason: 'db-error', error: 'module-config lookup: ' + modErr.message };
    if (!modCfg?.phone_number_id) return { sent: false, reason: 'geen-module-config' };

    // 4) Invite-template-naam uit joost_config.knowledge_base.invite.
    const { data: jcfg, error: jcfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('knowledge_base, is_enabled')
      .eq('module', 'onboarding')
      .maybeSingle();
    if (jcfgErr) return { sent: false, reason: 'db-error', error: 'joost_config lookup: ' + jcfgErr.message };
    const kb = (jcfg && jcfg.knowledge_base && typeof jcfg.knowledge_base === 'object') ? jcfg.knowledge_base : {};
    const inviteCfg = (kb.invite && typeof kb.invite === 'object') ? kb.invite : {};
    const templateName = typeof inviteCfg.template_name === 'string' ? inviteCfg.template_name.trim() : '';
    const languageCode = typeof inviteCfg.language === 'string' && inviteCfg.language.trim()
      ? inviteCfg.language.trim().toLowerCase() : 'nl';
    const inviteEnabled = inviteCfg.enabled !== false; // default true; alleen expliciet false skipt
    if (!templateName) return { sent: false, reason: 'geen-template-config' };
    if (!inviteEnabled) return { sent: false, reason: 'invite-uit-gezet' };

    // 5) Template-row ophalen (status APPROVED) + mapping.
    const { data: tplRow, error: tplErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, status, body_text, meta_param_mapping, header_type, header_content')
      .eq('name', templateName)
      .maybeSingle();
    if (tplErr) return { sent: false, reason: 'db-error', error: 'template lookup: ' + tplErr.message };
    if (!tplRow) return { sent: false, reason: 'template-niet-gevonden', error: `template '${templateName}' niet in whatsapp_meta_templates` };
    if (tplRow.status && tplRow.status !== 'APPROVED' && tplRow.status !== 'approved') {
      return { sent: false, reason: 'template-niet-approved', error: `template '${templateName}' status=${tplRow.status}` };
    }

    // 6) Module-context (afdeling-vars).
    let moduleContext = null;
    try {
      moduleContext = await getModuleContextByPhoneNumberId(supabaseAdmin, modCfg.phone_number_id);
    } catch (e) {
      console.error('[onboarding-invite] module-context:', e?.message || e);
    }

    // 7) Conv-upsert (outbound) op de onboarding-lijn.
    let convId = null;
    let convCreated = false;
    try {
      const upsert = await upsertOutboundConversation({
        phoneE164Plus : phone,
        phoneNumberId : modCfg.phone_number_id,
        displayName   : [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || null,
        customerId    : customer.id || null,
      });
      convId = upsert.id;
      convCreated = upsert.created;
    } catch (e) {
      console.error('[onboarding-invite] conv-upsert:', e?.message || e);
      return { sent: false, reason: 'conv-upsert-fail', error: e?.message || 'conv upsert failed' };
    }

    // 8) Variabelen resolven via meta_param_mapping.body.
    const bodyMapping = (tplRow.meta_param_mapping && typeof tplRow.meta_param_mapping === 'object')
      ? (tplRow.meta_param_mapping.body || tplRow.meta_param_mapping)
      : null;
    const onboardingCtx = {
      token:         ob.token,
      status:        ob.status,
      traject_label: ob.traject?.label || null,
    };
    const ctx = { customer, onboarding: onboardingCtx, moduleContext };
    let resolved = {};
    if (bodyMapping && typeof bodyMapping === 'object' && Object.keys(bodyMapping).length > 0) {
      try {
        resolved = buildMetaVariablesFromMapping(bodyMapping, ctx) || {};
      } catch (e) {
        console.error('[onboarding-invite] resolve:', e?.message || e);
        return { sent: false, reason: 'variable-resolve-fail', error: e?.message || 'resolve failed' };
      }
    }
    const sortedKeys = Object.keys(resolved)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const variables = sortedKeys.map((k) => String(resolved[k] ?? '').slice(0, MAX_VAR_VALUE));

    // 9) Send via Meta. sendTemplate verwacht 'to' ZONDER '+'.
    let metaResult;
    try {
      metaResult = await sendTemplate({
        to            : phone.replace(/^\+/, ''),
        templateName,
        languageCode,
        variables,
        phoneNumberId : modCfg.phone_number_id,
      });
    } catch (e) {
      if (e instanceof MetaNotConfiguredError) {
        return { sent: false, reason: 'meta-niet-geconfigureerd', error: 'Meta-config ontbreekt: ' + (e.missing || []).join(', ') };
      }
      const msg = String(e?.message || 'unknown');
      console.error('[onboarding-invite] Meta send:', msg);
      return { sent: false, reason: 'meta-send-fail', error: 'Meta send failed: ' + msg };
    }
    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;

    // 10) Preview-body bouwen voor whatsapp_messages.body.
    let previewBody = null;
    if (tplRow.body_text && sortedKeys.length) {
      let rendered = String(tplRow.body_text);
      for (const k of sortedKeys) {
        const re = new RegExp(`\\{\\{${k}\\}\\}`, 'g');
        rendered = rendered.replace(re, String(resolved[k] ?? ''));
      }
      previewBody = rendered;
    } else if (tplRow.body_text) {
      previewBody = String(tplRow.body_text);
    }

    // 11) Persist outbound whatsapp_messages-row.
    const nowIso = new Date().toISOString();
    const templateVarsForDb = sortedKeys.length
      ? Object.fromEntries(sortedKeys.map((k) => [k, String(resolved[k] ?? '')]))
      : null;
    let insertedId = null;
    try {
      const { data: ins, error: insErr } = await supabaseAdmin
        .from('whatsapp_messages')
        .insert({
          conversation_id   : convId,
          direction         : 'out',
          meta_wamid        : wamid,
          body              : previewBody,
          template_name     : templateName,
          template_variables: templateVarsForDb,
          status            : 'queued',
          sent_at           : nowIso,
          sent_by_user_id   : sentByUserId || null,
        })
        .select('id')
        .single();
      if (insErr) console.error('[onboarding-invite] message persist:', insErr.message);
      else insertedId = ins?.id || null;
    } catch (e) {
      console.error('[onboarding-invite] message persist exception:', e?.message || e);
    }

    // 12) Update conv.last_message_at + preview (best-effort).
    try {
      await supabaseAdmin
        .from('whatsapp_conversations')
        .update({
          last_message_at     : nowIso,
          last_message_preview: previewBody ? String(previewBody).slice(0, 120) : null,
        })
        .eq('id', convId);
    } catch (e) {
      console.error('[onboarding-invite] conv update:', e?.message || e);
    }

    // 13) Mark de onboarding-rij als verzonden (idempotentie-gate voor volgende run).
    try {
      await supabaseAdmin
        .from('onboardings')
        .update({ invite_sent_at: nowIso })
        .eq('id', onboardingId);
    } catch (e) {
      console.error('[onboarding-invite] mark sent:', e?.message || e);
    }

    // 14) Audit-log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     sentByUserId || null,
        action:      'onboarding.invite.sent',
        entity_type: 'onboarding',
        entity_id:   onboardingId,
        after_json:  {
          template_name : templateName,
          language      : languageCode,
          conv_id       : convId,
          conv_created  : convCreated,
          message_id    : insertedId,
          meta_wamid    : wamid,
          source,
          forced        : !!force,
          previously_sent_at: ob.invite_sent_at || null,
        },
      });
    } catch (e) {
      console.error('[onboarding-invite audit]', e?.message || e);
    }

    return {
      sent          : true,
      wizard_link   : `${process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app'}/modules/onboarding.html?t=${encodeURIComponent(ob.token)}`,
      template_name : templateName,
      message_id    : insertedId,
      meta_wamid    : wamid,
      conv_id       : convId,
    };
  } catch (e) {
    console.error('[onboarding-invite] fatal:', e?.message || e);
    return { sent: false, reason: 'fatal', error: e?.message || 'invite send failed' };
  }
}
