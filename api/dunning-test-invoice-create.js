// POST /api/dunning-test-invoice-create
//
// Maakt N is_test-facturen aan voor een is_test-customer. Bypass volledig
// Teamleader (geen tlFetch, geen invoice-create-core.js). Rechtstreekse
// INSERT met TEST- prefix invoice_number + backdated due_date.
//
// Weigert non-test klant (400): valideert customers.is_test=true vóór
// insert. Nooit een echte klant kunnen raken.
//
// Body:
//   {
//     customer_id: uuid,
//     invoices: [
//       {
//         amount: number,                 // amount_total in EUR
//         days_late: number,              // > 0 (due_date = today - N)
//         scenario_tag?: string,          // opt: bv. 'r1-basis'
//         expected_outcome?: string       // opt: bv. 'reminder-r1'
//       },
//       ...
//     ]
//   }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function shortId() {
  // 8-char hex — voldoende uniek voor test-batches (composite unique is
  // (invoice_number, YEAR), niet global)
  return Math.random().toString(16).slice(2, 10);
}

async function audit({ actor, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'create_test_invoices',
      scope:        'test',
      target:       { customer_id: payload?.customer_id, invoice_ids: result?.invoice_ids || [] },
      payload:      { count: payload?.invoices?.length, scenario_tags: (payload?.invoices || []).map(i => i.scenario_tag).filter(Boolean) },
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-invoice-create] audit insert failed:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const actor = { userId: admin.user.id, email: admin.profile.email };
  const body = req.body || {};
  const customerId = body.customer_id;
  const invoices = Array.isArray(body.invoices) ? body.invoices : [];

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });
  if (invoices.length === 0) return res.status(400).json({ error: 'invoices moet minstens 1 entry hebben.' });

  // Weiger als de customer niet is_test=true is — mag NOOIT op een echte
  // klant landen.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers')
    .select('id, is_test, first_name, last_name')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust)          return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!cust.is_test)  return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering — test-cockpit raakt nooit een echte klant.' });

  // Bouw insert-rijen.
  const now = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const inv of invoices) {
    const amount = Number(inv?.amount);
    const daysLate = Number(inv?.days_late);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: `Ongeldig amount: ${inv?.amount}` });
    }
    if (!Number.isFinite(daysLate) || daysLate < 0) {
      return res.status(400).json({ error: `Ongeldig days_late: ${inv?.days_late}` });
    }
    const invoiceNumber = 'TEST-' + shortId();
    rows.push({
      customer_id:    customerId,
      invoice_number: invoiceNumber,
      amount_total:   amount,
      amount_paid:    0,
      status:         'open',
      issue_date:     now,
      due_date:       isoDaysAgo(daysLate),
      is_test:        true,
      test_metadata: {
        scenario_tag:     inv?.scenario_tag || null,
        expected_outcome: inv?.expected_outcome || null,
        created_by:       actor.email,
        days_late_at_creation: daysLate,
      },
    });
  }

  try {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('invoices')
      .insert(rows)
      .select('id, invoice_number, amount_total, due_date, is_test, test_metadata');

    if (insErr) {
      await audit({ actor, payload: { customer_id: customerId, invoices }, status: 'error', error: insErr.message });
      return res.status(500).json({ error: insErr.message });
    }

    const invoiceIds = (inserted || []).map(r => r.id);
    await audit({
      actor,
      payload: { customer_id: customerId, invoices },
      result:  { invoice_ids: invoiceIds, count: invoiceIds.length },
      status:  'ok',
    });

    return res.status(201).json({
      ok: true,
      count: invoiceIds.length,
      invoices: inserted,
      message: `${invoiceIds.length} test-factuur/facturen aangemaakt (TEST-prefix, backdated due_date, geen Teamleader-push).`,
    });
  } catch (e) {
    await audit({ actor, payload: { customer_id: customerId, invoices }, status: 'error', error: e?.message || String(e) });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
