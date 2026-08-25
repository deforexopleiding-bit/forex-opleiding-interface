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
// Splitsing 2026-08-25: sandbox-flow leest de test-vlag, niet de productie-vlag.
import { isTestDryRunEnabled as isDryRunEnabled, assertRecipientMatchesSandbox } from './_lib/dunning-dry-run.js';
import { isAutoEnabled, ensurePipelineCustomer, setStage } from './_lib/dunning-pipeline.js';
import { renderTemplate }              from './_lib/dunning-template-render.js';
import { buildMetaTemplateVariables,
         diagnoseTemplatePlaceholders } from './_lib/dunning-template-placeholders.js';
import { ensureInvoicePaymentLink,
         InvoicePaymentLinkError }      from './_lib/invoice-payment-link.js';

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

    // Finance-afzendlijn expliciet uit whatsapp_module_config (module='finance'),
    // zodat de sandbox niet impliciet op de globale default leunt. Ontbreekt de
    // config, dan blijft sendTemplate op de globale default vallen — die is óók
    // finance, dus geen verkeerde-lijn-risico (finance is hier inhoudelijk juist).
    const { data: finCfg } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'finance')
      .eq('is_active', true)
      .maybeSingle();
    const financePnId = finCfg?.phone_number_id || null;

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
      status           : 'pending',
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
        // Guard 1 (behouden): recipient MUST match dunning_sandbox_contact.phone.
        // Onmogelijk dat send naar een niet-sandbox-nummer gaat.
        await assertRecipientMatchesSandbox({ isTest: true, actual: phonePlus, channel: 'whatsapp' });

        // ─────────────── 3) Verzenden — REPRESENTATIEVE FLOW ───────────────
        // Sinds Optie B: sandbox gebruikt EXACT dezelfde params-opbouw als
        // dunning-step-executors.js (buildMetaTemplateVariables + resolvers
        // + betaal_link pre-fetch). Zonder deze inline flow stuurde sandbox
        // 0 params → altijd Meta #132000, ongeacht body-fix.
        //
        // Guard 2 (behouden): tplName is verplicht. Zonder tplName kan de
        // sandbox geen echte dunning-template testen; oude 'test_template'
        // fallback is verwijderd — dat verhulde het probleem.
        if (!tplName) {
          throw new Error('template_name is verplicht (bv. "aanmaning_dag7" of "aanmaning_dag14")');
        }

        // Body uit dunning_templates. LOOKUP op meta_template_name (niet 'name'):
        // - 'name'                = display-label (bv. "Aanmaning dag 7 (WhatsApp)")
        // - 'meta_template_name'  = de Meta-side approved key (bv. "aanmaning_dag7")
        // De console-caller geeft de Meta-key mee (die matcht het template in
        // Meta Business Manager). Vorige lookup op 'name' vond 0 rijen → error
        // "geen whatsapp-template met name=..." verhulde de echte oorzaak.
        const { data: tpl, error: tplErr } = await supabaseAdmin
          .from('dunning_templates')
          .select('id, name, kind, subject, body, meta_template_name, language, is_active')
          .eq('meta_template_name', tplName)
          .eq('kind', 'whatsapp')
          .maybeSingle();
        if (tplErr) throw new Error('dunning_templates fetch: ' + tplErr.message);
        if (!tpl)   throw new Error(`dunning_templates: geen whatsapp-template met meta_template_name='${tplName}'`);
        if (!tpl.meta_template_name) throw new Error(`template '${tplName}': meta_template_name ontbreekt`);

        // Open invoices al gefetcht boven (openInvs) — hergebruik als context.
        // Fetch volledige invoice-rijen zodat renderTemplate alle velden ziet
        // (invoice_number, due_date, etc.) die resolvers nodig hebben.
        const { data: fullInvs } = await supabaseAdmin
          .from('invoices')
          .select('id, invoice_number, amount_total, amount_paid, credited_amount, status, due_date, issue_date, payment_url')
          .in('id', invoiceIds.length ? invoiceIds : ['00000000-0000-0000-0000-000000000000']);
        const invoicesForRender = Array.isArray(fullInvs) ? fullInvs : [];

        // Betaal-link pre-fetch (fail-CLOSED, exact zelfde patroon als executor).
        // Alleen als template.body de placeholder gebruikt.
        const bodyStr = String(tpl.body || '');
        if (bodyStr.includes('{{factuur.betaal_link}}')) {
          const oudsteInv = invoicesForRender[0]; // openInvs was al gefilterd op openAmount>0
          if (!oudsteInv?.id) {
            throw new Error('template gebruikt {{factuur.betaal_link}} maar geen open invoice om link voor te fetchen');
          }
          try {
            const linkRes = await ensureInvoicePaymentLink(oudsteInv.id);
            if (linkRes && linkRes.payment_url) {
              oudsteInv.payment_url = linkRes.payment_url;
            } else {
              throw new Error('ensureInvoicePaymentLink leverde geen payment_url');
            }
          } catch (linkErr) {
            const code = linkErr instanceof InvoicePaymentLinkError ? linkErr.code : 'UNKNOWN';
            throw new Error('payment-link fetch fout: ' + code + ' — ' + (linkErr?.message || 'onbekend'));
          }
        }

        // Render placeholders → variables_used object.
        const rendered = renderTemplate({
          body:         tpl.body,
          subject:      tpl.subject,
          customer,
          openInvoices: invoicesForRender,
        });

        // Positional params in Meta-approved volgorde (uit body-scan).
        const variables = buildMetaTemplateVariables(tpl.body, rendered.variables_used || {});

        // Empty-param guard (zelfde als executor — voorkomt Meta #131008).
        const emptyIdx = variables.findIndex(v => v == null || String(v).length === 0);
        if (emptyIdx >= 0) {
          let emptyKey = null;
          try {
            const diag = diagnoseTemplatePlaceholders(tpl.body);
            emptyKey = diag.matched[emptyIdx] || null;
          } catch (_) { /* diag mag nooit blokkeren */ }
          throw new Error(`Empty param {{${emptyIdx + 1}}} (${emptyKey || 'onbekend'}) — Meta zou #131008 gooien; check sandbox-klant data`);
        }

        // Diagnose-warn zichtbaar in Vercel-logs bij body-drift.
        try {
          const diag = diagnoseTemplatePlaceholders(tpl.body);
          if (diag.n_missing > 0) {
            console.warn('[sandbox-run-bulk whatsapp] UNMATCHED PLACEHOLDERS — Meta #132000 risico', {
              template_id: tpl.id, meta_template_name: tpl.meta_template_name,
              matched: diag.matched, unmatched: diag.unmatched,
              n_sent_to_meta: diag.total_count, n_expected_in_body: diag.raw_count,
            });
          }
        } catch (_) { /* fail-soft */ }

        if (dry) {
          wamid = 'dry-run:wa:' + rec.id;
          waOk = true;
          console.log('[sandbox-run-bulk] DRY-RUN WA', rec.id, phonePlus, tpl.meta_template_name, 'params:', variables.length);
        } else {
          const { sendTemplate } = await import('./_lib/meta-whatsapp.js');
          const sendRes = await sendTemplate({
            to:            phonePlus,
            templateName:  tpl.meta_template_name,
            languageCode:  tpl.language || 'nl',
            variables,     // ← REPRESENTATIEVE FLOW: 4 params voor dag7/dag14
            phoneNumberId: financePnId,
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
    // HARD SAFETY GUARD: scope recipient-UPDATE ook op customer_id + job_id
    // (extra defense — de rec-rij is net door ons ingevoegd met customer_id
    // = sandbox-klant, dus deze filters matchen altijd voor onze rij en
    // NOOIT voor een niet-test recipient-rij die we per ongeluk zouden raken).
    await supabaseAdmin.from('dunning_bulk_recipients').update({
      status          : successAny ? 'sent' : 'failed',
      sent_at         : successAny ? new Date().toISOString() : null,
      wamid           : wamid || null,
      email_message_id: emailMsgId || null,
      error           : sendError ? sendError.slice(0, 2000) : null,
    })
    .eq('id', rec.id)
    .eq('customer_id', customer.id)
    .eq('job_id', job.id);

    // HARD SAFETY GUARD: scope job-UPDATE ook op is_test=true. De job is
    // hierboven ingevoegd met is_test:true, dus dit matcht altijd onze rij
    // en nooit een productie-job.
    await supabaseAdmin.from('dunning_bulk_jobs').update({
      status       : 'completed',
      sent_count   : successAny ? 1 : 0,
      failed_count : successAny ? 0 : 1,
    })
    .eq('id', job.id)
    .eq('is_test', true);

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
