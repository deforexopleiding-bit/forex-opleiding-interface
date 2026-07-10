// api/cron-dunning-bulk-send.js
//
// FASE 2 — daadwerkelijke verzending van approved bulk-jobs. Elke run:
//   1. Zoek approved/running jobs (FIFO op created_at).
//   2. Selecteer max BATCH_SIZE (10) pending recipients TOTAAL over die jobs.
//   3. Per recipient: atomische claim (pending→sending), send WA + email,
//      resultaat naar 'sent'/'failed', tellers bijwerken.
//   4. Job leeg → 'completed' + notify manager+super_admin.
//
// IDEMPOTENTIE:
//   Claim is `.eq('id',rid).eq('status','pending').update({status:'sending'})`
//   + select('id') → als een parallelle worker (of dubbele cron-run) 'm al
//   heeft gepakt, matched onze WHERE 0 rijen → we skippen. Send gebeurt
//   dus maximaal 1x per recipient.
//
// RATE / VEILIGHEID:
//   Hard cap BATCH_SIZE per cron-run — nooit meer dan 10 berichten per 3 min.
//   Vercel schedule "*/3 * * * *".
//   Fail-soft per recipient (try/catch): één klant faalt → rest gaat door.
//
// DUNNING-KOPPELING:
//   Per succesvolle send (recipient status='sent', minstens één kanaal
//   geslaagd) schrijven we een dunning_log-entry met event_type=
//   'bulk_reminder_sent'. run_id=NULL (kolom is nullable — geverifieerd
//   in 2026-06-07-dunning-foundation.sql r75-83). customer_id gaat mee
//   in payload zodat de engine's cooldown-check 'm kan vinden. Fail-soft:
//   log-insert faalt → verzending faalt NIET, alleen console-warning.
//
// Auth: Bearer $CRON_SECRET (checkCronAuth).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { sendTemplate } from './_lib/meta-whatsapp.js';
import { buildSendComponents } from './_lib/meta-template-components-builder.js';
import { buildMetaVariablesFromMapping } from './_lib/template-variables.js';
import { upsertOutboundConversation } from './_lib/conv-upsert.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { createNotification } from './_lib/notify.js';

const BATCH_SIZE     = 10;
const EMAIL_MAILBOX  = 'administratie@deforexopleiding.nl';
const OPEN_STATUSES  = ['open', 'partially_paid', 'overdue'];

// Finance-WABA lookup: zelfde bron als wanbetalers-whatsapp-templates-list.js.
async function getFinanceWaba() {
  const { data: cfg } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('business_account_id, phone_number_id')
    .in('module', ['finance', 'dunning'])
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (cfg?.phone_number_id) return cfg;
  const envBaId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null;
  const envPnId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || null;
  if (envBaId && envPnId) return { business_account_id: envBaId, phone_number_id: envPnId };
  return null;
}

function normPhonePlus(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : ('+' + digits.replace(/^0+/, ''));
}

