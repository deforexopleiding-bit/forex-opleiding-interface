// api/wanbetalers-sandbox-run-bulk.js
// POST { channel: 'whatsapp'|'email', template_name?, email_template_id?, subject?, body? }
//
// Simpele end-to-end bulk-simulatie voor de test-persoon:
//  1) Bouwt een dunning_bulk_jobs-rij met is_test=true, status='approved'.
//  2) Insert 1 recipient (de test-persoon) met de gegeven channel-preview.
//  3) Roept de bestaande cron-bulk-send handler INLINE aan. Die skipt
//     normaal is_test=true jobs, maar we runnen 'm hier met een override-
//     flag zodat sandbox-jobs wél worden opgepikt.
//
// Voor MVP: dit endpoint laat gewoon de job/recipient staan. Jeffrey kan
// hem in Vercel-cron-tab handmatig triggeren, of we bouwen de inline-runner
// in een vervolg-PR. Voor NU: gewoon de job aanmaken → dry-run guardrail
// zorgt dat er nooit iets echt verstuurd wordt.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';

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
  const subject  = typeof body.subject === 'string' ? body.subject : 'Herinnering — TEST';
  const bodyText = typeof body.body    === 'string' ? body.body    : 'Dit is een sandbox-testbericht.';

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });

    const dry = await isDryRunEnabled();
    const nowIso = new Date().toISOString();

    // 1) Job.
    const { data: job, error: jErr } = await supabaseAdmin.from('dunning_bulk_jobs').insert({
      channel        : channel,
      template_name  : channel === 'whatsapp' ? (tplName || 'test_template') : null,
      email_template_id: emailTplId,
      status         : 'approved',
      batch_size     : 1,
      total_recipients: 1,
      sent_count     : 0,
      failed_count   : 0,
      skipped_count  : 0,
      is_test        : true,
      created_at     : nowIso,
    }).select('id').single();
    if (jErr) throw new Error('bulk_jobs insert: ' + jErr.message);

    // 2) Recipient.
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
      invoice_ids      : [],
      status           : 'pending',
      created_at       : nowIso,
    }).select('id').single();
    if (rErr) throw new Error('bulk_recipients insert: ' + rErr.message);

    return res.status(200).json({
      ok: true,
      dry_run: dry,
      job_id: job.id,
      recipient_id: rec.id,
      hint: 'Test-job aangemaakt (is_test=true). Trigger daarna cron-dunning-bulk-send handmatig; dry-run guard zorgt dat er niets echt verstuurd wordt.',
    });
  } catch (e) {
    console.error('[sandbox-run-bulk]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
