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

  // ─── SANDBOX / DRY-RUN GUARDS ───────────────────────────────────────
  // 1) Als de globale dry-run vlag AAN staat → geen echte SMTP-call, wel
  //    het 'email_sent'-log-event zodat de rest van de flow (pipeline-
  //    trigger, workflow-status) normaal doorloopt.
  // 2) Als de klant is_test=true is: assert dat het doel-adres exact
  //    matcht met app_settings.dunning_sandbox_contact.email — anders
  //    abort. Zelfs zonder dry-run kan een test-mail dus nooit lekken.
  try {
    const { isDryRunEnabled, assertRecipientMatchesSandbox, buildDryRunLogPayload } =
      await import('./dunning-dry-run.js');
    if (customer?.is_test) {
      try {
        await assertRecipientMatchesSandbox({ isTest: true, actual: to, channel: 'email' });
      } catch (guardErr) {
        return {
          status: 'skipped',
          log_event: 'email_skipped_sandbox_guard',
          log_payload: { template_id: template.id, to, reason: guardErr.message },
        };
      }
    }
    if (await isDryRunEnabled()) {
      return {
        status: 'ok',
        log_event: 'email_sent',
        log_payload: {
          template_id: template.id,
          to,
          subject: rendered.subject,
          message_id: 'dry-run',
          variables_used: rendered.variables_used,
          ...buildDryRunLogPayload({
            channel: 'email',
            to,
            isTest: !!customer?.is_test,
            preview: { subject: rendered.subject, body: rendered.body.slice(0, 200) },
          }),
        },
      };
    }
  } catch (guardModuleErr) {
    // Fail-safe: als de guard-module niet laadt (bv. eerste deploy zonder
    // migratie 036), gedragen we ons alsof dry-run AAN staat en sturen NIET.
    console.warn('[dunning-executor] dry-run module niet beschikbaar → skip send', guardModuleErr?.message);
    return {
      status: 'ok',
      log_event: 'email_sent',
      log_payload: {
        template_id: template.id,
        to,
        subject: rendered.subject,
        message_id: 'dry-run-fallback',
        variables_used: rendered.variables_used,
        dry_run: true,
        fallback: 'guard_module_unavailable',
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
 * Task-step: maakt een echte taak aan in pending_actions (Fase 2a).
 *
 * Model-keuze: we hergebruiken de bestaande pending_actions-tabel met
 * action_type='MANUAL_FOLLOWUP' (uit api/_lib/task-types.js — categorie
 * 'arrangement', label 'Follow-up bericht'). Dat is bewust:
 *   - de tabel + het frontend Open Acties-dashboard renderen 'em al;
 *   - MANUAL_FOLLOWUP is expliciet bedoeld als "generieke follow-up
 *     die door een mens moet worden opgepakt" (zie task-types.js r47-51);
 *   - geen nieuwe migratie nodig.
 *
 * Config (step.config):
 *   title       (verplicht) — kop van de taak
 *   description (opt)       — vrije tekst
 *   assignee_role (opt)     — informatief; routing komt in later fase
 *
 * Dry-run: consistent met email/whatsapp-executor. In dry-run géén
 * pending_actions-INSERT, wel log_event='task_created' met dry_run:true
 * payload zodat de rest van de workflow-run normaal doorloopt.
 *
 * Fail-soft:
 *   config.title ontbreekt        → skipped 'task_skipped_no_title'
 *   customer.id ontbreekt         → skipped 'task_skipped_no_customer'
 *   dry-run module load faalt     → skipped 'task_skipped_no_guard' (fail-safe: geen insert)
 *   insert-fout                   → failed  'task_create_failed'
 * Een mislukte taak laat de workflow-run niet klappen — cron logt + telt.
 */
export async function executeTaskStep({ supabaseAdmin, run, step, customer, openInvoices }) {
  const cfg = step?.config || {};
  const rawTitle       = String(cfg.title || '').trim();
  const rawDescription = String(cfg.description || '').trim();
  const assigneeRole   = cfg.assignee_role ? String(cfg.assignee_role) : null;

  if (!rawTitle) {
    return {
      status: 'skipped',
      log_event: 'task_skipped_no_title',
      log_payload: {
        workflow_id: run?.workflow_id || null,
        step_id: step?.id || null,
        reason: 'step.config.title ontbreekt',
      },
    };
  }
  if (!customer?.id) {
    return {
      status: 'skipped',
      log_event: 'task_skipped_no_customer',
      log_payload: {
        workflow_id: run?.workflow_id || null,
        step_id: step?.id || null,
        reason: 'customer.id ontbreekt in run-context',
      },
    };
  }

  // Kies een aanleiding-factuur (eerste openstaande) — informatief in de
  // taak; niet leidend. Bewust: pending_actions.invoice_id is een FK die
  // Open Acties toont, dus we koppelen 'em zodat de admin direct de
  // context ziet. Bij geen open facturen: null.
  const firstInvoice = Array.isArray(openInvoices) && openInvoices.length
    ? openInvoices[0]
    : null;

  // ─── DRY-RUN GUARD ────────────────────────────────────────────────
  // Zelfde patroon als email/whatsapp-executors. In dry-run géén write
  // naar pending_actions; wel log_event zodat de workflow doorloopt en
  // je in dunning_log ziet wat er gebeurd zou zijn.
  let dry = false;
  try {
    const { isDryRunEnabled, buildDryRunLogPayload } = await import('./dunning-dry-run.js');
    dry = await isDryRunEnabled();
    if (dry) {
      return {
        status: 'ok',
        log_event: 'task_created',
        log_payload: {
          title:           rawTitle,
          description:     rawDescription || null,
          assignee_role:   assigneeRole,
          customer_id:     customer.id,
          invoice_id:      firstInvoice?.id || null,
          workflow_id:     run?.workflow_id || null,
          workflow_run_id: run?.id || null,
          step_id:         step?.id || null,
          pending_action_id: 'dry-run',
          ...buildDryRunLogPayload({
            channel: 'task',
            to:      customer.id,
            isTest:  !!customer?.is_test,
            preview: { title: rawTitle, description: rawDescription.slice(0, 200) },
          }),
        },
      };
    }
  } catch (guardModuleErr) {
    // Guard-module niet beschikbaar → fail-safe: GEEN taak aanmaken.
    // Zelfde defensieve keuze als email-executor (r144-161).
    console.warn('[dunning-executor task] dry-run module niet beschikbaar → skip insert', guardModuleErr?.message);
    return {
      status: 'skipped',
      log_event: 'task_skipped_no_guard',
      log_payload: {
        title:           rawTitle,
        customer_id:     customer.id,
        workflow_id:     run?.workflow_id || null,
        step_id:         step?.id || null,
        reason:          'dry-run guard module load failed: ' + (guardModuleErr?.message || 'unknown'),
        fallback:        'no_insert',
      },
    };
  }

  // ─── LIVE INSERT ──────────────────────────────────────────────────
  // action_type='MANUAL_FOLLOWUP' zodat de taak in Open Acties (categorie
  // 'arrangement') verschijnt. arrangement_id=NULL — deze taak is
  // workflow-driven, niet arrangement-driven.
  const payload = {
    title:           rawTitle,
    description:     rawDescription || null,
    assignee_role:   assigneeRole,
    source:          'dunning_workflow',
    workflow_id:     run?.workflow_id || null,
    workflow_run_id: run?.id || null,
    step_id:         step?.id || null,
    rationale:       `Taak aangemaakt door dunning-workflow-step (run ${run?.id || '?'})`,
  };
  const insertRow = {
    customer_id:         customer.id,
    arrangement_id:      null,
    invoice_id:          firstInvoice?.id || null,
    action_type:         'MANUAL_FOLLOWUP',
    status:              'PENDING',
    proposed_by_user_id: null, // cron
    payload,
  };
  try {
    const { data, error } = await supabaseAdmin
      .from('pending_actions')
      .insert(insertRow)
      .select('id, customer_id, action_type, status, invoice_id, created_at')
      .single();
    if (error) throw new Error(error.message);
    return {
      status: 'ok',
      log_event: 'task_created',
      log_payload: {
        title:             rawTitle,
        description:       rawDescription || null,
        assignee_role:     assigneeRole,
        pending_action_id: data.id,
        customer_id:       data.customer_id,
        action_type:       data.action_type,
        invoice_id:        data.invoice_id,
        workflow_id:       run?.workflow_id || null,
        workflow_run_id:   run?.id || null,
        step_id:           step?.id || null,
        dry_run:           false,
      },
    };
  } catch (e) {
    return {
      status: 'failed',
      log_event: 'task_create_failed',
      log_payload: {
        title:       rawTitle,
        customer_id: customer.id,
        workflow_id: run?.workflow_id || null,
        step_id:     step?.id || null,
        error:       e?.message || String(e),
      },
    };
  }
}
