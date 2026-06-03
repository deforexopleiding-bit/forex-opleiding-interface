// api/sales-subscription-delete.js
// POST { subscription_id }  (of DELETE ?id=) → zet abonnement lokaal op
// 'cancelled' (soft-delete) en schakelt het uit in Teamleader (best-effort).
// Permission: sales.deal.edit.
//
// TL-DISCOVERY (apiary): er is GEEN subscriptions.delete endpoint.
// Wel subscriptions.deactivate { id } → abonnement wordt gestopt (geen nieuwe
// facturen meer). Reeds geboekte/openstaande facturen blijven bestaan in TL —
// deactivate raakt die niet. Daarom: lokaal soft-delete (status='cancelled'),
// niet hard verwijderen, zodat de historie bewaard blijft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'POST/DELETE only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  const subscriptionId = req.body?.subscription_id || req.query?.id;
  const force = req.body?.force === true; // 'Alleen lokaal stopzetten' bij TL-fout
  if (!subscriptionId) return res.status(400).json({ error: 'subscription_id vereist' });

  try {
    const { data: sub } = await supabaseAdmin.from('subscriptions').select('*').eq('id', subscriptionId).maybeSingle();
    if (!sub) return res.status(404).json({ error: 'Abonnement niet gevonden' });

    // TL-FIRST (Issue 2): deactiveer eerst in TL. Faalt dat én geen force →
    // 502 zonder lokale wijziging (geen out-of-sync state). Met force=true of
    // zonder TL-koppeling → lokaal stopzetten.
    let tl = { deactivated: false };
    if (sub.teamleader_subscription_id) {
      try {
        const tok = await getActiveToken();
        if (!tok) { tl = { deactivated: false, error: 'Geen TL-token actief' }; }
        else {
          const r = await tlFetch('/subscriptions.deactivate', { method: 'POST', body: JSON.stringify({ id: sub.teamleader_subscription_id }) });
          if (r.ok) tl = { deactivated: true };
          else { tl = { deactivated: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }; console.warn('[sub-delete] TL deactivate', tl.error); }
        }
      } catch (e) { tl = { deactivated: false, error: e.message }; console.warn('[sub-delete] TL exception:', e.message); }
      // Audit de TL-poging (traceability).
      try { await supabaseAdmin.from('audit_log').insert({ user_id: user.id, action: 'subscription.tl_deactivate_attempt', entity_type: 'subscription', entity_id: subscriptionId, after_json: tl, ip_address: getClientIp(req) }); } catch {}
      if (!tl.deactivated && !force) {
        return res.status(502).json({ error: 'Teamleader-deactivatie mislukt: ' + (tl.error || 'onbekend') + '. Probeer opnieuw of kies \'Alleen lokaal stopzetten\'.', tl_failed: true, tl });
      }
    }

    // Lokaal soft-delete: status='cancelled' (historie blijft).
    const { error: upErr } = await supabaseAdmin.from('subscriptions')
      .update({ status: 'cancelled' }).eq('id', subscriptionId);
    if (upErr) throw upErr;

    // Audit (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'subscription.cancelled', entity_type: 'subscription', entity_id: subscriptionId,
        before_json: { status: sub.status }, after_json: { status: 'cancelled' },
        reason_text: tl.deactivated ? 'Verwijderd + TL gedeactiveerd' : 'Verwijderd (TL niet gesynct)', ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[sub-delete] audit:', e.message); }

    return res.status(200).json({ success: true, tl });
  } catch (e) {
    console.error('[sales-subscription-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
