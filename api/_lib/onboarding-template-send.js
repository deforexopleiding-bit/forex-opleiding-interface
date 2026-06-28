// api/_lib/onboarding-template-send.js
//
// Gedeelde send-pipeline voor outbound onboarding-WhatsApp-templates.
// Gebruikt door de reminder-cron; SHOULD ook gebruikt worden door
// onboarding-invite.js (zie REFACTOR-NOTE onderaan). Pipeline is bewust
// generic gemaakt zodat een nieuwe outbound use-case (bv. event-uitnodiging
// vanuit onboarding) alleen een nieuwe wrapper hoeft te schrijven.
//
// Wat deze module doet:
//   - laadt onboarding + customer + module-config + template-row
//   - resolved meta_param_mapping.body via buildMetaVariablesFromMapping
//     met ctx = { customer, onboarding, moduleContext }
//   - upsert outbound conversation
//   - sendTemplate (Meta) — skip bij dry=true (alleen rapporteren)
//   - persist whatsapp_messages-rij + conv last_message_at
//   - delegate post-send idempotency-update aan caller (postSendUpdate)
//   - audit-log met caller-bepaalde action
//
// Wat deze module NIET doet:
//   - Geen idempotentie-check (caller doet 'm voordat ie deze helper aanroept).
//     Bv. invite-wrapper checkt `invite_sent_at`, reminder-cron checkt
//     `reminder_count < max_reminders + day_offset bereikt`.
//   - Geen e-mail.
//   - Geen nieuwe Meta-client — hergebruikt sendTemplate uit meta-whatsapp.js.
//
// REFACTOR-NOTE:
//   api/_lib/onboarding-invite.js heeft (sinds PR #393) deze pipeline INLINE.
//   In deze PR (C2) bewust GEEN refactor om de bewezen invite-flow niet te
//   raken — risicobeperking. Een latere PR kan onboarding-invite.js migreren
//   naar deze helper; mismatch wordt dan opgelost door post-send-callback
//   die invite_sent_at update i.p.v. reminder_count++.

import { supabaseAdmin } from '../supabase.js';
import { sendTemplate, MetaNotConfiguredError } from './meta-whatsapp.js';
import { buildMetaVariablesFromMapping } from './template-variables.js';
import { upsertOutboundConversation } from './conv-upsert.js';
import { getModuleContextByPhoneNumberId } from './module-context.js';
import { ensureInvoicePaymentLink } from './invoice-payment-link.js';

const MAX_VAR_VALUE = 1000;

function toE164Plus(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 8) return null;
  return '+' + digits;
}

/**
 * Stuur een onboarding-WhatsApp-template voor één onboarding.
 *
 * @param {object} opts
 * @param {string} opts.onboardingId         - uuid van de onboarding
 * @param {string} opts.templateName         - meta-template-naam (APPROVED-gate)
 * @param {string} [opts.languageCode='nl']
 * @param {string} [opts.source]             - audit-bron ('reminder-step-1' etc)
 * @param {string|null} [opts.sentByUserId]  - operator-id (null voor system)
 * @param {string} [opts.auditAction]        - bv. 'onboarding.reminder.sent'
 * @param {(onboarding:object, result:object) => Promise<void>} [opts.postSendUpdate]
 *                                            - caller-callback voor idempotentie-
 *                                              update (reminder_count++, etc).
 *                                              Mag NULL zijn → geen update.
 *                                              Wordt NIET aangeroepen bij dry=true.
 * @param {boolean} [opts.dry=false]         - report-only modus; geen Meta-send
 *                                              en geen persist + geen postSendUpdate.
 * @param {object} [opts.extraOnboardingCtx] - extra velden die in de onboarding-
 *                                              context worden gemerged (bv. temp_password,
 *                                              login_url) voor de credentials-flow.
 *                                              Worden NIET gepersist.
 * @returns {Promise<{
 *   sent: boolean, dry?: boolean,
 *   reason?: string, error?: string,
 *   template_name?: string, conv_id?: string,
 *   message_id?: string, meta_wamid?: string,
 *   onboarding?: object, customer?: object
 * }>}
 */
