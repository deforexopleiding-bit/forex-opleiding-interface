// api/wanbetalers-sandbox-run-bulk.js
//
// POST { channel: 'whatsapp'|'email', template_name?, email_template_id?, subject?, body? }
//
// End-to-end bulk-simulatie voor de test-persoon, INLINE. Zelfde
// verzendcontract als cron-dunning-bulk-send.js: recipient-guard,
// dry-run, dunning_log-insert, pipeline-hook. Verschil: hier draaien
// we het ZELF af zodat de sandbox-flow niet afhankelijk is van de cron
// (die is_test=true jobs juist skipt).
//
// Volgorde:
//   1) is_test=true dunning_bulk_jobs + 1 dunning_bulk_recipients
//   2) recipient-guard (per channel)
//   3) verzenden (of dry-run overslaan)
//   4) recipient + job status bijwerken
//   5) dunning_log 'bulk_reminder_sent' insert
//   6) pipeline-hook 'on_bulk_sent_to_aangemaand'
//   7) fase na afloop uitlezen → response
//
// Super_admin only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
import { isDryRunEnabled, assertRecipientMatchesSandbox } from './_lib/dunning-dry-run.js';
import { isAutoEnabled, ensurePipelineCustomer, setStage } from './_lib/dunning-pipeline.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function openAmountEur(inv) {
  const t = Number(inv?.amount_total)    || 0;
  const p = Number(inv?.amount_paid)     || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
