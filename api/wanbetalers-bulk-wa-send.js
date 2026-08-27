// api/wanbetalers-bulk-wa-send.js
// POST → bulk WhatsApp-template naar N wanbetaler-klanten.
//
// Onafhankelijk van dunning-state: raakt GEEN dunning_runs, GEEN pending_actions,
// GEEN unpauseRunsForConversation. Alleen comms-log (whatsapp_messages,
// whatsapp_conversations.last_message_at) + audit (activity_log, dunning_bulk_jobs
// met channel='whatsapp', dunning_bulk_recipients).
//
// Modi (via body):
//   dry_run:true         → valideer + render, stuur NIETS. Response bevat volledige
//                          recipients[] (variables_rendered + rendered_body_preview
//                          + last_wa_contact_at + skip_reasons).
//   dry_run:false        → live-send. INSERT-first idempotency via client-side
//                          bulk_job_id (PK op dunning_bulk_jobs); PK-collision:
//                          - status='running' → 202 + processed_so_far[]
//                          - status='completed' → 409 met totals
//   test_send_to:"+31..." → 1 send naar Jeffrey's nummer; variabelen van customer_ids[0]
//                          (of dummy). Log alleen in activity_log, NIET in whatsapp_messages.
//
// Skip-regels (in volgorde, hard):
//   1. customer.is_test                    → 'customer_is_test'
//   2. customer.archived_at/anonymized_at  → 'customer_archived'
//   3. phone niet strict E.164             → 'no_phone'
//   4. template-variabele leeg             → 'variable_missing:<slot-key>'
//   5. openstaand_bedrag_cents < MIN       → 'openstaand_bedrag_null_or_zero'
//   6. recent send within 1h (dedup)       → 'recent_send_within_1h'
//
// Cap 200 → 422 met count. Marketing soft-gate (409 + X-Confirm-Marketing) alleen
// op live-send + test-send; dry-run mag altijd (preview is onschadelijk).
//
// Money-pariteit: fetchOpenInvoicesForCustomersBatch is de SHARED bron met
// de brief-generator (incasso-pre-brief-core.js) — één rekenregel, één plek.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { sendTemplate, MetaNotConfiguredError, getConfigStatus } from './_lib/meta-whatsapp.js';
import { buildMetaVariablesFromMapping, resolveVariables } from './_lib/template-variables.js';
import { formatEur, pickOldestInvoice } from './_lib/dunning-template-render.js';
import { fetchOpenInvoicesForCustomer, fetchOpenInvoicesForCustomersBatch } from './_lib/incasso-pre-brief-core.js';
import { getClientIp } from './_lib/audit-customer.js';

const MIN_OPENSTAAND_CENTS  = 50;
const MAX_RECIPIENTS        = 200;
const RECENT_SEND_WINDOW_MS = 60 * 60 * 1000; // 1h
const PER_SEND_THROTTLE_MS  = 150;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Vercel Pro: 200 klanten × 150ms + Meta (~200ms) + DB-writes (~50ms×4) = ~110s → ruim binnen 300s.
export const config = { maxDuration: 300 };

// Strikt E.164 — GEEN landcode raden. 06.../0497... zonder + → return null → skip 'no_phone'.
// Wrong-country send is klant-rakend; liever een terechte skip dan een verkeerde geadresseerde.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/\s+/g, '').replace(/[-()]/g, '');
  const cleaned = s.startsWith('00') ? '+' + s.slice(2) : s;
  return E164_RE.test(cleaned) ? cleaned : null;
}

function displayName(cust) {
  const parts = [cust.first_name, cust.last_name || cust.company_name].filter(Boolean).map(String);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}
function phoneMask(e164) {
  return e164.replace(/(\+\d{2})(\d{2})(\d{4})(\d+)/, '$1 $2 $3 …');
}

// Recent-send dedup: template + phone in laatste 1h. 2-stap: conv-lookup dan msg-count.
async function hasRecentSend(templateName, phoneE164) {
  const { data: convs } = await supabaseAdmin
    .from('whatsapp_conversations').select('id').eq('phone_number', phoneE164);
  const convIds = (convs || []).map(r => r.id);
  if (!convIds.length) return false;
  const sinceIso = new Date(Date.now() - RECENT_SEND_WINDOW_MS).toISOString();
  const { count } = await supabaseAdmin
    .from('whatsapp_messages').select('id', { count: 'exact', head: true })
    .eq('template_name', templateName).eq('direction', 'out')
    .gte('sent_at', sinceIso).in('conversation_id', convIds);
  return (count || 0) > 0;
}