export async function sendOnboardingTemplateGeneric({
  onboardingId,
  templateName,
  languageCode = 'nl',
  source = 'unknown',
  sentByUserId = null,
  auditAction = 'onboarding.template.sent',
  postSendUpdate = null,
  dry = false,
  extraOnboardingCtx = null,
} = {}) {
  if (!onboardingId) return { sent: false, reason: 'no-onboarding-id' };
  if (!templateName) return { sent: false, reason: 'no-template-name' };

  try {
    // 1) Onboarding-row + traject.
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select(
        'id, customer_id, traject_id, status, current_step, token, archived_at, ' +
        'invite_sent_at, reminder_count, last_reminder_at, ' +
        'traject:onboarding_trajecten(label, type)'
      )
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) return { sent: false, reason: 'db-error', error: 'onboarding lookup: ' + obErr.message };
    if (!ob) return { sent: false, reason: 'not-found' };
    if (ob.archived_at) return { sent: false, reason: 'archived' };
    if (!ob.token) return { sent: false, reason: 'no-token' };

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

    // 3) Module-config voor onboarding-lijn.
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id, business_account_id, is_active')
      .eq('module', 'onboarding')
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) return { sent: false, reason: 'db-error', error: 'module-config lookup: ' + modErr.message };
    if (!modCfg?.phone_number_id) return { sent: false, reason: 'geen-module-config' };

    // 4) Template-row (APPROVED-gate).
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

    // 5) Module-context (afdeling-vars).
    let moduleContext = null;
    try {
      moduleContext = await getModuleContextByPhoneNumberId(supabaseAdmin, modCfg.phone_number_id);
    } catch (e) {
      console.error('[onboarding-template-send] module-context:', e?.message || e);
    }

    // 6) Vars resolven.
    const bodyMapping = (tplRow.meta_param_mapping && typeof tplRow.meta_param_mapping === 'object')
      ? (tplRow.meta_param_mapping.body || tplRow.meta_param_mapping)
      : null;
    const onboardingCtx = {
      token:         ob.token,
      status:        ob.status,
      traject_label: ob.traject?.label || null,
    };
    // Caller-specifieke extra context (bv. credentials-flow met
    // temp_password + login_url). NIET gepersist; alleen voor de
    // variabelen-resolver van deze ene template-send.
    if (extraOnboardingCtx && typeof extraOnboardingCtx === 'object') {
      Object.assign(onboardingCtx, extraOnboardingCtx);
    }

    // Invoice-context: alleen laden als het template een factuur.*-variabele
    // (of een klant-invoice-aggregatie) gebruikt — anders geen extra query/TL-call.
    let invoice = null;
    let openInvoices = [];
    const needsInvoice = bodyMapping && typeof bodyMapping === 'object' &&
      Object.values(bodyMapping).some((v) => typeof v === 'string' &&
        (v.startsWith('factuur.') || v === 'klant.factuur_lijst' || v === 'klant.totaal_open' || v === 'klant.aantal_open'));
    if (needsInvoice) {
      try {
        const { data: invs, error: invErr } = await supabaseAdmin
          .from('invoices')
          .select('id, tl_invoice_id, invoice_number, status, amount_total, amount_paid, credited_amount, due_date, issue_date, payment_url')
          .eq('customer_id', ob.customer_id)
          .in('status', ['open', 'partially_paid', 'overdue'])
          .order('due_date', { ascending: true });
        if (!invErr) {
          openInvoices = invs || [];
          invoice = openInvoices[0] || null;
          if (invoice?.id) {
            try {
              const linkRes = await ensureInvoicePaymentLink(invoice.id);
              if (linkRes?.payment_url) invoice.payment_url = linkRes.payment_url;
            } catch (e) {
              console.error('[onboarding-template-send] payment-link:', e?.message || e);
            }
          }
        }
      } catch (e) {
        console.error('[onboarding-template-send] invoice-context:', e?.message || e);
      }
    }

    const ctx = { customer, onboarding: onboardingCtx, moduleContext, invoice, openInvoices };
    let resolved = {};
    if (bodyMapping && typeof bodyMapping === 'object' && Object.keys(bodyMapping).length > 0) {
      try {
        resolved = buildMetaVariablesFromMapping(bodyMapping, ctx) || {};
      } catch (e) {
        console.error('[onboarding-template-send] resolve:', e?.message || e);
        return { sent: false, reason: 'variable-resolve-fail', error: e?.message || 'resolve failed' };
      }
    }
    const sortedKeys = Object.keys(resolved)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const variables = sortedKeys.map((k) => String(resolved[k] ?? '').slice(0, MAX_VAR_VALUE));

    // 7) Dry-mode: terug-rapporteren zonder Meta-send + zonder persist.
    if (dry) {
      return {
        sent: true,
        dry: true,
        template_name: templateName,
        onboarding: ob,
        customer,
      };
    }

    // 8) Conv-upsert (outbound).
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
      console.error('[onboarding-template-send] conv-upsert:', e?.message || e);
      return { sent: false, reason: 'conv-upsert-fail', error: e?.message || 'conv upsert failed' };
    }

    // 9) Meta-send.
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
      console.error('[onboarding-template-send] Meta send:', msg);
      return { sent: false, reason: 'meta-send-fail', error: 'Meta send failed: ' + msg };
    }
    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;

    // 10) Preview-body voor whatsapp_messages.body.
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

    // 11) Persist outbound whatsapp_messages.
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
      if (insErr) console.error('[onboarding-template-send] message persist:', insErr.message);
      else insertedId = ins?.id || null;
    } catch (e) {
      console.error('[onboarding-template-send] message persist exception:', e?.message || e);
    }

    // 12) Update conv.last_message_at.
    try {
      await supabaseAdmin
        .from('whatsapp_conversations')
        .update({
          last_message_at     : nowIso,
          last_message_preview: previewBody ? String(previewBody).slice(0, 120) : null,
        })
        .eq('id', convId);
    } catch (e) {
      console.error('[onboarding-template-send] conv update:', e?.message || e);
    }

    // 13) Caller-callback voor idempotentie (reminder_count++, etc.).
    const sendResult = {
      sent: true,
      template_name: templateName,
      conv_id: convId,
      conv_created: convCreated,
      message_id: insertedId,
      meta_wamid: wamid,
    };
    if (typeof postSendUpdate === 'function') {
      try {
        await postSendUpdate(ob, sendResult);
      } catch (e) {
        console.error('[onboarding-template-send] postSendUpdate:', e?.message || e);
      }
    }

    // 14) Audit-log.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     sentByUserId || null,
        action:      auditAction,
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
        },
      });
    } catch (e) {
      console.error('[onboarding-template-send audit]', e?.message || e);
    }

    return { ...sendResult, onboarding: ob, customer };
  } catch (e) {
    console.error('[onboarding-template-send] fatal:', e?.message || e);
    return { sent: false, reason: 'fatal', error: e?.message || 'send failed' };
  }
}
