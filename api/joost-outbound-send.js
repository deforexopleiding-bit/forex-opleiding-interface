// api/joost-outbound-send.js
// Joost E2.2 — outbound template-send executor (per workflow-event).
//
// Doel:
//   Verzend (of weiger te verzenden) een Joost outbound WhatsApp-template die
//   hoort bij één dunning_workflow_runs-event. STRICT template-only: er wordt
//   GEEN LLM-generatie gedaan; de template-keuze + variabelen-render volgen
//   uitsluitend de workflow-step config (template_id). Dit is de "Joost-laag"
//   bovenop de dunning engine: in plaats van direct via dunning-step-executors
//   te sturen (die zit nog in 'skipped_no_meta'-mode), routeert deze endpoint
//   via Joost's autonomy-laag zodat dezelfde guardrails (office-hours,
//   rate-limits, paused-check) gelden als bij reactive autonomy.
//
// Architectuur:
//   * Caller: api/joost-outbound-scheduler.js (cron) — per pending workflow-
//     event roept hij dit endpoint INTERN aan met X-Internal-Token.
//   * Geen LLM. Geen suggestion-row. Wel een audit-trail via joost.outbound_*
//     audit-actions + joost_conversation_state-update voor cooldown/cap-telling.
//   * Hergebruikt evaluateAutonomy() voor de gate-logica (zonder mode-check:
//     outbound is per-definitie autonomous omdat de workflow-engine het
//     scheduled heeft) + sendTemplate() uit _lib/meta-whatsapp.js voor de
//     Meta-call.
//
// Auth:
//   * X-Internal-Token == INTERNAL_API_TOKEN -> system call (scheduler).
//     Verplicht. Geen user-flow ondersteund: outbound-send is altijd
//     server-getriggerd, geen "klik om te sturen" pad.
//
// Body:
//   {
//     run_id:  uuid (verplicht),  // dunning_workflow_runs.id
//     step_id: uuid (verplicht),  // dunning_workflow_steps.id (current_step_id)
//   }
//
// Response 200:
//   {
//     sent:    boolean,
//     run_id:  uuid,
//     step_id: uuid,
//     decision: { intent, confidence, mode, allow_autonomous, blocked_reason, ... },
//     message_id?: uuid,         // alleen bij sent=true
//     meta_wamid?: string,       // alleen bij sent=true
//     blocked_reason?: string,   // alleen bij sent=false
//     skipped_reason?: string,   // workflow-config-skip (geen Joost-decision)
//   }
//
// Error responses:
//   400  body-validatie
//   401  geen INTERNAL_API_TOKEN match
//   403  feature-flag e2_outbound_executor uit
//   404  run / step / template / conv niet gevonden
//   409  run niet in active-state (al voltooid / cancelled)
//   500  database-fout
//   502  Meta API-fout
//   503  Meta WhatsApp niet geconfigureerd / ANTHROPIC niet relevant (template-pad)

import { supabaseAdmin } from './supabase.js';
import {
  sendTemplate,
  getConfigStatus,
  MetaNotConfiguredError,
} from './_lib/meta-whatsapp.js';
import { renderTemplate } from './_lib/dunning-template-render.js';
import { evaluateAutonomy, logAutonomyDecision } from './joost-autonomy-evaluate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }
function nowIso() { return new Date().toISOString(); }

/**
 * Map decision -> compact reason string voor response + audit.
 */
