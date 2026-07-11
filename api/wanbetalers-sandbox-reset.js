// api/wanbetalers-sandbox-reset.js
// POST → wist ALLE is_test-data volledig. Idempotent. Super_admin only.
//
// Volgorde (child → parent om FK-constraints te respecteren):
//   dunning_pipeline_log        (customer_id in test_customer_ids)
//   dunning_pipeline_appointments (idem)
//   dunning_pipeline_customers  (idem)
//   dunning_bulk_recipients     (customer_id in test_customer_ids)
//   dunning_bulk_jobs           (is_test=true)
//   dunning_log                 (payload->>customer_id in test_customer_ids)
//   whatsapp_messages           (conversation_id in test-conversations)
//   whatsapp_conversations      (customer_id in test_customer_ids)
//   invoices                    (is_test=true)
//   customers                   (is_test=true)
//   app_settings dunning_sandbox_contact → reset naar {phone:null, email:null}

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, setSandboxContact } from './_lib/wanbetalers-sandbox.js';
import { invalidateDryRunCache } from './_lib/dunning-dry-run.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const summary = { customers_deleted: 0, invoices_deleted: 0, conversations_deleted: 0, messages_deleted: 0, pipeline_rows: 0, bulk_jobs: 0 };

  try {
    // 1) Alle test-customer-ids ophalen.
    const { data: custs } = await supabaseAdmin
      .from('customers').select('id').eq('is_test', true);
    const custIds = (custs || []).map((c) => c.id);

    if (custIds.length > 0) {
      // 2) Test-conversations ophalen (om messages te vinden).
      const { data: convs } = await supabaseAdmin
        .from('whatsapp_conversations').select('id').in('customer_id', custIds);
      const convIds = (convs || []).map((c) => c.id);

      if (convIds.length > 0) {
        const { count: mCount } = await supabaseAdmin.from('whatsapp_messages')
          .delete({ count: 'exact' }).in('conversation_id', convIds);
        summary.messages_deleted = mCount || 0;
      }

      const { count: cCount } = await supabaseAdmin.from('whatsapp_conversations')
        .delete({ count: 'exact' }).in('customer_id', custIds);
      summary.conversations_deleted = cCount || 0;

      // 3) Pipeline-rijen.
      await supabaseAdmin.from('dunning_pipeline_log').delete().in('customer_id', custIds);
      await supabaseAdmin.from('dunning_pipeline_appointments').delete().in('customer_id', custIds);
      const { count: pCount } = await supabaseAdmin.from('dunning_pipeline_customers')
        .delete({ count: 'exact' }).in('customer_id', custIds);
      summary.pipeline_rows = pCount || 0;

      // 4) Bulk-jobs voor deze test-klanten (én sowieso alle is_test=true jobs).
      const { data: recs } = await supabaseAdmin.from('dunning_bulk_recipients')
        .select('id, job_id').in('customer_id', custIds);
      const recJobIds = Array.from(new Set((recs || []).map((r) => r.job_id).filter(Boolean)));
      if (recs && recs.length > 0) {
        await supabaseAdmin.from('dunning_bulk_recipients').delete().in('customer_id', custIds);
      }
      if (recJobIds.length > 0) {
        await supabaseAdmin.from('dunning_bulk_jobs').delete().in('id', recJobIds);
      }
      // Extra: alle is_test=true jobs (vangnet).
      const { count: bCount } = await supabaseAdmin.from('dunning_bulk_jobs')
        .delete({ count: 'exact' }).eq('is_test', true);
      summary.bulk_jobs = bCount || 0;

      // 5) dunning_log — verwijder rijen waar payload.customer_id in test-set zit.
      // PostgREST filter met jsonb ->>text.
      for (const cid of custIds) {
        try {
          await supabaseAdmin.from('dunning_log').delete().filter('payload->>customer_id', 'eq', cid);
        } catch (_) { /* fail-soft per klant */ }
      }
    }

    // 6) Invoices + customers (in die volgorde vanwege FK).
    const { count: iCount } = await supabaseAdmin.from('invoices')
      .delete({ count: 'exact' }).eq('is_test', true);
    summary.invoices_deleted = iCount || 0;

    const { count: custCount } = await supabaseAdmin.from('customers')
      .delete({ count: 'exact' }).eq('is_test', true);
    summary.customers_deleted = custCount || 0;

    // 7) Reset sandbox-contact naar leeg.
    await setSandboxContact({ phone: null, email: null });
    invalidateDryRunCache();

    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[sandbox-reset]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', summary });
  }
}
