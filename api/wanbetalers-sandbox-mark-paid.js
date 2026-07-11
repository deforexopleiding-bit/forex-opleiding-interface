// api/wanbetalers-sandbox-mark-paid.js
// POST { invoice_id? } → markeert een (of alle) is_test-factuur op 'paid'
// en vuurt de dunning-pipeline 'on_paid_to_opgelost'-trigger als er geen
// open facturen meer zijn. Super_admin only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const invoiceId = typeof body.invoice_id === 'string' ? body.invoice_id.trim() : null;

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });

    // Target-set: één factuur (indien meegegeven) of ALLE test-facturen.
    let q = supabaseAdmin.from('invoices')
      .select('id, amount_total, amount_paid, status, is_test')
      .eq('customer_id', customer.id).eq('is_test', true).in('status', ['open', 'partially_paid', 'overdue']);
    if (invoiceId) q = q.eq('id', invoiceId);
    const { data: invs, error: iErr } = await q;
    if (iErr) throw new Error('invoices lookup: ' + iErr.message);
    if (!invs || invs.length === 0) return res.status(400).json({ error: 'Geen open test-facturen' });

    const now = new Date().toISOString();
    const dateOnly = now.slice(0, 10);
    let updated = 0;
    for (const inv of invs) {
      const { error: uErr } = await supabaseAdmin.from('invoices').update({
        amount_paid: Number(inv.amount_total) || 0,
        status     : 'paid',
        paid_date  : dateOnly,
        updated_at : now,
      }).eq('id', inv.id);
      if (!uErr) updated++;
    }

    // Pipeline-trigger 'on_paid_to_opgelost' — alleen als er 0 open facturen
    // over zijn (zelfde check als register-payment-internal).
    let pipelineFired = false;
    try {
      const { isAutoEnabled, setStage } = await import('./_lib/dunning-pipeline.js');
      const { count: openLeft } = await supabaseAdmin.from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customer.id)
        .in('status', ['open', 'partially_paid', 'overdue']);
      if ((openLeft || 0) === 0 && (await isAutoEnabled('on_paid_to_opgelost'))) {
        await setStage(customer.id, 'opgelost', 'all_paid', 'sandbox:paid');
        pipelineFired = true;
      }
    } catch (e) {
      console.warn('[sandbox-mark-paid] pipeline hook soft-fail', e?.message);
    }

    return res.status(200).json({ ok: true, invoices_marked_paid: updated, pipeline_opgelost_fired: pipelineFired });
  } catch (e) {
    console.error('[sandbox-mark-paid]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
