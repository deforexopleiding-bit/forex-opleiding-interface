// api/_lib/subscription-postpone.js
// Gedeelde postpone-logica voor één abonnement. Gebruikt door
// sales-subscription-postpone.js (losse sub) en sales-customer-postpone-all.js
// (alle subs van een klant).
//
// PUNT 5 — lopend vs toekomstig:
//   - sub al gestart (start_date < vandaag): LOOPTIJD VERLENGEN.
//       end_date += months, term_count += months, start_date BLIJFT.
//       original_end_date snapshot (NIET original_start_date).
//       TL: subscriptions.update { ends_on } (starts_on ongemoeid).
//   - sub nog niet gestart (start_date >= vandaag): VERSCHUIVEN.
//       start_date += months, end_date += months.
//       original_start_date + original_end_date snapshot.
//       TL: subscriptions.update { starts_on, ends_on }.
//   - start_date == vandaag → behandeld als toekomstig (verschuiven).

import { supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from './teamleader-token.js';
import { getClientIp } from './audit-customer.js';

// 'YYYY-MM-DD' + n maanden → 'YYYY-MM-DD' (lokale datum, klok-veilig).
export function addMonthsStr(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + Number(n));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Verschuift/verlengt één sub. Returnt { subscription, tl, extended }.
// Gooit bij een DB-fout (caller vangt af / telt als fail).
export async function postponeSubscription(sub, months, { userId = null, req = null, todayStr = null } = {}) {
  const m = Number(months);
  const today = todayStr || new Date().toISOString().slice(0, 10);
  const running = !!(sub.start_date && sub.start_date < today); // start < vandaag = al lopend

  const before = { start_date: sub.start_date, end_date: sub.end_date, term_count: sub.term_count, postponed_months: sub.postponed_months || 0 };
  const patch = { postponed_months: (Number(sub.postponed_months) || 0) + m };
  let newStart = sub.start_date;
  let newEnd = sub.end_date;

  if (running) {
    // Looptijd verlengen: alleen einde + termijnen, start blijft.
    newEnd = sub.end_date ? addMonthsStr(sub.end_date, m) : null;
    patch.end_date = newEnd;
    patch.term_count = (Number(sub.term_count) || 1) + m;
    if (sub.original_end_date == null) patch.original_end_date = sub.end_date || null;
  } else {
    // Verschuiven: start + einde schuiven mee.
    newStart = addMonthsStr(sub.start_date, m);
    newEnd = sub.end_date ? addMonthsStr(sub.end_date, m) : null;
    patch.start_date = newStart;
    patch.end_date = newEnd;
    if (sub.original_start_date == null) { patch.original_start_date = sub.start_date; patch.original_end_date = sub.end_date || null; }
  }

  const { data: updated, error } = await supabaseAdmin.from('subscriptions').update(patch).eq('id', sub.id).select('*').single();
  if (error) throw error;

  // TL best-effort: subscriptions.update.
  let tl = { pushed: false };
  if (sub.teamleader_subscription_id) {
    try {
      const tok = await getActiveToken();
      if (tok) {
        const body = { id: sub.teamleader_subscription_id };
        if (!running && newStart) body.starts_on = newStart; // lopend: starts_on ongemoeid laten
        if (newEnd) body.ends_on = newEnd;
        const r = await tlFetch('/subscriptions.update', { method: 'POST', body: JSON.stringify(body) });
        if (r.ok) tl = { pushed: true };
        else { tl = { pushed: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }; console.warn('[sub-postpone] TL update', tl.error); }
      }
    } catch (e) { tl = { pushed: false, error: e.message }; console.warn('[sub-postpone] TL exception:', e.message); }
  }

  // Audit (fail-soft).
  try {
    await supabaseAdmin.from('audit_log').insert({
      user_id: userId, action: running ? 'subscription.extended' : 'subscription.postponed',
      entity_type: 'subscription', entity_id: sub.id, before_json: before,
      after_json: { start_date: newStart, end_date: newEnd, term_count: patch.term_count ?? sub.term_count, postponed_months: patch.postponed_months },
      reason_text: `${running ? 'Looptijd verlengd' : 'Verschoven'} +${m} maand(en)`, ip_address: req ? getClientIp(req) : null,
    });
  } catch (e) { console.error('[sub-postpone] audit:', e.message); }

  return { subscription: updated, tl, extended: running };
}