function describeBlock(decision) {
  if (!decision) return 'no_decision';
  if (decision.blocked_reason) return decision.blocked_reason;
  if (decision.stop_action === 'escalation') return 'INTENT_DISABLED';
  if (decision.stop_action === 'task_create') return 'MANDATE_EXCEEDED';
  if (!decision.allow_autonomous) return 'MODE_DRAFT_OR_UNKNOWN';
  return 'allowed';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth: INTERNAL_API_TOKEN verplicht ----
  const internalTokenHeader = req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || null;
  const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
  if (!expectedInternalToken) {
    return res.status(503).json({ error: 'INTERNAL_API_TOKEN niet geconfigureerd' });
  }
  if (!internalTokenHeader || internalTokenHeader !== expectedInternalToken) {
    return res.status(401).json({ error: 'Unauthorized (X-Internal-Token vereist)' });
  }

  // ---- Body parsen ----
  const body = req.body || {};
  const runId  = typeof body.run_id  === 'string' ? body.run_id.trim()  : '';
  const stepId = typeof body.step_id === 'string' ? body.step_id.trim() : '';
  if (!runId)  return res.status(400).json({ error: 'run_id vereist' });
  if (!stepId) return res.status(400).json({ error: 'step_id vereist' });
  if (!isUuid(runId))  return res.status(400).json({ error: 'run_id moet geldige uuid zijn' });
  if (!isUuid(stepId)) return res.status(400).json({ error: 'step_id moet geldige uuid zijn' });

  try {
    // ========================================================================
    // STAP 1: run + step + workflow ophalen
    // ========================================================================
    const { data: run, error: runErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, workflow_id, customer_id, status, current_step_id, next_action_at')
      .eq('id', runId)
      .maybeSingle();
    if (runErr) throw new Error('dunning_workflow_runs lookup: ' + runErr.message);
    if (!run) return res.status(404).json({ error: 'Workflow-run niet gevonden' });
    if (run.status !== 'active') {
      return res.status(409).json({
        error: 'Workflow-run is niet in active-state',
        current_status: run.status,
      });
    }

    const { data: step, error: stepErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, workflow_id, step_order, step_type, config')
      .eq('id', stepId)
      .maybeSingle();
    if (stepErr) throw new Error('dunning_workflow_steps lookup: ' + stepErr.message);
    if (!step) return res.status(404).json({ error: 'Workflow-step niet gevonden' });
    if (step.step_type !== 'whatsapp') {
      return res.status(400).json({
        error: 'Alleen whatsapp-steps ondersteund door outbound-send',
        step_type: step.step_type,
      });
    }
    const templateId = step.config && step.config.template_id ? String(step.config.template_id) : '';
    if (!templateId) {
      return res.status(400).json({ error: 'Step heeft geen template_id in config' });
    }

    // ========================================================================
    // STAP 2: joost_config + feature-flag gate (e2_outbound_executor)
    // ========================================================================
    const moduleKey = 'finance';
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, autonomy_config, feature_flags, is_enabled')
      .eq('module', moduleKey)
      .maybeSingle();
    if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);
    if (!cfg) return res.status(503).json({ error: `joost_config ontbreekt voor module=${moduleKey}` });

    const featureFlags = (cfg.feature_flags && typeof cfg.feature_flags === 'object')
      ? cfg.feature_flags : {};
    if (featureFlags.e2_outbound_executor !== true) {
      return res.status(403).json({
        error: 'Outbound executor is uitgeschakeld',
        feature_flag: 'e2_outbound_executor',
      });
    }

    // Workflow-config skip-checks (allowed_templates + allowed_workflow_steps).
    const autonomyCfg = (cfg.autonomy_config && typeof cfg.autonomy_config === 'object')
      ? cfg.autonomy_config : {};
    const outboundCfg = (autonomyCfg.outbound && typeof autonomyCfg.outbound === 'object')
      ? autonomyCfg.outbound : {};
    const allowedTemplates = Array.isArray(outboundCfg.allowed_templates) ? outboundCfg.allowed_templates : [];
    const allowedSteps     = Array.isArray(outboundCfg.allowed_workflow_steps) ? outboundCfg.allowed_workflow_steps : [];
    if (outboundCfg.enabled === false) {
      return res.status(200).json({
        sent: false, run_id: runId, step_id: stepId,
        skipped_reason: 'OUTBOUND_DISABLED_IN_CONFIG',
      });
    }
    if (allowedTemplates.length > 0 && !allowedTemplates.includes(templateId)) {
      return res.status(200).json({
        sent: false, run_id: runId, step_id: stepId,
        skipped_reason: 'TEMPLATE_NOT_IN_ALLOWED_LIST',
      });
    }
    if (allowedSteps.length > 0 && !allowedSteps.includes(stepId)) {
      return res.status(200).json({
        sent: false, run_id: runId, step_id: stepId,
        skipped_reason: 'STEP_NOT_IN_ALLOWED_LIST',
      });
    }

    // ========================================================================
    // STAP 3: customer + conv + template + open invoices
    // ========================================================================
    const { data: customer, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at')
      .eq('id', run.customer_id)
      .maybeSingle();
    if (custErr) throw new Error('customers lookup: ' + custErr.message);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });
    if (customer.archived_at || customer.anonymized_at) {
      return res.status(200).json({
        sent: false, run_id: runId, step_id: stepId,
        skipped_reason: 'CUSTOMER_ARCHIVED_OR_ANONYMIZED',
      });
    }

    // Conv: zoek de meest recente whatsapp-conversation voor deze klant.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, phone_number, phone_number_id, last_inbound_at, last_message_at')
      .eq('customer_id', customer.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (convErr) throw new Error('whatsapp_conversations lookup: ' + convErr.message);
    if (!conv) {
      return res.status(404).json({ error: 'Geen WhatsApp-conversatie voor klant gekoppeld' });
    }
    if (!conv.phone_number) {
      return res.status(400).json({ error: 'Conversation heeft geen phone_number' });
    }

    const { data: template, error: tplErr } = await supabaseAdmin
      .from('dunning_templates')
      .select('id, name, kind, subject, body, meta_template_name, language, is_active')
      .eq('id', templateId)
      .maybeSingle();
    if (tplErr) throw new Error('dunning_templates lookup: ' + tplErr.message);
    if (!template) return res.status(404).json({ error: 'Template niet gevonden' });
    if (template.kind !== 'whatsapp') {
      return res.status(400).json({ error: 'Template-kind moet whatsapp zijn', kind: template.kind });
    }
    if (template.is_active === false) {
      return res.status(200).json({
        sent: false, run_id: runId, step_id: stepId,
        skipped_reason: 'TEMPLATE_INACTIVE',
      });
    }
    if (!template.meta_template_name) {
      return res.status(400).json({ error: 'Template heeft geen meta_template_name' });
    }

    const { data: openInvRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, amount_total, amount_paid, credited_amount, amount_open, due_date, status, invoice_number')
      .eq('customer_id', customer.id)
      .in('status', OPEN_STATUSES);
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);
    const openInvoices = Array.isArray(openInvRows) ? openInvRows : [];
    let openAmount = 0;
    for (const inv of openInvoices) {
      const v = Number(inv.amount_open);
      if (Number.isFinite(v)) openAmount += v;
    }
    // STOP-CONDITIE: geen open invoices = klant heeft betaald.
    if (openInvoices.length === 0) {
      return res.status(200).json({
        sent: false, run_id: runId, step_id: stepId,
        skipped_reason: 'NO_OPEN_INVOICES',
      });
    }

    // ========================================================================
    // STAP 4: conversation-state + autonomy-evaluatie
    // ========================================================================
    const { data: convStateRaw, error: stateErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .select(
        'conversation_id, messages_sent_today, messages_sent_today_date, ' +
        'messages_sent_total, last_message_sent_at, last_outbound_template_sent_at, ' +
        'last_outbound_workflow_step, autonomy_paused_until, autonomy_paused_reason, ' +
        'no_reply_streak_count'
      )
      .eq('conversation_id', conv.id)
      .maybeSingle();
    if (stateErr) throw new Error('joost_conversation_state lookup: ' + stateErr.message);

    // Synthetic suggestion: outbound is template-driven, geen LLM-suggestion.
    // We construeren een minimal suggestion-shape zodat de decision-engine
    // dezelfde rate-limit / office-hours / paused checks doet. Confidence=1.0
    // omdat de template door de workflow-engine al gekozen is. Intent=template-
    // gebaseerd; we mappen op generic 'other' zodat geen arrangement-mandate
    // ten onrechte wordt geraakt (outbound triggers GEEN voorstel-beleid).
    const syntheticSuggestion = {
      detected_intent: 'other',
      confidence:      1.0,
      suggested_reply: template.body || '',
    };

    const decision = evaluateAutonomy({
      suggestion:       syntheticSuggestion,
      conv_state:       convStateRaw || null,
      joost_config:     cfg,
      customer_context: { open_amount: openAmount },
      now:              new Date(),
    });

    // Outbound = altijd autonomous als checks passeren. Mode-check uit
    // evaluateAutonomy verwacht echter een intent-config met mode='autonomous'.
    // Voor 'other'-intent geeft hij stop_action=escalation terug; we overrulen
    // dat: zolang er geen blocked_reason is, behandelen we het als allow.
    // (Rate-limit / paused / office-hours hebben WEL een blocked_reason en
    // worden gerespecteerd.)
    const hasBlockReason = !!decision.blocked_reason;
    const allowOutbound = !hasBlockReason;

    // Audit-log decision ALTIJD.
    await logAutonomyDecision({
      supabaseAdmin,
      conv_id:       conv.id,
      suggestion_id: null,
      decision,
      user_id:       null,
      ip_address:    null,
      triggered_by:  'outbound_scheduler',
    });

    if (!allowOutbound) {
      const reason = describeBlock(decision);
      try {
        await supabaseAdmin.from('audit_log').insert({
          user_id:     null,
          action:      'joost.outbound_send_blocked',
          entity_type: 'dunning_workflow_runs',
          entity_id:   runId,
          after_json:  {
            run_id:       runId,
            step_id:      stepId,
            customer_id:  customer.id,
            conv_id:      conv.id,
            template_id:  templateId,
            blocked_reason: reason,
            decision_log:   Array.isArray(decision.decision_log) ? decision.decision_log : [],
          },
          reason_text: reason,
          ip_address:  null,
        });
      } catch (eAudit) {
        console.error('[joost-outbound-send] audit blocked exception:', eAudit && eAudit.message);
      }
      return res.status(200).json({
        sent:           false,
        run_id:         runId,
        step_id:        stepId,
        decision,
        blocked_reason: reason,
      });
    }

    // ========================================================================
    // STAP 5: Meta config + template render + send
    // ========================================================================
    const cfgStatus = getConfigStatus();
    if (!cfgStatus.configured) {
      return res.status(503).json({
        error:   'Meta WhatsApp niet geconfigureerd',
        missing: cfgStatus.missing,
      });
    }

    // Module-config: outbound phone_number_id (fallback op env).
    let financePnId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('phone_number_id')
        .eq('module', moduleKey)
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[joost-outbound-send] module-config lookup:', modErr.message);
      } else if (modCfg && modCfg.phone_number_id) {
        financePnId = modCfg.phone_number_id;
      }
    } catch (eMod) {
      console.error('[joost-outbound-send] module-config exception:', eMod && eMod.message);
    }
    const outboundPnId = conv.phone_number_id || financePnId || undefined;

    // Render template (UPPERCASE {{NAAM}} / {{FACTUUR_NR}} / etc) voor de
    // body-preview + variables-log. De Meta-call zelf gebruikt het approved
    // template + positional parameters; we mappen onze rendered variabelen
    // in dezelfde volgorde als de dunning_templates legacy-set.
    const rendered = renderTemplate({
      body:          template.body,
      subject:       template.subject,
      customer,
      openInvoices,
    });
    const variablesUsed = rendered.variables_used || {};
    // Positionele Meta-parameters: volgorde komt overeen met
    // hoe template body {{1}}, {{2}}, ... refereert. Voor de legacy dunning-
    // templates is dat NIET expliciet gedefinieerd; we sturen alle vars in
    // de NAAM/FACTUUR_NR/TOTAAL_BEDRAG/DAGEN_OVERDUE/VERVAL_DATUM volgorde
    // als best-effort. C4.6 mapping-pad volgt in latere PR.
    const orderedKeys = ['NAAM', 'FACTUUR_NR', 'TOTAAL_BEDRAG', 'DAGEN_OVERDUE', 'VERVAL_DATUM'];
    const variables = orderedKeys
      .filter(k => Object.prototype.hasOwnProperty.call(variablesUsed, k))
      .map(k => String(variablesUsed[k] || ''));

    // Sandbox-guard: alleen ECHTE klanten worden zonder aanvullende check
    // naar Meta gestuurd. Bij een is_test-klant (sandbox-persoon):
    //   1) recipient-guard (nummer moet matchen met sandbox-contact);
    //   2) als dry-run AAN → sla de Meta-call over, gebruik dry-run-wamid.
    // Zo blijft de productie-flow voor echte klanten identiek.
    let isTestRecipient = false;
    if (conv.customer_id) {
      const { data: cRow } = await supabaseAdmin
        .from('customers').select('is_test').eq('id', conv.customer_id).maybeSingle();
      isTestRecipient = !!(cRow && cRow.is_test === true);
    }

    let metaResult;
    try {
      if (isTestRecipient) {
        const { isDryRunEnabled, assertRecipientMatchesSandbox } =
          await import('./_lib/dunning-dry-run.js');
        try {
          await assertRecipientMatchesSandbox({
            isTest: true, actual: conv.phone_number, channel: 'whatsapp',
          });
        } catch (guardErr) {
          return res.status(400).json({
            error: guardErr?.message || 'Sandbox recipient-guard geblokkeerd',
          });
        }
        if (await isDryRunEnabled()) {
          metaResult = { wamid: 'dry-run:joost:' + conv.id };
          console.log('[joost-outbound-send] DRY-RUN (test) skip Meta', conv.phone_number);
        } else {
          metaResult = await sendTemplate({
            to:             conv.phone_number,
            templateName:   template.meta_template_name,
            languageCode:   template.language || 'nl',
            variables,
            phoneNumberId:  outboundPnId,
          });
        }
      } else {
        metaResult = await sendTemplate({
          to:             conv.phone_number,
          templateName:   template.meta_template_name,
          languageCode:   template.language || 'nl',
          variables,
          phoneNumberId:  outboundPnId,
        });
      }
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({
          error:   'Meta WhatsApp niet geconfigureerd',
          missing: metaErr.missing,
        });
      }
      console.error('[joost-outbound-send] Meta API fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const sentAt = nowIso();

    // ========================================================================
    // STAP 6: Persist + state-updates
    // ========================================================================
    const templateVarsForDb = variables.length
      ? Object.fromEntries(variables.map((v, i) => [String(i + 1), v]))
      : null;
    const previewBody = rendered.body ? String(rendered.body).slice(0, 1000) : null;

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id:    conv.id,
        direction:          'out',
        meta_wamid:         wamid,
        body:               previewBody,
        template_name:      template.meta_template_name,
        template_variables: templateVarsForDb,
        status:             'queued',
        sent_at:            sentAt,
        sent_by_user_id:    null,
      })
      .select('id, meta_wamid, status, sent_at')
      .single();
    if (insErr) throw new Error('whatsapp_messages insert: ' + insErr.message);
    const sentMessageId = inserted.id;

    // whatsapp_conversations last_message_at + preview (fail-soft).
    {
      const preview = ('[template] ' + template.meta_template_name).slice(0, 120);
      const { error: convUpdErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ last_message_at: sentAt, last_message_preview: preview })
        .eq('id', conv.id);
      if (convUpdErr) {
        console.error('[joost-outbound-send] conversation update fail:', convUpdErr.message);
      }
    }

    // joost_conversation_state update (counters + last_outbound_template_*).
    try {
      const today = sentAt.slice(0, 10);
      if (!convStateRaw) {
        const { error: stateInsErr } = await supabaseAdmin
          .from('joost_conversation_state')
          .insert({
            conversation_id:                conv.id,
            messages_sent_today:            1,
            messages_sent_today_date:       today,
            messages_sent_total:            1,
            last_message_sent_at:           sentAt,
            last_outbound_template_sent_at: sentAt,
            last_outbound_workflow_step:    stepId,
          });
        if (stateInsErr && stateInsErr.code !== '23505') {
          console.error('[joost-outbound-send] conv_state insert fail:', stateInsErr.message);
        } else if (stateInsErr && stateInsErr.code === '23505') {
          // Race: andere call insertte intussen — reload + update.
          const { data: stateAgain } = await supabaseAdmin
            .from('joost_conversation_state')
            .select('messages_sent_today, messages_sent_today_date, messages_sent_total')
            .eq('conversation_id', conv.id)
            .maybeSingle();
          if (stateAgain) {
            const sameDay = stateAgain.messages_sent_today_date === today;
            const newToday = (sameDay ? Number(stateAgain.messages_sent_today || 0) : 0) + 1;
            const newTotal = Number(stateAgain.messages_sent_total || 0) + 1;
            await supabaseAdmin
              .from('joost_conversation_state')
              .update({
                messages_sent_today:            newToday,
                messages_sent_today_date:       today,
                messages_sent_total:            newTotal,
                last_message_sent_at:           sentAt,
                last_outbound_template_sent_at: sentAt,
                last_outbound_workflow_step:    stepId,
              })
              .eq('conversation_id', conv.id);
          }
        }
      } else {
        const sameDay = convStateRaw.messages_sent_today_date === today;
        const newToday = (sameDay ? Number(convStateRaw.messages_sent_today || 0) : 0) + 1;
        const newTotal = Number(convStateRaw.messages_sent_total || 0) + 1;
        const { error: stateUpdErr } = await supabaseAdmin
          .from('joost_conversation_state')
          .update({
            messages_sent_today:            newToday,
            messages_sent_today_date:       today,
            messages_sent_total:            newTotal,
            last_message_sent_at:           sentAt,
            last_outbound_template_sent_at: sentAt,
            last_outbound_workflow_step:    stepId,
          })
          .eq('conversation_id', conv.id);
        if (stateUpdErr) {
          console.error('[joost-outbound-send] conv_state update fail:', stateUpdErr.message);
        }
      }
    } catch (eState) {
      console.error('[joost-outbound-send] conv_state exception:', eState && eState.message);
    }

    // dunning_log: registreer dat Joost outbound-send heeft uitgevoerd.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id:     runId,
        step_id:    stepId,
        event_type: 'joost_outbound_sent',
        payload: {
          template_id:        templateId,
          meta_template_name: template.meta_template_name,
          meta_wamid:         wamid,
          message_id:         sentMessageId,
          conversation_id:    conv.id,
          variables:          templateVarsForDb,
        },
        message_id: sentMessageId,
      });
    } catch (eLog) {
      console.error('[joost-outbound-send] dunning_log exception:', eLog && eLog.message);
    }

    // Audit: joost.outbound_send_executed.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     null,
        action:      'joost.outbound_send_executed',
        entity_type: 'whatsapp_message',
        entity_id:   sentMessageId,
        after_json:  {
          run_id:             runId,
          step_id:            stepId,
          customer_id:        customer.id,
          conversation_id:    conv.id,
          template_id:        templateId,
          meta_template_name: template.meta_template_name,
          meta_wamid:         wamid,
          variables:          templateVarsForDb,
          triggered_by:       'outbound_scheduler',
        },
        reason_text: ('outbound:' + template.meta_template_name).slice(0, 200),
        ip_address:  null,
      });
    } catch (eAudit) {
      console.error('[joost-outbound-send] audit executed exception:', eAudit && eAudit.message);
    }

    return res.status(200).json({
      sent:       true,
      run_id:     runId,
      step_id:    stepId,
      message_id: sentMessageId,
      meta_wamid: wamid,
      decision,
    });
  } catch (e) {
    console.error('[joost-outbound-send]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
