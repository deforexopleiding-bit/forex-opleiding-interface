// api/sales-deal-mark-subscription-done.js
// POST { deal_id, done } → zet deals.subscription_marked_done handmatig
// op true (afgehandeld) of false (weer openzetten).
//
// Wanneer een klant zijn abonnement standalone heeft ingevoerd (dus niet
// via de offerte-omzet-flow), blijft de bijbehorende accepted offerte
// hangen in "wachten op subscription" / "Omzetten naar abonnement" —
// de per-deal-koppeling in sales-quotations is bewust strict (voorkomt
// false positives per klant). Deze handmatige vlag is de ontsnappings-
// route: sales.html toont de offerte dan als "✓ Afgehandeld" en de
// pending-widget laat 'm vallen. Volledig idempotent.
//
// Auth: Bearer JWT (createUserClient) + RBAC 'sales.tab.subscriptions'
// met OR-fallback naar 'sales.deal.edit' (dat is de bestaande edit-
// permission die o.a. sales-quotation-mark-accepted gebruikt) zodat
// managers/admins zonder de nieuwe tab-permission ook kunnen markeren.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.subscriptions');
  if (!allowed) allowed = await requirePermission(req, 'sales.deal.edit');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (sales.tab.subscriptions / sales.deal.edit)' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const dealId = typeof body.deal_id === 'string' ? body.deal_id.trim() : null;
  const done   = body.done === undefined ? true : !!body.done;
  if (!dealId || !UUID_RE.test(dealId)) return res.status(400).json({ error: 'deal_id (uuid) vereist' });

  try {
    // Deal-bestaanscheck + huidige waarde voor audit + response.
    const { data: deal, error: fErr } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id, subscription_marked_done, tl_quotation_status')
      .eq('id', dealId)
      .maybeSingle();
    if (fErr) throw new Error('deal lookup: ' + fErr.message);
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });

    // Idempotent: geen update als de waarde al klopt.
    if (deal.subscription_marked_done === done) {
      return res.status(200).json({ ok: true, deal_id: dealId, done, unchanged: true });
    }

    const { error: uErr } = await supabaseAdmin
      .from('deals')
      .update({ subscription_marked_done: done })
      .eq('id', dealId);
    if (uErr) throw new Error('update: ' + uErr.message);

    // Audit-log (best-effort, non-blocking).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id    : user.id,
        action     : done ? 'sales_deal.subscription_marked_done' : 'sales_deal.subscription_marked_open',
        entity_type: 'deal',
        entity_id  : dealId,
        before_json: { subscription_marked_done: deal.subscription_marked_done === true },
        after_json : { subscription_marked_done: done },
        reason_text: done
          ? 'Offerte handmatig gemarkeerd als afgehandeld (abo standalone ingevoerd of niet meer nodig).'
          : 'Offerte weer opengezet (subscription_marked_done teruggezet op false).',
        ip_address : getClientIp(req),
      });
    } catch (e) { console.warn('[mark-subscription-done] audit soft-fail', e?.message || e); }

    return res.status(200).json({ ok: true, deal_id: dealId, done, unchanged: false });
  } catch (e) {
    console.error('[mark-subscription-done]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
