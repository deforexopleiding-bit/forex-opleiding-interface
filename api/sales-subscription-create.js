// api/sales-subscription-create.js
// POST { deal_id, tl_department_id, first_call_at, subscriptions[], sync_to_tl }
// Wizard 2: maakt meerdere subscriptions (+ optionele bonus) lokaal aan en
// pusht ze best-effort naar TL. Permission: sales.deal.create.
//
// subscriptions[]: { description, amount, term_count, start_date, end_date, vat_percentage }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getOrCreateContact } from './_lib/teamleader-contact.js';
import { taxRateIdFor } from './_lib/teamleader-quotation.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
  }

  const { deal_id, tl_department_id, first_call_at, subscriptions = [], sync_to_tl = false } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id vereist' });
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return res.status(400).json({ error: 'minimaal 1 abonnement vereist' });

  try {
    const { data: deal } = await supabaseAdmin.from('deals').select('*').eq('id', deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });
    const departmentId = tl_department_id || deal.tl_department_id || null;

    // 1. Deal bijwerken (1e call).
    await supabaseAdmin.from('deals').update({ first_call_at: first_call_at || null }).eq('id', deal_id);

    // 2. Subscriptions lokaal aanmaken.
    const subRows = [];
    for (const s of subscriptions) {
      const { data: row } = await supabaseAdmin.from('subscriptions').insert({
        deal_id,
        description:        s.description || null,
        amount:            Number(s.amount) || 0,
        vat_percentage:    s.vat_percentage ?? 21,
        term_count:        Number(s.term_count) || 1,
        start_date:        s.start_date || null,
        end_date:          s.end_date || null,
        tl_department_id:  departmentId,
        status:            'active',
      }).select('*').single();
      if (row) subRows.push(row);
    }

    // 3. Bonus op de eerste 1-termijn-sub (aanbetaling).
    let bonus = null;
    const downSub = subscriptions.find(s => (Number(s.term_count) || 1) === 1 && Number(s.amount) > 0);
    if (downSub && deal.sales_user_id) {
      const { data: cfg } = await supabaseAdmin.from('sales_bonus_configs')
        .select('percentage, threshold_amount').eq('user_id', deal.sales_user_id)
        .order('active_from', { ascending: false }).limit(1).maybeSingle();
      const pct = cfg?.percentage ?? 3;
      const threshold = cfg?.threshold_amount ?? 1000;
      if (Number(downSub.amount) >= Number(threshold)) {
        const bonusAmount = Math.round(Number(downSub.amount) * Number(pct)) / 100;
        const { data: b } = await supabaseAdmin.from('bonuses').insert({
          deal_id, sales_user_id: deal.sales_user_id, amount: bonusAmount, status: 'pending',
        }).select('*').single();
        bonus = b || { amount: bonusAmount, status: 'pending' };
      }
    }

    // 4. Best-effort TL-push per sub (non-blocking).
    const tlResults = [];
    const tok = sync_to_tl ? await getActiveToken() : null;
    if (sync_to_tl && tok) {
      const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', deal.customer_id).maybeSingle();
      let tlContactId = null;
      try { tlContactId = await getOrCreateContact(customer); } catch (e) { console.error('[sub-create] contact:', e.message); }

      for (const row of subRows) {
        try {
          let taxRateId = null;
          try { taxRateId = taxRateIdFor(row.vat_percentage, departmentId, deal.sale_type); } catch (e) { console.warn('[sub-create] tax_rate:', e.message); }
          const body = {
            invoicee: { customer: { type: 'contact', id: tlContactId } },
            department_id: departmentId,
            starts_on: row.start_date,
            title: row.description || 'Abonnement',
            billing_cycle: { periodicity: 'monthly' },
            grouped_lines: [{ line_items: [{
              quantity: 1, description: row.description || 'Abonnement',
              unit_price: { amount: Number(row.amount), currency: 'EUR', tax: 'excluding' },
              tax_rate_id: taxRateId,
            }] }],
            // Factuur automatisch boeken + versturen bij elke termijn.
            invoice_generation: { action: 'book_and_send' },
          };
          if ((Number(row.term_count) || 1) === 1) body.ends_on = row.start_date;
          else if (row.end_date) body.ends_on = row.end_date;

          let r = await tlFetch('/subscriptions.create', { method: 'POST', body: JSON.stringify(body) });
          if (!r.ok && r.status === 400) {
            // Fallback: sommige accounts kennen 'book_and_send' niet → 'book'.
            const txt = await r.text();
            console.warn('[sub-create] 400, fallback invoice_generation=book:', txt.slice(0, 150));
            body.invoice_generation = { action: 'book' };
            r = await tlFetch('/subscriptions.create', { method: 'POST', body: JSON.stringify(body) });
          }
          if (r.ok) {
            const d = await r.json();
            const tlSubId = d.data?.id;
            if (tlSubId) await supabaseAdmin.from('subscriptions').update({ teamleader_subscription_id: tlSubId }).eq('id', row.id);
            tlResults.push({ sub_id: row.id, tl_sub_id: tlSubId, success: true });
          } else {
            tlResults.push({ sub_id: row.id, success: false, error: 'HTTP ' + r.status });
          }
        } catch (e) {
          console.error('[sub-create] sub push exception:', e.message);
          tlResults.push({ sub_id: row.id, success: false, error: e.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      subscription_ids: subRows.map(r => r.id),
      bonus,
      tl_pushed: tlResults.filter(r => r.success).length,
      tl_failed: tlResults.filter(r => !r.success).length,
      tl_results: tlResults,
    });
  } catch (e) {
    console.error('[sales-subscription-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
