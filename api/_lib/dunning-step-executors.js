// api/_lib/dunning-step-executors.js
//
// Step-executors voor de dunning workflow engine. Elke executor neemt context
// uit de cron (supabaseAdmin, run, step, customer, openInvoices) en geeft een
// uniform resultaat terug:
//   { status, log_event, log_payload }
//
// status:
//   "ok"      — actie geslaagd, ga naar volgende stap
//   "skipped" — actie bewust overgeslagen (bv. infra ontbreekt, geen email)
//   "failed"  — actie probeerde te draaien maar viel om; cron logt + telt error
//
// Logs worden door de cron weggeschreven in dunning_run_log (of vergelijkbaar).
//
// Email-strategie (recon-aanbeveling A): Hergebruik api/mailer.js sendMail +
// wrapEmailHtml. We importeren dynamisch zodat een ontbrekende env-var (test-
// omgeving zonder IMAP_PASS_INFO) de cron niet keihard crasht — bij missende
// infra valt deze terug op een "skipped" + log_event.
//
// WhatsApp-strategie: altijd "skipped" — Meta Cloud API credentials komen pas
// online in PR A2 (zie module A roadmap).

import { renderTemplate } from './dunning-template-render.js';

async function loadTemplate(supabaseAdmin, templateId, expectedKind) {
  if (!templateId) {
    return { error: { code: 'no_template_id', message: 'step.config.template_id ontbreekt' } };
  }
  const { data, error } = await supabaseAdmin
    .from('dunning_templates')
    .select('id, name, kind, subject, body, is_active')
    .eq('id', templateId)
    .maybeSingle();
  if (error) {
    return { error: { code: 'template_fetch_failed', message: error.message } };
  }
  if (!data) {
    return { error: { code: 'template_not_found', message: `Template ${templateId} niet gevonden` } };
  }
  if (expectedKind && data.kind !== expectedKind) {
    return { error: { code: 'template_kind_mismatch', message: `Template kind=${data.kind} expected=${expectedKind}` } };
  }
  return { template: data };
}

/**
 * Email-step: render template, verstuur via Strato SMTP (mailer.js).
 * Bij ontbrekende infra of geen klant-email → "skipped".
 */
export async function executeEmailStep({ supabaseAdmin, run, step, customer, openInvoices }) {
  const templateId = step?.config?.template_id;
  const { template, error: tplError } = await loadTemplate(supabaseAdmin, templateId, 'email');
  if (tplError) {
    return {
      status: 'skipped',
      log_event: 'email_skipped_template_error',
      log_payload: { template_id: templateId, ...tplError },
    };
  }

  const rendered = renderTemplate({
    body: template.body,
    subject: template.subject,
    customer,
    openInvoices,
  });

  const to = customer?.email;
  if (!to) {
    return {
      status: 'skipped',
      log_event: 'email_skipped_no_recipient',
      log_payload: {
        template_id: template.id,
        subject_rendered: rendered.subject,
        reason: 'Klant heeft geen email-adres',
      },
    };
  }

  // Dynamische import: bij ontbrekende IMAP_PASS_INFO valt mailer.js om bij
  // eerste sendMail-call. We vangen dat hier op als "skipped" i.p.v. "failed"
  // omdat het een infra-config issue is, geen runtime-bug per klant.
  let sendMail;
  let wrapEmailHtml;
  try {
    const mailer = await import('../mailer.js');
    sendMail = mailer.sendMail;
    wrapEmailHtml = mailer.wrapEmailHtml;
  } catch (e) {
    return {
      status: 'skipped',
      log_event: 'email_skipped_no_infra',
      log_payload: {
        template_id: template.id,
        subject_rendered: rendered.subject,
        body_rendered: rendered.body,
        to,
        reason: `mailer module load failed: ${e.message}`,
      },
    };
  }

  try {
    const html = wrapEmailHtml(rendered.subject, escapeBodyToHtml(rendered.body));
    const result = await sendMail({
      to,
      subject: rendered.subject,
      text: rendered.body,
      html,
    });
    if (!result || !result.success) {
      return {
        status: 'failed',
        log_event: 'email_send_failed',
        log_payload: {
          template_id: template.id,
          to,
          error: result?.error || 'unknown',
        },
      };
    }
    return {
      status: 'ok',
      log_event: 'email_sent',
      log_payload: {
        template_id: template.id,
        to,
        subject: rendered.subject,
        message_id: result.messageId,
        variables_used: rendered.variables_used,
      },
    };
  } catch (e) {
    return {
      status: 'failed',
      log_event: 'email_send_exception',
      log_payload: {
        template_id: template.id,
        to,
        error: e.message,
      },
    };
  }
}

