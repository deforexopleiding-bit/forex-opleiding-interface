// api/sales-subscription-postpone.js
// POST { subscription_id, months } → verschuift start_date + end_date X maanden
// vooruit (looptijd blijft gelijk). Permission: sales.deal.edit.
//
// - Eerste keer uitstel: original_start_date/original_end_date = snapshot baseline.
// - postponed_months += months (cumulatief).
// - TL: subscriptions.update { id, starts_on, ends_on } (best-effort; bevestigd
//   in apiary: update accepteert id/starts_on/ends_on/status/...).
// - Audit: audit_log entry (entity_type 'subscription').

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';

// 'YYYY-MM-DD' + n maanden → 'YYYY-MM-DD' (klok-veilig, lokale datum).
function addMonths(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + Number(n));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

    const before = { start_date: sub.start_date, end_date: sub.end_date, postponed_months: sub.postponed_months || 0 };
    const newStart = addMonths(sub.start_date, m);
    const newEnd = sub.end_date ? addMonths(sub.end_date, m) : null;

    const patch = {
      start_date: newStart,
      end_date: newEnd,
      postponed_months: (Number(sub.postponed_months) || 0) + m,
    };
    // Eerste keer uitstel → baseline-snapshot vastleggen.
    if (sub.original_start_date == null) {
      patch.original_start_date = sub.start_date;
      patch.original_end_date = sub.end_date || null;
    }

    const { data: updated, error: upErr } = await supabaseAdmin.from('subscriptions')
      .update(patch).eq('id', subscription_id).select('*').single();
    if (upErr) throw upErr;

    // TL best-effort: subscriptions.update met nieuwe datums.
    let tl = { pushed: false };
    if (sub.teamleader_subscription_id) {
      try {
        const tok = await getActiveToken();
        if (tok) {
          const tlBody = { id: sub.teamleader_subscription_id, starts_on: newStart };
          if (newEnd) tlBody.ends_on = newEnd;
          const r = await tlFetch('/subscriptions.update', { method: 'POST', body: JSON.stringify(tlBody) });
          if (r.ok) tl = { pushed: true };
          else { tl = { pushed: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }; console.warn('[sub-postpone] TL update', tl.error); }
        }
      } catch (e) { tl = { pushed: false, error: e.message }; console.warn('[sub-postpone] TL exception:', e.message); }
    }

    // Audit (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'subscription.postponed', entity_type: 'subscription', entity_id: subscription_id,
        before_json: before, after_json: { start_date: newStart, end_date: newEnd, postponed_months: patch.postponed_months },
        reason_text: `+${m} maand(en) uitgesteld`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[sub-postpone] audit:', e.message); }

    return res.status(200).json({ success: true, subscription: updated, tl });
  } catch (e) {
    console.error('[sales-subscription-postpone]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