function normPhonePlus(p) {
  if (!p) return null;
  const s = String(p).replace(/\s+/g, '');
  if (!s) return null;
  return s.startsWith('+') ? s : ('+' + s);
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const channel  = (body.channel === 'email') ? 'email' : 'whatsapp';
  const tplName  = typeof body.template_name === 'string' ? body.template_name.trim() : '';
  const emailTplId = typeof body.email_template_id === 'string' ? body.email_template_id : null;
  const subject  = typeof body.subject === 'string' && body.subject.trim() ? body.subject : 'Herinnering (SANDBOX-TEST)';
  const bodyText = typeof body.body    === 'string' && body.body.trim()    ? body.body    : 'Dit is een sandbox-testbericht — negeer.';

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });

    const dry = await isDryRunEnabled();
    const nowIso = new Date().toISOString();

    // ─────────────── 1) Job + recipient aanmaken ───────────────
    // Verrijk realisme: haal de is_test-invoices op voor deze klant.
    const { data: invRows } = await supabaseAdmin
      .from('invoices')
      .select('id, amount_total, amount_paid, credited_amount, status')
      .eq('customer_id', customer.id).eq('is_test', true).in('status', OPEN_STATUSES);
    const openInvs = (invRows || []).filter((iv) => openAmountEur(iv) > 0);
    const invoiceIds = openInvs.map((iv) => iv.id);
    const totalOpenCents = openInvs.reduce((s, iv) => s + Math.round(openAmountEur(iv) * 100), 0);

    const { data: job, error: jErr } = await supabaseAdmin.from('dunning_bulk_jobs').insert({
      channel        : channel,
      template_name  : channel === 'whatsapp' ? (tplName || 'test_template') : null,
      email_template_id: emailTplId,
      status         : 'running',
      batch_size     : 1,
      total_recipients: 1,
      sent_count     : 0,
      failed_count   : 0,
      skipped_count  : 0,
      is_test        : true,
      created_at     : nowIso,
    }).select('id').single();
    if (jErr) throw new Error('bulk_jobs insert: ' + jErr.message);

    const { data: rec, error: rErr } = await supabaseAdmin.from('dunning_bulk_recipients').insert({
      job_id           : job.id,
      customer_id      : customer.id,
      customer_name    : customer.first_name,
      customer_email   : customer.email,
      customer_phone   : customer.phone,
      channel_whatsapp : channel === 'whatsapp',
      channel_email    : channel === 'email',
      resolved_preview_whatsapp     : channel === 'whatsapp' ? bodyText : null,
      resolved_preview_email_subject: channel === 'email' ? subject : null,
      resolved_preview_email_body   : channel === 'email' ? bodyText : null,
      invoice_ids      : invoiceIds,
      status           : 'sending',
      created_at       : nowIso,
    }).select('id').single();
    if (rErr) throw new Error('bulk_recipients insert: ' + rErr.message);

    // ─────────────── 2) Recipient-guard ───────────────
    let waOk = false, emOk = false, wamid = null, emailMsgId = null;
    let sendError = null;
    try {
      if (channel === 'whatsapp') {
        const phonePlus = normPhonePlus(customer.phone);
        if (!phonePlus) throw new Error('Test-persoon heeft geen telefoonnummer.');
        await assertRecipientMatchesSandbox({ isTest: true, actual: phonePlus, channel: 'whatsapp' });
        // ─────────────── 3) Verzenden (of dry-run) ───────────────
        if (dry) {
          wamid = 'dry-run:wa:' + rec.id;
          waOk = true;
          console.log('[sandbox-run-bulk] DRY-RUN WA', rec.id, phonePlus, tplName || 'test_template');
        } else {
          const { sendTemplate } = await import('./_lib/meta-whatsapp.js');
          const sendRes = await sendTemplate({
            to           : phonePlus,
            templateName : tplName || 'test_template',
            languageCode : 'nl',
          });
          wamid = sendRes?.wamid || sendRes?.messages?.[0]?.id || null;
          waOk = true;
        }
      } else { // email
        if (!customer.email) throw new Error('Test-persoon heeft geen e-mailadres.');
        await assertRecipientMatchesSandbox({ isTest: true, actual: customer.email, channel: 'email' });
        if (dry) {
          emailMsgId = 'dry-run:em:' + rec.id;
          emOk = true;
          console.log('[sandbox-run-bulk] DRY-RUN EM', rec.id, customer.email, subject);
        } else {
          const { sendMail, wrapEmailHtml } = await import('./mailer.js');
          const html = wrapEmailHtml(
            subject,
            '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">' + escapeHtml(bodyText) + '</div>'
          );
          const result = await sendMail({ to: customer.email, subject, text: bodyText, html });
          if (!result || !result.success) throw new Error(result?.error || 'SMTP fail');
          emailMsgId = result.messageId || null;
          emOk = true;
        }
      }
    } catch (e) {
      sendError = e?.message || String(e);
      console.error('[sandbox-run-bulk] send failed', rec.id, sendError);
    }

    const successAny = waOk || emOk;

    // ─────────────── 4) Recipient + job status ───────────────
    await supabaseAdmin.from('dunning_bulk_recipients').update({
      status          : successAny ? 'sent' : 'failed',
      sent_at         : successAny ? new Date().toISOString() : null,
      wamid           : wamid || null,
      email_message_id: emailMsgId || null,
      error           : sendError ? sendError.slice(0, 2000) : null,
    }).eq('id', rec.id);

    await supabaseAdmin.from('dunning_bulk_jobs').update({
      status       : 'completed',
      sent_count   : successAny ? 1 : 0,
      failed_count : successAny ? 0 : 1,
    }).eq('id', job.id);

    // ─────────────── 5) dunning_log ───────────────
    if (successAny) {
      try {
        await supabaseAdmin.from('dunning_log').insert({
          run_id     : null,
          step_id    : null,
          event_type : 'bulk_reminder_sent',
          payload    : {
            customer_id       : customer.id,
            channels          : { whatsapp: waOk, email: emOk },
            total_open_cents  : totalOpenCents,
            invoice_ids       : invoiceIds,
            job_id            : job.id,
            bulk_recipient_id : rec.id,
            wamid             : wamid || null,
            email_message_id  : emailMsgId || null,
            dry_run           : dry,
            is_test           : true,
          },
        });
      } catch (e) {
        console.warn('[sandbox-run-bulk] dunning_log insert soft-fail', rec.id, e?.message || e);
      }
    }

    // ─────────────── 6) Pipeline-hook ───────────────
    // Zelfde contract als cron-dunning-bulk-send.js — fase → 'aangemaand'
    // wanneer toggle aan staat en 'nieuw'-guard door setStage passed. Bij
    // dry-run vuurt de hook ook, want de sandbox-flow moet de fase kunnen
    // laten schuiven zonder echte send.
    let autoOn = false;
    if (successAny) {
      try {
        autoOn = await isAutoEnabled('on_bulk_sent_to_aangemaand');
        if (autoOn) {
          await ensurePipelineCustomer(customer.id);
          await setStage(customer.id, 'aangemaand', 'bulk_sent', 'auto:sandbox_bulk', { onlyIfFrom: 'nieuw' });
        }
      } catch (e) {
        console.warn('[sandbox-run-bulk] pipeline hook soft-fail', rec.id, e?.message || e);
      }
    }

    // ─────────────── 7) Fase-na uitlezen ───────────────
    let stageAfter = null;
    try {
      const { data: pipe } = await supabaseAdmin
        .from('dunning_pipeline_customers').select('stage_slug')
        .eq('customer_id', customer.id).maybeSingle();
      stageAfter = pipe?.stage_slug || null;
    } catch (_) { /* fail-soft */ }

    return res.status(200).json({
      ok            : true,
      dry_run       : dry,
      sent          : successAny,
      channel,
      auto_toggle   : autoOn,
      pipeline_moved: (stageAfter === 'aangemaand'),
      stage_after   : stageAfter,
      job_id        : job.id,
      recipient_id  : rec.id,
      wamid,
      email_message_id: emailMsgId,
      hint          : successAny
        ? (dry
            ? 'Dry-run: aanmaning gelogd, niet echt verstuurd.'
            : 'Echt verstuurd naar sandbox-contact.')
        : ('Mislukt: ' + (sendError || 'onbekend')),
    });
  } catch (e) {
    console.error('[sandbox-run-bulk]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