function escapeBodyToHtml(text) {
  if (!text) return '';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Behoud newlines als <br> zodat plain-text templates leesbaar blijven.
  return `<div style="white-space:pre-wrap; line-height:1.5; color:#111;">${escaped}</div>`;
}

/**
 * WhatsApp-step: altijd "skipped" tot Meta Cloud API credentials online zijn
 * (PR A2). We renderen wel zodat we de body in de log kunnen meegeven voor
 * preview/audit.
 */
export async function executeWhatsappStep({ supabaseAdmin, run, step, customer, openInvoices }) {
  const templateId = step?.config?.template_id;
  const { template, error: tplError } = await loadTemplate(supabaseAdmin, templateId, 'whatsapp');
  if (tplError) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_template_error',
      log_payload: { template_id: templateId, ...tplError },
    };
  }

  const rendered = renderTemplate({
    body: template.body,
    subject: template.subject,
    customer,
    openInvoices,
  });

  // C4.5 + C4.6 TODO: bij integratie met named-variable templates, twee
  // extra resolve-stappen vóór de send-call:
  //
  //   1. Roep `await ensureInvoicePaymentLink(invoice.id)` aan
  //      (api/_lib/invoice-payment-link.js) zodat factuur.betaal_link gevuld
  //      is. Pre-warm bespaart een latency-spike op het send-moment; de
  //      send-endpoint zelf doet ook lazy-fetch als backup.
  //   2. Roep `await getModuleContextByPhoneNumberId(supabaseAdmin,
  //      conv.phone_number_id)` aan (api/_lib/module-context.js) zodat
  //      afdeling.* (telefoon/whatsapp/email/ondertekenaar) geresolved worden
  //      uit de juiste whatsapp_module_config rij van de zendende lijn.
  //   3. Geef beide resultaten door aan resolveVariables-context:
  //      { customer, invoice, openInvoices, moduleContext }.
  //
  // Pattern (zodra Meta credentials live zijn, PR A2):
  //   - Detecteer of de gekozen WhatsApp-template een factuur.betaal_link of
  //     afdeling.* mapping bevat (meta_param_mapping.body bevat de keys).
  //   - Kies de eerste openInvoices[0] (of een step.config.invoice_id selector)
  //     en doe pre-warm + lookup.
  //   - POST naar /api/inbox-send-template (die intern dezelfde resolve-flow
  //     doet) of inline render via resolveVariables.
  //   - Fail-soft: errors loggen en doorgaan — resolver vult lege string.

  return {
    status: 'skipped',
    log_event: 'whatsapp_skipped_no_meta',
    log_payload: {
      template_id: template.id,
      body_rendered: rendered.body,
      reason: 'Meta credentials niet ingesteld - wacht op PR A2',
    },
  };
}

/**
 * Wait-step: pure no-op. De cron zelf bepaalt op basis van log_payload.days
 * wanneer de run weer mag draaien.
 */
export async function executeWaitStep({ run, step }) {
  return {
    status: 'ok',
    log_event: 'wait',
    log_payload: { days: step?.config?.days || 0 },
  };
}

/**
 * Task-step: zou een taak moeten aanmaken in de tasks-tabel.
 * Voor nu: log-only. Implementatie volgt in PR B5.
 */
export async function executeTaskStep({ supabaseAdmin, run, step, customer }) {
  const title = step?.config?.title || '';
  const description = step?.config?.description || '';
  const assigned_user_id = step?.config?.assigned_user_id || null;

  // TODO PR B5: insert in tasks-tabel
  return {
    status: 'ok',
    log_event: 'task_created',
    log_payload: {
      title,
      description,
      assigned_user_id,
      customer_id: customer?.id || null,
    },
  };
}