function openAmount(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const summary = {
    processed      : 0,
    sent           : 0,
    failed         : 0,
    jobs_touched   : 0,
    jobs_completed : 0,
    errors         : [],
    duration_ms    : 0,
  };

  try {
    // 1) Pick jobs met pending recipients (FIFO op created_at).
    const { data: jobs, error: jobsErr } = await supabaseAdmin
      .from('dunning_bulk_jobs')
      .select('id, channel, template_name, email_template_id, status, batch_size, sent_count, failed_count, skipped_count, total_recipients')
      .in('status', ['approved', 'running'])
      .order('created_at', { ascending: true })
      .limit(20);
    if (jobsErr) throw new Error('jobs fetch: ' + jobsErr.message);
    if (!jobs || jobs.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      return res.status(200).json({ ok: true, ...summary });
    }

    // 2) Verzamel pending recipients FIFO over de jobs, cap BATCH_SIZE.
    const jobIds = jobs.map((j) => j.id);
    const { data: pendingRecips, error: recErr } = await supabaseAdmin
      .from('dunning_bulk_recipients')
      .select('id, job_id, customer_id, customer_name, customer_email, customer_phone, channel_whatsapp, channel_email, invoice_ids, resolved_preview_whatsapp, resolved_preview_email_subject, resolved_preview_email_body, status')
      .in('job_id', jobIds)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (recErr) throw new Error('recipients fetch: ' + recErr.message);

    if (!pendingRecips || pendingRecips.length === 0) {
      // Geen pending → check of we jobs kunnen completen.
      for (const job of jobs) {
        const { count: leftover } = await supabaseAdmin
          .from('dunning_bulk_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('job_id', job.id).eq('status', 'pending');
        if ((leftover || 0) === 0) {
          await maybeCompleteJob(job, summary);
        }
      }
      summary.duration_ms = Date.now() - startedAt;
      return res.status(200).json({ ok: true, ...summary });
    }

    // 3) Set touched jobs op 'running' als ze nog approved zijn.
    const touchedJobIds = new Set(pendingRecips.map((r) => r.job_id));
    summary.jobs_touched = touchedJobIds.size;
    for (const jid of touchedJobIds) {
      await supabaseAdmin.from('dunning_bulk_jobs')
        .update({ status: 'running' })
        .eq('id', jid).eq('status', 'approved');
    }

    // WABA + template caches (per template_name).
    const waba = await getFinanceWaba();
    const templateCache = new Map(); // name → row of null
    const emailTplCache = new Map(); // id → {subject, body}

    for (const rec of pendingRecips) {
      summary.processed++;
      // 3a) ATOMISCHE CLAIM.
      const { data: claim, error: claimErr } = await supabaseAdmin
        .from('dunning_bulk_recipients')
        .update({ status: 'sending' })
        .eq('id', rec.id).eq('status', 'pending')
        .select('id');
      if (claimErr) {
        summary.errors.push({ recipient_id: rec.id, error: 'claim: ' + claimErr.message });
        continue;
      }
      if (!claim || claim.length === 0) {
        // Andere worker was ons voor. Skip.
        continue;
      }

      const job = jobs.find((j) => j.id === rec.job_id);
      let wamid = null, emailMsgId = null;
      const errorParts = [];
      let waOk = false, emOk = false;

      // 3b) Customer + open invoices context.
      let customerRow = null;
      try {
        if (rec.customer_id) {
          const { data: c } = await supabaseAdmin
            .from('customers')
            .select('id, first_name, last_name, company_name, is_company, email, phone')
            .eq('id', rec.customer_id).maybeSingle();
          customerRow = c || null;
        }
      } catch (_) { /* fail-soft */ }
      let openInvoices = [];
      try {
        if (rec.customer_id) {
          const { data: invs } = await supabaseAdmin
            .from('invoices')
            .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status')
            .eq('customer_id', rec.customer_id)
            .in('status', OPEN_STATUSES);
          openInvoices = (invs || []).filter((inv) => openAmount(inv) > 0);
        }
      } catch (_) { /* fail-soft */ }

      // 3c) WhatsApp send.
      if (rec.channel_whatsapp && job && job.template_name && customerRow) {
        try {
          if (!waba) throw new Error('Geen finance-WABA geconfigureerd');
          const phonePlus = normPhonePlus(rec.customer_phone);
          if (!phonePlus) throw new Error('phone-normalisatie faalde');

          // Template ophalen incl. mapping.
          let tpl = templateCache.get(job.template_name);
          if (tpl === undefined) {
            const { data: tRows } = await supabaseAdmin
              .from('whatsapp_meta_templates')
              .select('name, language, status, body_text, header_type, meta_param_mapping, buttons')
              .eq('name', job.template_name)
              .limit(5);
            tpl = (tRows || []).find((r) => String(r.status || '').toLowerCase() === 'approved') || null;
            templateCache.set(job.template_name, tpl);
          }
          if (!tpl) throw new Error(`Template '${job.template_name}' niet approved`);

          // Find-or-create conversation.
          const conv = await upsertOutboundConversation({
            phoneE164Plus: phonePlus,
            phoneNumberId: waba.phone_number_id,
            displayName  : rec.customer_name || null,
            customerId   : rec.customer_id,
          });

          // Variables via mapping.
          const ctx = { customer: customerRow, openInvoices, invoice: openInvoices[0] || null };
          const bodyMapping = tpl.meta_param_mapping?.body || null;
          const bodyVariables = bodyMapping
            ? buildMetaVariablesFromMapping(bodyMapping, ctx)
            : {};
          const { components } = buildSendComponents({ template: tpl, bodyVariables });

          const sendRes = await sendTemplate({
            to           : phonePlus,
            templateName : tpl.name,
            languageCode : tpl.language || 'nl',
            components   : components.length ? components : null,
            phoneNumberId: waba.phone_number_id,
          });
          wamid = sendRes?.wamid || sendRes?.messages?.[0]?.id || null;
          waOk = true;

          // Best-effort: audit-log de outbound message in whatsapp_messages
          // zodat 'ie in de Inbox-tab verschijnt.
          try {
            await supabaseAdmin.from('whatsapp_messages').insert({
              conversation_id: conv.id,
              direction      : 'outbound',
              wamid,
              body           : String(tpl.body_text || '').slice(0, 4000),
              status         : 'sent',
              created_at     : new Date().toISOString(),
            });
          } catch (_) { /* fail-soft; niet-kritiek voor de send */ }
        } catch (e) {
          errorParts.push('WA: ' + (e?.message || e));
          console.error('[cron-dunning-bulk-send] WA', rec.id, e?.message || e);
        }
      }

      // 3d) E-mail send.
      if (rec.channel_email && rec.customer_email
          && rec.resolved_preview_email_subject && rec.resolved_preview_email_body) {
        try {
          const subj = String(rec.resolved_preview_email_subject);
          const bodyText = String(rec.resolved_preview_email_body);
          // Simpele HTML-wrapper: nl2br op de resolved text.
          const bodyHtml = '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">' +
            bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</div>';
          const emRes = await sendEmailViaSmtp({
            fromMailbox: EMAIL_MAILBOX,
            to         : rec.customer_email,
            subject    : subj,
            text       : bodyText,
            html       : bodyHtml,
          });
          if (emRes.ok) {
            emailMsgId = emRes.messageId || null;
            emOk = true;
          } else {
            throw new Error(emRes.reason || 'SMTP fail');
          }
        } catch (e) {
          errorParts.push('EM: ' + (e?.message || e));
          console.error('[cron-dunning-bulk-send] EM', rec.id, e?.message || e);
        }
      }

      // 3e) Recipient afronden.
      const successAny = waOk || emOk;
      const nowIso = new Date().toISOString();
      const patch = {
        status         : successAny ? 'sent' : 'failed',
        sent_at        : successAny ? nowIso : null,
        wamid          : wamid || null,
        email_message_id: emailMsgId || null,
        error          : errorParts.length ? errorParts.join(' | ').slice(0, 2000) : null,
      };
      const { error: updErr } = await supabaseAdmin
        .from('dunning_bulk_recipients')
        .update(patch)
        .eq('id', rec.id);
      if (updErr) {
        summary.errors.push({ recipient_id: rec.id, error: 'update: ' + updErr.message });
      }
      if (successAny) summary.sent++;
      else            summary.failed++;

      // Dunning-koppeling: alleen bij ECHTE 'sent'. Fail-soft — verzending
      // is al gebeurd, log-fail mag de flow niet stoppen. run_id=NULL is
      // toegestaan (zie file-header).
      if (successAny && rec.customer_id) {
        try {
          await supabaseAdmin.from('dunning_log').insert({
            run_id     : null,
            step_id    : null,
            event_type : 'bulk_reminder_sent',
            payload    : {
              customer_id       : rec.customer_id,
              channels          : { whatsapp: waOk, email: emOk },
              total_open_cents  : Number(rec.total_open_cents) || 0,
              invoice_ids       : Array.isArray(rec.invoice_ids) ? rec.invoice_ids : [],
              job_id            : rec.job_id,
              bulk_recipient_id : rec.id,
              wamid             : wamid || null,
              email_message_id  : emailMsgId || null,
            },
          });
        } catch (e) {
          console.warn('[cron-dunning-bulk-send] dunning_log insert soft-fail', rec.id, e?.message || e);
        }
      }

      // 3f) Job-tellers atomisch bumpen (via RPC-vrije weg: re-read + increment).
      try {
        const jobRow = jobs.find((j) => j.id === rec.job_id);
        if (jobRow) {
          const jobPatch = successAny
            ? { sent_count: (jobRow.sent_count || 0) + 1 }
            : { failed_count: (jobRow.failed_count || 0) + 1 };
          if (successAny) jobRow.sent_count = (jobRow.sent_count || 0) + 1;
          else            jobRow.failed_count = (jobRow.failed_count || 0) + 1;
          await supabaseAdmin.from('dunning_bulk_jobs').update(jobPatch).eq('id', rec.job_id);
        }
      } catch (_) { /* fail-soft */ }
    }

    // 4) Per touched job: check of 'ie leeg is → completed.
    for (const jid of touchedJobIds) {
      const { count: leftover } = await supabaseAdmin
        .from('dunning_bulk_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jid).in('status', ['pending', 'sending']);
      if ((leftover || 0) === 0) {
        const job = jobs.find((j) => j.id === jid);
        await maybeCompleteJob(job, summary);
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    console.error('[cron-dunning-bulk-send] fatal:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'fatal', ...summary });
  }
}

async function maybeCompleteJob(job, summary) {
  if (!job) return;
  const { data: updated, error } = await supabaseAdmin
    .from('dunning_bulk_jobs')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', job.id).in('status', ['approved', 'running'])
    .select('id, sent_count, failed_count, skipped_count, total_recipients');
  if (error || !updated || updated.length === 0) return;
  summary.jobs_completed++;
  // Notify manager+super_admin. Fail-soft.
  try {
    const u = updated[0];
    await createNotification({
      toRole    : ['manager', 'super_admin'],
      type      : 'dunning_bulk.completed',
      title     : 'Bulk-aanmaan voltooid',
      body      : `Verstuurd: ${u.sent_count || 0} · Mislukt: ${u.failed_count || 0} · Overgeslagen: ${u.skipped_count || 0} (van ${u.total_recipients || 0})`,
      linkUrl   : `/modules/finance.html?tab=wanbetalers&sub=geschiedenis&bulk_job=${u.id}`,
      entityType: 'dunning_bulk_job',
      entityId  : u.id,
      priority  : 'normal',
    });
  } catch (e) {
    console.error('[cron-dunning-bulk-send] notify fail', e?.message || e);
  }
}
