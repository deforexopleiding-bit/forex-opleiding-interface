// api/wanbetalers-bulk-brief-create.js
// POST → bulk WIK-brief-generatie voor N wanbetaler-klanten.
//
// Hergebruikt _lib/incasso-pre-brief-core.js#generatePreBriefForCustomer —
// ZELFDE brief-generator als de handmatige knop en de dunning-engine.
// runId=null → géén dunning-koppeling, géén brief-niveau dedup, géén
// dunning-state-mutatie.
//
// Money-pariteit dry-run==brief door SHARED helpers:
//   - fetchOpenInvoicesForCustomersBatch (dry-run + preview)
//   - generatePreBriefForCustomer intern óók fetchOpenInvoicesForCustomer
// → één rekenregel (via _isPositiveOpen/_openCents in het core-bestand).
//
// Skip-regels (hard, in volgorde):
//   1. customer.is_test / archived_at / anonymized_at
//   2. Geen address_street OF geen address_city              → 'no_address'
//   3. openstaand_bedrag_cents < MIN_OPENSTAAND_CENTS (50)   → 'openstaand_bedrag_null_or_zero'
//   4. generator-code (ADDRESS_INCOMPLETE / CUSTOMER_NOT_FOUND / TEMPLATE_NOT_FOUND
//      / BRIEF_ROW_FAILED / STORAGE_UPLOAD_FAILED)
//
// Partieel adres (ontbrekend huisnummer of postcode maar wel straat+city):
// dry-run zet flag='address_incomplete' + missing[] (would_create blijft);
// live-run laat generator beslissen. validateCustomerAddress checkt op de 4
// address_*-velden (address_street, address_number, address_postal, address_city).
//
// Cap 100 — PDF-render + storage-upload zwaarder dan WA. >100 → 422 met count.
// INSERT-first idempotency via client-side bulk_job_id (PK op dunning_bulk_jobs
// met channel='brief_only', vereist migratie 048). Stuck-job: PK-collision met
// status='running' → 202 + processed_so_far, met 'completed' → 409 met totals.
//
// Landcode: brief-generator resolvet zelf via bepaalLand (single source);
// bulk geeft country:null door zodat er geen tweede detectie-pad ontstaat.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { generatePreBriefForCustomer, fetchOpenInvoicesForCustomersBatch } from './_lib/incasso-pre-brief-core.js';
import { formatEur } from './_lib/dunning-template-render.js';
import { validateCustomerAddress, bepaalLand } from './_lib/wik-brief-layout.js';
import { getClientIp } from './_lib/audit-customer.js';

const MIN_OPENSTAAND_CENTS = 50;
const MAX_RECIPIENTS       = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const config = { maxDuration: 300 };