// Resolveer per klant: variabelen + body-preview. openstaandCents komt van
// de shared helper (kanaal-pariteit). pickOldestInvoice = zelfde factuur-
// pick als de brief-generator's variabele-context.
function resolveRecipient({ customer, template, moduleContext, openInvoices, totalOpenCents }) {
  const oldest = pickOldestInvoice(openInvoices);
  const context = { customer, invoice: oldest, openInvoices, moduleContext };

  // meta_param_mapping is in DB genest onder .body ({"body":{"1":"klant.voornaam",...}}).
  // Fallback op de mapping-root voor robuustheid (oudere/handmatige templates zonder .body wrapper).
  // Zonder deze unwrap: buildMetaVariablesFromMapping filtert Object.keys op /^\d+$/ en krijgt
  // enkel "body" → geen match → rendered={} → iedereen 'variable_missing'.
  const raw = template.meta_param_mapping || {};
  const mapping = (raw.body && typeof raw.body === 'object' && !Array.isArray(raw.body)) ? raw.body : raw;

  const rendered = buildMetaVariablesFromMapping(mapping, context);
  const bodyRender = resolveVariables(template.body_text || '', mapping, context);
  return {
    rendered,
    rendered_body_preview: bodyRender.text || '',
    openstaandCents: totalOpenCents,
    _mapping: mapping,   // voor variable_missing-check downstream (undefined-safe)
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }
  const rl = await checkRateLimit({ req, bucket: 'wa-bulk-send', maxHits: 12, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const body = req.body || {};
  const customerIds = Array.isArray(body.customer_ids) ? body.customer_ids : [];
  const templateId  = String(body.template_id || '').trim();
  const language    = String(body.language || 'nl').trim().toLowerCase() || 'nl';
  const dryRun      = body.dry_run !== false; // default TRUE (fail-safe)
  const testSendTo  = body.test_send_to ? normalizePhone(body.test_send_to) : null;
  const clientBulkJobId = String(body.bulk_job_id || '').trim();

  if (!templateId || !UUID_RE.test(templateId)) return res.status(400).json({ error: 'template_id (uuid) vereist' });
  if (!customerIds.every(id => UUID_RE.test(id))) return res.status(400).json({ error: 'customer_ids moet uuids zijn' });
  if (customerIds.length === 0 && !testSendTo) return res.status(400).json({ error: 'customer_ids leeg (of test_send_to zetten)' });
  if (customerIds.length > MAX_RECIPIENTS) {
    return res.status(422).json({ error: `Max ${MAX_RECIPIENTS} klanten per bulk`, count: customerIds.length });
  }
  if (testSendTo === null && body.test_send_to) return res.status(400).json({ error: 'test_send_to ongeldig E.164' });
  if (!dryRun && !testSendTo && !UUID_RE.test(clientBulkJobId)) {
    return res.status(400).json({ error: 'bulk_job_id (uuid) vereist bij live-send zonder test_send_to' });
  }

  const cfg = getConfigStatus();
  if (!cfg.configured) return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd', missing: cfg.missing });

  try {
    // Template ophalen.
    const { data: template, error: tErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, name, language, category, body_text, meta_param_mapping, status, business_account_id')
      .eq('id', templateId).maybeSingle();
    if (tErr) throw new Error('template lookup: ' + tErr.message);
    if (!template) return res.status(400).json({ error: 'Template niet gevonden' });
    if (String(template.status || '').toUpperCase() !== 'APPROVED') {
      return res.status(400).json({ error: 'Template niet APPROVED' });
    }
    const isMarketing = String(template.category || '').toUpperCase() === 'MARKETING';

    // Finance-WABA-lijn: prioriteer module='finance', limit(1).
    const { data: modCfg } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id, business_account_id, display_label, afdeling_telefoon, afdeling_whatsapp, afdeling_email, afdeling_ondertekenaar')
      .eq('module', 'finance').eq('is_active', true).limit(1).maybeSingle();
    const phoneNumberId = modCfg?.phone_number_id || null;
    if (!phoneNumberId) return res.status(503).json({ error: 'Finance-WhatsApp-lijn niet geconfigureerd' });
    const moduleContext = {
      afdeling_telefoon:      modCfg?.afdeling_telefoon      || null,
      afdeling_whatsapp:      modCfg?.afdeling_whatsapp      || null,
      afdeling_email:         modCfg?.afdeling_email         || null,
      afdeling_ondertekenaar: modCfg?.afdeling_ondertekenaar || null,
    };

    // ── TEST-SEND ─────────────────────────────────────────────────────────
    if (testSendTo) {
      if (isMarketing && String(req.headers['x-confirm-marketing'] || '').toLowerCase() !== 'true') {
        return res.status(409).json({
          error: 'MARKETING_TEMPLATE_REQUIRES_CONFIRMATION',
          message: 'Marketing-template test-send vereist X-Confirm-Marketing header (WABA-compliance-risico).',
        });
      }
      let rendered = { 1: 'Test', 2: 'EUR 80,00' };
      if (customerIds.length) {
        const { data: cust } = await supabaseAdmin.from('customers').select('*').eq('id', customerIds[0]).maybeSingle();
        if (cust) {
          const { openInvoices, totalOpenCents } = await fetchOpenInvoicesForCustomer(cust.id, supabaseAdmin);
          const r = resolveRecipient({ customer: cust, template, moduleContext, openInvoices, totalOpenCents });
          rendered = r.rendered;
        }
      }
      try {
        const variables = Object.keys(rendered).sort((a, b) => Number(a) - Number(b)).map(k => rendered[k]);
        const { wamid } = await sendTemplate({ to: testSendTo, templateName: template.name, languageCode: language, variables, phoneNumberId });
        await supabaseAdmin.from('activity_log').insert({
          user_id: user.id,
          action:  'finance.wanbetalers.wa_test_send',
          entity_type: 'whatsapp_template',
          entity_id:   template.id,
          payload: { test_send_to: testSendTo, template_name: template.name, wamid, variables_used: rendered },
        }).then(() => {}, () => {});
        return res.status(200).json({
          mode: 'test_send', test_send_to: testSendTo,
          template: { id: template.id, name: template.name, category: template.category },
          variables_rendered_used: rendered, wamid,
        });
      } catch (e) {
        return res.status(500).json({ error: 'test-send faalde: ' + (e?.message || 'onbekend') });
      }
    }

    // ── DRY-RUN of LIVE (batch) ───────────────────────────────────────────
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, is_test, archived_at, anonymized_at')
      .in('id', customerIds);
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    const custById = new Map((customers || []).map(c => [c.id, c]));

    // Batch-invoices via SHARED helper — 1 query, identieke rekenregel als brief.
    // Fail-hard: invoices zijn money — geen fail-soft naar 0.
    let invoicesByCust;
    try {
      invoicesByCust = await fetchOpenInvoicesForCustomersBatch(customerIds, supabaseAdmin);
    } catch (e) {
      console.error('[wanbetalers-bulk-wa-send] batch invoices:', e?.message || e);
      return res.status(500).json({ error: 'Interne fout (invoices)' });
    }

    // Recipients + skip-check per klant
    const recipients = [];
    for (const cid of customerIds) {
      const cust = custById.get(cid);
      if (!cust) { recipients.push({ customer_id: cid, action: 'skip', skip_reason: 'customer_not_found' }); continue; }
      const nm = displayName(cust);
      if (cust.is_test) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'customer_is_test' }); continue; }
      if (cust.archived_at || cust.anonymized_at) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'customer_archived' }); continue; }
      const phoneE164 = normalizePhone(cust.phone);
      if (!phoneE164) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'no_phone' }); continue; }

      const bucket = invoicesByCust.get(cid) || { openInvoices: [], totalOpenCents: 0 };
      const r = resolveRecipient({ customer: cust, template, moduleContext,
                                    openInvoices: bucket.openInvoices,
                                    totalOpenCents: bucket.totalOpenCents });

      // variable_missing: itereer over BODY-slot-keys (van de unwrapped mapping,
      // niet raw.meta_param_mapping — dat geeft ['body']). Alleen numerieke Meta-slots.
      const missing = [];
      const bodyMapping = r._mapping || {};
      for (const slot of Object.keys(bodyMapping)) {
        if (!/^\d+$/.test(slot)) continue;
        if (!String(r.rendered[slot] || '').trim()) {
          const varKey = String(bodyMapping[slot] || `slot_${slot}`);
          missing.push(varKey);
        }
      }
      if (missing.length) {
        recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: `variable_missing:${missing.join(',')}` });
        continue;
      }
      if (r.openstaandCents < MIN_OPENSTAAND_CENTS) {
        recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'openstaand_bedrag_null_or_zero', openstaand_bedrag_display: formatEur(r.openstaandCents / 100) });
        continue;
      }
      const recent = await hasRecentSend(template.name, phoneE164).catch(() => false);
      if (recent) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'recent_send_within_1h' }); continue; }

      const { data: waRows } = await supabaseAdmin
        .from('whatsapp_conversations').select('last_message_at').eq('customer_id', cid).eq('is_test', false)
        .not('last_message_at', 'is', null).order('last_message_at', { ascending: false }).limit(1);
      const lastWa = waRows?.[0]?.last_message_at || null;

      recipients.push({
        customer_id: cid, customer_name: nm,
        phone_e164: phoneE164, phone_masked: phoneMask(phoneE164),
        last_wa_contact_at: lastWa,
        openstaand_bedrag_cents: r.openstaandCents,
        openstaand_bedrag_display: formatEur(r.openstaandCents / 100),
        variables_rendered: r.rendered,
        rendered_body_preview: r.rendered_body_preview,
        action: 'would_send',
      });
    }

    const skipReasonSummary = {};
    for (const r of recipients) if (r.action === 'skip') skipReasonSummary[r.skip_reason] = (skipReasonSummary[r.skip_reason] || 0) + 1;
    const wouldSend = recipients.filter(r => r.action === 'would_send').length;
    const wouldSkip = recipients.filter(r => r.action === 'skip').length;

    // DRY-RUN → early return (marketing-gate NIET afgedwongen; preview mag altijd)
    if (dryRun) {
      return res.status(200).json({
        mode: 'dry_run',
        line: { phone_number_id: phoneNumberId, display_number: modCfg.display_label || null },
        template: { id: template.id, name: template.name, language: template.language, category: template.category, is_marketing: isMarketing },
        totals: { requested: customerIds.length, would_send: wouldSend, would_skip: wouldSkip },
        recipients,
        skip_reason_summary: skipReasonSummary,
      });
    }

    // LIVE — marketing-gate afdwingen
    if (isMarketing && String(req.headers['x-confirm-marketing'] || '').toLowerCase() !== 'true') {
      return res.status(409).json({
        error: 'MARKETING_TEMPLATE_REQUIRES_CONFIRMATION',
        message: 'Marketing-template naar debiteuren = WABA-compliance-risico. Herhaal met header X-Confirm-Marketing: true.',
      });
    }

    // INSERT-first idempotency
    const { error: jobInsErr } = await supabaseAdmin.from('dunning_bulk_jobs').insert({
      id: clientBulkJobId, created_by_user_id: user.id,
      channel: 'whatsapp', template_name: template.name, status: 'running',
      total_recipients: customerIds.length, sent_count: 0, failed_count: 0, skipped_count: 0,
    });
    if (jobInsErr) {
      if (jobInsErr.code === '23505') {
        const [existingJob, doneRecipients] = await Promise.all([
          supabaseAdmin.from('dunning_bulk_jobs').select('id, status, sent_count, failed_count, skipped_count, created_at, completed_at').eq('id', clientBulkJobId).maybeSingle(),
          supabaseAdmin.from('dunning_bulk_recipients').select('customer_id, customer_name, status, wamid, error, skip_reason').eq('job_id', clientBulkJobId),
        ]);
        const stillRunning = existingJob.data?.status === 'running';
        return res.status(stillRunning ? 202 : 409).json({
          error: stillRunning ? 'BULK_JOB_IN_PROGRESS' : 'DUPLICATE_BULK_JOB',
          existing_job: existingJob.data,
          processed_so_far: doneRecipients.data || [],
        });
      }
      throw new Error('bulk-job insert: ' + jobInsErr.message);
    }

    const t0 = Date.now();
    const results = [];
    let sentCount = 0, failedCount = 0, skippedCount = 0;

    try {
      for (const r of recipients) {
        if (r.action !== 'would_send') {
          skippedCount++;
          results.push({ customer_id: r.customer_id, customer_name: r.customer_name, action: 'skipped', skip_reason: r.skip_reason });
          await supabaseAdmin.from('dunning_bulk_recipients').insert({
            job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
            channel_whatsapp: true, status: 'skipped', skip_reason: r.skip_reason,
          }).then(() => {}, () => {});
          continue;
        }
        try {
          const variables = Object.keys(r.variables_rendered).sort((a, b) => Number(a) - Number(b)).map(k => r.variables_rendered[k]);
          const { wamid } = await sendTemplate({ to: r.phone_e164, templateName: template.name, languageCode: language, variables, phoneNumberId });

          // Conversation upsert — GEEN unpauseRunsForConversation (bewust: dunning-state onaangeraakt).
          let convId;
          const { data: existingConv } = await supabaseAdmin.from('whatsapp_conversations')
            .select('id').eq('customer_id', r.customer_id).eq('phone_number', r.phone_e164).limit(1).maybeSingle();
          if (existingConv) { convId = existingConv.id; }
          else {
            const { data: newConv, error: cvErr } = await supabaseAdmin.from('whatsapp_conversations')
              .insert({ customer_id: r.customer_id, phone_number: r.phone_e164, phone_number_id: phoneNumberId, status: 'open', is_test: false, last_message_at: new Date().toISOString() })
              .select('id').single();
            if (cvErr) throw new Error('conv insert: ' + cvErr.message);
            convId = newConv.id;
          }
          const nowIso = new Date().toISOString();
          const { data: msg } = await supabaseAdmin.from('whatsapp_messages').insert({
            conversation_id: convId, direction: 'out', meta_wamid: wamid,
            template_name: template.name, template_variables: r.variables_rendered,
            body: null, status: 'queued', sent_at: nowIso, sent_by_user_id: user.id,
          }).select('id').single();
          await supabaseAdmin.from('whatsapp_conversations')
            .update({ last_message_at: nowIso, last_message_preview: r.rendered_body_preview.slice(0, 120) })
            .eq('id', convId);

          await supabaseAdmin.from('dunning_bulk_recipients').insert({
            job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
            customer_phone: r.phone_e164, total_open_cents: r.openstaand_bedrag_cents,
            channel_whatsapp: true, resolved_preview_whatsapp: r.rendered_body_preview.slice(0, 2000),
            status: 'sent', wamid, sent_at: nowIso,
          }).then(() => {}, () => {});

          sentCount++;
          results.push({ customer_id: r.customer_id, customer_name: r.customer_name, phone_masked: r.phone_masked, action: 'sent', wamid, message_id_local: msg?.id });
        } catch (e) {
          failedCount++;
          const errCode = e instanceof MetaNotConfiguredError ? 'META_NOT_CONFIGURED' : 'SEND_FAILED';
          results.push({ customer_id: r.customer_id, customer_name: r.customer_name, action: 'error', error_code: errCode, error_message: e?.message || 'onbekend' });
          await supabaseAdmin.from('dunning_bulk_recipients').insert({
            job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
            customer_phone: r.phone_e164, channel_whatsapp: true, status: 'failed',
            error: (e?.message || '').slice(0, 500),
          }).then(() => {}, () => {});
        }
        await sleep(PER_SEND_THROTTLE_MS);
      }
    } finally {
      // Altijd job finaliseren — ook bij exception halverwege.
      await supabaseAdmin.from('dunning_bulk_jobs').update({
        status: 'completed', completed_at: new Date().toISOString(),
        sent_count: sentCount, failed_count: failedCount, skipped_count: skippedCount,
      }).eq('id', clientBulkJobId).then(() => {}, () => {});
    }

    await supabaseAdmin.from('activity_log').insert({
      user_id: user.id,
      action:  'finance.wanbetalers.wa_bulk_send',
      entity_type: 'dunning_bulk_job',
      entity_id:   clientBulkJobId,
      payload: {
        template_id: template.id, template_name: template.name, category: template.category,
        totals: { requested: customerIds.length, sent: sentCount, skipped: skippedCount, errors: failedCount },
        actor_user_id: user.id, ip: getClientIp(req),
      },
    }).then(() => {}, () => {});

    return res.status(200).json({
      mode: 'live', bulk_job_id: clientBulkJobId,
      line: { phone_number_id: phoneNumberId, display_number: modCfg.display_label || null },
      template: { id: template.id, name: template.name, category: template.category },
      totals: { requested: customerIds.length, sent: sentCount, skipped: skippedCount, errors: failedCount },
      results, duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[wanbetalers-bulk-wa-send]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
