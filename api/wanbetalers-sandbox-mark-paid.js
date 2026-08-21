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
      // HARD SAFETY GUARD (defense-in-depth):
      //   - .eq('id', inv.id)          → doel-factuur
      //   - .eq('is_test', true)       → ook op de UPDATE zelf, niet alleen SELECT
      //   - .eq('customer_id', customer.id) → sandbox-klant, dubbele scope
      // Als tussen SELECT en UPDATE de `is_test`-vlag toch verandert (RLS-shift,
      // manuele DB-mutatie, refactor-fout), matcht deze UPDATE 0 rijen ipv per
      // ongeluk een productie-factuur te raken.
      //
      // Fail-loud: als 0 rijen matchen terwijl we wél iets verwachtten te
      // updaten, gooien we een expliciete SANDBOX_GUARD_FAILED-fout. Beter een
      // duidelijk foutspoor dan silent success bij een guard-mismatch.
      const { data: updRows, error: uErr } = await supabaseAdmin
        .from('invoices')
        .update({
          amount_paid: Number(inv.amount_total) || 0,
          status     : 'paid',
          paid_date  : dateOnly,
          updated_at : now,
        })
        .eq('id', inv.id)
        .eq('is_test', true)
        .eq('customer_id', customer.id)
        .select('id, is_test, customer_id');
      if (uErr) {
        console.error('[sandbox-mark-paid] update fail', inv.id, uErr.message);
        continue;
      }
      if (!updRows || updRows.length === 0) {
        // 0 rijen geraakt: id-only SELECT vond de rij, maar met is_test+
        // customer_id guard matcht 'ie niet meer. Iemand heeft die vlag
        // omgezet tussen SELECT en UPDATE. Faalt hard om ontdekt te worden.
        return res.status(500).json({
          error: `SANDBOX_GUARD_FAILED: invoice ${inv.id} matchte SELECT (is_test=true, customer=${customer.id}) maar UPDATE met dezelfde guards raakte 0 rijen. Iets is niet consistent — abort.`,
        });
      }
      updated++;
    }

    // Pipeline-trigger 'on_paid_to_opgelost' — alleen als er 0 open facturen
    // over zijn (zelfde check als register-payment-internal). Sluit NIET meteen
    // af: plant de grace-afsluiting (now()+60min), consistent met de echte flow.
    let pipelineFired = false;
    try {
      const { isAutoEnabled, schedulePaidResolve } = await import('./_lib/dunning-pipeline.js');
      const { count: openLeft } = await supabaseAdmin.from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customer.id)
        .in('status', ['open', 'partially_paid', 'overdue']);
      if ((openLeft || 0) === 0 && (await isAutoEnabled('on_paid_to_opgelost'))) {
        await schedulePaidResolve(customer.id, 'sandbox:paid');
        pipelineFired = true;
      }
    } catch (e) {
      console.warn('[sandbox-mark-paid] pipeline hook soft-fail', e?.message);
    }

    return res.status(200).json({ ok: true, invoices_marked_paid: updated, pipeline_resolve_scheduled: pipelineFired });
  } catch (e) {
    console.error('[sandbox-mark-paid]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