function displayName(cust) {
  const parts = [cust.first_name, cust.last_name || cust.company_name].filter(Boolean).map(String);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
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
  const rl = await checkRateLimit({ req, bucket: 'brief-bulk-create', maxHits: 6, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const body = req.body || {};
  const customerIds = Array.isArray(body.customer_ids) ? body.customer_ids : [];
  const dryRun      = body.dry_run !== false;
  const clientBulkJobId = String(body.bulk_job_id || '').trim();

  if (customerIds.length === 0) return res.status(400).json({ error: 'customer_ids leeg' });
  if (!customerIds.every(id => UUID_RE.test(id))) return res.status(400).json({ error: 'customer_ids moet uuids zijn' });
  if (customerIds.length > MAX_RECIPIENTS) {
    return res.status(422).json({
      error: `Max ${MAX_RECIPIENTS} klanten per bulk (brief-generatie is CPU-intensief)`,
      count: customerIds.length,
    });
  }
  if (!dryRun && !UUID_RE.test(clientBulkJobId)) {
    return res.status(400).json({ error: 'bulk_job_id (uuid) vereist bij live-run' });
  }

  try {
    // Klanten — address_* velden (bevestigd via wik-brief-layout REQUIRED_ADDRESS_FIELDS).
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, address_street, address_number, address_postal, address_city, address_country, is_test, archived_at, anonymized_at')
      .in('id', customerIds);
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    const custById = new Map((customers || []).map(c => [c.id, c]));

    // Batch invoices via SHARED helper — 1 query voor alle klanten.
    // Fail-hard: invoices zijn money — geen fail-soft naar 0.
    let invoicesByCust;
    try {
      invoicesByCust = await fetchOpenInvoicesForCustomersBatch(customerIds, supabaseAdmin);
    } catch (e) {
      console.error('[wanbetalers-bulk-brief-create] batch invoices:', e?.message || e);
      return res.status(500).json({ error: 'Interne fout (invoices)' });
    }

    // Recipients — skip-check + dry-run preview
    const recipients = [];
    for (const cid of customerIds) {
      const cust = custById.get(cid);
      if (!cust) { recipients.push({ customer_id: cid, action: 'skip', skip_reason: 'customer_not_found' }); continue; }
      const nm = displayName(cust);
      if (cust.is_test) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'customer_is_test' }); continue; }
      if (cust.archived_at || cust.anonymized_at) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'customer_archived' }); continue; }

      // Adres-validatie (dezelfde helper die generator gebruikt).
      const addr = validateCustomerAddress(cust);
      const missing = Array.isArray(addr?.missing) ? addr.missing : [];
      // Hard-skip: als straat OF stad ontbreekt → geen enveloppe mogelijk.
      const hasStreet = !!(cust.address_street && String(cust.address_street).trim());
      const hasCity   = !!(cust.address_city   && String(cust.address_city).trim());
      if (!hasStreet || !hasCity) { recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'no_address' }); continue; }

      // Openstaand-bedrag — SHARED helper (money-pariteit met generator per constructie).
      const openstaandCents = (invoicesByCust.get(cid) || { totalOpenCents: 0 }).totalOpenCents;
      if (openstaandCents < MIN_OPENSTAAND_CENTS) {
        recipients.push({ customer_id: cid, customer_name: nm, action: 'skip', skip_reason: 'openstaand_bedrag_null_or_zero', openstaand_bedrag_display: formatEur(openstaandCents / 100) });
        continue;
      }

      const addressLines = [
        [cust.address_street, cust.address_number].filter(Boolean).join(' ') || null,
        [cust.address_postal, cust.address_city].filter(Boolean).join(' ') || null,
      ].filter(Boolean);

      recipients.push({
        customer_id: cid, customer_name: nm,
        country: bepaalLand(cust),          // 'NL' | 'BE' via canonieke resolver (display-only)
        address_lines: addressLines,
        openstaand_bedrag_cents: openstaandCents,
        openstaand_bedrag_display: formatEur(openstaandCents / 100),
        action: 'would_create',
        flag: missing.length ? 'address_incomplete' : null,
        missing: missing.length ? missing : undefined,
      });
    }

    const totals = {
      requested: customerIds.length,
      would_create: recipients.filter(r => r.action === 'would_create').length,
      would_skip:   recipients.filter(r => r.action === 'skip').length,
      flag_address_incomplete: recipients.filter(r => r.flag === 'address_incomplete').length,
    };
    const skipReasonSummary = {};
    for (const r of recipients) if (r.action === 'skip') skipReasonSummary[r.skip_reason] = (skipReasonSummary[r.skip_reason] || 0) + 1;

    // DRY-RUN → early return
    if (dryRun) {
      return res.status(200).json({ mode: 'dry_run', totals, recipients, skip_reason_summary: skipReasonSummary });
    }

    // LIVE — INSERT-first idempotency
    const { error: jobInsErr } = await supabaseAdmin.from('dunning_bulk_jobs').insert({
      id: clientBulkJobId, created_by_user_id: user.id,
      channel: 'brief_only', status: 'running',
      total_recipients: customerIds.length, sent_count: 0, failed_count: 0, skipped_count: 0,
    });
    if (jobInsErr) {
      if (jobInsErr.code === '23505') {
        const [existingJob, doneRecipients] = await Promise.all([
          supabaseAdmin.from('dunning_bulk_jobs').select('id, status, sent_count, failed_count, skipped_count, created_at, completed_at').eq('id', clientBulkJobId).maybeSingle(),
          supabaseAdmin.from('dunning_bulk_recipients').select('customer_id, customer_name, status, error, skip_reason').eq('job_id', clientBulkJobId),
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
    const briefIds = [];
    let createdCount = 0, skippedCount = 0, errorCount = 0;

    try {
      for (const r of recipients) {
        if (r.action === 'skip') {
          skippedCount++;
          results.push({ customer_id: r.customer_id, customer_name: r.customer_name, action: 'skipped', skip_reason: r.skip_reason });
          await supabaseAdmin.from('dunning_bulk_recipients').insert({
            job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
            channel_whatsapp: false, channel_email: false,
            total_open_cents: r.openstaand_bedrag_cents || 0,
            status: 'skipped', skip_reason: r.skip_reason,
          }).then(() => {}, () => {});
          continue;
        }

        try {
          const gen = await generatePreBriefForCustomer({
            customerId: r.customer_id,
            country: null,               // laat generator zelf via bepaalLand detecteren (single source)
            generatedByUserId: user.id,
            runId: null, stepId: null,   // geen dunning-koppeling
            db: supabaseAdmin,
          });
          if (gen.ok) {
            createdCount++;
            briefIds.push(gen.brief_id);
            results.push({ customer_id: r.customer_id, customer_name: r.customer_name, action: 'created', brief_id: gen.brief_id, pdf_path: gen.pdf_path });
            await supabaseAdmin.from('dunning_bulk_recipients').insert({
              job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
              channel_whatsapp: false, channel_email: false,
              total_open_cents: r.openstaand_bedrag_cents,
              status: 'sent', sent_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          } else {
            errorCount++;
            results.push({ customer_id: r.customer_id, customer_name: r.customer_name, action: 'error', error_code: gen.code, error_message: gen.error || null, missing: gen.missing });
            await supabaseAdmin.from('dunning_bulk_recipients').insert({
              job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
              channel_whatsapp: false, channel_email: false,
              status: 'failed', error: `${gen.code}: ${gen.error || ''}`.slice(0, 500),
            }).then(() => {}, () => {});
          }
        } catch (e) {
          errorCount++;
          results.push({ customer_id: r.customer_id, customer_name: r.customer_name, action: 'error', error_code: 'GENERATE_EXCEPTION', error_message: e?.message || 'onbekend' });
          await supabaseAdmin.from('dunning_bulk_recipients').insert({
            job_id: clientBulkJobId, customer_id: r.customer_id, customer_name: r.customer_name,
            channel_whatsapp: false, channel_email: false,
            status: 'failed', error: (e?.message || '').slice(0, 500),
          }).then(() => {}, () => {});
        }
      }
    } finally {
      // Altijd job finaliseren — ook bij exception halverwege.
      await supabaseAdmin.from('dunning_bulk_jobs').update({
        status: 'completed', completed_at: new Date().toISOString(),
        sent_count: createdCount, failed_count: errorCount, skipped_count: skippedCount,
      }).eq('id', clientBulkJobId).then(() => {}, () => {});
    }

    await supabaseAdmin.from('activity_log').insert({
      user_id: user.id,
      action:  'finance.wanbetalers.brief_bulk_create',
      entity_type: 'dunning_bulk_job',
      entity_id:   clientBulkJobId,
      payload: {
        totals: { requested: customerIds.length, created: createdCount, skipped: skippedCount, errors: errorCount },
        actor_user_id: user.id, ip: getClientIp(req),
      },
    }).then(() => {}, () => {});

    return res.status(200).json({
      mode: 'live', bulk_job_id: clientBulkJobId,
      totals: { requested: customerIds.length, created: createdCount, skipped: skippedCount, errors: errorCount },
      brief_ids: briefIds, results,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[wanbetalers-bulk-brief-create]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
