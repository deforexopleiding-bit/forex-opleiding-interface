// api/wanbetalers-bulk-preview.js
//
// POST → bouw een bulk-aanmaan-JOB als DRAFT.
//   VERSTUURT NIETS. Alleen persistence + preview-tekst per klant.
//
// Auth: finance.dunning.execute (zelfde als wanbetalers-bulk-start-workflow).
//
// Body:
//   {
//     customer_ids?: [uuid],       // OF
//     invoice_ids?:  [uuid],       // wordt gemapt naar unieke customer_ids
//     channel:       'whatsapp' | 'email' | 'both',
//     template_name?:     string,  // WhatsApp meta-template naam (status='approved')
//     email_template_id?: string,  // Fase 3 — placeholder
//   }
//
// Max 200 klanten per job.
//
// Skip-logica (Jeffrey's keuze):
//   - klant zonder phone → channel_whatsapp=false
//   - klant zonder email → channel_email=false
//   - voor het GEKOZEN kanaal geen contact beschikbaar → status='skipped'
//     + skip_reason ∈ { 'no_phone', 'no_email', 'no_contact' }
//   - deze klanten STAAN wel in de preview + recipients-tabel, tellen als
//     skipped.
//
// Response:
//   {
//     job_id: uuid,
//     summary: { total, will_send, skipped, skipped_breakdown: {...} },
//     recipients: [{ customer_id, customer_name, total_open_cents,
//                     open_invoice_count, channel_whatsapp, channel_email,
//                     skip_reason, preview_whatsapp }],
//     template: { name, body_source: 'raw'|'not_found' }|null
//   }
//
// Read-modelmutatie: 1 INSERT in dunning_bulk_jobs + N INSERTs in
// dunning_bulk_recipients. Geen externe calls (geen TL, geen Meta, geen
// e-mail).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { resolveVariables } from './_lib/template-variables.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CHANNELS = ['whatsapp', 'email', 'both'];
const OPEN_STATUSES  = ['open', 'partially_paid', 'overdue'];
const MAX_CUSTOMERS  = 200;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const toCents = (eur) => Math.round((Number(eur) || 0) * 100);
function openAmount(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}
function normStr(v) { return typeof v === 'string' ? v.trim() : ''; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const channel = normStr(body.channel).toLowerCase();
  if (!VALID_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `channel vereist (${VALID_CHANNELS.join('|')})` });
  }
  const templateName    = normStr(body.template_name)      || null;
  const emailTemplateId = normStr(body.email_template_id)  || null;
  if ((channel === 'whatsapp' || channel === 'both') && !templateName) {
    return res.status(400).json({ error: 'template_name vereist voor WhatsApp-kanaal' });
  }

  // customer_ids of invoice_ids → set van unieke customer_ids.
  const rawCustIds = Array.isArray(body.customer_ids) ? body.customer_ids.filter((v) => typeof v === 'string' && UUID_RE.test(v)) : [];
  const rawInvIds  = Array.isArray(body.invoice_ids)  ? body.invoice_ids.filter((v)  => typeof v === 'string' && UUID_RE.test(v))  : [];
  if (rawCustIds.length === 0 && rawInvIds.length === 0) {
    return res.status(400).json({ error: 'customer_ids of invoice_ids vereist' });
  }

  try {
    const customerIdSet = new Set(rawCustIds);
    if (rawInvIds.length > 0) {
      const { data: invRows, error: invErr } = await supabaseAdmin
        .from('invoices').select('id, customer_id').in('id', rawInvIds);
      if (invErr) throw new Error('invoice mapping: ' + invErr.message);
      for (const inv of invRows || []) if (inv.customer_id) customerIdSet.add(inv.customer_id);
    }
    const customerIds = Array.from(customerIdSet);
    if (customerIds.length === 0) return res.status(400).json({ error: 'Geen geldige klanten gevonden' });
    if (customerIds.length > MAX_CUSTOMERS) {
      return res.status(400).json({ error: `Max ${MAX_CUSTOMERS} klanten per job (${customerIds.length} meegegeven)` });
    }

    // Klanten + open facturen ophalen in 2 queries.
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, archived_at, anonymized_at')
      .in('id', customerIds);
    if (cErr) throw new Error('customers fetch: ' + cErr.message);
    const customerById = new Map((customers || []).map((c) => [c.id, c]));

    const { data: invRows, error: iErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, issue_date, due_date, status')
      .in('customer_id', customerIds)
      .in('status', OPEN_STATUSES);
    if (iErr) throw new Error('invoices fetch: ' + iErr.message);
    const openInvByCustomer = new Map();
    for (const inv of invRows || []) {
      const open = openAmount(inv);
      if (open <= 0) continue;
      const list = openInvByCustomer.get(inv.customer_id) || [];
      list.push(inv);
      openInvByCustomer.set(inv.customer_id, list);
    }

    // Template-body ophalen (whatsapp / both). Bij not-found: laat body_source='not_found' zien;
    // preview_whatsapp wordt dan een placeholder-tekst en de UI kan waarschuwen.
    // Status hoofdletter-tolerant ('approved' | 'APPROVED') — spiegelt de
    // dunning-templates-list + events-send. Vroeger stond hier strict
    // .eq('status','approved') → APPROVED-rijen verschenen in de dropdown
    // maar gaven 'not_found' bij preview.
    let templateBodyText = '';
    let templateSource   = null;
    if (templateName) {
      const { data: tplRows, error: tErr } = await supabaseAdmin
        .from('whatsapp_meta_templates')
        .select('name, language, status, body_text')
        .eq('name', templateName)
        .limit(5);
      const approvedRow = (tplRows || []).find((r) => String(r.status || '').toLowerCase() === 'approved') || null;
      if (!tErr && approvedRow) {
        templateBodyText = String(approvedRow.body_text || '');
        templateSource   = { name: approvedRow.name, body_source: 'raw', language: approvedRow.language };
      } else {
        templateSource = { name: templateName, body_source: 'not_found' };
      }
    }

    // E-mail template ophalen (email/both). Hergebruikt de bestaande
    // dunning_templates-tabel (kind='email') — zelfde bron als de UI in de
    // dunning-templates-tab, dus operators beheren één plek.
    let emailTemplateSubject = '';
    let emailTemplateBody    = '';
    let emailTemplateSource  = null;
    if (emailTemplateId && (channel === 'email' || channel === 'both')) {
      const { data: etRow, error: etErr } = await supabaseAdmin
        .from('dunning_templates')
        .select('id, name, kind, subject, body, is_active')
        .eq('id', emailTemplateId)
        .maybeSingle();
      if (etErr) {
        console.warn('[wanbetalers-bulk-preview] email template fetch:', etErr.message);
        emailTemplateSource = { id: emailTemplateId, source: 'error' };
      } else if (etRow && etRow.kind === 'email' && etRow.is_active) {
        emailTemplateSubject = String(etRow.subject || '');
        emailTemplateBody    = String(etRow.body    || '');
        emailTemplateSource  = { id: etRow.id, name: etRow.name, source: 'raw' };
      } else {
        emailTemplateSource = { id: emailTemplateId, source: 'not_found_or_inactive' };
      }
    }

    // Per klant: bouw preview + skip-check + recipient-row.
    const rejectedNoCustomer = [];
    const recipients = [];
    let willSend = 0, skipped = 0;
    const skipBreakdown = { no_phone: 0, no_email: 0, no_contact: 0 };

    for (const cid of customerIds) {
      const cust = customerById.get(cid);
      if (!cust || cust.archived_at || cust.anonymized_at) {
        rejectedNoCustomer.push(cid);
        continue;
      }
      const openInvoices = openInvByCustomer.get(cid) || [];
      const totalOpenEur = openInvoices.reduce((s, inv) => s + openAmount(inv), 0);
      const name = customerDisplayName(cust, '(zonder naam)');

      const emailVal = normStr(cust.email);
      const phoneVal = normStr(cust.phone);
      const wantWa  = (channel === 'whatsapp' || channel === 'both');
      const wantEm  = (channel === 'email'    || channel === 'both');
      const canWa   = wantWa && !!phoneVal;
      const canEm   = wantEm && !!emailVal;

      // Skip-reason bepalen.
      let skipReason = null;
      let status     = 'pending';
      if (channel === 'whatsapp'  && !canWa) { skipReason = 'no_phone';   status = 'skipped'; }
      else if (channel === 'email' && !canEm) { skipReason = 'no_email';   status = 'skipped'; }
      else if (channel === 'both'  && !canWa && !canEm) { skipReason = 'no_contact'; status = 'skipped'; }

      // Preview-resolve. Named-mode: resolveVariables leest {{klant.*}} etc.
      // Bij template not_found → placeholder-tekst.
      const ctx = { customer: cust, openInvoices };
      let previewWa = null;
      if (wantWa && templateBodyText) {
        try {
          const resolved = resolveVariables(templateBodyText, null, ctx);
          previewWa = resolved?.text ?? '';
        } catch (e) {
          previewWa = '(preview-fout: ' + (e?.message || 'onbekend') + ')';
        }
      } else if (wantWa && templateSource?.body_source === 'not_found') {
        previewWa = '(WhatsApp-template niet gevonden: ' + templateName + ')';
      }

      // E-mail preview (subject + body los resolven — resolveVariables is
      // per string; we roepen 'm 2x aan met dezelfde context).
      let previewEmailSubject = null;
      let previewEmailBody    = null;
      if (wantEm && (emailTemplateSubject || emailTemplateBody)) {
        try {
          previewEmailSubject = resolveVariables(emailTemplateSubject, null, ctx)?.text ?? '';
          previewEmailBody    = resolveVariables(emailTemplateBody,    null, ctx)?.text ?? '';
        } catch (e) {
          previewEmailBody = '(preview-fout: ' + (e?.message || 'onbekend') + ')';
        }
      } else if (wantEm && emailTemplateId && emailTemplateSource?.source !== 'raw') {
        previewEmailSubject = '(E-mail template niet gevonden/inactief)';
        previewEmailBody    = '';
      }

      recipients.push({
        customer_id     : cid,
        customer_name   : name,
        customer_email  : emailVal || null,
        customer_phone  : phoneVal || null,
        invoice_ids     : openInvoices.map((inv) => inv.id),
        total_open_cents: toCents(totalOpenEur),
        open_invoice_count: openInvoices.length,
        channel_whatsapp: canWa,
        channel_email   : canEm,
        preview_whatsapp: previewWa,
        preview_email_subject: previewEmailSubject,
        preview_email_body   : previewEmailBody,
        skip_reason     : skipReason,
        status,
      });

      if (status === 'skipped') { skipped++; if (skipReason) skipBreakdown[skipReason]++; }
      else willSend++;
    }

    if (recipients.length === 0) {
      return res.status(400).json({
        error: 'Geen bruikbare klanten in selectie (allemaal gearchiveerd/anoniem of niet gevonden)',
        rejected: rejectedNoCustomer,
      });
    }

    // Job aanmaken (status='draft').
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('dunning_bulk_jobs')
      .insert({
        created_by_user_id: user.id,
        channel,
        template_name    : templateName,
        email_template_id: emailTemplateId,
        status           : 'draft',
        total_recipients : recipients.length,
        skipped_count    : skipped,
      })
      .select('id')
      .single();
    if (jobErr) throw new Error('job insert: ' + jobErr.message);
    const jobId = job.id;

    // Recipients-rijen inserten (chunked bij grote lijsten).
    const CHUNK = 100;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const slice = recipients.slice(i, i + CHUNK).map((r) => ({
        job_id                        : jobId,
        customer_id                   : r.customer_id,
        customer_name                 : r.customer_name,
        customer_email                : r.customer_email,
        customer_phone                : r.customer_phone,
        invoice_ids                   : r.invoice_ids,
        total_open_cents              : r.total_open_cents,
        open_invoice_count            : r.open_invoice_count,
        channel_whatsapp              : r.channel_whatsapp,
        channel_email                 : r.channel_email,
        resolved_preview_whatsapp     : r.preview_whatsapp,
        resolved_preview_email_subject: r.preview_email_subject,
        resolved_preview_email_body   : r.preview_email_body,
        status                        : r.status,
        skip_reason                   : r.skip_reason,
      }));
      const { error: rErr } = await supabaseAdmin.from('dunning_bulk_recipients').insert(slice);
      if (rErr) {
        // Rollback-poging: verwijder de job zodat er geen half-lege draft blijft hangen.
        await supabaseAdmin.from('dunning_bulk_jobs').delete().eq('id', jobId);
        throw new Error('recipients insert: ' + rErr.message);
      }
    }

    return res.status(200).json({
      job_id : jobId,
      summary: {
        total    : recipients.length,
        will_send: willSend,
        skipped  ,
        skipped_breakdown: skipBreakdown,
      },
      recipients,
      template: templateSource,
      email_template: emailTemplateSource,
      rejected: rejectedNoCustomer,
      phase_note: 'FASE 1: draft-job aangemaakt. Er wordt nog NIETS verstuurd — dat gebeurt in Fase 2.',
    });
  } catch (e) {
    console.error('[wanbetalers-bulk-preview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
