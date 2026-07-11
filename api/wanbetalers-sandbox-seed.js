// api/wanbetalers-sandbox-seed.js
// POST { name, phone, email, invoice_count?, amount_per_invoice_eur?, days_overdue? }
//   Maakt óf ververst 1 is_test-customer (naam prefixed met "🧪 TEST — "),
//   N is_test-invoices met vervaldatum backdated, en een pipeline-rij in 'nieuw'.
//   Slaat phone/email ook op in app_settings.dunning_sandbox_contact (recipient-guard).
// Idempotent: als er al een is_test-customer bestaat → wordt ge-update i.p.v.
// een 2e persoon gemaakt (de sandbox-flow werkt met 1 test-persoon per omgeving).
// Super_admin only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer, setSandboxContact, sandboxDisplayName } from './_lib/wanbetalers-sandbox.js';
import { invalidateDryRunCache } from './_lib/dunning-dry-run.js';

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const phone   = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email   = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const invoiceCount   = Math.max(1, Math.min(10, Number(body.invoice_count) || 2));
  const amountEur      = Math.max(1, Math.min(10_000, Number(body.amount_per_invoice_eur) || 250));
  const daysOverdue    = Math.max(1, Math.min(365, Number(body.days_overdue) || 30));

  if (!rawName || !phone || !email) {
    return res.status(400).json({ error: 'name, phone en email zijn verplicht' });
  }

  try {
    // 1) Customer upsert. Als er al een is_test-persoon is, update die.
    const displayName = sandboxDisplayName(rawName);
    let customer = await getSandboxCustomer();
    if (customer) {
      const { data: upd, error: uErr } = await supabaseAdmin
        .from('customers')
        .update({
          first_name: displayName,
          last_name : '',
          email,
          phone,
          is_company: false,
        })
        .eq('id', customer.id)
        .select('id, first_name, last_name, email, phone, is_test')
        .single();
      if (uErr) throw new Error('customer update: ' + uErr.message);
      customer = upd;
    } else {
      const { data: ins, error: iErr } = await supabaseAdmin
        .from('customers')
        .insert({
          first_name: displayName,
          last_name : '',
          email,
          phone,
          is_company: false,
          is_test   : true,
        })
        .select('id, first_name, last_name, email, phone, is_test')
        .single();
      if (iErr) throw new Error('customer insert: ' + iErr.message);
      customer = ins;
    }

    // 2) Verwijder oude test-invoices van deze klant (idempotent refresh).
    const { error: delErr } = await supabaseAdmin
      .from('invoices').delete().eq('customer_id', customer.id).eq('is_test', true);
    if (delErr) console.warn('[sandbox-seed] oude test-invoices delete soft-fail:', delErr.message);

    // 3) Maak N nieuwe invoices, allemaal 'open', vervaldatum backdated.
    const nowIso = new Date().toISOString().slice(0, 10);
    const dueIso = isoDaysAgo(daysOverdue);
    const invRows = Array.from({ length: invoiceCount }).map((_, i) => ({
      customer_id  : customer.id,
      amount_total : amountEur,
      amount_paid  : 0,
      status       : 'open',
      due_date     : dueIso,
      issue_date   : isoDaysAgo(daysOverdue + 14),
      invoice_number: 'TEST-' + Date.now().toString(36) + '-' + (i + 1),
      is_test      : true,
    }));
    const { data: newInvs, error: invErr } = await supabaseAdmin
      .from('invoices').insert(invRows).select('id, invoice_number, amount_total, due_date, status');
    if (invErr) throw new Error('invoices insert: ' + invErr.message);

    // 4) Pipeline-rij (of reset) → 'nieuw'.
    const { data: existingPipe } = await supabaseAdmin
      .from('dunning_pipeline_customers').select('id').eq('customer_id', customer.id).maybeSingle();
    const stagePayload = {
      customer_id     : customer.id,
      stage_slug      : 'nieuw',
      stage_changed_at: new Date().toISOString(),
      stage_changed_by: 'sandbox:seed',
      last_activity_at: new Date().toISOString(),
    };
    if (existingPipe) {
      await supabaseAdmin.from('dunning_pipeline_customers').update(stagePayload).eq('id', existingPipe.id);
    } else {
      await supabaseAdmin.from('dunning_pipeline_customers').insert(stagePayload);
    }

    // 5) Sandbox-contact opslaan voor de recipient-guard.
    const contact = await setSandboxContact({ phone, email });
    invalidateDryRunCache();

    return res.status(200).json({
      ok       : true,
      customer,
      invoices : newInvs || [],
      contact,
      pipeline_stage: 'nieuw',
    });
  } catch (e) {
    console.error('[sandbox-seed]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
