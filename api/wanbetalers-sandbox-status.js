// api/wanbetalers-sandbox-status.js
// GET → { customer, invoices, pipeline_stage, dry_run, contact, counts }
// Super_admin only. Read-only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer, getSandboxContact, getDryRun } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    const customer = await getSandboxCustomer();
    const contact  = await getSandboxContact();
    const dry_run  = await getDryRun();

    let invoices = [];
    let pipeline = null;
    let convs = [];
    if (customer) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, status, is_test, created_at')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: true });
      invoices = invs || [];

      const { data: pipe } = await supabaseAdmin
        .from('dunning_pipeline_customers')
        .select('id, stage_slug, stage_changed_at, last_activity_at')
        .eq('customer_id', customer.id)
        .maybeSingle();
      pipeline = pipe || null;

      const { data: cvs } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number, status, last_message_at, last_inbound_at')
        .eq('customer_id', customer.id)
        .order('last_message_at', { ascending: false, nullsFirst: false });
      convs = cvs || [];
    }

    // Meta-count: hoeveel is_test-rijen zijn er totaal (indien de user twijfelt of reset compleet werkte).
    const { count: testCustCount } = await supabaseAdmin
      .from('customers').select('id', { count: 'exact', head: true }).eq('is_test', true);
    const { count: testInvCount } = await supabaseAdmin
      .from('invoices').select('id', { count: 'exact', head: true }).eq('is_test', true);

    return res.status(200).json({
      customer,
      invoices,
      pipeline_stage: pipeline?.stage_slug || null,
      pipeline,
      conversations: convs,
      dry_run,
      contact,
      counts: {
        test_customers_total: testCustCount || 0,
        test_invoices_total : testInvCount  || 0,
      },
    });
  } catch (e) {
    console.error('[sandbox-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
