// api/sales-customer-postpone-all.js
// POST { customer_id, months } → verschuift/verlengt ALLE actieve abonnementen
// van een klant X maanden. Permission: sales.deal.edit.
// Per sub dezelfde logica als de losse postpone (gedeelde helper);
// faalt een sub individueel, dan loggen we en gaan door.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { postponeSubscription } from './_lib/subscription-postpone.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  const { customer_id, months } = req.body || {};
  const m = Number(months);
  if (!customer_id) return res.status(400).json({ error: 'customer_id vereist' });
  if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ error: 'months moet 1–12 zijn' });

  try {
    // Subs van deze klant via diens deals.
    const { data: deals } = await supabaseAdmin.from('deals').select('id').eq('customer_id', customer_id).is('archived_at', null);
    const dealIds = (deals || []).map(d => d.id);
    if (!dealIds.length) return res.status(200).json({ success: true, total: 0, ok: 0, failed: 0 });

    const { data: subs } = await supabaseAdmin.from('subscriptions')
      .select('*').in('deal_id', dealIds).eq('status', 'active');
    const list = (subs || []).filter(s => s.start_date); // zonder startdatum niets te verschuiven

    const todayStr = new Date().toISOString().slice(0, 10);
    let ok = 0, failed = 0;
    for (const sub of list) {
      try { await postponeSubscription(sub, m, { userId: user.id, req, todayStr }); ok++; }
      catch (e) { failed++; console.error('[postpone-all] sub', sub.id, 'mislukt:', e.message); }
    }

    return res.status(200).json({ success: true, total: list.length, ok, failed });
  } catch (e) {
    console.error('[sales-customer-postpone-all]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
