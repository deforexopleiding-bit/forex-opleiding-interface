// api/sales-subscription-postpone.js
// POST { subscription_id, months } → verschuift (toekomstig) OF verlengt (lopend)
// een abonnement X maanden. Permission: sales.deal.edit.
// Kernlogica in api/_lib/subscription-postpone.js (gedeeld met postpone-all).

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

  const { subscription_id, months } = req.body || {};
  const m = Number(months);
  if (!subscription_id) return res.status(400).json({ error: 'subscription_id vereist' });
  if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ error: 'months moet 1–12 zijn' });

  try {
    const { data: sub } = await supabaseAdmin.from('subscriptions').select('*').eq('id', subscription_id).maybeSingle();
    if (!sub) return res.status(404).json({ error: 'Abonnement niet gevonden' });
    if (!sub.start_date) return res.status(422).json({ error: 'Abonnement heeft geen startdatum om te verschuiven' });

    const result = await postponeSubscription(sub, m, { userId: user.id, req });
    return res.status(200).json({ success: true, subscription: result.subscription, tl: result.tl, extended: result.extended });
  } catch (e) {
    console.error('[sales-subscription-postpone]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
